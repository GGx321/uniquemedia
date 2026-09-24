import type { AvatarDescriptor, AvatarTraits, EngineError } from "../../shared/engine";
import type { Budget } from "../money/budget";
import type { Scope } from "../money/ledger";
import type { PriceBook } from "../money/prices";
import { toEngineError } from "../openrouter/engineError";
import { truncate } from "../openrouter/transport";
import type { OpenRouterClient } from "../openrouter/types";
import {
  descriptorCall,
  descriptorMessages,
  DESCRIPTOR_JSON_SCHEMA,
  DESCRIPTOR_MAX_ATTEMPTS,
  readDescriptorAnswer,
  type DescriptorRefusal,
} from "./descriptor";

export interface DescriptorJobDeps {
  /** The OpenRouter client's chat (T3): reserve on disk, send, settle. */
  chat: OpenRouterClient["chat"];
  budget: Budget;
  /** The prices the job was accepted at; the reserve of each attempt is its worst case at these prices. */
  priceBook: PriceBook;
}

export interface DescriptorJob {
  jobId: string;
  /** The job's cap scope; the Budget holds its cap. */
  scope: Scope;
  traits: AvatarTraits;
  /** The settings' text model. */
  textModel: string;
}

export type DescriptorJobResult = { ok: true; descriptor: AvatarDescriptor } | { ok: false; error: EngineError };

/** The descriptor call cannot be cancelled: it is one short request inside a user's command. */
const NEVER_ABORTED = new AbortController().signal;

function refusalText(refusal: DescriptorRefusal): string {
  return refusal.words.length > 0 ? `${refusal.problems.join(", ")} (${refusal.words.join(", ")})` : refusal.problems.join(", ");
}

function afterRefusal(error: EngineError, earlier: DescriptorRefusal): EngineError {
  const detail = `${error.detail ?? error.code} (after an answer rejected for: ${refusalText(earlier)})`;
  return { ...error, detail: truncate(detail) };
}

/**
 * Asks the text model for the avatar's descriptor. A paid answer that cannot
 * be used (not the JSON asked for, empty, or refused by the contract's
 * AvatarDescriptor once normalised) is asked for once more under the next
 * attempt id, with the reasons fed back; the Budget checks each attempt
 * against the job's cap and the global budget (invariant 3). Any other
 * failure is final. Every attempt's money is settled by the client's settle
 * rule, whatever the answer was.
 */
export async function runDescriptorJob(deps: DescriptorJobDeps, job: DescriptorJob): Promise<DescriptorJobResult> {
  const call = descriptorCall(job.textModel);
  let feedback: DescriptorRefusal = { problems: [], words: [] };
  for (let attempt = 1; attempt <= DESCRIPTOR_MAX_ATTEMPTS; attempt++) {
    const result = await deps.chat({
      attemptId: `${job.jobId}:descriptor#${attempt}`,
      jobId: job.jobId,
      scope: job.scope,
      model: job.textModel,
      budget: deps.budget,
      priceBook: deps.priceBook,
      signal: NEVER_ABORTED,
      messages: descriptorMessages(job.traits, feedback),
      jsonSchema: DESCRIPTOR_JSON_SCHEMA,
      maxTokens: call.maxTokens,
      inputTokens: call.inputTokens,
      reasoningEffort: "low",
    });
    // A bill above the worst case still bought a usable answer; the Budget
    // has halted every later reserve and the money status says so.
    if (result.status === "ok") {
      const read = readDescriptorAnswer(result.content, job.traits.age);
      if (read.ok) return { ok: true, descriptor: read.descriptor };
      feedback = { problems: read.problems, words: read.words };
      continue;
    }
    if (result.status === "error" && result.kind === "EMPTY_CONTENT") {
      feedback = { problems: ["empty"], words: [] };
      continue;
    }
    const error = toEngineError(result)?.error ?? { code: "INTERNAL", detail: "the descriptor request was cancelled" };
    return { ok: false, error: feedback.problems.length > 0 ? afterRefusal(error, feedback) : error };
  }
  return {
    ok: false,
    error: { code: "INTERNAL", detail: truncate(`the text model's descriptor was rejected ${DESCRIPTOR_MAX_ATTEMPTS} times; the last answer for: ${refusalText(feedback)}`) },
  };
}
