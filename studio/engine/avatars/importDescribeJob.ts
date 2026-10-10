import type { AvatarDescriptor, AvatarTraits, EngineError } from "../../shared/engine";
import type { Budget } from "../money/budget";
import type { Scope } from "../money/ledger";
import type { PriceBook } from "../money/prices";
import { toEngineError } from "../openrouter/engineError";
import { truncate } from "../openrouter/transport";
import type { OpenRouterClient } from "../openrouter/types";
import { IMPORT_DESCRIBE_JSON_SCHEMA, importDescribeMessages, readImportDescribeAnswer, type ImportDescribeRefusal, type ImportedBody } from "./importDescribe";
import { importDescribeCall, IMPORT_DESCRIBE_MAX_ATTEMPTS } from "./plan";

// T6c: the one-off vision call for an imported avatar (mirrors
// descriptorJob.ts's own retry-with-feedback shape exactly, but there is no
// traits input at all — everything comes from the attached photo — and the
// image is sent again on every attempt).

export interface ImportDescribeJobDeps {
  /** The OpenRouter client's chat (T3): reserve on disk, send, settle. */
  chat: OpenRouterClient["chat"];
  budget: Budget;
  /** The prices the job was accepted at; the reserve of each attempt is its worst case at these prices. */
  priceBook: PriceBook;
}

export interface ImportDescribeJob {
  jobId: string;
  /** The job's cap scope; the Budget holds its cap. */
  scope: Scope;
  /** The settings' text model. */
  textModel: string;
  /** The staged photo, already downscaled to a JPEG for this call (never the raw upload). */
  image: Uint8Array;
}

/** `body` is the body the photo showed (S5.2b), absent when it showed none. */
export type ImportDescribeJobResult = { ok: true; traits: AvatarTraits; descriptor: AvatarDescriptor; body?: ImportedBody } | { ok: false; error: EngineError };

/** The describe call cannot be cancelled: it is one short request inside a user's command. */
const NEVER_ABORTED = new AbortController().signal;

function refusalText(refusal: ImportDescribeRefusal): string {
  return refusal.words.length > 0 ? `${refusal.problems.join(", ")} (${refusal.words.join(", ")})` : refusal.problems.join(", ");
}

function afterRefusal(error: EngineError, earlier: ImportDescribeRefusal): EngineError {
  const detail = `${error.detail ?? error.code} (after an answer rejected for: ${refusalText(earlier)})`;
  return { ...error, detail: truncate(detail) };
}

/**
 * Asks the settings' text model to describe the staged photo: her typed
 * traits and her descriptor, in one strict JSON answer. A paid answer that
 * cannot be used (not the JSON asked for, empty, or refused by the
 * contract's AvatarTraits/AvatarDescriptor once normalised) is asked for once
 * more under the next attempt id, with the reasons fed back and the same
 * photo attached again; the Budget checks each attempt against the job's cap
 * and the global budget (invariant 3). Any other failure is final. Every
 * attempt's money is settled by the client's settle rule, whatever the
 * answer was.
 */
export async function runImportDescribeJob(deps: ImportDescribeJobDeps, job: ImportDescribeJob): Promise<ImportDescribeJobResult> {
  const call = importDescribeCall(job.textModel);
  let feedback: ImportDescribeRefusal = { problems: [], words: [] };
  for (let attempt = 1; attempt <= IMPORT_DESCRIBE_MAX_ATTEMPTS; attempt++) {
    const result = await deps.chat({
      attemptId: `${job.jobId}:describe#${attempt}`,
      jobId: job.jobId,
      scope: job.scope,
      model: job.textModel,
      budget: deps.budget,
      priceBook: deps.priceBook,
      signal: NEVER_ABORTED,
      messages: importDescribeMessages(feedback),
      jsonSchema: IMPORT_DESCRIBE_JSON_SCHEMA,
      maxTokens: call.maxTokens,
      inputTokens: call.inputTokens,
      images: [job.image],
      reasoningEffort: "low",
    });
    // A bill above the worst case still bought a usable answer; the Budget
    // has halted every later reserve and the money status says so.
    if (result.status === "ok") {
      const read = readImportDescribeAnswer(result.content);
      if (read.ok) return { ok: true, traits: read.traits, descriptor: read.descriptor, ...(read.body === undefined ? {} : { body: read.body }) };
      // M5: the photo does not change between attempts, so a group photo or
      // the wrong gender is not worth asking again — final at once, unlike
      // every other rejection above (a malformed or rule-breaking answer,
      // which asking again can genuinely fix).
      if (read.problems.includes("multiple-people") || read.problems.includes("not-a-woman")) {
        return { ok: false, error: { code: "IMPORT_SUBJECT_INVALID", detail: truncate(refusalText(read)) } };
      }
      feedback = { problems: read.problems, words: read.words };
      continue;
    }
    if (result.status === "error" && result.kind === "EMPTY_CONTENT") {
      feedback = { problems: ["empty"], words: [] };
      continue;
    }
    const error = toEngineError(result)?.error ?? { code: "INTERNAL", detail: "the describe request was cancelled" };
    return { ok: false, error: feedback.problems.length > 0 ? afterRefusal(error, feedback) : error };
  }
  return {
    ok: false,
    error: { code: "INTERNAL", detail: truncate(`the vision description was rejected ${IMPORT_DESCRIBE_MAX_ATTEMPTS} times; the last answer for: ${refusalText(feedback)}`) },
  };
}
