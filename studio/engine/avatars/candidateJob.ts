import { createHash } from "node:crypto";
import type { AvatarDescriptor, EngineError, FailedCandidateSlot } from "../../shared/engine";
import type { CandidatesJobEnd } from "../jobs";
import type { NewPhotoMeta } from "../library";
import { imageSize, isAnimatedImage } from "../library/media";
import type { Budget } from "../money/budget";
import { AGE_CHECK_CALL } from "../money/estimate";
import type { Scope } from "../money/ledger";
import type { PriceBook } from "../money/prices";
import { chatAttemptWorstMicros, type ChatPriceShape } from "../openrouter/chat";
import { toEngineError } from "../openrouter/engineError";
import { truncate } from "../openrouter/transport";
import type { ChatResult, ImageOk, ImageResult, OpenRouterClient } from "../openrouter/types";
import { AGE_JSON_SCHEMA, ageCheckMessages, readAgeAnswer, type AgeRejection } from "./ageCheck";
import { CANDIDATE_ASPECT_RATIO, CANDIDATES_PER_BATCH, candidateImage } from "./plan";
import { candidatePrompt, PromptSubjectError } from "./prompts";

// One batch of candidate portraits for a draft (T6a part 2b). Each of the
// CANDIDATES_PER_BATCH slots sends exactly the calls the next-batch estimate
// priced (plan.ts): one image attempt and, for a usable image, one age
// check, each under its own attempt id, never retried. A candidate enters the
// library only after a clear yes from the age check (invariant 8); a rejected
// image is dropped: it is never written anywhere, since it may show a minor.

export interface CandidateJobDeps {
  generateImage: OpenRouterClient["generateImage"];
  chat: OpenRouterClient["chat"];
  budget: Budget;
  /** The prices the job was accepted at; each reserve is its attempt's worst case at these prices. */
  priceBook: PriceBook;
  /** A paid image as the age check's JPEG (studio/node's ffmpeg in the engine); throws when it cannot. */
  downscale: (bytes: Uint8Array, signal: AbortSignal) => Promise<Uint8Array>;
  /** Stores a candidate that passed the age check on the draft (the library: image first, then sidecar). */
  store: (bytes: Uint8Array, meta: NewPhotoMeta) => Promise<{ id: string }>;
  /** A thrown error (a ledger write, a bug) in the T0 error model. */
  errorOf: (error: unknown) => EngineError;
  /** Each slot as it finishes: passed, rejected or failed. Aborted and skipped slots are not reported. */
  onSlot?: (outcome: SlotOutcome) => void;
}

export interface CandidateJob {
  jobId: string;
  /** The job's cap scope; the Budget holds its cap. */
  scope: Scope;
  /** The settings' image model. */
  imageModel: string;
  /** The draft's descriptor: the prompt is built from it alone (prompts.ts). */
  descriptor: AvatarDescriptor;
  /** Slots in flight at once: the settings' network concurrency. */
  concurrency: number;
  /** A user's cancel: requests in flight are aborted and no new slot starts. */
  signal: AbortSignal;
  /** PREPARE_TIMEOUT_MS unless a test says otherwise. */
  prepareTimeoutMs?: number;
}

/**
 * - passed: stored on the draft as `photoId`.
 * - rejected: the age check did not say a clear yes (or refused to answer); the image is dropped.
 * - failed: the slot could not finish; `fatal` stops the job from starting more slots;
 *   `reserveLeftOpen`: a request of it may have been billed (timeout, network), so its reserve waits for a reconcile.
 * - aborted: a cancel stopped it. skipped: it never started (a cancel or a fatal error came first).
 */
export type SlotOutcome =
  | { slot: number; kind: "passed"; photoId: string }
  | { slot: number; kind: "rejected"; why: AgeRejection | "age-check-refused" | "empty-answer" }
  | { slot: number; kind: "failed"; error: EngineError; fatal: boolean; reserveLeftOpen: boolean }
  | { slot: number; kind: "aborted" }
  | { slot: number; kind: "skipped" };

/**
 * How long preparing one paid image for its age check may take: a 768 px
 * downscale takes ~20 ms, so this only ends a hung ffmpeg, which must not
 * hold the slot (and the job, and the library switch) forever.
 */
export const PREPARE_TIMEOUT_MS = 30_000;

/**
 * Everything of an age check its price depends on. The slot's hold and the
 * request are both built from it, so the hold is exactly what the request
 * will reserve (chatAttemptWorstMicros, the client's own computation).
 */
const AGE_CHECK_SHAPE: ChatPriceShape = {
  model: AGE_CHECK_CALL.model,
  messages: ageCheckMessages(),
  jsonSchema: AGE_JSON_SCHEMA,
  maxTokens: AGE_CHECK_CALL.maxTokens,
  inputTokens: AGE_CHECK_CALL.inputTokens,
  images: AGE_CHECK_CALL.images,
};

/** The attempt id of a slot's image; its age check's is `<jobId>:candidate-<n>:age#1`. */
export function candidateAttemptId(jobId: string, slot: number): string {
  return `${jobId}:candidate-${slot}#1`;
}

