import type { ImageQuality, PriceBook, PriceSource, Resolution } from "./prices";

/** Invariant 7: at most 3 paid attempts per slot across all QA branches and fallbacks. */
export const MAX_ATTEMPTS_PER_SLOT = 3;

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
}

/** One image model configuration, as sent. */
export interface ImageChoice {
  model: string;
  resolution: Resolution;
  quality: ImageQuality | null;
  refs: number;
}

/** A chat call: `maxTokens` and `inputTokens` bound the worst case; `typical` gives the expected cost. */
export interface ChatCall {
  model: string;
  maxTokens: number;
  /** Prompt-token ceiling, images included. */
  inputTokens: number;
  /** Input images, for models with a per-image price. */
  images: number;
  typical: TokenCounts;
}

/** The scene writer: one call per run; its typical tokens scale with the number of scenes. */
export interface WriterCall extends Omit<ChatCall, "typical"> {
  typicalPerScene: TokenCounts;
}

/**
 * Measured in the spike (2026-09-24, grok-4.3, $1.25/M in, $2.50/M out).
 * Ceilings: the writer's max_tokens 8K + ~8K prompt = $0.03; an age check's
 * 1K + 2.2K prompt (one image) = $0.00525 — its prompt floor (text, schema
 * and the image allowance, openrouter/chat.ts) is ~2K, and the headroom keeps
 * a small wording change from raising every reserve above the estimate. Typical: the writer used 2,645 prompt
 * and 3,230 completion tokens for 25 scenes ($0.0112); 83 age checks averaged
 * 658 prompt and 334 completion tokens (max 747 / 573), $0.00166 at list price
 * ($0.00142 billed, with cached prompt tokens).
 */
export const WRITER_CALL: WriterCall = {
  model: "x-ai/grok-4.3",
  maxTokens: 8_000,
  inputTokens: 8_000,
  images: 0,
  typicalPerScene: { inputTokens: 106, outputTokens: 130 },
};
export const AGE_CHECK_CALL: ChatCall = {
  model: "x-ai/grok-4.3",
  maxTokens: 1_000,
  inputTokens: 2_200,
  images: 1,
  typical: { inputTokens: 658, outputTokens: 335 },
};

export interface RunPlanInput {
  photos: number;
  attemptsPerSlot: number;
  /** The provider route of every slot: the primary model first, then its fallbacks (e.g. Seedream on a refusal). */
  route: readonly [ImageChoice, ...ImageChoice[]];
  writer: WriterCall;
  /** The age check run on every returned image; null when age checks are off. */
  ageChecks: ChatCall | null;
}

export interface AvatarJobInput {
  candidates: number;
  image: ImageChoice;
  /**
   * The descriptor call of a new avatar and how many paid attempts it may take
   * (a rejected answer is asked once more); null for another batch of an
   * existing draft.
   */
  descriptor: { call: ChatCall; maxAttempts: number } | null;
  ageChecks: ChatCall | null;
}

export interface Estimate {
  /** One attempt per slot on the primary model, chat calls at their typical token counts. */
  expectedMicros: number;
  /** Every attempt of every slot on the dearest model of the route, chat calls at their ceilings. */
  worstMicros: number;
  /** "fallback" when any price came from the dated table; the UI must say so. */
  priceSource: PriceSource;
}

function assertCount(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative integer, got ${value}`);
}

function safe(value: number): number {
  if (!Number.isSafeInteger(value)) throw new RangeError("estimate is out of range");
  return value;
}

function imageMicros(book: PriceBook, image: ImageChoice): number {
  return book.imageWorstCase({ model: image.model, resolution: image.resolution, quality: image.quality, refs: image.refs });
}

function typicalMicros(book: PriceBook, call: ChatCall | null): number {
  return call ? book.chatCost({ model: call.model, images: call.images, ...call.typical }) : 0;
}

function ceilingMicros(book: PriceBook, call: Omit<ChatCall, "typical"> | null): number {
  return call ? book.chatWorstCase({ model: call.model, maxTokens: call.maxTokens, inputTokens: call.inputTokens, images: call.images }) : 0;
}

/**
 * A photo run. Expected: one attempt per slot on the primary model, an age
 * check per photo and the writer, chat at typical tokens. Worst: every attempt
 * of every slot on the dearest model of the route, an age check per attempt
 * and the writer, chat at its ceilings. The worst case is the run's default cap.
 */
export function estimateRun(book: PriceBook, plan: RunPlanInput): Estimate {
  assertCount("photos", plan.photos);
  if (!Number.isSafeInteger(plan.attemptsPerSlot) || plan.attemptsPerSlot < 1 || plan.attemptsPerSlot > MAX_ATTEMPTS_PER_SLOT) {
    throw new RangeError(`attemptsPerSlot must be 1..${MAX_ATTEMPTS_PER_SLOT}, got ${plan.attemptsPerSlot}`);
  }
  const [primary] = plan.route;
  if (primary === undefined) throw new RangeError("the provider route must name at least one model");
  if (plan.photos === 0) return { expectedMicros: 0, worstMicros: 0, priceSource: book.source };

  const dearestAttempt = Math.max(...plan.route.map((choice) => imageMicros(book, choice)));
  const writerTypical = book.chatCost({
    model: plan.writer.model,
    images: plan.writer.images,
    inputTokens: plan.writer.typicalPerScene.inputTokens * plan.photos,
    outputTokens: plan.writer.typicalPerScene.outputTokens * plan.photos,
  });
  return {
    expectedMicros: safe(plan.photos * (imageMicros(book, primary) + typicalMicros(book, plan.ageChecks)) + writerTypical),
    worstMicros: safe(plan.photos * plan.attemptsPerSlot * (dearestAttempt + ceilingMicros(book, plan.ageChecks)) + ceilingMicros(book, plan.writer)),
    priceSource: book.source,
  };
}

/**
 * An avatar job: every candidate portrait and its age check, plus the
 * descriptor call when there is one. Expected: one descriptor attempt at its
 * typical tokens. Worst: every descriptor attempt at its ceilings. Portraits
 * and age checks are not retried.
 */
export function estimateAvatarJob(book: PriceBook, job: AvatarJobInput): Estimate {
  assertCount("candidates", job.candidates);
  const { descriptor } = job;
  if (descriptor !== null && (!Number.isSafeInteger(descriptor.maxAttempts) || descriptor.maxAttempts < 1)) {
    throw new RangeError(`descriptor maxAttempts must be a positive integer, got ${descriptor.maxAttempts}`);
  }
  const image = imageMicros(book, job.image);
  const descriptorExpected = descriptor === null ? 0 : typicalMicros(book, descriptor.call);
  const descriptorWorst = descriptor === null ? 0 : descriptor.maxAttempts * ceilingMicros(book, descriptor.call);
  return {
    expectedMicros: safe(job.candidates * (image + typicalMicros(book, job.ageChecks)) + descriptorExpected),
    worstMicros: safe(job.candidates * (image + ceilingMicros(book, job.ageChecks)) + descriptorWorst),
    priceSource: book.source,
  };
}
