import { lstat, mkdir, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { Id } from "../../shared/engine/primitives";
import { Montage, MontageDraft, MontageName } from "../../shared/engine/montage";
import { hasErrorCode, isTempName, writeJsonAtomic } from "../library/durableFs";
import { runExclusive } from "../library/keyedMutex";
import { isFromNewerVersion, MONTAGE_FILE_SCHEMA_VERSION } from "../library/layout";
import type { Library } from "../library/library";
import { openRegularNoFollow, UnsafeOpenError, type OpenRegularOptions } from "../library/openRegular";
import { unlinkWithRetry } from "../library/unlinkRetry";

// The montage drafts on disk (Stage 3 plan, "Library, storage and contract additions"):
// `avatars/<avatarId>/montages/<montageId>.json`, one file per draft.
//
// - Written atomically with the library's own helper (temp sibling, fsync, rename with the Windows retry, fsync of the
//   folder): a reader, or a restart, sees the old draft or the new one, never a mix. The temp of a crashed write is
//   left behind and quarantined by the next library open (survey.ts); the listing ignores dot files meanwhile.
// - Read as a file that must be OURS: `openRegularNoFollow` refuses a link, a folder or a device, the size is bounded
//   before the read, and the JSON is parsed through the contract's own `MontageDraft`, so nothing malformed is ever a draft.
// - Never trusted for its place: the file's `montageId` must be its name and its spec's avatar the folder's.
// - A listing never fails for a bad file: it is skipped and counted (the caller logs the count, never a path).
//
// A draft is the owner's work in progress. It takes no part in "used" (only a rendered video's record does), so nothing
// here talks to the used index, and a draft may name photos that are gone or rejected.
//
// Serialising is the CALLER'S job, through `exclusive`: one queue per draft, entered in arrival order, so two saves of one
// draft never interleave and the last one asked is the last one written. Reads are not queued (an atomic replace
// makes them safe).

/**
 * The largest legitimate draft (20 collages of 4 with the longest ids, 10 captions of 1024 units, 10 stickers, pretty-printed) is
 * about 125 KB (a caption of 1024 three-byte units is the worst for bytes); a file over this is not a draft. Small enough that a listing of `MAX_DRAFT_FILES_READ` files parses at most
 * a quarter of a GiB.
 */
export const MAX_DRAFT_BYTES = 256 * 1024;
/** One listing reads at most this many draft files (sorted by name), so a folder of junk cannot stall the engine. */
export const MAX_DRAFT_FILES_READ = 1000;
/** How many times a read looks again when a save replaced the file between its two looks. */
const OPEN_ATTEMPTS = 5;
/** Draft files are read this many at a time. */
const READ_CONCURRENCY = 16;

const DRAFT_FILE_NAME = /^([a-z0-9-]{8,64})\.json$/;

/** What is on disk: the contract's `Montage` plus the schema version of the file. */
const DraftFile = z.strictObject({
  schemaVersion: z.literal(MONTAGE_FILE_SCHEMA_VERSION),
  montageId: Id,
  name: MontageName.nullable(),
  spec: MontageDraft,
  updatedAt: z.iso.datetime(),
});

/** `changing`: saves replaced the file faster than it could be opened, so it could not be read just now (try again); never a verdict on the draft. */
export type DraftUnreadable = "corrupt" | "too-new" | "misfiled" | "too-large" | "not-a-file" | "io" | "changing";

/** `missing`: nothing is there. `unreadable`: something is, and it is not a usable draft (the reason is a code, never text from the file). */
export type DraftRead = { kind: "ok"; montage: Montage } | { kind: "missing" } | { kind: "unreadable"; reason: DraftUnreadable };

export interface DraftListing {
  /** Every readable draft, newest `updatedAt` first, ties by id. */
  montages: Montage[];
  /** Files named like a draft that could not be used, plus the files left unread when there were more than `MAX_DRAFT_FILES_READ` (the oldest by mtime). */
  skipped: number;
  /** More draft files than `MAX_DRAFT_FILES_READ`: the oldest were not read (and are counted in `skipped`). */
  truncated: boolean;
}

/** An avatar's drafts folder that could not be listed (not a missing one: that is no drafts). `code` is the disk's. */
export class DraftFolderError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`the drafts folder could not be listed (${code})`);
    this.name = "DraftFolderError";
    this.code = code;
  }
}

/** Something that is not a regular file has a draft's name (a folder, a link): it is never deleted or retried. */
export class DraftNotAFileError extends Error {
  constructor() {
    super("a draft's name is taken by something that is not a file");
    this.name = "DraftNotAFileError";
  }
}