function ageAttemptId(jobId: string, slot: number): string {
  return `${jobId}:candidate-${slot}:age#1`;
}

function failed(slot: number, error: EngineError, fatal: boolean, reserveLeftOpen = false): SlotOutcome {
  return { slot, kind: "failed", error: { ...error, ...(error.detail === undefined ? {} : { detail: truncate(error.detail) }) }, fatal, reserveLeftOpen };
}

/** A client result that ended the slot, with whether its reserve was left open until a reconcile. */
function failedBy(slot: number, result: ImageResult | ChatResult, what: string): SlotOutcome {
  const mapped = toEngineError(result);
  if (mapped === null) return internal(slot, `${what} ended without a result`);
  const leftOpen = "ledger" in result && result.ledger.action === "left-open";
  return failed(slot, mapped.error, mapped.fatal, leftOpen);
}

function internal(slot: number, detail: string): SlotOutcome {
  return failed(slot, { code: "INTERNAL", detail }, false);
}

/** `work`, or the signal's reason as soon as it fires; a late rejection of the abandoned work is dropped. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  work.catch(() => {});
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs the batch through the network pool and answers every slot's outcome,
 * in slot order. Never throws: a slot that throws fails fatally. A descriptor
 * that today's rules refuse fails every slot before anything is sent.
 */
