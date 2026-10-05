import { createHash } from "node:crypto";
import { FfmpegError } from "../../node/runFfmpeg";
import { timeoutSignal, untilAborted } from "../money/timeoutSignal";
import type { AvatarDescriptor, EngineError, FailedCandidateSlot, ImageAgeCheck, ImageQuality } from "../../shared/engine";
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
import { ageCheckMessages, ageJsonSchema, readAgeAnswer, type AgeRejection } from "./ageCheck";
import { CANDIDATE_ASPECT_RATIO, CANDIDATES_PER_BATCH, candidateImage } from "./plan";
import { candidatePrompt, PromptSubjectError } from "./prompts";

// One batch of candidate portraits for a draft (T6a part 2b). Each of the
// CANDIDATES_PER_BATCH slots sends exactly the calls the next-batch estimate
// priced (plan.ts): one image attempt and, when the image age check is on,
// one age check, each under its own attempt id, never retried. With the
// check on, a candidate enters the library only after a clear yes from it
// (invariant 8); a rejected image is dropped: it is never written anywhere,
// since it may show a minor. With the check off (owner's decision,
// 2026-09-27, the default: the owner judges age by eye), it is skipped
// entirely — no hold, no reserve, no request — and a candidate enters the
// library right after its image checks, with no qa.age verdict at all. The
// free text-level 21+ safeguards (ageText.ts, promptSubject, youth-word-free
// prompts) apply either way and are never affected by this toggle.

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
  /** The settings' image quality captured with the model; `null` sends none, absent is `low`. */
  imageQuality?: ImageQuality | null;
  /** The draft's descriptor: the prompt is built from it alone (prompts.ts). */
  descriptor: AvatarDescriptor;
  /** Slots in flight at once: the settings' network concurrency. */
  concurrency: number;
  /** A user's cancel: requests in flight are aborted and no new slot starts. */
  signal: AbortSignal;
  /** PREPARE_TIMEOUT_MS unless a test says otherwise. */
  prepareTimeoutMs?: number;
  /**
   * The setting's value captured once at job start (a mid-flight
   * settings.setImageAgeCheck must not affect a job already running).
   * Required, not defaulted: a caller must always say which mode this batch
   * runs in, so a forgotten value fails loudly instead of silently running
   * (or, worse, silently charging for) the wrong mode.
   */
  imageAgeCheck: ImageAgeCheck;
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
 * Everything of an age check its price depends on, fresh for each slot. The
 * slot's hold and its request are both built from the one shape, so the hold
 * is exactly what the request will reserve (chatAttemptWorstMicros, the
 * client's own computation), and nothing is shared between slots.
 */
function ageCheckShape(): ChatPriceShape {
  return {
    model: AGE_CHECK_CALL.model,
    messages: ageCheckMessages(),
    jsonSchema: ageJsonSchema(),
    maxTokens: AGE_CHECK_CALL.maxTokens,
    inputTokens: AGE_CHECK_CALL.inputTokens,
    images: AGE_CHECK_CALL.images,
  };
}

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

/**
 * `error.message`, with an `FfmpegError`'s own stderr tail appended (review
 * A): the bare exit code ("ffmpeg exited with code 1") explains nothing on
 * its own — what ffmpeg printed with `-loglevel error` is the actual
 * diagnostic. `truncate()` (see `failed()`) still bounds the final detail.
 */
function messageOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!(error instanceof FfmpegError)) return message;
  const stderrTail = error.stderrTail.trim();
  return stderrTail === "" ? message : `${message}: ${stderrTail}`;
}

/**
 * A spawn failure (the ffmpeg binary itself missing, ENOENT, or not
 * executable, EACCES): systemic, since every downscale spawns its own
 * ffmpeg process from the same fixed path — the next slot's spawn would fail
 * the exact same way. A decode failure (ffmpeg ran, exited non-zero: this
 * one image was garbled or unusual) has no `code` at all and is not this.
 */
function isSpawnFailure(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "EACCES");
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
        outcome = await runSlot(deps, job, prompt, slot, () => fatal);
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
async function runSlot(deps: CandidateJobDeps, job: CandidateJob, prompt: string, slot: number, isFatal: () => boolean): Promise<SlotOutcome> {
  const choice = candidateImage(job.imageModel, job.imageQuality);
  const attemptId = candidateAttemptId(job.jobId, slot);
  const ageId = ageAttemptId(job.jobId, slot);
  const imageAgeCheck = job.imageAgeCheck;
  const ageShape = imageAgeCheck === "on" ? ageCheckShape() : null;
  const holds = [{ attemptId, scope: job.scope, worstMicros: deps.priceBook.imageWorstCase({ model: choice.model, quality: choice.quality, refs: choice.refs }) }];
  if (ageShape !== null) holds.push({ attemptId: ageId, scope: job.scope, worstMicros: chatAttemptWorstMicros(deps.priceBook, ageShape) });
  const held = await deps.budget.tryHold(holds);
  if (!held.ok) {
    const mapped = toEngineError({ status: "blocked", refusal: held });
    return mapped === null ? internal(slot, "the budget refused the slot") : failed(slot, mapped.error, mapped.fatal);
  }
  try {
    // Review (LOW 14): the worker loop only checks `fatal` before picking a
    // slot; this slot was already past that check when another slot's own
    // failure turned the job fatal while this one awaited its hold above.
    // Re-checked here, right before the request would actually be sent, so
    // no image is bought after the job is already known to be fatal.
    if (isFatal()) return { slot, kind: "skipped" };
    return await sendPair(deps, job, prompt, slot, ageShape);
  } finally {
    // Whatever was not reserved will not be sent. releaseHold on an id never
    // held (the age id, with the check off) is a harmless no-op.
    deps.budget.releaseHold(attemptId);
    deps.budget.releaseHold(ageId);
  }
}

