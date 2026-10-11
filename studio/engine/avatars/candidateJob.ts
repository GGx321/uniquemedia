import { createHash } from "node:crypto";
import { FfmpegError } from "../../node/runFfmpeg";
import { timeoutSignal, untilAborted } from "../money/timeoutSignal";
import { PORTRAIT_MIN_LIKENESS, PORTRAITS_PER_BATCH, type AvatarDescriptor, type EngineError, type FailedCandidateSlot, type FailedPortraitSlot, type ImageAgeCheck, type ImageQuality } from "../../shared/engine";
import type { FaceVerdict } from "../face/verdict";
import type { CandidatesJobEnd, PortraitsJobEnd } from "../jobs";
import type { LibraryReference, NewPhotoMeta } from "../library";
import { imageSize, isAnimatedImage } from "../library/media";
import type { Budget } from "../money/budget";
import { AGE_CHECK_CALL, type ImageChoice } from "../money/estimate";
import type { Scope } from "../money/ledger";
import type { PriceBook } from "../money/prices";
import { chatAttemptWorstMicros, type ChatPriceShape } from "../openrouter/chat";
import { toEngineError } from "../openrouter/engineError";
import { truncate } from "../openrouter/transport";
import type { AspectRatio, ChatResult, ImageOk, ImageResult, OpenRouterClient } from "../openrouter/types";
import { ageCheckMessages, ageJsonSchema, readAgeAnswer, type AgeRejection } from "./ageCheck";
import { PHOTO_ASPECT_RATIO } from "../money/prices";
import { clampCosine } from "../runs/faceGate";
import { QA_GATE_TIMEOUT_MS } from "../runs/qa";
import { CANDIDATE_ASPECT_RATIO, CANDIDATES_PER_BATCH, candidateImage, portraitImage } from "./plan";
import { candidatePrompt, PromptSubjectError, referencePortraitPrompt } from "./prompts";

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

// Stage 5, S5.3b: the same money path also runs the reference portrait batch (an imported avatar's master portrait, drawn from the imported photo). What differs is
// data, carried by a `BatchSpec`: the slots and their ids, the aspect ratio, the references sent, the prompt and an optional free `rank` step. Candidates build exactly
// the spec they always had (4 slots, `candidate-N`, 3:4, no reference, no rank), so their requests and attempt ids are byte-identical to before.

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
  /** Portraits only: PORTRAIT_RANK_TIMEOUT_MS unless a test says otherwise. */
  rankTimeoutMs?: number;
}

/**
 * The free ranking of one paid image (the face gate's check against the source photo's embedding). The slot is passed so a scripted gate answers by slot, not by call
 * order under concurrency. It may be slow or hang: the job bounds it and stops it on a cancel.
 */
export type RankSlot = (slot: number, bytes: Uint8Array, signal: AbortSignal) => Promise<FaceVerdict>;

/** Everything a batch of paid images differs by (see the header). */
export interface BatchSpec {
  /** The slots, in order; a worker pool takes them one by one. */
  slots: readonly number[];
  /** The slot as the stored photo names it (`PhotoSource.slot`); both attempt ids of the slot are made from it (`imageAttemptId`, `ageAttemptId`). */
  slotName: (slot: number) => string;
  aspectRatio: AspectRatio;
  /** The images sent with every request. `image.refs` is NOT trusted: the hold and the reserve both count these, through `imageChoiceOf`. */
  references: readonly LibraryReference[];
  image: ImageChoice;
  prompt: string;
  /** After the image and before the paid age check; absent for candidates. */
  rank?: RankSlot;
}

/** What `runPortraitJob` adds to the job: the imported photo as the one reference, and the ranking against it. */
export interface PortraitBatch {
  /** Exactly one: the estimate prices `refs: 1`, and the holds count what is sent. */
  references: readonly [LibraryReference];
  rank: RankSlot;
}

/** The ranking's bound, the run gate's own (a hung worker must not hold the holds, the claim and the paid-command count). */
export const PORTRAIT_RANK_TIMEOUT_MS = QA_GATE_TIMEOUT_MS;

/**
 * - passed: stored on the draft as `photoId`.
 * - passed.likeness: a ranked batch only, the image's likeness to the source photo (clamped to the cosine range).
 * - ranked-out: the ranking said the image is not the source photo's face (or has no face, or several); it is dropped, never stored, and pays no age check.
 * - rejected: the age check did not say a clear yes (or refused to answer); the image is dropped.
 * - failed: the slot could not finish; `fatal` stops the job from starting more slots;
 *   `reserveLeftOpen`: a request of it may have been billed (timeout, network), so its reserve waits for a reconcile.
 * - aborted: a cancel stopped it. skipped: it never started (a cancel or a fatal error came first).
 */