export async function runCandidateJob(deps: CandidateJobDeps, job: CandidateJob): Promise<SlotOutcome[]> {
  const slots = Array.from({ length: CANDIDATES_PER_BATCH }, (_, i) => i + 1);
  let prompt: string;
  try {
    prompt = candidatePrompt(job.descriptor);
  } catch (error) {
    if (!(error instanceof PromptSubjectError)) throw error;
    return slots.map((slot) => failed(slot, { code: "DESCRIPTOR_INVALID", detail: error.message }, true));
  }

  const outcomes: SlotOutcome[] = slots.map((slot) => ({ slot, kind: "skipped" }));
  let fatal = false;
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (job.signal.aborted || fatal) return;
      const slot = slots[next++];
      if (slot === undefined) return;
      let outcome: SlotOutcome;
      try {
        outcome = await runSlot(deps, job, prompt, slot);
      } catch (error) {
        outcome = failed(slot, deps.errorOf(error), true);
      }
      outcomes[slot - 1] = outcome;
      if (outcome.kind === "failed" && outcome.fatal) fatal = true;
      if (outcome.kind === "passed" || outcome.kind === "rejected" || outcome.kind === "failed") deps.onSlot?.(outcome);
    }
  };
  const workers = Math.max(1, Math.min(job.concurrency, slots.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return outcomes;
}

/**
 * One slot. Its image and its age check are admitted together first (both
 * at their worst case, in the job's scope and the month): an image is never
 * paid for when its check could not be (m3 of the part 1 review). Each
 * request is still reserved on disk, and checked again, when it is sent.
 */
async function runSlot(deps: CandidateJobDeps, job: CandidateJob, prompt: string, slot: number): Promise<SlotOutcome> {
  const choice = candidateImage(job.imageModel);
  const attemptId = candidateAttemptId(job.jobId, slot);
  const ageId = ageAttemptId(job.jobId, slot);
  const held = await deps.budget.tryHold([
    { attemptId, scope: job.scope, worstMicros: deps.priceBook.imageWorstCase({ model: choice.model, resolution: choice.resolution, quality: choice.quality, refs: choice.refs }) },
    { attemptId: ageId, scope: job.scope, worstMicros: chatAttemptWorstMicros(deps.priceBook, AGE_CHECK_SHAPE) },
  ]);
  if (!held.ok) {
    const mapped = toEngineError({ status: "blocked", refusal: held });
    return mapped === null ? internal(slot, "the budget refused the slot") : failed(slot, mapped.error, mapped.fatal);
  }
  try {
    return await sendPair(deps, job, prompt, slot);
  } finally {
    // Whatever was not reserved will not be sent.
    deps.budget.releaseHold(attemptId);
    deps.budget.releaseHold(ageId);
  }
}

async function sendPair(deps: CandidateJobDeps, job: CandidateJob, prompt: string, slot: number): Promise<SlotOutcome> {
  const choice = candidateImage(job.imageModel);
  const attemptId = candidateAttemptId(job.jobId, slot);
  const image = await deps.generateImage({
    attemptId,
    jobId: job.jobId,
    scope: job.scope,
    model: choice.model,
    budget: deps.budget,
    priceBook: deps.priceBook,
    signal: job.signal,
    prompt,
    resolution: choice.resolution,
    aspectRatio: CANDIDATE_ASPECT_RATIO,
    quality: choice.quality,
    references: [],
  });
  if (image.status === "aborted") return { slot, kind: "aborted" };
  // A refusal is free and never retried; a bill above the worst case halts every later reserve.
  if (image.status !== "ok" || image.aboveWorst) return failedBy(slot, image, "the image attempt");
  const size = imageSize(image.bytes);
  if (size === null) return internal(slot, `the ${image.mediaType} image's size cannot be read`);
  // The age check would judge whichever frame the decoder picks, not necessarily the one a viewer sees.
  if (isAnimatedImage(image.bytes)) return internal(slot, `the ${image.mediaType} image is animated; only a still image can be age-checked`);
  if (job.signal.aborted) return { slot, kind: "aborted" };
  // The downscale is told to stop on a cancel or the timeout, and is not waited for past either.
  const timeoutMs = job.prepareTimeoutMs ?? PREPARE_TIMEOUT_MS;
  const prepare = AbortSignal.any([job.signal, AbortSignal.timeout(timeoutMs)]);
  let jpeg: Uint8Array;
  try {
    jpeg = await untilAborted(deps.downscale(image.bytes, prepare), prepare);
  } catch (error) {
    if (job.signal.aborted) return { slot, kind: "aborted" };
    if (prepare.aborted) return internal(slot, `preparing the image for the age check timed out after ${timeoutMs} ms`);
    return internal(slot, `the image could not be prepared for the age check: ${messageOf(error)}`);
  }
  return ageGate(deps, job, slot, { attemptId, prompt, image, size, jpeg });
}

interface Checked {
  attemptId: string;
  prompt: string;
  image: ImageOk;
  size: { width: number; height: number };
  jpeg: Uint8Array;
}

/** The age check of one paid image; only a clear yes stores it (invariant 8). */
async function ageGate(deps: CandidateJobDeps, job: CandidateJob, slot: number, checked: Checked): Promise<SlotOutcome> {
  const age = await deps.chat({
    attemptId: ageAttemptId(job.jobId, slot),
    jobId: job.jobId,
    scope: job.scope,
    budget: deps.budget,
    priceBook: deps.priceBook,
    signal: job.signal,
    model: AGE_CHECK_SHAPE.model,
    messages: AGE_CHECK_SHAPE.messages,
    jsonSchema: AGE_CHECK_SHAPE.jsonSchema,
    maxTokens: AGE_CHECK_SHAPE.maxTokens,
    inputTokens: AGE_CHECK_SHAPE.inputTokens,
    // AGE_CHECK_SHAPE.images: this one.
    images: [checked.jpeg],
    reasoningEffort: "low",
  });
  if (age.status === "aborted") return { slot, kind: "aborted" };
  // A refusal to judge the image, or a paid answer without content, is doubt.
  if (age.status === "refused") return { slot, kind: "rejected", why: "age-check-refused" };
  if (age.status === "error" && age.kind === "EMPTY_CONTENT") return { slot, kind: "rejected", why: "empty-answer" };
  if (age.status !== "ok" || age.aboveWorst) return failedBy(slot, age, "the age check");
  const verdict = readAgeAnswer(age.content);
  if (!verdict.pass) return { slot, kind: "rejected", why: verdict.why };

  const { image, size, prompt, attemptId } = checked;
  const meta: NewPhotoMeta = {
    mediaType: image.mediaType,
    width: size.width,
    height: size.height,
    source: {
      kind: "generated",
      model: job.imageModel,
      provider: "openrouter",
      jobId: job.jobId,
      attemptId,
      promptSha: createHash("sha256").update(prompt).digest("hex"),
      prompt,
      slot: `candidate-${slot}`,
      costMicros: image.costMicros,
    },
    qa: { age: { adult: true, confidence: verdict.confidence } },
  };
  try {
    const photo = await deps.store(image.bytes, meta);
    return { slot, kind: "passed", photoId: photo.id };
  } catch (error) {
    return internal(slot, `the candidate passed the age check but could not be stored: ${messageOf(error)}`);
  }
}

/**
 * How a batch ended. A cancel that stopped a slot ends it as cancelled. A
 * fatal error fails it, even with candidates stored (they are in the draft
 * already). Otherwise it is done when any candidate passed or the age check
 * judged any, with every other slot and why; with neither, it failed with the
 * first slot's error.
 */
export function candidateJobEnd(outcomes: readonly SlotOutcome[], cancelRequested: boolean): CandidatesJobEnd {
  if (cancelRequested && outcomes.some((o) => o.kind === "aborted" || o.kind === "skipped")) return { status: "cancelled" };
  const failures = outcomes.flatMap((o) => (o.kind === "failed" ? [o] : []));
  const fatal = failures.find((o) => o.fatal);
  if (fatal !== undefined) return { status: "failed", error: fatal.error };
  const photoIds = outcomes.flatMap((o) => (o.kind === "passed" ? [o.photoId] : []));
  const failedSlots = [...outcomes]
    .sort((a, b) => a.slot - b.slot)
    .flatMap((o): FailedCandidateSlot[] => {
      if (o.kind === "rejected") return [{ slot: o.slot, reason: "age-rejected" }];
      if (o.kind === "failed") return [{ slot: o.slot, reason: "failed", error: o.error, reserveLeftOpen: o.reserveLeftOpen }];
      return [];
    });
  if (photoIds.length === 0 && failedSlots.every((f) => f.reason !== "age-rejected")) {
    return { status: "failed", error: failures[0]?.error ?? { code: "INTERNAL", detail: "no candidate slot ran" } };
  }
  return { status: "done", photoIds, failedSlots };
}
