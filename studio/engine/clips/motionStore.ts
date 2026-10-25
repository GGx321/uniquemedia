import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CLIP_CHOICES_MAX, MOTION_ID_MAX, MOTION_STORE_MAX_ITEMS } from "../../shared/engine";
import { fsyncDir, makeFolder, readFolderNames, readRecordFile, writeJsonAtomic } from "../library/durableFs";
import { isLibraryId } from "../library/ids";
import { MOTIONS_DIR, MOTION_STORE_SCHEMA_VERSION, isFromNewerVersion } from "../library/layout";
import { MotionStoreFile } from "./schemas";

// Stage 5, 5b.2, S5.WC3 (plan s5b2 §5.3 «The store», I5.67; review round 2 L2): the photo's motion store, `avatars/<id>/motions/<photoId>.json`. It holds the vision writer's suggestions and the owner's own
// ideas as CHECKED English texts and labels, never the owner's full words, and the last frame reading. Up to twelve items, the oldest trimmed first (FIFO); an id (`v-<n>`, `o-<n>`) is issued from the
// store's `next` counter and never reused while the store lives, and a photo whose sha256 changed starts a new store (the counters too).

export type MotionItem = MotionStoreFile["items"][number];
type Source = MotionItem["source"];

/** What a call brings to the store: the checked text, its label, the model that wrote it, the time. The store issues the id. */
export interface MotionDraft {
  readonly label: string;
  readonly text: string;
  readonly model: string;
  readonly at: string;
}

/** The temp sibling the shared atomic write makes of `<photoId>.json` (`tempSiblingPath`): `.<photoId>.json.<hex>.tmp`. */
const TEMP_NAME = /^\.(.+)\.json\.[0-9a-f]+\.tmp$/;

const PREFIX: Readonly<Record<Source, "v" | "o">> = { vision: "v", own: "o" };

export function emptyStore(photoId: string, photoSha256: string): MotionStoreFile {
  return { schemaVersion: MOTION_STORE_SCHEMA_VERSION, photoId, photoSha256, next: { vision: 1, own: 1 }, items: [] };
}

/** Whether the source issued its last id: the next call on this photo is refused free (`motions-full`). */
export function isFull(file: MotionStoreFile, source: Source): boolean {
  return file.next[source] > MOTION_ID_MAX;
}

/**
 * The drafts as new items, ids issued in order from the source's counter, appended; the oldest items past twelve go. A source with fewer ids left than drafts keeps the first ones: an id is never reused.
 * The `reading` stays as it is.
 */
export function addItems(file: MotionStoreFile, source: Source, drafts: readonly MotionDraft[]): { file: MotionStoreFile; items: MotionItem[] } {
  let next = file.next[source];
  const items: MotionItem[] = [];
  for (const draft of drafts) {
    if (next > MOTION_ID_MAX) break;
    items.push({ id: `${PREFIX[source]}-${next}`, source, label: draft.label, text: draft.text, model: draft.model, at: draft.at });
    next += 1;
  }
  const all = [...file.items, ...items];
  return { file: { ...file, next: { ...file.next, [source]: next }, items: all.slice(Math.max(0, all.length - MOTION_STORE_MAX_ITEMS)) }, items };
}

/**
 * What `clips.options` lists (plan s5b2 §5.3, r2.1 L2): the newest three suggestions and the newest two own ideas that PASS the check made now (an older one takes the place of one that no longer passes),
 * each source in the order it was made. Older items stay in the store until FIFO trims them.
 */
export function listedItems(file: MotionStoreFile, passes: (item: MotionItem) => boolean): MotionItem[] {
  const newest = (source: Source): MotionItem[] => {
    const kept: MotionItem[] = [];
    for (const item of [...file.items].reverse()) {
      if (item.source !== source || !passes(item)) continue;
      kept.push(item);
      if (kept.length === CLIP_CHOICES_MAX[source]) break;
    }
    return kept.reverse();
  };
  return [...newest("vision"), ...newest("own")];
}

export interface MotionStoreRead {
  readonly file: MotionStoreFile;
  /** False for a store written by a newer build or one that does not read: it reads as empty and is never written over. */
  readonly writable: boolean;
  /** Why it is not writable. */
  readonly why?: "newer-build" | "does-not-read";
}

/** The stores on disk: reads, and serialised read-modify-writes (a suggestion and an idea of one photo may finish together). */
export class MotionStores {
  readonly #log: (line: string) => void;
  readonly #tails = new Map<string, Promise<unknown>>();

  /** A test seam: awaited by the atomic write just before its rename; what it throws is what the write threw (Windows refusing a rename). */
  readonly #beforeRename: ((path: string) => void | Promise<void>) | undefined;

  constructor(log: (line: string) => void, options: { beforeRename?: (path: string) => void | Promise<void> } = {}) {
    this.#log = log;
    this.#beforeRename = options.beforeRename;
  }

  static path(avatarDir: string, photoId: string): string {
    return join(avatarDir, MOTIONS_DIR, `${photoId}.json`);
  }

