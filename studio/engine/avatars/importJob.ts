import type { AvatarDescriptor, AvatarTraits, EngineError } from "../../shared/engine";
import type { Budget } from "../money/budget";
import type { Scope } from "../money/ledger";
import type { PriceBook } from "../money/prices";
import type { OpenRouterClient } from "../openrouter/types";
import { runImportDescribeJob } from "./importDescribeJob";

// T6c: the orchestration engine.ts's own #importAvatar hands to, extracted so
// the hand-off (which failure marks the key rejected) is directly testable
// against an injected client, exactly like descriptorJob.ts. Owner decision
// 2026-10-05 (personal-use app): the one-time image age check that used to
// run first is gone — the vision describe job is the whole import.

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
  /** The staged photo, already downscaled to the describe call's own JPEG size. */
  describeJpeg: Uint8Array;
}

export type ImportJobResult =
  | { ok: true; traits: AvatarTraits; descriptor: AvatarDescriptor }
  | { ok: false; error: EngineError; /** Whether this failure means the stored key was rejected (401): the caller marks it so. */ authInvalid: boolean };

/** The vision describe job for her typed traits and descriptor; a failure stores nothing, every attempt made is still settled by the client's own settle rule. */
export async function runImportJob(deps: ImportJobDeps, job: ImportJob): Promise<ImportJobResult> {
  const described = await runImportDescribeJob(
    { chat: deps.chat, budget: deps.budget, priceBook: deps.priceBook },
    { jobId: job.jobId, scope: job.scope, textModel: job.textModel, image: job.describeJpeg },
  );
  if (!described.ok) return { ok: false, error: described.error, authInvalid: described.error.code === "AUTH_INVALID" };
  return { ok: true, traits: described.traits, descriptor: described.descriptor };
}
