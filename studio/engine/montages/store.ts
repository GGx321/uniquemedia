import { mkdir, readdir } from "node:fs/promises";
import { basename } from "node:path";
import { z } from "zod";
import { Id } from "../../shared/engine/primitives";
import { Montage, MontageDraft, MontageName } from "../../shared/engine/montage";
import { hasErrorCode, isTempName, writeJsonAtomic } from "../library/durableFs";
import { runExclusive } from "../library/keyedMutex";
import { isFromNewerVersion, MONTAGE_FILE_SCHEMA_VERSION } from "../library/layout";
import type { Library } from "../library/library";
import { openRegularNoFollow, UnsafeOpenError } from "../library/openRegular";
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
// Serialising is the CALLER'S job, through `exclusive`: one queue per draft, in arrival order, so two saves of one
// draft never interleave and the last one asked is the last one written. Reads are not queued (an atomic replace
// makes them safe).

/** A draft is a few KB (20 clips, 20 layers, captions of at most 1024 units); a file this large is not one. */
export const MAX_DRAFT_BYTES = 1024 * 1024;
/** One listing reads at most this many draft files (sorted by name), so a folder of junk cannot stall the engine. */
export const MAX_DRAFT_FILES_READ = 1000;
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

export type DraftUnreadable = "corrupt" | "too-new" | "misfiled" | "too-large" | "not-a-file" | "io";

/** `missing`: nothing is there. `unreadable`: something is, and it is not a usable draft (the reason is a code, never text from the file). */
export type DraftRead = { kind: "ok"; montage: Montage } | { kind: "missing" } | { kind: "unreadable"; reason: DraftUnreadable };

export interface DraftListing {
  /** Every readable draft, newest `updatedAt` first, ties by id. */
  montages: Montage[];
  /** Files named like a draft that could not be used. */
  skipped: number;
  /** More draft files than `MAX_DRAFT_FILES_READ`: the rest were not read. */
  truncated: boolean;
}

export interface DraftStoreDeps {
  /** Codes and counts only: never a path or a file's text. */
  log: (line: string) => void;
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

  /** Runs `task` after every earlier task on the same draft (of the same library) has settled, whether it succeeded or failed. */
  exclusive<T>(library: Library, montageId: string, task: () => Promise<T>): Promise<T> {
    return runExclusive(`montage:${library.root}:${montageId}`, task);
  }

  /** One draft's file, read as described above. Both ids become path segments, so a bad one throws (`invalid-id`) before any path exists. */
  async read(library: Library, avatarId: string, montageId: string): Promise<DraftRead> {
    return this.#readFile(library.montageFilePath(avatarId, montageId), avatarId, montageId);
  }

  async #readFile(path: string, avatarId: string, montageId: string): Promise<DraftRead> {
    let handle;
    try {
      handle = await openRegularNoFollow(path);
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return { kind: "missing" };
      if (error instanceof UnsafeOpenError) return { kind: "unreadable", reason: "not-a-file" };
      this.#deps.log(`a draft file could not be opened (${kindOf(error)})`);
      return { kind: "unreadable", reason: "io" };
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

  /** Whether a draft file is there for this avatar and id (a damaged one included: something is there). */
  async exists(library: Library, avatarId: string, montageId: string): Promise<boolean> {
    return (await this.read(library, avatarId, montageId)).kind !== "missing";
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
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (error) {
        if (hasErrorCode(error, "ENOENT")) continue;
        skipped++;
        this.#deps.log(`the drafts folder of an avatar could not be listed (${kindOf(error)})`);
        continue;
      }
      const named = entries.filter((entry) => !isTempName(entry.name) && DRAFT_FILE_NAME.test(entry.name)).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      if (named.length > budget) truncated = true;
      const wanted = named.slice(0, budget);
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
    try {
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
