import type { EngineError, SceneStoppedBy } from "../../shared/engine";
import type { StoredSceneSet } from "../library/sceneSets";
import type { Budget } from "../money/budget";
import type { Scope } from "../money/ledger";
import type { PriceBook } from "../money/prices";
import { runWriterConfig } from "../runs/plan";
import { runWriterPhase, type WriterPhase, type WriterPhaseDeps } from "../runs/writerPhase";
import { chunkState, pendingChunks } from "./chunks";

// CS.4a: the scene set's writer job (a compose and a «Дописать» are the same job). It drives the run's own writer phase (`runWriterPhase`, the writer's
// prompt, answer rules, re-ask feedback and call shape, unchanged) ONE PENDING CHUNK AT A TIME:
//
//  - an accepted chunk is written into the set (its sentences into their scenes) before the next chunk is asked, so a stop loses no paid chunk;
//  - a chunk that cannot be written (two rejected answers, or a provider's refusal) is given up on and the job GOES ON with the next one. A run's own
//    phase stops at its first unwritable chunk, and stays so; a set must not let one bad chunk block the others forever;
//  - an attempt that got no answer (a final 429, a 5xx, the network, a timeout) stops the job, resumable: the set keeps its ids, and the ledger what became
//    of them;
//  - a chunk is asked only for the scenes still without text that are not removed, from its first id the ledger holds no reserve for, with the answered
//    attempts it has left across ALL jobs (`chunkState`): never a fresh pair after an interruption, never a reserved id twice.

export interface SceneWriteDeps {
  /** The OpenRouter client's chat: reserve on disk, send, settle. */
  chat: WriterPhaseDeps["chat"];
  budget: Budget;
  /** The prices the job was accepted at; each attempt's reserve is its worst case at these prices. */
  priceBook: PriceBook;
  /** A network slot for one call; rejects when the signal aborts first. */
  acquire: WriterPhaseDeps["acquire"];
  /** The set as it is now. */
  load: () => Promise<StoredSceneSet>;
  /** Writes an accepted chunk's sentences into the set (under its lock); awaited before the next chunk is asked. */
  saveChunk: (chunk: number, sentences: ReadonlyMap<number, string>) => Promise<void>;
  /** Records a job's verdict against a whole chunk; no job asks it again. */
  giveUp: (chunk: number, by: "rejected" | "refused") => Promise<void>;
  /** The scenes this job has written so far. */
  progress: (done: number) => void;
}

export interface SceneWriteRequest {
  jobId: string;
  /** The job's cap scope; the Budget holds its cap (the accepted worst case). */
  scope: Scope;
  signal: AbortSignal;
  /**
   * S4.5b, the soft stop: once it fires no new chunk and no new attempt is asked; the request already out finishes, and an accepted chunk is saved. It aborts
   * nothing, so it leaves no open reserve. The job ends `cancelled`; a chunk whose first answer was rejected stays pending for the next job's next unused id.
   */
  stop?: AbortSignal;
}

/**
 * How the job ended. `done`: nothing is left for it to ask; `unwritten` counts the scenes it set out to write that still have no text (a chunk it gave up on
 * or found out of attempts). `failed`: stopped by a failure, resumable; `stoppedBy` is why, for the set's record.
 */
export type SceneWriteEnd =
  | { status: "done"; written: number; unwritten: number }
  | { status: "failed"; error: EngineError; stoppedBy: Exclude<SceneStoppedBy, "closed"> }
  | { status: "cancelled" };

/**
 * Why a failure stopped the job, as the notice words it. A 5xx that outlasted the transport retries and a dropped connection are both the code
 * NETWORK, but money tells them apart: the 5xx settled at nothing (a free settle, no reconcile), the dropped connection left its reserve open.
 */
