import type { SceneGaveUpBy } from "../../shared/engine";
import type { ChunkRecord, StoredSceneSet } from "../library/sceneSets";
import { WRITER_CALL } from "../money/estimate";
import { attemptPaid, type LedgerView } from "../runs/journal";
import { setLocal } from "./local";

// CS.4a: what a writer chunk of a scene set may still do. The set file holds the chunk's attempt ids (issued with the set, before any call); the
// LEDGER says what became of them, so a chunk's attempts are counted across every job and every restart, never per job:
//
//   answered     = ids the ledger holds as paid (`attemptPaid`: a settled cost, an open reserve and a reconcile's estimated settle all count;
//                  a free settle of a final 429/5xx and a release do not)
//   unused       = ids the ledger holds no reserve for (an id that was reserved is never sent again)
//   attemptsLeft = min(2 − answered, unused), and 0 for a chunk a job gave up on
//
// THE ATTEMPT INVARIANT: answered attempts per chunk are at most WRITER_CALL.maxAttempts, whatever the jobs and crashes in between: an interruption
// never grants a fresh pair.

export interface ChunkState {
  chunk: number;
  sceneIds: number[];
  attemptIds: string[];
  answered: number;
  unused: number;
  attemptsLeft: number;
  /** Why the chunk is given up for good (its scenes read «не составлена»): what a job decided, or `no-attempts` when none is left and a scene still lacks its sentence. */
  gaveUpBy: SceneGaveUpBy | null;
}

/** The ledger's side of the chunk's attempts, as it stands now. With no ledger to read the chunk looks untouched (every paid command refuses without one anyway). */
export function chunkState(set: StoredSceneSet, chunk: ChunkRecord, ledger: LedgerView | null): ChunkState {
  const answered = ledger === null ? 0 : chunk.attemptIds.filter((attemptId) => attemptPaid(ledger, attemptId)).length;
  const unused = ledger === null ? chunk.attemptIds.length : chunk.attemptIds.filter((attemptId) => ledger.reserveOf(attemptId) === undefined).length;
  const attemptsLeft = chunk.gaveUp === undefined ? Math.max(0, Math.min(WRITER_CALL.maxAttempts - answered, unused)) : 0;
  const lacksText = set.scenes.some((s) => chunk.sceneIds.includes(s.sceneId) && s.text === null);
  const gaveUpBy: SceneGaveUpBy | null = chunk.gaveUp ?? (attemptsLeft === 0 && lacksText ? "no-attempts" : null);
  return { chunk: chunk.chunk, sceneIds: [...chunk.sceneIds], attemptIds: [...chunk.attemptIds], answered, unused, attemptsLeft, gaveUpBy };
}

/** The scenes a request for this chunk covers: those of the chunk that are not removed and still have no sentence (a typed text is a written scene). */
export function requestSceneIds(set: StoredSceneSet, chunk: ChunkRecord): number[] {
  const wanted = new Set(chunk.sceneIds);
  return set.scenes.filter((s) => wanted.has(s.sceneId) && !s.removed && s.text === null).map((s) => s.sceneId);
}

export interface PendingChunk {
  chunk: ChunkRecord;
  state: ChunkState;
  /** The scenes its request covers, in scene order. */
  sceneIds: number[];
  /** 5a.2: the code template writes every scene of the request, so the chunk is written with no request and costs nothing. */
  free: boolean;
  /** 5a.2 (S5.6c2): how many of the request's scenes the template cannot write, so the model must: what the chunk's request carries and what its estimate prices. 0 exactly when `free`. */
  modelScenes: number;
}

/**
 * The chunks a «Дописать» sends, in order: those with a scene to write and attempts left, and no verdict of a job against them. A chunk out of
 * attempts or given up is skipped, not a reason to stop: the set's job goes on with the next one (a run's own writer phase stops at the first,
 * unchanged). 5a.2: a chunk whose every scene the code template can now write is offered again whatever its attempts and verdict (`free`: it needs
 * no request); only a chunk that holds a scene the template cannot write is a chunk for money.
 */
export function pendingChunks(set: StoredSceneSet, ledger: LedgerView | null): PendingChunk[] {
  const pending: PendingChunk[] = [];
  let local: ReturnType<typeof setLocal> | null = null;
  for (const chunk of set.chunks) {
    const state = chunkState(set, chunk, ledger);
    const sceneIds = requestSceneIds(set, chunk);
    if (sceneIds.length === 0) continue;
    local ??= setLocal(set);
    const modelScenes = sceneIds.filter((sceneId) => {
      const scene = set.scenes.find((s) => s.sceneId === sceneId);
      return !(scene?.origin === "planned" && local?.(scene.slot) != null);
    }).length;
    const free = modelScenes === 0;
    if (free || state.attemptsLeft > 0) pending.push({ chunk, state, sceneIds, free, modelScenes });
  }
  return pending;
}
