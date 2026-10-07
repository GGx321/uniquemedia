import { mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  AttemptId,
  CategoryRef,
  CategorySnapshot,
  EngineError,
  Id,
  isCustomCategory,
  MAX_RUN_CATEGORIES,
  MAX_SCENES_PER_SET,
  MAX_SCENES_PER_WRITE,
  ModelId,
  PoolShot,
  SCENE_CHUNK_SIZE,
  SceneComposeTally,
  SceneId,
  SceneIdeaInput,
  ScenePose,
  SceneStoppedBy,
  SceneText,
} from "../../shared/engine";
import { isPhoneInHandShot, PlanSlotSchema } from "../scenes";
import { fsyncDir, hasErrorCode, readdirTolerant, writeJsonAtomic } from "./durableFs";
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

/** A scene as the planner drew it, with its sentence (null until written) and the owner's marks. */
export const PlannedSceneRecord = z.strictObject({
  sceneId: SceneId,
  origin: z.literal("planned"),
  slot: PlanSlotSchema,
  text: SceneText.nullable(),
  edited: z.boolean(),
  removed: z.boolean(),
});
export type PlannedSceneRecord = z.infer<typeof PlannedSceneRecord>;

/** A selfie or mirror shot always faces the camera: the same rule a plan's slot is held to. */
const facesCamera = (own: { shot: z.infer<typeof PoolShot>; pose: z.infer<typeof ScenePose> }): boolean => !isPhoneInHandShot(own.shot) || own.pose === "front" || own.pose === "three-quarter";
const FACES_CAMERA = { message: "a selfie or mirror shot always faces the camera: pose must be front or three-quarter", path: ["pose"] };

/**
 * An own scene (CS.4b): written by the model from the owner's idea, never placed. It always has its sentence (it enters the set only with an accepted one),
 * its stored idea (what ⟳ writes from again; the idea is the input, never the text) and a shot and a pose. No place, no category, no chunk.
 */
export const OwnSceneRecord = z
  .strictObject({
    sceneId: SceneId,
    origin: z.literal("own"),
    idea: SceneIdeaInput,
    shot: PoolShot,
    pose: ScenePose,
    text: SceneText,
    edited: z.boolean(),
    removed: z.boolean(),
  })
  .refine(facesCamera, FACES_CAMERA);
export type OwnSceneRecord = z.infer<typeof OwnSceneRecord>;

export const SceneRecord = z.discriminatedUnion("origin", [PlannedSceneRecord, OwnSceneRecord]);
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

/** The most review-time writes (rewrite and idea) a set records: each is kept for the money it spent and the ids it burnt, so the file must not grow without end. */
export const MAX_REVIEW_WRITES = 500;
/** A review write's ids: its answered attempts plus two for attempts that got no answer, `${sceneSetId}:write-${k}#n`. */
export const REVIEW_WRITE_IDS = 4;

const ReviewWriteBase = {
  /** The write's number, from the set's own counter: the ids of a write are derived from it and are never reused. */
  k: z.number().int().min(1),
  /** The job that ran it last (a resume has a new one). */
  jobId: Id,
  attemptIds: z.array(AttemptId).min(1).max(REVIEW_WRITE_IDS),
  /** Resolved: accepted, dismissed, or out of attempts. A closed record is kept only for what it spent and the ids it burnt. */
  closed: z.boolean(),
  stoppedBy: StoredStoppedBy.optional(),
  stoppedError: EngineError.optional(),
};

/**
 * A rewrite, recorded before its first call. With `redraw`, `slots` holds the new place, outfit, activity, time and pose of each target scene, drawn once and
 * kept here (a resume sends the same ones); the scene itself changes only when the sentence is accepted, and `snapshots` are the category snapshots that
 * accepted write refreshes.
 */
export const RewriteWriteRecord = z.strictObject({
  ...ReviewWriteBase,
  kind: z.literal("rewrite"),
  sceneIds: z.array(SceneId).min(1).max(MAX_SCENES_PER_WRITE),
  redraw: z.boolean(),
  slots: z.array(PlanSlotSchema).max(MAX_SCENES_PER_WRITE),
  snapshots: z.array(CategorySnapshot).max(MAX_SCENES_PER_WRITE),
});
export type RewriteWriteRecord = z.infer<typeof RewriteWriteRecord>;

