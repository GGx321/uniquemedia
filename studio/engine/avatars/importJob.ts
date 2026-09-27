import type { AvatarDescriptor, AvatarTraits, EngineError } from "../../shared/engine";
import type { Budget } from "../money/budget";
import { AGE_CHECK_CALL } from "../money/estimate";
import type { Scope } from "../money/ledger";
import type { PriceBook } from "../money/prices";
import { toEngineError } from "../openrouter/engineError";
import type { OpenRouterClient } from "../openrouter/types";
import { ageCheckMessages, ageJsonSchema, readAgeAnswer } from "./ageCheck";
import { runImportDescribeJob } from "./importDescribeJob";

// T6c (review round 2, H1): the orchestration engine.ts's own #importAvatar
// used to inline — the mandatory one-time image age check, then, only on a
// clear pass, the vision describe job — extracted here so every guard (each
// non-ok branch of the age check, the hand-off to the describe job, which
// failure marks the key rejected) is directly testable against an injected
// client, exactly like descriptorJob.ts and candidateJob.ts's own age-check
// matrix (M7) test their own jobs, instead of only reachable through the
// whole Engine. Also removes the duplicated NEVER_ABORTED that used to live
// in engine.ts alongside descriptorJob.ts's own copy.

export interface ImportJobDeps {
  /** The OpenRouter client's chat (T3): reserve on disk, send, settle. */
  chat: OpenRouterClient["chat"];
  budget: Budget;
  /** The prices the job was accepted at; each attempt's reserve is its worst case at these prices. */
  priceBook: PriceBook;
}

export interface ImportJob {
  jobId: string;
  /** The job's cap scope; the Budget holds its cap. */
  scope: Scope;
  /** The settings' text model, for the describe call. */
  textModel: string;
  /** The staged photo, already downscaled to the age check's own JPEG size. */
  ageJpeg: Uint8Array;
  /** The staged photo, already downscaled to the describe call's own (larger) JPEG size. */
  describeJpeg: Uint8Array;
}

export type ImportJobResult =
  | { ok: true; traits: AvatarTraits; descriptor: AvatarDescriptor; ageConfidence: number }
  | { ok: false; error: EngineError; /** Whether this failure means the stored key was rejected (401): the caller marks it so. */ authInvalid: boolean };

/** Neither the age check nor the describe call can be cancelled: both are short requests inside one user's command. */
const NEVER_ABORTED = new AbortController().signal;

/** T6c: the one-time image age check on an imported photo did not clearly confirm an adult; the import is refused. */
function importAgeFailure(reason: string): EngineError {
  return { code: "AGE_CHECK_FAILED", detail: `the one-time image age check did not confirm an adult (${reason})` };
}

/**
 * The mandatory one-time image age check on the staged photo (whatever the
 * `imageAgeCheck` toggle says — an imported image bypasses the prompt's own
 * 21+ anchoring), then, only on a clear pass, the vision describe job for
 * her typed traits and descriptor. A refusal at either step stores nothing;
 * every attempt made so far is still settled by the client's own settle rule.
 */
export async function runImportJob(deps: ImportJobDeps, job: ImportJob): Promise<ImportJobResult> {
  const age = await deps.chat({
    attemptId: `${job.jobId}:age`,
    jobId: job.jobId,
    scope: job.scope,
    model: AGE_CHECK_CALL.model,
    budget: deps.budget,
    priceBook: deps.priceBook,
    signal: NEVER_ABORTED,
    messages: ageCheckMessages(),
    jsonSchema: ageJsonSchema(),
    maxTokens: AGE_CHECK_CALL.maxTokens,
    inputTokens: AGE_CHECK_CALL.inputTokens,
    images: [job.ageJpeg],
    reasoningEffort: "low",
  });
  if (age.status === "refused") return { ok: false, error: importAgeFailure("the model refused to judge the image"), authInvalid: false };
  if (age.status === "error" && age.kind === "EMPTY_CONTENT") return { ok: false, error: importAgeFailure("the model's answer had no content"), authInvalid: false };
  if (age.status !== "ok" || age.aboveWorst) {
    const mapped = toEngineError(age);
    if (mapped === null) throw new Error("unreachable: the age check is never aborted or cancelled");
    return { ok: false, error: mapped.error, authInvalid: mapped.error.code === "AUTH_INVALID" };
  }
  const verdict = readAgeAnswer(age.content);
  if (!verdict.pass) return { ok: false, error: importAgeFailure(verdict.why), authInvalid: false };

  const described = await runImportDescribeJob(
    { chat: deps.chat, budget: deps.budget, priceBook: deps.priceBook },
    { jobId: job.jobId, scope: job.scope, textModel: job.textModel, image: job.describeJpeg },
  );
  if (!described.ok) return { ok: false, error: described.error, authInvalid: described.error.code === "AUTH_INVALID" };
  return { ok: true, traits: described.traits, descriptor: described.descriptor, ageConfidence: verdict.confidence };
}
