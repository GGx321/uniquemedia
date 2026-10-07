import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  categoryNameKey,
  CategoryCallKind,
  CategoryDescription,
  CategoryName,
  CategorySummary,
  CustomCategoryId,
  Id,
  MAX_CUSTOM_CATEGORIES,
  POOL_OUTFITS_MIN,
  POOL_PLACES_MIN,
  type CategoryPool,
  type CategorySnapshot,
  type CategoryStyle,
} from "../../shared/engine";
import { poolOf } from "../scenes/poolGen";
import { PoolSchema } from "../scenes/pools";
import { fsyncDir, hasErrorCode, readdirTolerant, readJsonFileTolerant, writeJsonAtomic } from "./durableFs";
import { CATEGORIES_DIR, CATEGORY_FILE_SCHEMA_VERSION, isFromNewerVersion } from "./layout";
import { runExclusive } from "./keyedMutex";
import { unlinkWithRetry } from "./unlinkRetry";

// The owner's own scene categories (CS.2): `<library>/categories/<categoryId>.json`, one record per category, shared by every
// avatar. Every change is a read-modify-write of one record under one lock for the whole folder and ends in the library's own
// atomic write (temp, fsync, rename, fsync of the folder), so a reader or a restart sees the old record or the new, never half.
//
// A record is read through the schema AND the engine's own pool rules (a hand-edited file with a youth word in a place is not
// served). A file that cannot be read, or that a newer Studio wrote, is counted in `unreadable` and left exactly where it is: it
// is never moved, rewritten or removed. Names are unique per library (compared case-insensitively after trim, NFC), because two
// categories with one name cannot be told apart in the montage bin's filter. At most 50 category files: every `cat-*.json` counts towards the limit,
// readable or not (an unreadable or newer record is kept, so it holds its place and the folder stays bounded), and `list()` answers at most 50 of the
// readable ones, the oldest first, counting the rest in `overLimit`.
//
// `pending-<jobId>.json` is the record of a paid create or regenerate that has not ended: written before the call, removed on any
// outcome. A leftover after a restart is the call a closed Studio left (`categories.list`'s `interrupted`).

export type CategoryErrorCode = "limit" | "name-taken" | "not-found" | "exists" | "item-not-found" | "below-minimum" | "mirror-needed";

export class CategoryError extends Error {
  readonly code: CategoryErrorCode;
  constructor(code: CategoryErrorCode, message: string) {
    super(message);
    this.name = "CategoryError";
    this.code = code;
  }
}

/** How many booked job ids a record keeps (the last ones, the oldest dropped). */
export const BOOKED_JOBS_CAP = 200;

/**
 * The record on disk: the contract's summary, the file's schema version, and `bookedJobs`, the ids of the paid calls whose cost is already in
 * `spentMicros` (never part of the contract). It is the idempotency key of the money: a job's cost is added together with its id in ONE record
 * write, and a job already listed adds nothing, so a retried booking (a dismiss whose record removal failed, a restart that shows a finished call as
 * interrupted, a write that threw after its rename) cannot count a call twice. A record written without the field reads as an empty list.
 *
 * The list is the last `BOOKED_JOBS_CAP` ids, the oldest dropped. A call that can still be booked again is a recent one: only one paid call runs at a
 * time, and its pending record is either removed at its end or shown as interrupted at the next listing for the owner to dismiss, so 200 later
 * bookings of one category before that record is dismissed is out of reach; the cap keeps the record at a few KB however long the category lives.
 */
export const StoredCategory = CategorySummary.extend({ schemaVersion: z.literal(CATEGORY_FILE_SCHEMA_VERSION), bookedJobs: z.array(Id).max(BOOKED_JOBS_CAP).default([]) });
export type StoredCategory = z.infer<typeof StoredCategory>;