/**
 * An idea write, recorded before its first call: the idea, how many scenes and the shot asked for, and for each of the scenes it will add the id it reserved
 * and the shot and pose drawn. The scenes join the set only with the accepted sentences.
 */
export const IdeaWriteRecord = z.strictObject({
  ...ReviewWriteBase,
  kind: z.literal("idea"),
  idea: SceneIdeaInput,
  count: z.number().int().min(1).max(MAX_SCENES_PER_WRITE),
  shot: PoolShot.nullable(),
  scenes: z.array(z.strictObject({ sceneId: SceneId, shot: PoolShot, pose: ScenePose }).refine(facesCamera, FACES_CAMERA)).min(1).max(MAX_SCENES_PER_WRITE),
});
export type IdeaWriteRecord = z.infer<typeof IdeaWriteRecord>;

export const ReviewWriteRecord = z
  .discriminatedUnion("kind", [RewriteWriteRecord, IdeaWriteRecord])
  .refine((w) => (w.stoppedError !== undefined) === (w.stoppedBy === "failed"), { message: "the error belongs to a write that stopped by a failure", path: ["stoppedError"] });
export type ReviewWriteRecord = z.infer<typeof ReviewWriteRecord>;

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
    /**
     * The number of the review write whose accepted redraw last refreshed each snapshot above, by category ref (absent for one never refreshed): a write
     * that began earlier and is resumed later must not roll back the fresher snapshot a later write put there.
     */
    snapshotWrites: z.record(z.string(), z.number().int().min(1)).optional(),
    models: z.strictObject({ text: ModelId }),
    scenes: z.array(SceneRecord).max(MAX_SCENES_PER_SET),
    chunks: z.array(ChunkRecord),
    write: WriteRecord.nullable(),
    /** Every rewrite and idea write of the review (CS.4b), in the order they began; absent in a set that has none. */
    reviewWrites: z.array(ReviewWriteRecord).max(MAX_REVIEW_WRITES).optional(),
    /** The counters of the planned scenes when the last write job ended (a compose or a «Дописать»): what «Готово 35 из 60» says, kept as it was said. Absent until a job ended. */
    lastOutcome: SceneComposeTally.optional(),
    /** How many writes were started: the next write is number `writes + 1`. */
    writes: z.number().int().min(0),
  })
  .superRefine((set, ctx) => {
    const ids = set.scenes.map((s) => s.sceneId);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: "a scene id must not repeat", path: ["scenes"] });
    for (const [i, scene] of set.scenes.entries()) {
      if (scene.origin === "planned" && scene.slot.slotIndex !== scene.sceneId) ctx.addIssue({ code: "custom", message: "a planned scene's slot is numbered like the scene", path: ["scenes", i] });
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
    const plannedCategories = set.scenes.flatMap((s) => (s.origin === "planned" ? [s.slot.category] : []));
    const used = new Set([...set.request.categories, ...plannedCategories].filter(isCustomCategory));
    for (const ref of used) {
      if (!snapshotRefs.includes(ref)) ctx.addIssue({ code: "custom", message: `the set names custom category ${ref} without a snapshot of it`, path: ["categories"] });
    }
    if (set.write !== null && set.write.k > set.writes) ctx.addIssue({ code: "custom", message: "the recorded write is one of the writes started", path: ["write"] });
    checkReviewWrites(set, snapshotRefs, ctx);
  });

