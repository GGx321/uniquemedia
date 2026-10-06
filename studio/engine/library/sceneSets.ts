import { mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { AttemptId, CategoryRef, CategorySnapshot, EngineError, Id, isCustomCategory, MAX_RUN_CATEGORIES, MAX_SCENES_PER_SET, ModelId, SCENE_CHUNK_SIZE, SceneId, SceneStoppedBy, SceneText } from "../../shared/engine";
import { PlanSlotSchema } from "../scenes";
import { fsyncDir, hasErrorCode, writeJsonAtomic } from "./durableFs";
import { isLibraryId } from "./ids";
import { AVATARS_DIR, isFromNewerVersion, SCENE_SET_FILE_SCHEMA_VERSION, SCENES_DIR } from "./layout";
import { runExclusive } from "./keyedMutex";
import { unlinkWithRetry } from "./unlinkRetry";

// CS.4a: the scene sets on disk — `avatars/<avatarId>/scenes/<sceneSetId>.json`, one atomically rewritten record per set. A set is the planner's
// scenes of one avatar, the sentence the scene writer wrote for each and the owner's free edits, held before any image is paid for. Every change is
// a read-modify-write under the set's own lock with the `revision` the change was made on, so two edits can never lose one another.

export type SceneSetErrorCode = "not-found" | "stale" | "exists" | "invalid";

export class SceneSetError extends Error {
  readonly code: SceneSetErrorCode;
  constructor(code: SceneSetErrorCode, message: string) {
    super(message);
    this.name = "SceneSetError";
    this.code = code;
  }
}

/** What the file keeps of a stopped write: why, never `closed` (a dying process cannot write it). */
const StoredStoppedBy = SceneStoppedBy.exclude(["closed"]);

/** A scene as the planner drew it, with its sentence (null until written) and the owner's marks. Own scenes (CS.4b) join this union. */
export const SceneRecord = z.strictObject({
  sceneId: SceneId,
  origin: z.literal("planned"),
  slot: PlanSlotSchema,
  text: SceneText.nullable(),
  edited: z.boolean(),
  removed: z.boolean(),
});
export type SceneRecord = z.infer<typeof SceneRecord>;

/**
 * One request's worth of scenes, with the attempt ids it may ever use: `${sceneSetId}:writer-${chunk}#N`, issued when the set is made and written
 * BEFORE the first call. `gaveUp` is only what a job decided about the whole chunk (two rejected answers, or a provider's refusal); that its attempts
 * ran out is read from the ledger.
 */
export const ChunkRecord = z.strictObject({
  chunk: z.number().int().min(1),
  sceneIds: z.array(SceneId).min(1).max(SCENE_CHUNK_SIZE),
  attemptIds: z.array(AttemptId).min(1).max(4),
  gaveUp: z.enum(["rejected", "refused"]).optional(),
});
export type ChunkRecord = z.infer<typeof ChunkRecord>;

/** The write recorded before its first call: its number, its kind, its job, and — once it stopped — why. No outcome and no live job reads `closed`. */
export const WriteRecord = z
  .strictObject({
    k: z.number().int().min(1),
    kind: z.enum(["compose", "unwritten"]),
    jobId: Id,
    stoppedBy: StoredStoppedBy.optional(),
    stoppedError: EngineError.optional(),
  })
  .refine((w) => (w.stoppedError !== undefined) === (w.stoppedBy === "failed"), { message: "the error belongs to a write that stopped by a failure", path: ["stoppedError"] });
export type WriteRecord = z.infer<typeof WriteRecord>;

export const SceneSetFile = z
  .strictObject({
    schemaVersion: z.literal(SCENE_SET_FILE_SCHEMA_VERSION),
    sceneSetId: Id,
    avatarId: Id,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    /** Grows by one on every write of the file. */
    revision: z.number().int().min(1),
    /** Issued at compose, never changed: the set is used exactly when `runs/<runId>/` exists. */
    runId: Id,
    request: z.strictObject({
      count: z.number().int().min(0),
      categories: z.array(CategoryRef).max(MAX_RUN_CATEGORIES),
      poses: z.strictObject({ profile: z.boolean(), back: z.boolean() }),
    }),
    /** A snapshot of every custom category the set uses, so a later rename, regeneration or delete changes nothing in it. */
    categories: z.array(CategorySnapshot).optional(),
    models: z.strictObject({ text: ModelId }),
    scenes: z.array(SceneRecord).max(MAX_SCENES_PER_SET),
    chunks: z.array(ChunkRecord),
    write: WriteRecord.nullable(),
    /** How many writes were started: the next write is number `writes + 1`. */
    writes: z.number().int().min(0),
  })
  .superRefine((set, ctx) => {
    const ids = set.scenes.map((s) => s.sceneId);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: "a scene id must not repeat", path: ["scenes"] });
    for (const [i, scene] of set.scenes.entries()) {
      if (scene.slot.slotIndex !== scene.sceneId) ctx.addIssue({ code: "custom", message: "a planned scene's slot is numbered like the scene", path: ["scenes", i] });
    }
    const inChunk = set.chunks.flatMap((c) => c.sceneIds);
    if (new Set(inChunk).size !== inChunk.length || inChunk.some((id) => !ids.includes(id))) {
      ctx.addIssue({ code: "custom", message: "every chunk names scenes of the set, and a scene is in one chunk at most", path: ["chunks"] });
    }
    const chunkIds = set.chunks.map((c) => c.chunk);
    if (new Set(chunkIds).size !== chunkIds.length) ctx.addIssue({ code: "custom", message: "a chunk number must not repeat", path: ["chunks"] });
    const attempts = set.chunks.flatMap((c) => c.attemptIds);
    if (new Set(attempts).size !== attempts.length || attempts.some((id) => !id.startsWith(`${set.sceneSetId}:`))) {
      ctx.addIssue({ code: "custom", message: "an attempt id is the set's own and never repeats", path: ["chunks"] });
    }
    const snapshotRefs = (set.categories ?? []).map((c) => c.ref);
    if (new Set(snapshotRefs).size !== snapshotRefs.length) ctx.addIssue({ code: "custom", message: "a custom category must have one snapshot entry at most", path: ["categories"] });
    const used = new Set([...set.request.categories, ...set.scenes.map((s) => s.slot.category)].filter(isCustomCategory));
    for (const ref of used) {
      if (!snapshotRefs.includes(ref)) ctx.addIssue({ code: "custom", message: `the set names custom category ${ref} without a snapshot of it`, path: ["categories"] });
    }
    if (set.write !== null && set.write.k > set.writes) ctx.addIssue({ code: "custom", message: "the recorded write is one of the writes started", path: ["write"] });
  });