/** A paid call that has begun and not ended. */
export const PendingCall = z
  .strictObject({
    schemaVersion: z.literal(CATEGORY_FILE_SCHEMA_VERSION),
    jobId: Id,
    kind: CategoryCallKind,
    name: CategoryName,
    description: CategoryDescription,
    categoryId: CustomCategoryId.nullable(),
    startedAt: z.iso.datetime(),
  })
  .refine((p) => (p.kind === "regenerate") === (p.categoryId !== null), { message: "a regenerate names its category and a create has none", path: ["categoryId"] });
export type PendingCall = Omit<z.infer<typeof PendingCall>, "schemaVersion">;

export type NewCategory = Omit<StoredCategory, "schemaVersion" | "createdAt" | "updatedAt" | "bookedJobs">;

/** The record as the contract carries it (the file's schema version is the store's own business). */
export function summaryOf(stored: StoredCategory): CategorySummary {
  const { schemaVersion: _schemaVersion, bookedJobs: _bookedJobs, ...summary } = stored;
  return summary;
}

/** What a plan keeps of a custom category it uses, so a resume never reads the library again. */
export function snapshotOf(stored: StoredCategory): CategorySnapshot {
  return { ref: stored.categoryId, name: stored.name, label: stored.label, style: stored.style };
}

export interface CategoryStoreDeps {
  now?: () => Date;
  /** Test seam: called after each temp file is durable and before it is renamed into place. Throwing simulates a crash there. */
  beforeRename?: ((finalPath: string) => void | Promise<void>) | undefined;
  /** Test seam: called after each record is renamed into place and before the folder is flushed. Throwing simulates a flush that failed. */
  afterRename?: ((finalPath: string) => void | Promise<void>) | undefined;
  /** Test seam: called before each record is unlinked. Throwing simulates a disk that refuses the delete. */
  beforeUnlink?: ((path: string) => void | Promise<void>) | undefined;
  /** Test seam: the flush of the folder after an unlink; defaults to the library's own. */
  fsyncDir?: ((dir: string) => Promise<void>) | undefined;
}

const RECORD_NAME = /^(cat-[a-z0-9-]{8,59})\.json$/;
const PENDING_NAME = /^pending-([a-z0-9-]{8,64})\.json$/;

/** An item the owner removes is named by its text, compared as names are (trim, NFC, case fold). */
function sameText(a: string, b: string): boolean {
  return categoryNameKey(a) === categoryNameKey(b);
}

/** A record is readable when it is this version's schema and its pool passes the engine's own pool rules. */
function readRecord(raw: unknown, fileId: string): StoredCategory | null {
  const parsed = StoredCategory.safeParse(raw);
  if (!parsed.success || parsed.data.categoryId !== fileId) return null;
  return PoolSchema.safeParse(poolOf(parsed.data.pool)).success ? parsed.data : null;
}

/**
 * The record's booked jobs with `jobId` last, the list cut to `BOOKED_JOBS_CAP`, the oldest dropped first. An id whose
 * `pending-<id>.json` is still in the folder is skipped (that call is not over: its booking may be retried), unless the cap
 * cannot be kept otherwise, which is the file's own limit.
 */
function booked(record: StoredCategory, jobId: string, livePending: ReadonlySet<string>): string[] {
  const ids = [...record.bookedJobs, jobId];
  let excess = ids.length - BOOKED_JOBS_CAP;
  if (excess <= 0) return ids;
  const kept: string[] = [];
  for (const id of ids) {
    if (excess > 0 && id !== jobId && !livePending.has(id)) excess -= 1;
    else kept.push(id);
  }
  return excess > 0 ? kept.slice(excess) : kept;
}

export class CategoryStore {
  readonly dir: string;
  readonly #lockKey: string;
  readonly #now: () => Date;
  readonly #beforeRename: ((finalPath: string) => void | Promise<void>) | undefined;
  readonly #afterRename: ((finalPath: string) => void | Promise<void>) | undefined;
  readonly #beforeUnlink: ((path: string) => void | Promise<void>) | undefined;
  readonly #fsyncDir: (dir: string) => Promise<void>;