export interface DraftStoreDeps {
  /** Codes and counts only: never a path or a file's text. */
  log: (line: string) => void;
  /** Test seam of the no-follow open (its disk calls), to play a rename landing between the two looks. */
  open?: OpenRegularOptions;
  /** Test seam of `writeJsonAtomic`: runs after the temp is durable and before the rename; throwing leaves the disk as a crash there would. */
  beforeRename?: (finalPath: string) => void | Promise<void>;
}

function kindOf(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  return "code" in error && typeof error.code === "string" ? error.code : error.name;
}

/** The order of a listing: newest first; the id breaks a tie so the order is the same on every call. */
function newestFirst(a: Montage, b: Montage): number {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
  return a.montageId < b.montageId ? -1 : a.montageId > b.montageId ? 1 : 0;
}

export class DraftStore {
  readonly #deps: DraftStoreDeps;
  /** The drafts this process deleted: a render queued from one keeps the id, and its record must not name a draft that is gone. Ids are unique, so this is exact for the life of the process. */
  readonly #removed = new Set<string>();

  constructor(deps: DraftStoreDeps) {
    this.#deps = deps;
  }

  /**
   * Runs `task` after every earlier task on the same draft has settled, whether it succeeded or failed. The queue is entered
   * SYNCHRONOUSLY, before any await, so the order of the calls is the order of the tasks: a caller that queues before it looks
   * up the library (which awaits) keeps its place. Ids are unique across the library, so the id alone is the key.
   */
  exclusive<T>(montageId: string, task: () => Promise<T>): Promise<T> {
    return runExclusive(`montage:${montageId}`, task);
  }

  /** One draft's file, read as described above. Both ids become path segments, so a bad one throws (`invalid-id`) before any path exists. */
  async read(library: Library, avatarId: string, montageId: string): Promise<DraftRead> {
    return this.#readFile(library.montageFilePath(avatarId, montageId), avatarId, montageId);
  }

  async #readFile(path: string, avatarId: string, montageId: string): Promise<DraftRead> {
    let handle;
    // A save replaces the file by rename: a read that looked at the old file and opened the new one meets `ECHANGED`, which
    // is the race, not a bad file. It looks again (the new file is whole by then); a file that keeps changing is not read.
    for (let attempt = 0; ; attempt++) {
      try {
        handle = await openRegularNoFollow(path, this.#deps.open);
        break;
      } catch (error) {
        if (hasErrorCode(error, "ENOENT")) return { kind: "missing" };
        if (error instanceof UnsafeOpenError && error.code === "ECHANGED") {
          if (attempt < OPEN_ATTEMPTS - 1) continue;
          return { kind: "unreadable", reason: "changing" };
        }
        if (error instanceof UnsafeOpenError) return { kind: "unreadable", reason: "not-a-file" };
        this.#deps.log(`a draft file could not be opened (${kindOf(error)})`);
        return { kind: "unreadable", reason: "io" };
      }
    }
    let text: string;
    try {
      const { size } = await handle.stat();
      if (size > MAX_DRAFT_BYTES) return { kind: "unreadable", reason: "too-large" };
      text = await handle.readFile({ encoding: "utf8" });
    } catch (error) {
      this.#deps.log(`a draft file could not be read (${kindOf(error)})`);
      return { kind: "unreadable", reason: "io" };
    } finally {
      await handle.close().catch(() => undefined);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return { kind: "unreadable", reason: "corrupt" };
    }
    // A newer Studio's draft may hold fields this build would drop on its next save: it is not read at all.
    if (isFromNewerVersion(raw, MONTAGE_FILE_SCHEMA_VERSION)) return { kind: "unreadable", reason: "too-new" };
    const parsed = DraftFile.safeParse(raw);
    if (!parsed.success) return { kind: "unreadable", reason: "corrupt" };
    const { schemaVersion: _version, ...montage } = parsed.data;
    if (montage.montageId !== montageId || montage.spec.avatarId !== avatarId) return { kind: "unreadable", reason: "misfiled" };
    return { kind: "ok", montage };
  }

  /**
   * The draft with this id, in whichever avatar's folder it is: `null` when no avatar has a file of that name. The first
   * avatar (in the library's order) that has one answers; a damaged file answers as damaged, never as missing.
   */
  async find(library: Library, montageId: string): Promise<{ avatarId: string; read: DraftRead } | null> {
    for (const manifest of library.listAvatars()) {
      const read = await this.read(library, manifest.id, montageId);
      if (read.kind !== "missing") return { avatarId: manifest.id, read };
    }
    return null;
  }