export type StoredSceneSet = z.infer<typeof SceneSetFile>;

/** What a new set is made of; the store stamps the schema version, the revision (1) and the times. */
export type NewSceneSet = Omit<StoredSceneSet, "schemaVersion" | "revision" | "createdAt" | "updatedAt"> & { createdAt?: string };

export interface SceneSetStoreDeps {
  now?: () => Date;
  /** Test seam: called after each temp file is durable and before it is renamed into place. Throwing simulates a crash there. */
  beforeRename?: ((finalPath: string) => void | Promise<void>) | undefined;
  /** Test seam: called after each record is renamed into place and before the folder is flushed. */
  afterRename?: ((finalPath: string) => void | Promise<void>) | undefined;
  /** Test seam: called before a record is unlinked. Throwing simulates a disk that refuses the delete. */
  beforeUnlink?: ((path: string) => void | Promise<void>) | undefined;
}

const RECORD_NAME = /^([a-z0-9-]{8,64})\.json$/;

/** The set's own lock: every change of its file, from the store or from a caller that must act between a read and a write (an approval), runs under it. */
export function withSceneSetLock<T>(sceneSetId: string, work: () => Promise<T>): Promise<T> {
  return runExclusive(`scenes:${sceneSetId}`, work);
}

/** A check the caller makes on the record under the set's lock, before it changes or removes it; it refuses by throwing. */
export type SceneSetGuard = (current: StoredSceneSet) => void | Promise<void>;

