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
import { hasErrorCode, readJsonFile, writeJsonAtomic } from "./durableFs";
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
// categories with one name cannot be told apart in the montage bin's filter. At most 50 readable categories.
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

/** The record on disk: the contract's summary and the file's schema version. */
export const StoredCategory = CategorySummary.extend({ schemaVersion: z.literal(CATEGORY_FILE_SCHEMA_VERSION) });
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

export type NewCategory = Omit<StoredCategory, "schemaVersion" | "createdAt" | "updatedAt">;

/** The record as the contract carries it (the file's schema version is the store's own business). */
export function summaryOf(stored: StoredCategory): CategorySummary {
  const { schemaVersion: _schemaVersion, ...summary } = stored;
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

export class CategoryStore {
  readonly dir: string;
  readonly #lockKey: string;
  readonly #now: () => Date;
  readonly #beforeRename: ((finalPath: string) => void | Promise<void>) | undefined;

  constructor(root: string, deps: CategoryStoreDeps = {}) {
    this.dir = join(root, CATEGORIES_DIR);
    this.#lockKey = `categories:${this.dir}`;
    this.#now = deps.now ?? (() => new Date());
    this.#beforeRename = deps.beforeRename;
  }

  #path(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  async #write(path: string, value: unknown): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeJsonAtomic(path, value, this.#beforeRename === undefined ? {} : { beforeRename: this.#beforeRename });
  }

  async #names(): Promise<string[]> {
    try {
      return await readdir(this.dir);
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return [];
      throw error;
    }
  }

  /** Every record file read once. Called under the lock by every writer, and by the readers without it (an atomic rename means they see whole records). */
  async #readAll(): Promise<{ categories: StoredCategory[]; unreadable: number }> {
    const categories: StoredCategory[] = [];
    let unreadable = 0;
    for (const name of await this.#names()) {
      const match = RECORD_NAME.exec(name);
      if (match === null) continue;
      const read = await readJsonFile(join(this.dir, name));
      const record = read.ok ? readRecord(read.value, match[1] ?? "") : null;
      if (record === null) unreadable += 1;
      else categories.push(record);
    }
    categories.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.categoryId < b.categoryId ? -1 : a.categoryId > b.categoryId ? 1 : 0));
    return { categories, unreadable };
  }

  /** The readable categories in creation order (equal times by id), and how many files could not be read (they stay where they are). */
  async list(): Promise<{ categories: StoredCategory[]; unreadable: number }> {
    return this.#readAll();
  }

  /** One category; null when there is no such record or it cannot be read (a newer Studio's included). */
  async get(id: string): Promise<StoredCategory | null> {
    if (!RECORD_NAME.test(`${id}.json`)) return null;
    const read = await readJsonFile(this.#path(id));
    return read.ok ? readRecord(read.value, id) : null;
  }

  /** Creates a category: refused with `limit` past 50, `name-taken` for a name another holds, `exists` for an id already used. */
  async create(input: NewCategory): Promise<StoredCategory> {
    return runExclusive(this.#lockKey, async () => {
      const { categories } = await this.#readAll();
      if (categories.length >= MAX_CUSTOM_CATEGORIES) throw new CategoryError("limit", `the library already holds ${MAX_CUSTOM_CATEGORIES} categories`);
      const name = input.name.trim();
      if (categories.some((c) => categoryNameKey(c.name) === categoryNameKey(name))) throw new CategoryError("name-taken", "another category already has this name");
      const existing = await readJsonFile(this.#path(input.categoryId));
      if (existing.ok || (await this.#names()).includes(`${input.categoryId}.json`)) throw new CategoryError("exists", `category ${input.categoryId} already exists`);
      const stamp = this.#now().toISOString();
      const record: StoredCategory = { schemaVersion: CATEGORY_FILE_SCHEMA_VERSION, ...input, name, createdAt: stamp, updatedAt: stamp };
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

  /** A regeneration's answer: the new description, label, style and pool, the money it cost added to the total; the id, name and creation time stay. */
  async replacePool(
    id: string,
    input: { description: string; label: string; style: CategoryStyle; pool: CategoryPool; model: string; spentMicros: number },
  ): Promise<StoredCategory> {
    return runExclusive(this.#lockKey, async () => {
      const current = await this.get(id);
      if (current === null) throw new CategoryError("not-found", `no readable category ${id}`);
      const { spentMicros, ...fresh } = input;
      const updated: StoredCategory = { ...current, ...fresh, spentMicros: current.spentMicros + spentMicros, updatedAt: this.#nextStamp(current.updatedAt) };
      await this.#write(this.#path(id), updated);
      return updated;
    });
  }

  /** Adds money a call cost to a category's total (a failed regeneration still cost it); null when there is no readable category. */
  async addSpend(id: string, micros: number): Promise<StoredCategory | null> {
    return runExclusive(this.#lockKey, async () => {
      const current = await this.get(id);
      if (current === null) return null;
      const updated: StoredCategory = { ...current, spentMicros: current.spentMicros + micros, updatedAt: this.#nextStamp(current.updatedAt) };
      await this.#write(this.#path(id), updated);
      return updated;
    });
  }

  /** Deletes a category's record; `not-found` when it is not there or cannot be read (a newer Studio's record is never removed). */
  async remove(id: string): Promise<void> {
    await runExclusive(this.#lockKey, async () => {
      if ((await this.get(id)) === null) throw new CategoryError("not-found", `no readable category ${id}`);
      await unlinkWithRetry(this.#path(id));
    });
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
      const read = await readJsonFile(join(this.dir, name));
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
        await unlinkWithRetry(join(this.dir, `pending-${jobId}.json`));
        return true;
      } catch (error) {
        if (hasErrorCode(error, "ENOENT")) return false;
        throw error;
      }
    });
  }
}