async function sendPair(deps: CandidateJobDeps, job: CandidateJob, prompt: string, slot: number, ageShape: ChatPriceShape | null): Promise<SlotOutcome> {
  const choice = candidateImage(job.imageModel, job.imageQuality);
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
    aspectRatio: CANDIDATE_ASPECT_RATIO,
    quality: choice.quality,
    references: [],
  });
  if (image.status === "aborted") return { slot, kind: "aborted" };
  // A refusal is free and never retried; a bill above the worst case halts every later reserve.
  if (image.status !== "ok" || image.aboveWorst) return failedBy(slot, image, "the image attempt");
  const size = imageSize(image.bytes);
  if (size === null) return internal(slot, `the ${image.mediaType} image's size cannot be read`);
  if (isAnimatedImage(image.bytes)) {
    // On: the age check would judge whichever frame the decoder picks, not
    // necessarily the one a viewer sees. Off: there is no age check to
    // reference at all, so the reason must not name one that never ran.
    const reason = ageShape === null ? "only a still image can be stored as a photo" : "only a still image can be age-checked";
    return internal(slot, `the ${image.mediaType} image is animated; ${reason}`);
  }
  if (job.signal.aborted) return { slot, kind: "aborted" };
  // The image age check is off: no downscale (its only use is the age
  // check's own JPEG), no age check, nothing more to prepare — the candidate
  // is stored right away, with no qa.age verdict.
  if (ageShape === null) return storeCandidate(deps, job, slot, { attemptId, prompt, image, size });
  // The downscale is told to stop on a cancel or the timeout, and is not waited for past either.
  const timeoutMs = job.prepareTimeoutMs ?? PREPARE_TIMEOUT_MS;
  // timeoutSignal(), not AbortSignal.timeout(): the latter's own timer is
  // unref'd, which hung the Windows CI runs once M6 moved these tests onto
  // Bun's native AbortController/AbortSignal (timeoutSignal.ts's own doc
  // comment has the full story). Cleared below whichever way `prepare` ends,
  // so its ref'd timer never outlives this slot's own work.
  const timeout = timeoutSignal(timeoutMs);
  const prepare = AbortSignal.any([job.signal, timeout.signal]);
  let jpeg: Uint8Array;
  try {
    jpeg = await untilAborted(deps.downscale(image.bytes, prepare), prepare);
  } catch (error) {
    if (job.signal.aborted) return { slot, kind: "aborted" };
    // M8 (review fix): fatal only for a SYSTEMIC failure of the image
    // pipeline — the prepare timeout (30 s is generous; a hang this long
    // points at something stuck, not a merely slow decode) or a spawn
    // failure (the ffmpeg binary itself missing or not executable). Every
    // downscale spawns its own ffmpeg process from the same fixed path, so
    // either of those would fail the exact same way for every slot after
    // this one — continuing would only buy more images that can never be
    // checked or stored. A decode failure (ffmpeg ran, exited non-zero: this
    // one paid image was garbled or unusual) is this slot's own problem:
    // the other slots' own images are independent, so they still have their
    // own chance, and the batch must not report itself failed while candidates
    // it already stored sit unreported.
    if (prepare.aborted) return failed(slot, { code: "INTERNAL", detail: `preparing the image for the age check timed out after ${timeoutMs} ms` }, true);
    return failed(slot, { code: "INTERNAL", detail: `the image could not be prepared for the age check: ${messageOf(error)}` }, isSpawnFailure(error));
  } finally {
    timeout.clear();
  }
  return ageGate(deps, job, slot, ageShape, { attemptId, prompt, image, size, jpeg });
}

interface Checked {
  attemptId: string;
  prompt: string;
  image: ImageOk;
  size: { width: number; height: number };
}

interface CheckedForAge extends Checked {
  jpeg: Uint8Array;
}

/** `NewPhotoMeta` for a paid, checked image: `age` only when the image age check ran and gave a verdict (invariant 8's `qa.age`). */
function buildMeta(job: CandidateJob, slot: number, checked: Checked, age?: { adult: true; confidence: number }): NewPhotoMeta {
  const { image, size, prompt, attemptId } = checked;
  return {
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
    ...(age === undefined ? {} : { qa: { age } }),
  };
}

/** Stores a candidate that is going into the library, whether or not it carries an age verdict. */
async function storeCandidate(deps: CandidateJobDeps, job: CandidateJob, slot: number, checked: Checked, age?: { adult: true; confidence: number }): Promise<SlotOutcome> {
  try {
    const photo = await deps.store(checked.image.bytes, buildMeta(job, slot, checked, age));
    return { slot, kind: "passed", photoId: photo.id };
  } catch (error) {
    const why = age === undefined ? "" : "passed the age check but ";
    return internal(slot, `the candidate ${why}could not be stored: ${messageOf(error)}`);
  }
}

/** The age check of one paid image; only a clear yes stores it (invariant 8). */
async function ageGate(deps: CandidateJobDeps, job: CandidateJob, slot: number, ageShape: ChatPriceShape, checked: CheckedForAge): Promise<SlotOutcome> {
  const age = await deps.chat({
    attemptId: ageAttemptId(job.jobId, slot),
    jobId: job.jobId,
    scope: job.scope,
    budget: deps.budget,
    priceBook: deps.priceBook,
    signal: job.signal,
    model: ageShape.model,
    messages: ageShape.messages,
    jsonSchema: ageShape.jsonSchema,
    maxTokens: ageShape.maxTokens,
    inputTokens: ageShape.inputTokens,
    // ageShape.images: this one.
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

  return storeCandidate(deps, job, slot, checked, { adult: true, confidence: verdict.confidence });
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