  /**
   * The store as it is on disk for this photo file: empty when it is missing or written for another sha256 (a new photo starts new counters). One from a newer build, or one that does not read (not JSON, breaks
   * the schema, is another photo's), reads as empty too but is NOT writable and is left as it is (S5.FU-DATA 5): starting it again would reset `next`, and an id would be issued twice. A disk that cannot be read rejects.
   */
  async read(avatarDir: string, photoId: string, sha: string): Promise<MotionStoreRead> {
    const path = MotionStores.path(avatarDir, photoId);
    const read = await readRecordFile(path);
    if (!read.ok) {
      if (read.reason === "io") throw read.error;
      if (read.reason === "invalid") return this.#unreadable(photoId, sha);
      return { file: emptyStore(photoId, sha), writable: true };
    }
    if (isFromNewerVersion(read.value,MOTION_STORE_SCHEMA_VERSION)) {
      this.#log(`[clip] the motion store of photo ${photoId} is from a newer build; it is left as it is`);
      return { file: emptyStore(photoId, sha), writable: false, why: "newer-build" };
    }
    const parsed = MotionStoreFile.safeParse(read.value);
    if (!parsed.success || parsed.data.photoId !== photoId) return this.#unreadable(photoId, sha);
    return { file: parsed.data.photoSha256 === sha ? parsed.data : emptyStore(photoId, sha), writable: true };
  }

  #unreadable(photoId: string, sha: string): MotionStoreRead {
    this.#log(`[clip] the motion store of photo ${photoId} does not read; it is left as it is`);
    return { file: emptyStore(photoId, sha), writable: false, why: "does-not-read" };
  }

  /** Runs `work` after every earlier piece of work on this photo's file; a rejection is the caller's, and never stops the next piece. */
  #serial<T>(path: string, work: () => Promise<T>): Promise<T> {
    const queued = (this.#tails.get(path) ?? Promise.resolve()).then(work, work);
    const tail = queued.catch(() => undefined);
    this.#tails.set(path, tail);
    void tail.then(() => {
      if (this.#tails.get(path) === tail) this.#tails.delete(path);
    });
    return queued;
  }

  /** The temp files of one photo's store, removed. Called only while no write of that photo runs. */
  async #removeTemps(avatarDir: string, photoId: string): Promise<void> {
    const dir = join(avatarDir, MOTIONS_DIR);
    const listed = await readFolderNames(dir);
    if (!listed.ok) return;
    for (const name of listed.names) if (TEMP_NAME.exec(name)?.[1] === photoId) await rm(join(dir, name), { force: true });
  }

  /**
   * Removes the temp files a write left in the avatar's `motions/` (a quit or a crash in the middle of one; they hold the owner's labels): each photo's after every earlier write of that photo, so a write in
   * flight never loses its own. Never rejects: what cannot be removed now is the next sweep's (S5.FU-DATA 7, as `BatchSummaryStore.sweepTemps`).
   */
  async sweepTemps(avatarDir: string): Promise<void> {
    const listed = await readFolderNames(join(avatarDir, MOTIONS_DIR));
    if (!listed.ok) return;
    const photoIds = new Set(listed.names.flatMap((name) => TEMP_NAME.exec(name)?.[1] ?? []).filter((id) => isLibraryId(id)));
    for (const photoId of photoIds) await this.#serial(MotionStores.path(avatarDir, photoId), () => this.#removeTemps(avatarDir, photoId)).catch(() => undefined);
  }

  /** Reads, applies `change`, checks the result under the strict schema and writes it atomically (a `null` from `change` writes nothing); one at a time per photo. Rejects for a store that is not writable (a newer build's, or one that does not read; nothing is written). */
  update(avatarDir: string, photoId: string, sha: string, change: (file: MotionStoreFile) => MotionStoreFile | null): Promise<MotionStoreFile> {
    const path = MotionStores.path(avatarDir, photoId);
    return this.#serial(path, async (): Promise<MotionStoreFile> => {
      const current = await this.read(avatarDir, photoId, sha);
      if (!current.writable) throw new Error(`the motion store of photo ${photoId} ${current.why === "does-not-read" ? "does not read" : "is from a newer build"} and is left as it is`);
      const changed = change(current.file);
      // `null`: nothing to write (a suggestion that added nothing must not even replace the reading); the file stays as it is on disk.
      if (changed === null) return current.file;
      const next = MotionStoreFile.parse(changed);
      const folder = dirname(path);
      // Only the `motions/` level, inside an avatar folder that is there (S5.FU-DATA 4): an avatar that was deleted meanwhile is never made again, the write fails. A folder made now is flushed into its parent.
      if (await makeFolder(folder)) await fsyncDir(dirname(folder));
      try {
        await writeJsonAtomic(path, next, this.#beforeRename === undefined ? {} : { beforeRename: this.#beforeRename });
      } catch (error) {
        // A write that failed for good (a rename Windows keeps refusing) leaves no temp file behind (S5.FU-DATA 7): it holds the owner's labels.
        await this.#removeTemps(avatarDir, photoId).catch(() => undefined);
        throw error;
      }
      return next;
    });
  }
}