/** What the records of the review writes must be, as a whole, for the engine to rely on them without looking again. */
function checkReviewWrites(
  set: { sceneSetId: string; writes: number; write: WriteRecord | null; scenes: readonly SceneRecord[]; reviewWrites?: readonly ReviewWriteRecord[] | undefined },
  snapshotRefs: readonly string[],
  ctx: z.RefinementCtx,
): void {
  const records = set.reviewWrites ?? [];
  const bad = (message: string, index: number): void => ctx.addIssue({ code: "custom", message, path: ["reviewWrites", index] });
  const byId = new Map(set.scenes.map((s) => [s.sceneId, s]));
  const numbers = new Set<number>(set.write === null ? [] : [set.write.k]);
  const reserved = new Set<number>();
  for (const [i, record] of records.entries()) {
    if (record.k > set.writes) bad("a recorded write is one of the writes started", i);
    if (numbers.has(record.k)) bad("a write number belongs to one write", i);
    numbers.add(record.k);
    const wanted = new Set(Array.from({ length: REVIEW_WRITE_IDS }, (_, n) => `${set.sceneSetId}:write-${record.k}#${n + 1}`));
    if (new Set(record.attemptIds).size !== record.attemptIds.length || record.attemptIds.some((id) => !wanted.has(id))) {
      bad("a write's attempt ids are its own, `${sceneSetId}:write-${k}#n`, and never repeat", i);
    }
    if (record.kind === "rewrite") {
      if (new Set(record.sceneIds).size !== record.sceneIds.length || record.sceneIds.some((id) => !byId.has(id))) bad("a rewrite names scenes of the set, each once", i);
      if (record.redraw) {
        const fits = record.slots.length === record.sceneIds.length && record.slots.every((slot, n) => slot.slotIndex === record.sceneIds[n]);
        if (!fits) bad("a redraw holds one new slot for each scene it rewrites, in order, numbered like the scene", i);
        const planned = record.sceneIds.every((id) => byId.get(id)?.origin === "planned");
        if (!planned) bad("only a planned scene has a place to redraw", i);
        else if (!record.slots.every((slot, n) => (byId.get(record.sceneIds[n] ?? -1) as PlannedSceneRecord | undefined)?.slot.category === slot.category)) bad("a redraw keeps the scene's category", i);
      } else if (record.slots.length > 0) bad("a rewrite without a redraw holds no new slot", i);
      const refs = record.snapshots.map((s) => s.ref);
      if (new Set(refs).size !== refs.length || refs.some((ref) => !snapshotRefs.includes(ref))) bad("a redraw refreshes snapshots of categories the set already has, each once", i);
    } else {
      const ids = record.scenes.map((s) => s.sceneId);
      if (ids.length !== record.count || new Set(ids).size !== ids.length) bad("an idea write reserves one scene id for each scene it adds", i);
      for (const id of ids) {
        if (reserved.has(id)) bad("two idea writes never reserve the same scene id", i);
        reserved.add(id);
        if (!record.closed && byId.has(id)) bad("an unresolved idea write's ids are not the ids of scenes the set already has", i);
      }
    }
  }
}
export type StoredSceneSet = z.infer<typeof SceneSetFile>;

/** What a new set is made of; the store stamps the schema version, the revision (1) and the times. */
export type NewSceneSet = Omit<StoredSceneSet, "schemaVersion" | "revision" | "createdAt" | "updatedAt"> & { createdAt?: string };

/** A set known to hold planned scenes only, as a compose makes it and the planner-side code reads it: its scenes all have a slot. */
export type PlannedNewSceneSet = Omit<NewSceneSet, "scenes"> & { scenes: PlannedSceneRecord[] };
export type PlannedSceneSet = Omit<StoredSceneSet, "scenes"> & { scenes: PlannedSceneRecord[] };

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
      // Any other refusal of the OS (no permission, a folder in the file's place, a cloud placeholder that cannot be fetched) makes THIS record
      // unreadable: counted and kept, never thrown at the siblings.
      return { ok: false, reason: "unreadable" };
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
      if ((await this.#read(path, input.sceneSetId, input.avatarId)).ok || ((await this.#names(input.avatarId)) ?? []).includes(`${input.sceneSetId}.json`)) {
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

  /** The names in the avatar's scenes/, or null when the folder cannot be listed at all (no permission, a file in its place). */
  async #names(avatarId: string): Promise<string[] | null> {
    return readdirTolerant(this.dirOf(avatarId));
  }

  /** The avatar's readable sets, oldest first (equal times by id), and how many files could not be read (they stay where they are). */
  async list(avatarId: string): Promise<{ sets: StoredSceneSet[]; unreadable: number }> {
    const sets: StoredSceneSet[] = [];
    let unreadable = 0;
    const names = await this.#names(avatarId);
    // A folder that cannot be listed is one unreadable record: the library opens, the set screen says so, nothing throws.
    if (names === null) return { sets, unreadable: 1 };
    for (const name of names) {
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
