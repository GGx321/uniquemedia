import type { CategoryPool, CategoryStyle, EngineError } from "../../shared/engine";
import type { Budget } from "../money/budget";
import { jobSpentMicros } from "../money/jobSpend";
import type { Scope } from "../money/ledger";
import type { PriceBook } from "../money/prices";
import { toEngineError } from "../openrouter/engineError";
import { truncate } from "../openrouter/transport";
import type { OpenRouterClient } from "../openrouter/types";
import { POOL_JSON_SCHEMA, POOL_MAX_ATTEMPTS, poolCall, poolMessages, readPoolAnswer, type PoolRefusal } from "./poolGen";

// CS.2: the pool call of a custom category, in the descriptor job's mould (avatars/descriptorJob.ts): one paid chat call, asked once
// more with the reasons when the answer cannot be used, each attempt reserved at its worst case before it is sent and settled after.

export interface CategoryJobDeps {
  /** The OpenRouter client's chat: reserve on disk, send, settle. */
  chat: OpenRouterClient["chat"];
  budget: Budget;
  /** The prices the job was accepted at; the reserve of each attempt is its worst case at these prices. */
  priceBook: PriceBook;
  /**
   * An error thrown out of an attempt (a ledger that cannot record the reserve or the settle) as the contract's error. The job answers it as a
   * failure with what the ledger booked, instead of throwing past the one place that knows the call's cost.
   */
  errorOf: (error: unknown) => EngineError;
}

export interface CategoryJob {
  jobId: string;
  /** The job's cap scope; the Budget holds its cap (the accepted worst case). */
  scope: Scope;
  /** The owner's description: the only text of his that is sent. */
  description: string;
  /** The settings' text model. */
  textModel: string;
}

/** `spentMicros` is what the ledger booked for the job's attempts: the call's cost, whatever the answer was. */
export type CategoryJobResult =
  | { ok: true; label: string; style: CategoryStyle; pool: CategoryPool; dropped: number; spentMicros: number }
  | { ok: false; error: EngineError; spentMicros: number };

/** The pool call cannot be cancelled: it is one short request inside a user's command. */
const NEVER_ABORTED = new AbortController().signal;

function refusalText(refusal: PoolRefusal): string {
  return refusal.problems.join(", ");
}

/**
 * Asks the text model for the pool of a custom category. An answer that cannot be used (not the JSON asked for, empty, or too little
 * left once every item that breaks the pool rules is dropped) is asked for once more under the next attempt id, with the fixed reasons
 * fed back; the Budget checks each attempt against the job's cap and the global budget (invariant 3). A moderation refusal and any
 * other failure are final. Every attempt's money is settled by the client's settle rule, whatever the answer was.
 */
export async function runCategoryJob(deps: CategoryJobDeps, job: CategoryJob): Promise<CategoryJobResult> {
  const call = poolCall(job.textModel);
  const spent = (): number => jobSpentMicros(deps.budget.ledger, job.jobId);
  const failed = (error: EngineError): CategoryJobResult => {
    const spentMicros = spent();
    return { ok: false, error: { ...error, spentMicros }, spentMicros };
  };
  let feedback: PoolRefusal | undefined;
  for (let attempt = 1; attempt <= POOL_MAX_ATTEMPTS; attempt++) {
    let result: Awaited<ReturnType<typeof deps.chat>>;
    try {
      result = await deps.chat({
        attemptId: `${job.jobId}:pool#${attempt}`,
        jobId: job.jobId,
        scope: job.scope,
        model: job.textModel,
        budget: deps.budget,
        priceBook: deps.priceBook,
        signal: NEVER_ABORTED,
        messages: poolMessages(job.description, feedback),
        jsonSchema: POOL_JSON_SCHEMA,
        maxTokens: call.maxTokens,
        inputTokens: call.inputTokens,
        reasoningEffort: "low",
      });
    } catch (error) {
      // The ledger could not record the reserve or the settle: what it holds for the job (an attempt left open counts at its worst case) is the cost.
      return failed(deps.errorOf(error));
    }
    // A bill above the worst case still bought a usable answer; the Budget has halted every later reserve and the money status says so.
    if (result.status === "ok") {
      const read = readPoolAnswer(result.content);
      if (read.ok) return { ok: true, label: read.label, style: read.style, pool: read.pool, dropped: read.dropped, spentMicros: spent() };
      feedback = { problems: read.problems, words: read.words };
      continue;
    }
    if (result.status === "error" && result.kind === "EMPTY_CONTENT") {
      feedback = { problems: ["empty"], words: [] };
      continue;
    }
    const error = toEngineError(result)?.error ?? { code: "INTERNAL", detail: "the pool request was cancelled" };
    const detail = feedback === undefined ? error.detail : truncate(`${error.detail ?? error.code} (after an answer rejected for: ${refusalText(feedback)})`);
    return failed({ ...error, ...(detail === undefined ? {} : { detail }) });
  }
  return failed({
    code: "POOL_REJECTED",
    detail: truncate(`the text model's pool was rejected ${POOL_MAX_ATTEMPTS} times; the last answer for: ${feedback === undefined ? "nothing" : refusalText(feedback)}`),
  });
}