  constructor(root: string, deps: CategoryStoreDeps = {}) {
    this.dir = join(root, CATEGORIES_DIR);
    this.#lockKey = `categories:${this.dir}`;
    this.#now = deps.now ?? (() => new Date());
    this.#beforeRename = deps.beforeRename;
    this.#afterRename = deps.afterRename;
    this.#beforeUnlink = deps.beforeUnlink;
    this.#fsyncDir = deps.fsyncDir ?? fsyncDir;
  }

  /** Unlinks a record and flushes the folder, so the deletion is as durable as a write; a flush that fails does not undo it (the record is gone). */
  async #unlink(path: string): Promise<void> {
    await this.#beforeUnlink?.(path);
    await unlinkWithRetry(path);
    await this.#fsyncDir(this.dir).catch(() => undefined);
  }

  #path(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  async #write(path: string, value: unknown): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeJsonAtomic(path, value, {
      ...(this.#beforeRename === undefined ? {} : { beforeRename: this.#beforeRename }),
      ...(this.#afterRename === undefined ? {} : { afterRename: this.#afterRename }),
    });
  }

  async #names(): Promise<string[]> {
    return (await readdirTolerant(this.dir)) ?? [];
  }

  /** Every record file read once. Called under the lock by every writer, and by the readers without it (an atomic rename means they see whole records). */
  async #readAll(): Promise<{ categories: StoredCategory[]; unreadable: number }> {
    const categories: StoredCategory[] = [];
    let unreadable = 0;
    // A folder that cannot be listed at all (no permission, a file in its place) is one unreadable record: the feature degrades, nothing throws.
    const names = await readdirTolerant(this.dir);
    if (names === null) return { categories, unreadable: 1 };
    for (const name of names) {
      const match = RECORD_NAME.exec(name);
      if (match === null) continue;
      const read = await readJsonFileTolerant(join(this.dir, name));
      const record = read.ok ? readRecord(read.value, match[1] ?? "") : null;
      if (record === null) unreadable += 1;
      else categories.push(record);
    }
    categories.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.categoryId < b.categoryId ? -1 : a.categoryId > b.categoryId ? 1 : 0));
    return { categories, unreadable };
  }

  /**
   * The readable categories in creation order (equal times by id), at most 50 and the oldest first; how many files could not be read (they stay where
   * they are); and how many readable ones are past the 50th and left out (they stay too).
   */
  async list(): Promise<{ categories: StoredCategory[]; unreadable: number; overLimit: number }> {
    const { categories, unreadable } = await this.#readAll();
    return { categories: categories.slice(0, MAX_CUSTOM_CATEGORIES), unreadable, overLimit: Math.max(0, categories.length - MAX_CUSTOM_CATEGORIES) };
  }

  /**
   * `limit` for a new category when the folder already holds 50 category files (readable or not), `name-taken` when another readable category (the
   * ones a listing leaves out included) has the name. `exceptId` is the category being renamed: it is not in its own way, and a rename has no limit.
   */
  async assertRoom(name: string, exceptId: string | null): Promise<void> {
    const { categories, unreadable } = await this.#readAll();
    this.#checkRoom(categories, unreadable, name, exceptId);
  }

  #checkRoom(categories: readonly StoredCategory[], unreadable: number, name: string, exceptId: string | null): void {
    if (exceptId === null && categories.length + unreadable >= MAX_CUSTOM_CATEGORIES) throw new CategoryError("limit", `the library already holds ${MAX_CUSTOM_CATEGORIES} categories`);
    const key = categoryNameKey(name);
    if (categories.some((c) => c.categoryId !== exceptId && categoryNameKey(c.name) === key)) throw new CategoryError("name-taken", "another category already has this name");
  }

  /** One category; null when there is no such record or it cannot be read (a newer Studio's included). */
  async get(id: string): Promise<StoredCategory | null> {
    if (!RECORD_NAME.test(`${id}.json`)) return null;
    const read = await readJsonFileTolerant(this.#path(id));
    return read.ok ? readRecord(read.value, id) : null;
  }

  /**
   * Creates a category: refused with `limit` when 50 category files are already there (readable or not), `name-taken` for a name another holds, `exists` for an id already used.
   * `jobId` is the paid call that made it: its cost (`spentMicros`) is booked under that id from the first write.
   */
  async create(input: NewCategory, jobId?: string): Promise<StoredCategory> {
    return runExclusive(this.#lockKey, async () => {
      const { categories, unreadable } = await this.#readAll();
      const name = input.name.trim();
      this.#checkRoom(categories, unreadable, name, null);
      const existing = await readJsonFileTolerant(this.#path(input.categoryId));
      if (existing.ok || (await this.#names()).includes(`${input.categoryId}.json`)) throw new CategoryError("exists", `category ${input.categoryId} already exists`);
      const stamp = this.#now().toISOString();
      const record: StoredCategory = { schemaVersion: CATEGORY_FILE_SCHEMA_VERSION, ...input, name, bookedJobs: jobId === undefined ? [] : [jobId], createdAt: stamp, updatedAt: stamp };
      await this.#write(this.#path(input.categoryId), record);
      return record;
    });
  }

  /**
   * A rename and/or items to remove, applied together or not at all. `below-minimum` when a removal would leave fewer than 5 places or 3
   * outfits, `mirror-needed` when it would remove the last mirror place of a deck that can draw a mirror shot, `item-not-found` for a
   * text that names nothing, `name-taken` for a name another category holds, `not-found` for a category that is not there or not readable.
   */
  async update(id: string, change: { name?: string; removeLocations?: readonly string[]; removeOutfits?: readonly string[] }): Promise<StoredCategory> {
    return runExclusive(this.#lockKey, async () => {
      const current = await this.get(id);
      if (current === null) throw new CategoryError("not-found", `no readable category ${id}`);
      let { name } = current;
      if (change.name !== undefined) {
        name = change.name.trim();
        const all = await this.#readAll();
        if (all.categories.some((c) => c.categoryId !== id && categoryNameKey(c.name) === categoryNameKey(name))) throw new CategoryError("name-taken", "another category already has this name");
      }
      let { locations, outfits } = current.pool;
      for (const text of change.removeLocations ?? []) {
        if (!locations.some((l) => sameText(l.name, text))) throw new CategoryError("item-not-found", "the category has no such place");
        locations = locations.filter((l) => !sameText(l.name, text));
      }
      for (const text of change.removeOutfits ?? []) {
        if (!outfits.some((o) => sameText(o, text))) throw new CategoryError("item-not-found", "the category has no such outfit");
        outfits = outfits.filter((o) => !sameText(o, text));
      }
      if (locations.length < POOL_PLACES_MIN) throw new CategoryError("below-minimum", `a pool keeps at least ${POOL_PLACES_MIN} places`);
      if (outfits.length < POOL_OUTFITS_MIN) throw new CategoryError("below-minimum", `a pool keeps at least ${POOL_OUTFITS_MIN} outfits`);
      if (current.pool.shotDeck.includes("mirror") && !locations.some((l) => l.mirror)) throw new CategoryError("mirror-needed", "the deck draws mirror shots: keep a place with a mirror");
      const updated: StoredCategory = { ...current, name, pool: { ...current.pool, locations, outfits }, updatedAt: this.#nextStamp(current.updatedAt) };
      await this.#write(this.#path(id), updated);
      return updated;
    });
  }

  /**
   * A regeneration's answer: the new description, label, style and pool, the money it cost added to the total; the id, name and creation time stay.
   * A job already booked on the record is a no-op (its answer and its cost are in the record already): the record is returned as it is.
   */
  async replacePool(
    id: string,
    input: { description: string; label: string; style: CategoryStyle; pool: CategoryPool; model: string; spentMicros: number; jobId: string },
  ): Promise<StoredCategory> {
    return runExclusive(this.#lockKey, async () => {
      const current = await this.get(id);
      if (current === null) throw new CategoryError("not-found", `no readable category ${id}`);
      if (current.bookedJobs.includes(input.jobId)) return current;
      const { spentMicros, jobId, ...fresh } = input;
      const updated: StoredCategory = { ...current, ...fresh, spentMicros: current.spentMicros + spentMicros, bookedJobs: booked(current, jobId, await this.#pendingIds()), updatedAt: this.#nextStamp(current.updatedAt) };
      await this.#write(this.#path(id), updated);
      return updated;
    });
  }

  /**
   * Adds money a call cost to a category's total (a failed regeneration still cost it), under the call's id; null when there is no readable category.
   * A job already booked on the record adds nothing: the record is returned as it is, and nothing is written.
   */
  async addSpend(id: string, micros: number, jobId: string): Promise<StoredCategory | null> {
    return runExclusive(this.#lockKey, async () => {
      const current = await this.get(id);
      if (current === null) return null;
      if (current.bookedJobs.includes(jobId)) return current;
      const updated: StoredCategory = { ...current, spentMicros: current.spentMicros + micros, bookedJobs: booked(current, jobId, await this.#pendingIds()), updatedAt: this.#nextStamp(current.updatedAt) };
      await this.#write(this.#path(id), updated);
      return updated;
    });
  }

  /** Deletes a category's record; `not-found` when it is not there or cannot be read (a newer Studio's record is never removed). */
  async remove(id: string): Promise<void> {
    await runExclusive(this.#lockKey, async () => {
      if ((await this.get(id)) === null) throw new CategoryError("not-found", `no readable category ${id}`);
      await this.#unlink(this.#path(id));
    });
  }

  /** The ids of the paid calls whose pending record is in the folder now. Read inside the store's lock, which writes and removes them. */
  async #pendingIds(): Promise<Set<string>> {
    const ids = new Set<string>();
    for (const name of await this.#names()) {
      const match = PENDING_NAME.exec(name);
      if (match?.[1] !== undefined) ids.add(match[1]);
    }
    return ids;
  }

  /** An update time that is never earlier than the record's own, even when the clock is. */
  #nextStamp(previous: string): string {
    const now = this.#now().toISOString();
    return now > previous ? now : previous;
  }

  // ---------- the record of a paid call that has begun ----------

  async writePending(record: PendingCall): Promise<void> {
    await runExclusive(this.#lockKey, async () => {
      await this.#write(join(this.dir, `pending-${record.jobId}.json`), { schemaVersion: CATEGORY_FILE_SCHEMA_VERSION, ...record });
    });
  }

  /** The records a closed Studio left, oldest first; one that cannot be read is skipped. */
  async listPending(): Promise<PendingCall[]> {
    const found: PendingCall[] = [];
    for (const name of await this.#names()) {
      const match = PENDING_NAME.exec(name);
      if (match === null) continue;
      const read = await readJsonFileTolerant(join(this.dir, name));
      if (!read.ok || isFromNewerVersion(read.value, CATEGORY_FILE_SCHEMA_VERSION)) continue;
      const parsed = PendingCall.safeParse(read.value);
      if (!parsed.success || parsed.data.jobId !== match[1]) continue;
      const { schemaVersion: _version, ...record } = parsed.data;
      found.push(record);
    }
    return found.sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : a.jobId < b.jobId ? -1 : 1));
  }

  /** Forgets a record; false when there was none. */
  async removePending(jobId: string): Promise<boolean> {
    return runExclusive(this.#lockKey, async () => {
      try {
        await this.#unlink(join(this.dir, `pending-${jobId}.json`));
        return true;
      } catch (error) {
        if (hasErrorCode(error, "ENOENT")) return false;
        throw error;
      }
    });
  }
}