export type SlotOutcome =
  | { slot: number; kind: "passed"; photoId: string; likeness?: number }
  | { slot: number; kind: "ranked-out"; why: "unlike"; likeness: number }
  | { slot: number; kind: "ranked-out"; why: "no-face" | "multiple-faces" }
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

/** The attempt id of a slot's image, `<jobId>:<slotName>#1` (`<jobId>:candidate-<n>#1`, `<jobId>:portrait-<n>#1`); its age check's is `<jobId>:<slotName>:age#1`. */
export function imageAttemptId(jobId: string, slotName: string): string {
  return `${jobId}:${slotName}#1`;
}

function ageAttemptId(jobId: string, slotName: string): string {
  return `${jobId}:${slotName}:age#1`;
}

const CANDIDATE_SLOTS: readonly number[] = Array.from({ length: CANDIDATES_PER_BATCH }, (_, i) => i + 1);
const PORTRAIT_SLOTS: readonly number[] = Array.from({ length: PORTRAITS_PER_BATCH }, (_, i) => i + 1);

/** Today's candidate batch. Throws `PromptSubjectError` for a descriptor today's rules refuse. */
export function candidateBatchSpec(job: CandidateJob): BatchSpec {
  return {
    slots: CANDIDATE_SLOTS,
    slotName: (slot) => `candidate-${slot}`,
    aspectRatio: CANDIDATE_ASPECT_RATIO,
    references: [],
    image: candidateImage(job.imageModel, job.imageQuality),
    prompt: candidatePrompt(job.descriptor),
  };
}

/** The reference portrait batch: five 9:16 images drawn from the one reference, ranked against it. Throws `PromptSubjectError` as the candidates' does. */
export function portraitBatchSpec(job: CandidateJob, batch: PortraitBatch): BatchSpec {
  return {
    slots: PORTRAIT_SLOTS,
    slotName: (slot) => `portrait-${slot}`,
    aspectRatio: PHOTO_ASPECT_RATIO,
    references: batch.references,
    image: portraitImage(job.imageModel, job.imageQuality),
    prompt: referencePortraitPrompt(job.descriptor),
    rank: batch.rank,
  };
}

/**
 * The image a batch prices and sends. The ONE place `refs` is decided: it is the number of references actually sent, so a slot's hold and the client's reserve (which
 * counts `params.references`) cannot disagree.
 */
