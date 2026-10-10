import type { AvatarDescriptor, DescriptorCheck, EngineError } from "../../shared/engine";
import type { Budget } from "../money/budget";
import type { Scope } from "../money/ledger";
import type { PriceBook } from "../money/prices";
import { toEngineError } from "../openrouter/engineError";
import { truncate } from "../openrouter/transport";
import type { OpenRouterClient } from "../openrouter/types";
import { DESCRIPTOR_CHECK_JSON_SCHEMA, descriptorCheckMessages, readDescriptorCheckAnswer, type DescriptorCheckRefusal } from "./descriptorCheck";
import { descriptorCheckCall, DESCRIPTOR_CHECK_MAX_ATTEMPTS } from "./plan";

// Stage 5, S5.0c: the vision call that compares a saved avatar's descriptor with her master photo. Mirrors importDescribeJob.ts's retry-with-feedback shape exactly (the image is
// sent again on every attempt), but it NEVER writes: its only dependencies are the chat, the budget and the prices, and its result is a `DescriptorCheck` the owner may act on.

export interface DescriptorCheckJobDeps {
  /** The OpenRouter client's chat (T3): reserve on disk, send, settle. */
  chat: OpenRouterClient["chat"];
  budget: Budget;
  /** The prices the job was accepted at; the reserve of each attempt is its worst case at these prices. */
  priceBook: PriceBook;
}

export interface DescriptorCheckJob {
  jobId: string;
  /** The job's cap scope; the Budget holds its cap. At import this is the import's own scope. */
  scope: Scope;
  /** The settings' text model. */
  textModel: string;
  /** The master photo as a downscaled JPEG: the import's staged one, or `Library.loadReference`'s for a saved avatar. */
  image: Uint8Array;
  /** The stored descriptor being judged; the caller has already proved it passes `AvatarDescriptor`. */
  stored: AvatarDescriptor;
  /** Her body phrase, once she has body traits (S5.2); null or absent before. */
  bodyPhrase?: string | null;
}

export type DescriptorCheckJobResult = { ok: true; check: DescriptorCheck } | { ok: false; error: EngineError };

/** The check cannot be cancelled: it is one short request inside a user's command. */
const NEVER_ABORTED = new AbortController().signal;

function afterRefusal(error: EngineError, earlier: DescriptorCheckRefusal): EngineError {
  return { ...error, detail: truncate(`${error.detail ?? error.code} (after an answer rejected for: ${earlier.problems.join(", ")})`) };
}

/**
 * Asks the settings' text model to compare the master photo with the stored descriptor. A paid answer that cannot be used (not the JSON asked for, empty, or with no
 * valid aspect) is asked for once more under the next attempt id, with the reason fed back and the same photo attached again; the Budget checks each attempt against the
 * scope's cap and the global budget. Any other failure is final. Ids: `<jobId>:check#1..2`. Every attempt's money is settled by the client's settle rule.
 */
export async function runDescriptorCheckJob(deps: DescriptorCheckJobDeps, job: DescriptorCheckJob): Promise<DescriptorCheckJobResult> {
  const call = descriptorCheckCall(job.textModel);
  const bodyPhrase = job.bodyPhrase ?? null;
  let feedback: DescriptorCheckRefusal = { problems: [] };
  for (let attempt = 1; attempt <= DESCRIPTOR_CHECK_MAX_ATTEMPTS; attempt++) {
    const result = await deps.chat({
      attemptId: `${job.jobId}:check#${attempt}`,
      jobId: job.jobId,
      scope: job.scope,
      model: job.textModel,
      budget: deps.budget,
      priceBook: deps.priceBook,
      signal: NEVER_ABORTED,
      messages: descriptorCheckMessages(job.stored, bodyPhrase, feedback),
      jsonSchema: DESCRIPTOR_CHECK_JSON_SCHEMA,
      maxTokens: call.maxTokens,
      inputTokens: call.inputTokens,
      images: [job.image],
      reasoningEffort: "low",
    });
    // A bill above the worst case still bought a usable answer; the Budget has halted every later reserve and the money status says so.
    if (result.status === "ok") {
      const read = readDescriptorCheckAnswer(result.content, job.stored, bodyPhrase);
      if (read.ok) return { ok: true, check: read.check };
      feedback = { problems: read.problems };
      continue;
    }
    if (result.status === "error" && result.kind === "EMPTY_CONTENT") {
      feedback = { problems: ["empty"] };
      continue;
    }
    const error = toEngineError(result)?.error ?? { code: "INTERNAL", detail: "the check request was cancelled" };
    return { ok: false, error: feedback.problems.length > 0 ? afterRefusal(error, feedback) : error };
  }
  return {
    ok: false,
    error: { code: "INTERNAL", detail: truncate(`the descriptor check was unreadable ${DESCRIPTOR_CHECK_MAX_ATTEMPTS} times; the last answer for: ${feedback.problems.join(", ")}`) },
  };
}
