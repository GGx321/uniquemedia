import type { EngineError } from "../../shared/engine";
import type { Budget } from "../money/budget";
import { WRITER_CALL } from "../money/estimate";
import type { Scope } from "../money/ledger";
import type { PriceBook } from "../money/prices";
import { toEngineError } from "../openrouter/engineError";
import { truncate } from "../openrouter/transport";
import type { OpenRouterClient } from "../openrouter/types";
import type { PlanSlot } from "./schema";
import { chunkSlots, readWriterAnswer, writerMessages, writerRefusalText, WRITER_JSON_SCHEMA, type WriterRefusal } from "./writer";

// T5b: the paid writer job — one call per chunk of at most
// WRITER_CALL.slotsPerCall slots (review round 2: RunRequest.count allows
// 1..100 photos per run, possibly all in one category, more than a single
// call can safely take), reserved/settled through the OpenRouter client
// exactly like avatars/descriptorJob.ts's own loop (money is the client's
// own job, this module only supplies each attempt's shape). Chunks run
// sequentially; the first chunk that exhausts its own attempts fails the
// whole job, and every chunk already settled stays settled — there is
// nothing to undo, since each attempt is already fully settled by the
// client the moment it responds. The job never takes the avatar's traits or
// its free-text mood note: its only inputs are the plan's slots and the
// run's own ids, so there is nothing here for that to leak from
// (writerJob.test.ts's own canary test).

export interface WriterJobDeps {
  /** The OpenRouter client's chat (T3): reserve on disk, send, settle. */
  chat: OpenRouterClient["chat"];
  budget: Budget;
  /** The prices the job was accepted at; the reserve of each attempt is its worst case at these prices. */
  priceBook: PriceBook;
}

export interface WriterJob {
  /** The run's id; attempt ids are `${runId}:writer-${chunkIndex}#N` (invariant 5). */
  runId: string;
  /** The ledger's jobId for this call. */
  jobId: string;
  /** The run's cap scope. */
  scope: Scope;
  slots: readonly PlanSlot[];
  /** The settings' text model. */
  textModel: string;
  /** T6's own abort (cancel leaves the reserve open at its worst case until reconcile, like any other attempt). */
  signal: AbortSignal;
}

export type WriterJobResult = { ok: true; sentences: ReadonlyMap<number, string> } | { ok: false; error: EngineError };

const NO_REFUSAL: WriterRefusal = { problems: [], missingSlots: [], twoHandedSlots: [], wordSlots: [], words: [] };

function afterRefusal(error: EngineError, earlier: WriterRefusal): EngineError {
  const detail = `${error.detail ?? error.code} (after an answer rejected for: ${writerRefusalText(earlier)})`;
  return { ...error, detail: truncate(detail) };
}

/**
 * Asks the text model to turn one chunk's slots into one sentence per slot,
 * under `${runId}:writer-${chunkIndex}#N`. A rejected answer (a two-handed
 * selfie/mirror action, a youth or revealing word, a missing or extra slot,
 * or unusable JSON) is asked for once more under the chunk's next attempt
 * id, with the reasons fed back; then the chunk (and the whole job) fails.
 * The Budget checks each attempt against the run's cap and the global
 * budget (invariant 3); every attempt's money is settled by the client's
 * settle rule, whatever the answer was.
 */
async function runChunk(
  deps: WriterJobDeps,
  job: WriterJob,
  chunk: readonly PlanSlot[],
  chunkIndex: number,
): Promise<{ ok: true; sentences: ReadonlyMap<number, string> } | { ok: false; error: EngineError }> {
  let feedback: WriterRefusal = NO_REFUSAL;
  for (let attempt = 1; attempt <= WRITER_CALL.maxAttempts; attempt++) {
    const result = await deps.chat({
      attemptId: `${job.runId}:writer-${chunkIndex}#${attempt}`,
      jobId: job.jobId,
      scope: job.scope,
      model: job.textModel,
      budget: deps.budget,
      priceBook: deps.priceBook,
      signal: job.signal,
      messages: writerMessages(chunk, feedback),
      jsonSchema: WRITER_JSON_SCHEMA,
      maxTokens: WRITER_CALL.maxTokens,
      inputTokens: WRITER_CALL.inputTokens,
      reasoningEffort: "low",
    });
    if (result.status === "ok") {
      const read = readWriterAnswer(result.content, chunk);
      if (read.ok) return { ok: true, sentences: read.sentences };
      feedback = read;
      continue;
    }
    if (result.status === "error" && result.kind === "EMPTY_CONTENT") {
      feedback = { ...NO_REFUSAL, problems: ["empty"] };
      continue;
    }
    const error = toEngineError(result)?.error ?? { code: "INTERNAL", detail: "the writer request was cancelled" };
    return { ok: false, error: feedback.problems.length > 0 ? afterRefusal(error, feedback) : error };
  }
  return {
    ok: false,
    error: {
      code: "INTERNAL",
      detail: truncate(
        `the text model's scene writer (chunk ${chunkIndex}) was rejected ${WRITER_CALL.maxAttempts} times; the last answer for: ${writerRefusalText(feedback)}`,
      ),
    },
  };
}

/**
 * Runs every chunk of the plan's slots (chunkSlots, at most
 * WRITER_CALL.slotsPerCall each) sequentially, one writer call per chunk. The
 * first chunk that exhausts its own attempts fails the whole job
 * immediately — a later chunk is never attempted, and every chunk settled
 * so far stays settled (nothing is left open: each chunk's own attempts are
 * already fully settled by the client before this function moves on). On
 * full success, every chunk's sentences are merged into one map covering
 * every slot of the plan.
 */
export async function runWriterJob(deps: WriterJobDeps, job: WriterJob): Promise<WriterJobResult> {
  const chunks = chunkSlots(job.slots);
  const sentences = new Map<number, string>();
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (chunk === undefined) continue;
    const result = await runChunk(deps, job, chunk, i + 1);
    if (!result.ok) return result;
    for (const [slotIndex, sentence] of result.sentences) sentences.set(slotIndex, sentence);
  }
  return { ok: true, sentences };
}
