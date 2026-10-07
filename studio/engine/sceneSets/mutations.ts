import type { EngineError, SceneComposeTally, SceneStoppedBy } from "../../shared/engine";
import type { StoredSceneSet } from "../library/sceneSets";

// CS.4a: the changes a write makes to its set's record, as pure functions of the record. The store rewrites the file (the next revision, atomically,
// under the set's lock); these say what changes in it.

/** Records the next write under its job BEFORE its first call. An earlier write's outcome goes with it: this one has none yet. */
export function beginWrite(set: StoredSceneSet, write: { kind: "compose" | "unwritten"; jobId: string }): StoredSceneSet {
  const k = set.writes + 1;
  return { ...set, write: { k, kind: write.kind, jobId: write.jobId }, writes: k };
}

/**
 * An accepted chunk's sentences go into their scenes, as the writer's own (`edited` stays false). A scene the owner has typed text into meanwhile keeps
 * his text (a free edit is refused while the job runs, so this is a guard, not a path), and a scene the set does not have is ignored.
 */
export function withChunkWritten(set: StoredSceneSet, sentences: ReadonlyMap<number, string>): StoredSceneSet {
  return { ...set, scenes: set.scenes.map((s) => (s.text === null && sentences.has(s.sceneId) ? { ...s, text: sentences.get(s.sceneId) ?? null } : s)) };
}

/** A job's verdict against a whole chunk: two rejected answers, or a provider's refusal. No job asks this chunk again. */
export function withChunkGivenUp(set: StoredSceneSet, chunk: number, by: "rejected" | "refused"): StoredSceneSet {
  return { ...set, chunks: set.chunks.map((c) => (c.chunk === chunk ? { ...c, gaveUp: by } : c)) };
}

/** Why the recorded write stopped (never `closed`: a dying process cannot write it). A set with no write recorded stays as it is. */
export function withWriteStopped(set: StoredSceneSet, stop: { stoppedBy: Exclude<SceneStoppedBy, "closed">; error?: EngineError }): StoredSceneSet {
  if (set.write === null) return set;
  const { stoppedBy: _by, stoppedError: _error, ...rest } = set.write;
  return { ...set, write: { ...rest, stoppedBy: stop.stoppedBy, ...(stop.stoppedBy === "failed" && stop.error !== undefined ? { stoppedError: stop.error } : {}) } };
}

/** The write ended with nothing left to resume. */
export function withWriteFinished(set: StoredSceneSet): StoredSceneSet {
  return { ...set, write: null };
}

/** What the write that just ended came to, kept in the set: the owner's later edits do not rewrite what the compose said. */
export function withOutcome(set: StoredSceneSet, outcome: SceneComposeTally): StoredSceneSet {
  return { ...set, lastOutcome: outcome };
}