export function stoppedByOf(error: EngineError, freeSettle: boolean): Exclude<SceneStoppedBy, "closed"> {
  switch (error.code) {
    case "RATE_LIMITED":
      return "rate-limited";
    case "TIMEOUT":
      return "timeout";
    case "NETWORK":
      return freeSettle ? "provider-error" : "network";
    default:
      return "failed";
  }
}

/** Whether the chunk's newest attempt was closed by a free settle (a final non-2xx), not left open or paid. */
export function lastAttemptWasFree(budget: Budget, attemptIds: readonly string[]): boolean {
  const last = [...attemptIds].reverse().find((attemptId) => budget.ledger.reserveOf(attemptId) !== undefined);
  if (last === undefined) return false;
  const close = budget.ledger.closeOf(last);
  return close?.type === "settle" && close.costMicros === 0 && !close.estimated;
}

export async function runSceneWrite(deps: SceneWriteDeps, request: SceneWriteRequest): Promise<SceneWriteEnd> {
  const { budget } = deps;
  const ledger = budget.ledger;
  const first = await deps.load();
  const target = pendingChunks(first, ledger).reduce((sum, pending) => sum + pending.sceneIds.length, 0);
  let written = 0;
  /** Chunks this job has already asked: each at most once, so a chunk that stays pending for any reason can never loop the job. */
  const asked = new Set<number>();
  for (;;) {
    if (request.signal.aborted) return { status: "cancelled" };
    const set = await deps.load();
    const next = pendingChunks(set, ledger).find((pending) => !asked.has(pending.chunk.chunk));
    if (next === undefined) break;
    // A soft stop with nothing left to ask changes nothing (the job is done); with a chunk still waiting it is not asked.
    if (request.stop?.aborted === true) return { status: "cancelled" };
    asked.add(next.chunk.chunk);

    const slots = next.sceneIds.map((sceneId) => {
      const scene = set.scenes.find((s) => s.sceneId === sceneId);
      if (scene === undefined) throw new Error(`the writer's chunk ${next.chunk.chunk} names scene ${sceneId}, which the set does not have`);
      if (scene.origin !== "planned") throw new Error(`the writer's chunk ${next.chunk.chunk} names scene ${sceneId}, which is not a planned scene`);
      return scene.slot;
    });
    const phase: WriterPhase = {
      ...runWriterConfig(set.categories),
      jobId: request.jobId,
      scope: request.scope,
      textModel: set.models.text,
      signal: request.signal,
      ...(request.stop === undefined ? {} : { stop: request.stop }),
      slots,
      chunks: [{ chunk: next.chunk.chunk, slotIndexes: next.sceneIds, attemptIds: next.chunk.attemptIds }],
      sentences: new Map(),
      writerDone: new Set(),
      ledger,
    };
    const result = await runWriterPhase(
      {
        chat: deps.chat,
        budget,
        priceBook: deps.priceBook,
        acquire: deps.acquire,
        onChunk: async (chunk, sentences) => {
          await deps.saveChunk(chunk, sentences);
          written += sentences.size;
          deps.progress(written);
        },
      },
      phase,
    );
    if (result.ok) continue;
    if (result.stop === "cancelled" || result.stop === "soft-stopped") return { status: "cancelled" };
    if (result.stop === "stopped") return { status: "failed", error: result.error, stoppedBy: stoppedByOf(result.error, lastAttemptWasFree(budget, next.chunk.attemptIds)) };
    // exhausted: the chunk will never be answered. A provider's refusal is final; two rejected answers are the chunk's verdict; a chunk whose attempts ran out
    // some other way (its ids all spent with no answer) is read «no attempts» from the ledger and needs no record.
    if (result.error.code === "MODERATION_REFUSED") await deps.giveUp(next.chunk.chunk, "refused");
    else if (chunkState(set, next.chunk, ledger).answered >= phase.call.maxAttempts) await deps.giveUp(next.chunk.chunk, "rejected");
  }
  return { status: "done", written, unwritten: Math.max(0, target - written) };
}