function imageChoiceOf(spec: BatchSpec): ImageChoice {
  return { ...spec.image, refs: spec.references.length };
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
 * Runs the candidate batch through the network pool and answers every slot's outcome, in slot order. Never throws: a slot that throws fails fatally. A descriptor
 * that today's rules refuse fails every slot before anything is sent.
 */
export function runCandidateJob(deps: CandidateJobDeps, job: CandidateJob): Promise<SlotOutcome[]> {
  return runSpecified(deps, job, CANDIDATE_SLOTS, () => candidateBatchSpec(job));
}

/** The same for the reference portrait batch (Stage 5, S5.3b). */
export function runPortraitJob(deps: CandidateJobDeps, job: CandidateJob, batch: PortraitBatch): Promise<SlotOutcome[]> {
  return runSpecified(deps, job, PORTRAIT_SLOTS, () => portraitBatchSpec(job, batch));
}

async function runSpecified(deps: CandidateJobDeps, job: CandidateJob, slots: readonly number[], build: () => BatchSpec): Promise<SlotOutcome[]> {
  let spec: BatchSpec;
  try {
    spec = build();
  } catch (error) {
    if (!(error instanceof PromptSubjectError)) throw error;
    return slots.map((slot) => failed(slot, { code: "DESCRIPTOR_INVALID", detail: error.message }, true));
  }
  return runBatch(deps, job, spec);
}

/** Runs a batch spec through the network pool; the outcomes in slot order. Never throws. */
export async function runBatch(deps: CandidateJobDeps, job: CandidateJob, spec: BatchSpec): Promise<SlotOutcome[]> {
  const { slots } = spec;
  const outcomes: SlotOutcome[] = slots.map((slot) => ({ slot, kind: "skipped" }));
  let fatal = false;
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (job.signal.aborted || fatal) return;
      const index = next++;
      const slot = slots[index];
      if (slot === undefined) return;
      let outcome: SlotOutcome;
      try {
        outcome = await runSlot(deps, job, spec, slot, () => fatal);
      } catch (error) {
        outcome = failed(slot, deps.errorOf(error), true);
      }
      outcomes[index] = outcome;
      if (outcome.kind === "failed" && outcome.fatal) fatal = true;
      if (outcome.kind === "passed" || outcome.kind === "ranked-out" || outcome.kind === "rejected" || outcome.kind === "failed") deps.onSlot?.(outcome);
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
async function runSlot(deps: CandidateJobDeps, job: CandidateJob, spec: BatchSpec, slot: number, isFatal: () => boolean): Promise<SlotOutcome> {
  const choice = imageChoiceOf(spec);
  const attemptId = imageAttemptId(job.jobId, spec.slotName(slot));
  const ageId = ageAttemptId(job.jobId, spec.slotName(slot));
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
    return await sendPair(deps, job, spec, slot, ageShape);
  } finally {
    // Whatever was not reserved will not be sent. releaseHold on an id never
    // held (the age id, with the check off) is a harmless no-op.
    deps.budget.releaseHold(attemptId);
    deps.budget.releaseHold(ageId);
  }
}

async function sendPair(deps: CandidateJobDeps, job: CandidateJob, spec: BatchSpec, slot: number, ageShape: ChatPriceShape | null): Promise<SlotOutcome> {
  const choice = imageChoiceOf(spec);
  const { prompt } = spec;
  const attemptId = imageAttemptId(job.jobId, spec.slotName(slot));
  const image = await deps.generateImage({
    attemptId,
    jobId: job.jobId,
    scope: job.scope,
    model: choice.model,
    budget: deps.budget,
    priceBook: deps.priceBook,
    signal: job.signal,
    prompt,
    aspectRatio: spec.aspectRatio,
    quality: choice.quality,
    references: spec.references,
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
  // A ranked batch (portraits): the free face check comes before anything else is paid for. An image that is not the source's face is dropped here, never stored
  // and never age-checked.
  let ranked: Rank | undefined;
  if (spec.rank !== undefined) {
    const result = await rankImage(job, spec.rank, slot, image.bytes);
    if (result.kind !== "ranked") return result.outcome;
    ranked = result.rank;
  }
  // The image age check is off: no downscale (its only use is the age
  // check's own JPEG), no age check, nothing more to prepare — the candidate
  // is stored right away, with no qa.age verdict.
  if (ageShape === null) return storeCandidate(deps, job, spec, slot, { attemptId, prompt, image, size, ...(ranked === undefined ? {} : { rank: ranked }) });
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
  return ageGate(deps, job, spec, slot, ageShape, { attemptId, prompt, image, size, jpeg, ...(ranked === undefined ? {} : { rank: ranked }) });
}

/** What the ranking said of an image that is the source's face: its likeness (clamped to the cosine range, which the photo schema caps) and its head ratio. */
interface Rank {
  likeness: number;
  headRatio: number;
}

interface Checked {
  attemptId: string;
  prompt: string;
  image: ImageOk;
  size: { width: number; height: number };
  rank?: Rank;
}

type Ranked = { kind: "ranked"; rank: Rank } | { kind: "ended"; outcome: SlotOutcome };

/**
 * The free ranking of one paid image, bounded by the run gate's 60 s (a hung worker must not hold the holds, the claim and the paid-command count) and stopped by a
 * cancel. A rank that throws is systemic (a dead worker, an undecodable image), so it fails the job, as the run gate does; but a cancel that stopped it is a cancel.
 */
async function rankImage(job: CandidateJob, rank: RankSlot, slot: number, bytes: Uint8Array): Promise<Ranked> {
  const timeoutMs = job.rankTimeoutMs ?? PORTRAIT_RANK_TIMEOUT_MS;
  const timeout = timeoutSignal(timeoutMs);
  const signal = AbortSignal.any([job.signal, timeout.signal]);
  let verdict: FaceVerdict;
  try {
    verdict = await untilAborted(rank(slot, bytes, signal), signal);
  } catch (error) {
    if (job.signal.aborted) return { kind: "ended", outcome: { slot, kind: "aborted" } };
    if (signal.aborted) return { kind: "ended", outcome: failed(slot, { code: "INTERNAL", detail: `ranking the image timed out after ${timeoutMs} ms` }, true) };
    return { kind: "ended", outcome: failed(slot, { code: "INTERNAL", detail: `the image could not be ranked: ${messageOf(error)}` }, true) };
  } finally {
    timeout.clear();
  }
  switch (verdict.kind) {
    case "match":
    case "mismatch": {
      // Decided here by the likeness against the contract's floor, not by the gate's own configured threshold: a stored or reported likeness must always fit the contract.
      const likeness = clampCosine(verdict.similarity);
      // Written as a negated `>=` so a NaN (a broken embedding) is out, never a candidate; the report needs a finite number, so it is the cosine's floor.
      if (!(likeness >= PORTRAIT_MIN_LIKENESS)) return { kind: "ended", outcome: { slot, kind: "ranked-out", why: "unlike", likeness: Number.isNaN(likeness) ? -1 : likeness } };
      return { kind: "ranked", rank: { likeness, headRatio: verdict.headRatio } };
    }
    case "no-face":
    case "multiple-faces":
      return { kind: "ended", outcome: { slot, kind: "ranked-out", why: verdict.kind } };
    default:
      // A pose rule or an unexpected face: not an answer the ranking asks for. This slot's own problem, not the job's.
      return { kind: "ended", outcome: internal(slot, `the face check gave no usable answer (${verdict.kind})`) };
  }
}

interface CheckedForAge extends Checked {
  jpeg: Uint8Array;
}

/** `NewPhotoMeta` for a paid, checked image: `age` only when the image age check ran and gave a verdict (invariant 8's `qa.age`). */
function buildMeta(job: CandidateJob, spec: BatchSpec, slot: number, checked: Checked, age?: { adult: true; confidence: number }): NewPhotoMeta {
  const { image, size, prompt, attemptId, rank } = checked;
  // The ranking's fields (a ranked batch) and the age verdict (the check on); a candidate with neither has no qa at all.
  const qa = { ...(rank === undefined ? {} : { faceCos: rank.likeness, headRatio: rank.headRatio }), ...(age === undefined ? {} : { age }) };
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
      slot: spec.slotName(slot),
      costMicros: image.costMicros,
    },
    ...(Object.keys(qa).length === 0 ? {} : { qa }),
  };
}

/** Stores a candidate that is going into the library, whether or not it carries an age verdict. */
async function storeCandidate(deps: CandidateJobDeps, job: CandidateJob, spec: BatchSpec, slot: number, checked: Checked, age?: { adult: true; confidence: number }): Promise<SlotOutcome> {
  try {
    const photo = await deps.store(checked.image.bytes, buildMeta(job, spec, slot, checked, age));
    return { slot, kind: "passed", photoId: photo.id, ...(checked.rank === undefined ? {} : { likeness: checked.rank.likeness }) };
  } catch (error) {
    const why = age === undefined ? "" : "passed the age check but ";
    return internal(slot, `the candidate ${why}could not be stored: ${messageOf(error)}`);
  }
}

/** The age check of one paid image; only a clear yes stores it (invariant 8). */
async function ageGate(deps: CandidateJobDeps, job: CandidateJob, spec: BatchSpec, slot: number, ageShape: ChatPriceShape, checked: CheckedForAge): Promise<SlotOutcome> {
  const age = await deps.chat({
    attemptId: ageAttemptId(job.jobId, spec.slotName(slot)),
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

  return storeCandidate(deps, job, spec, slot, checked, { adult: true, confidence: verdict.confidence });
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

/**
 * How a reference portrait batch ended (Stage 5, S5.3b). A cancel that stopped a slot is a cancel; a fatal error fails it, even with portraits stored (they are in the
 * library already). Otherwise it is done when any slot gave a candidate or reached a verdict on a paid image (ranked out, or judged by the age check): that includes no
 * candidate at all, the «none passed» end the window explains. When every slot ended before any verdict (e.g. five refusals) it failed with the first slot's error.
 * Candidates come best first, ties by photo id.
 */
export function portraitJobEnd(outcomes: readonly SlotOutcome[], cancelRequested: boolean): PortraitsJobEnd {
  if (cancelRequested && outcomes.some((o) => o.kind === "aborted" || o.kind === "skipped")) return { status: "cancelled" };
  const failures = outcomes.flatMap((o) => (o.kind === "failed" ? [o] : []));
  const fatal = failures.find((o) => o.fatal);
  if (fatal !== undefined) return { status: "failed", error: fatal.error };
  const candidates = outcomes
    .flatMap((o) => (o.kind === "passed" && o.likeness !== undefined ? [{ photoId: o.photoId, likeness: o.likeness }] : []))
    .sort((a, b) => b.likeness - a.likeness || (a.photoId < b.photoId ? -1 : a.photoId > b.photoId ? 1 : 0));
  const failedSlots = [...outcomes]
    .sort((a, b) => a.slot - b.slot)
    .flatMap((o): FailedPortraitSlot[] => {
      if (o.kind === "rejected") return [{ slot: o.slot, reason: "age-rejected" }];
      if (o.kind === "ranked-out") return [o.why === "unlike" ? { slot: o.slot, reason: "unlike", likeness: o.likeness } : { slot: o.slot, reason: o.why }];
      if (o.kind === "failed") return [{ slot: o.slot, reason: "failed", error: o.error, reserveLeftOpen: o.reserveLeftOpen }];
      return [];
    });
  if (candidates.length === 0 && failedSlots.every((f) => f.reason === "failed")) {
    return { status: "failed", error: failures[0]?.error ?? { code: "INTERNAL", detail: "no portrait slot ran" } };
  }
  return { status: "done", candidates, failedSlots };
}