/** A record as read: the set, or why not. A newer Studio's record, a damaged one and one in another set's file are all `unreadable` and are never touched. */
type Read = { ok: true; set: StoredSceneSet } | { ok: false; reason: "missing" | "unreadable" };

export class SceneSetStore {
  readonly #now: () => Date;

  constructor(
    readonly root: string,
    private readonly deps: SceneSetStoreDeps = {},
  ) {
    this.#now = deps.now ?? (() => new Date());
  }

  /** `<root>/avatars/<avatarId>/scenes`; the id becomes a path segment, so it is validated. */
  dirOf(avatarId: string): string {
    if (!isLibraryId(avatarId)) throw new SceneSetError("invalid", `avatar id ${JSON.stringify(avatarId)} breaks the id pattern`);
    return join(this.root, AVATARS_DIR, avatarId, SCENES_DIR);
  }

  #path(avatarId: string, sceneSetId: string): string {
    if (!isLibraryId(sceneSetId)) throw new SceneSetError("invalid", `scene set id ${JSON.stringify(sceneSetId)} breaks the id pattern`);
    return join(this.dirOf(avatarId), `${sceneSetId}.json`);
  }

  async #write(path: string, value: StoredSceneSet): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeJsonAtomic(path, value, {
      ...(this.deps.beforeRename === undefined ? {} : { beforeRename: this.deps.beforeRename }),
      ...(this.deps.afterRename === undefined ? {} : { afterRename: this.deps.afterRename }),
    });
  }

  async #read(path: string, sceneSetId: string, avatarId: string): Promise<Read> {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) return { ok: false, reason: "missing" };
      throw error;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return { ok: false, reason: "unreadable" };
    }
    if (isFromNewerVersion(raw, SCENE_SET_FILE_SCHEMA_VERSION)) return { ok: false, reason: "unreadable" };
    const parsed = SceneSetFile.safeParse(raw);
    if (!parsed.success || parsed.data.sceneSetId !== sceneSetId || parsed.data.avatarId !== avatarId) return { ok: false, reason: "unreadable" };
    return { ok: true, set: parsed.data };
  }

  /** The stamp of a new write: never earlier than the record's own, even when the clock is. */
  #nextStamp(previous: string): string {
    const now = this.#now().toISOString();
    return now > previous ? now : previous;
  }

  /**
   * Creates a set at revision 1. `exists` for an id already used (the record is left as it is), `invalid` for what the schema refuses (nothing is
   * written, not even the folder).
   */
  async create(input: NewSceneSet): Promise<StoredSceneSet> {
    const path = this.#path(input.avatarId, input.sceneSetId);
    const stamp = input.createdAt ?? this.#now().toISOString();
    const { createdAt: _createdAt, ...rest } = input;
    const parsed = SceneSetFile.safeParse({ schemaVersion: SCENE_SET_FILE_SCHEMA_VERSION, ...rest, revision: 1, createdAt: stamp, updatedAt: stamp });
    if (!parsed.success) throw new SceneSetError("invalid", `the scene set does not fit its schema: ${parsed.error.message}`);
    return withSceneSetLock(input.sceneSetId, async () => {
      if ((await this.#read(path, input.sceneSetId, input.avatarId)).ok || (await this.#names(input.avatarId)).includes(`${input.sceneSetId}.json`)) {
        throw new SceneSetError("exists", `scene set ${input.sceneSetId} already exists`);
      }
      await this.#write(path, parsed.data);
      return parsed.data;
    });
  }

  /** One set; null when there is no such record or it cannot be read (a newer Studio's included). */
  async get(avatarId: string, sceneSetId: string): Promise<StoredSceneSet | null> {
    const read = await this.#read(this.#path(avatarId, sceneSetId), sceneSetId, avatarId);
    return read.ok ? read.set : null;
  }

  async #names(avatarId: string): Promise<string[]> {
    try {
      return await readdir(this.dirOf(avatarId));
    } catch (error) {
      if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) return [];
      throw error;
    }
  }

  /** The avatar's readable sets, oldest first (equal times by id), and how many files could not be read (they stay where they are). */
  async list(avatarId: string): Promise<{ sets: StoredSceneSet[]; unreadable: number }> {
    const sets: StoredSceneSet[] = [];
    let unreadable = 0;
    for (const name of await this.#names(avatarId)) {
      const match = RECORD_NAME.exec(name);
      if (match === null) continue;
      const read = await this.#read(join(this.dirOf(avatarId), name), match[1] ?? "", avatarId);
      if (read.ok) sets.push(read.set);
      else if (read.reason === "unreadable") unreadable += 1;
    }
    sets.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.sceneSetId < b.sceneSetId ? -1 : a.sceneSetId > b.sceneSetId ? 1 : 0));
    return { sets, unreadable };
  }

  /**
   * Changes a set under its lock. `mutate` gets the current record and answers the new one, or null for «nothing changes» (nothing is written, the
   * revision stays). With `expectedRevision`, a record that has moved on is refused (`stale`) before `mutate` runs. The store stamps the revision
   * (the next) and the update time; the set's id, avatar, run id and creation time cannot change, and the result must fit the schema (`invalid`,
   * nothing written). `not-found` for a set that is not there or cannot be read.
   */
  async update(avatarId: string, sceneSetId: string, mutate: (current: StoredSceneSet) => StoredSceneSet | null, opts: { expectedRevision?: number; guard?: SceneSetGuard } = {}): Promise<StoredSceneSet> {
    const path = this.#path(avatarId, sceneSetId);
    return withSceneSetLock(sceneSetId, async () => {
      const read = await this.#read(path, sceneSetId, avatarId);
      if (!read.ok) throw new SceneSetError("not-found", `no readable scene set ${sceneSetId}`);
      const current = read.set;
      // The caller's own check, under the lock and before the revision is compared (a set that is used is refused whatever revision the window shows).
      await opts.guard?.(current);
      if (opts.expectedRevision !== undefined && opts.expectedRevision !== current.revision) {
        throw new SceneSetError("stale", `scene set ${sceneSetId} is at revision ${current.revision}, not ${opts.expectedRevision}`);
      }
      const changed = mutate(current);
      if (changed === null) return current;
      const next = { ...changed, schemaVersion: SCENE_SET_FILE_SCHEMA_VERSION, revision: current.revision + 1, updatedAt: this.#nextStamp(current.updatedAt) };
      if (changed.sceneSetId !== current.sceneSetId || changed.avatarId !== current.avatarId || changed.runId !== current.runId || changed.createdAt !== current.createdAt) {
        throw new SceneSetError("invalid", "a set's id, avatar, run id and creation time never change");
      }
      const parsed = SceneSetFile.safeParse(next);
      if (!parsed.success) throw new SceneSetError("invalid", `the changed scene set does not fit its schema: ${parsed.error.message}`);
      await this.#write(path, parsed.data);
      return parsed.data;
    });
  }

  /** Deletes a set's record and flushes the folder; `not-found` when it is not there or cannot be read (a newer Studio's record is never removed). */
  async remove(avatarId: string, sceneSetId: string, opts: { guard?: SceneSetGuard } = {}): Promise<void> {
    const path = this.#path(avatarId, sceneSetId);
    await withSceneSetLock(sceneSetId, async () => {
      const read = await this.#read(path, sceneSetId, avatarId);
      if (!read.ok) throw new SceneSetError("not-found", `no readable scene set ${sceneSetId}`);
      await opts.guard?.(read.set);
      await this.deps.beforeUnlink?.(path);
      await unlinkWithRetry(path);
      await fsyncDir(dirname(path)).catch(() => undefined);
    });
  }
}