  /** Whether something is at this draft's place (a damaged file included): one `lstat`, no read, so it is cheap enough to ask for every video of a listing. */
  async exists(library: Library, avatarId: string, montageId: string): Promise<boolean> {
    try {
      await lstat(library.montageFilePath(avatarId, montageId));
      return true;
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return false;
      throw error;
    }
  }

  /**
   * Every readable draft of one avatar, or of all of them. A file that cannot be used is skipped and counted; the count
   * is logged with no path. At most `MAX_DRAFT_FILES_READ` files are read over the whole call.
   */
  async list(library: Library, avatarId?: string): Promise<DraftListing> {
    const avatarIds = avatarId === undefined ? library.listAvatars().map((manifest) => manifest.id) : [avatarId];
    const montages: Montage[] = [];
    let skipped = 0;
    let truncated = false;
    let budget = MAX_DRAFT_FILES_READ;
    for (const id of avatarIds) {
      const dir = library.montagesDir(id);
      let entries: Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (error) {
        if (hasErrorCode(error, "ENOENT")) continue;
        this.#deps.log(`the drafts folder of an avatar could not be listed (${kindOf(error)})`);
        throw new DraftFolderError(kindOf(error));
      }
      let named = entries.filter((entry) => !isTempName(entry.name) && DRAFT_FILE_NAME.test(entry.name)).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      if (budget === 0) {
        // Nothing left to read: what this avatar has is counted, not looked at.
        skipped += named.length;
        truncated = truncated || named.length > 0;
        continue;
      }
      if (named.length > budget) {
        // Too many to read: keep the NEWEST by modification time (the drafts the owner is working on), not the ones whose random ids sort first.
        truncated = true;
        named = await this.#newestFirst(dir, named);
      }
      const wanted = named.slice(0, budget);
      skipped += named.length - wanted.length;
      budget -= wanted.length;
      for (let at = 0; at < wanted.length; at += READ_CONCURRENCY) {
        const batch = wanted.slice(at, at + READ_CONCURRENCY);
        const reads = await Promise.all(batch.map((entry) => this.read(library, id, basename(entry.name, ".json"))));
        for (const read of reads) {
          if (read.kind === "ok") montages.push(read.montage);
          else if (read.kind === "unreadable") skipped++;
        }
      }
    }
    if (skipped > 0) this.#deps.log(`${skipped} draft file(s) could not be used and are left out of the list`);
    if (truncated) this.#deps.log(`the drafts folders hold more draft files than one listing reads (${MAX_DRAFT_FILES_READ}); the rest are left out`);
    montages.sort(newestFirst);
    return { montages, skipped, truncated };
  }

  /** `entries` by modification time, newest first, ties by name; a file that cannot be looked at goes last. */
  async #newestFirst(dir: string, entries: readonly Dirent[]): Promise<Dirent[]> {
    const times = new Map<string, number>();
    for (let at = 0; at < entries.length; at += READ_CONCURRENCY * 4) {
      await Promise.all(
        entries.slice(at, at + READ_CONCURRENCY * 4).map(async (entry) => {
          try {
            times.set(entry.name, (await lstat(join(dir, entry.name))).mtimeMs);
          } catch {
            times.set(entry.name, -Infinity);
          }
        }),
      );
    }
    return [...entries].sort((a, b) => (times.get(b.name) ?? -Infinity) - (times.get(a.name) ?? -Infinity) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /**
   * Writes the draft, replacing any earlier one (the folder is made on the first). Not queued: the service holds
   * `exclusive` around a write that must not interleave with another on the same draft.
   */
  async write(library: Library, montage: Montage): Promise<void> {
    const avatarId = montage.spec.avatarId;
    const path = library.montageFilePath(avatarId, montage.montageId);
    await mkdir(library.montagesDir(avatarId), { recursive: true });
    const file = { schemaVersion: MONTAGE_FILE_SCHEMA_VERSION, ...montage };
    await writeJsonAtomic(path, DraftFile.parse(file), this.#deps.beforeRename === undefined ? {} : { beforeRename: this.#deps.beforeRename });
  }

  /** Deletes the draft's file (a damaged one too) and remembers it as removed; false when it was already gone. */
  async remove(library: Library, avatarId: string, montageId: string): Promise<boolean> {
    const path = library.montageFilePath(avatarId, montageId);
    // Looked at first: on Windows unlinking a folder answers EPERM, which the retry would take for a lock and spend seconds on.
    try {
      if (!(await lstat(path)).isFile()) throw new DraftNotAFileError();
      await unlinkWithRetry(path);
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return false;
      throw error;
    }
    this.#removed.add(montageId);
    return true;
  }

  /** Whether this process deleted the draft. */
  wasRemoved(montageId: string): boolean {
    return this.#removed.has(montageId);
  }
}
