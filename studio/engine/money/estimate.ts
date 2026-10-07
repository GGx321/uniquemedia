import type { ImageQuality, PriceBook, PriceSource } from "./prices";

/** Invariant 7: at most 3 paid attempts per slot across all QA branches and fallbacks. */
export const MAX_ATTEMPTS_PER_SLOT = 3;

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
}

/** One image model configuration, as sent. */
export interface ImageChoice {
  model: string;
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

/**
 * The scene writer: its typical tokens scale with the number of scenes.
 * Review round 2/3: `RunRequest.count` (studio/shared/engine/state.ts)
 * allows up to 100 photos per run, more than one call can safely take, so
 * the writer phase (runs/writerPhase.ts) splits the plan into chunks of at
 * most `slotsPerCall` slots, each its own call retried up to `maxAttempts`
 * times. These two fields are the ONE source of truth for that shape: this
 * module (`estimateRun`'s own writer term) and scenes/writer.ts's
 * `chunkSlots`/`writerRunPrice` both read them from here, so they cannot
 * drift apart (estimate.test.ts and scenes/writer.test.ts both pin that the
 * two agree for the same slot count).
 */
export interface WriterCall extends Omit<ChatCall, "typical"> {
  typicalPerScene: TokenCounts;
  /** The most slots one call takes; chunked past this. */
  slotsPerCall: number;
  /** Attempts per chunk before the writer job gives up on it. */
  maxAttempts: number;
}

/**
 * Measured in the spike (2026-09-24, grok-4.3, $1.25/M in, $2.50/M out).
 * Ceilings: the writer's max_tokens 8K + 12K prompt = $0.035; an age check's
 * 1K + 2.2K prompt (one image) = $0.00525 — its prompt floor (text, schema
 * and the image allowance, openrouter/chat.ts) is ~2K, and the headroom keeps
 * a small wording change from raising every reserve above the estimate. Typical: the writer used 2,645 prompt
 * and 3,230 completion tokens for 25 scenes ($0.0112); 83 age checks averaged
 * 658 prompt and 334 completion tokens (max 747 / 573), $0.00166 at list price
 * ($0.00142 billed, with cached prompt tokens).
 *
 * `inputTokens` review round 1 (MEDIUM, 2026-09-27): 8K understated a real
 * chunk's prompt floor once the writer's own re-ask feedback is included
 * (scenes/writer.ts's promptTokenFloor, measured via
 * openrouter/chat.ts's promptTokenFloor): a full chunk (25 slots) plain
 * ~8_317, +the worst plausible refusal message ~9_168; 20 slots (the
 * product's documented default, one chunk) +worst refusal ~7_818. Raised to
 * 12_000: ~2_800 headroom over one full chunk's worst refusal
 * (scenes/writer.test.ts pins this, parametrised on `slotsPerCall`).
 * `maxTokens` (the output ceiling) is untouched: typical output was 3_230
 * tokens for 25 scenes, far under it.
 *
 * T5c (2026-09-27): pose was added to every slot sent to the writer, to the
 * system prompt's own rules, and to a worst refusal's own new
 * pose-contradiction problem. Re-measured: a full chunk plain ~10_045,
 * +worst refusal ~11_108; 20 slots +worst refusal ~9_429 — still under
 * 12_000, but the headroom had shrunk to ~892 tokens.
 *
 * T5c round 2 (owner decision, 2026-09-27): raised to 14_000 anyway, to
 * restore real headroom (~2_892 tokens over one full chunk's worst refusal)
 * rather than run this close to the edge. Per-call ceiling rises from
 * $0.035 to $0.0375 (14_000 × $1.25/M + 8_000 × $2.50/M); every worst-case
 * figure that includes the writer's share moves with it — see
 * estimate.test.ts, scenes/writer.test.ts's `writerRunPrice` tests and
 * docs/studio/2026-09-24-stage-2-plan.md, all re-derived from this constant,
 * not computed by hand.
 *
 * `slotsPerCall`/`maxAttempts` review round 2/3: `RunRequest.count` allows
 * up to 100 photos, possibly all in one category — far more slots than one
 * call can safely take (a 100-slot prompt floor alone measured ~30_223
 * tokens, a 50-slot one ~16_247, and 100 scenes' typical output alone
 * (~130 tokens/scene) is already over `maxTokens`), and a single call for
 * that many scenes is unreliable besides. `slotsPerCall: 25` chunks it
 * (scenes/writer.ts's `chunkSlots`); `maxAttempts: 2` is the same ceiling
 * as the descriptor's own retry (avatars/descriptor.ts), per chunk. Both
 * `estimateRun`'s worst case below and scenes/writer.ts's `writerRunPrice`
 * read these two fields — the one place they live.
 */
export const WRITER_CALL: WriterCall = {
  model: "x-ai/grok-4.3",
  maxTokens: 8_000,
  inputTokens: 14_000,
  images: 0,
  typicalPerScene: { inputTokens: 106, outputTokens: 130 },
  slotsPerCall: 25,
  maxAttempts: 2,
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
  /** The scene writer; null for a run whose sentences already exist (CS.5, a run from a scene set): no writer term in either figure. */
  writer: WriterCall | null;
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
  return book.imageWorstCase({ model: image.model, quality: image.quality, refs: image.refs });
}

function typicalMicros(book: PriceBook, call: ChatCall | null): number {
  return call ? book.chatCost({ model: call.model, images: call.images, ...call.typical }) : 0;
}

function ceilingMicros(book: PriceBook, call: Omit<ChatCall, "typical"> | null): number {
  return call ? book.chatWorstCase({ model: call.model, maxTokens: call.maxTokens, inputTokens: call.inputTokens, images: call.images }) : 0;
}

/**
 * The writer's own worst case for `slotCount` slots: chunked into calls of
 * at most `writer.slotsPerCall` (review round 2), each retried up to
 * `writer.maxAttempts` times before the writer job gives up on it (review
 * round 3) — `ceil(slotCount / slotsPerCall) * maxAttempts * the per-call
 * ceiling`. Naturally 0 at `slotCount` 0 (no chunk, no call, no
 * `Math.ceil(0 / n)` special case needed). The one place this is computed:
 * `estimateRun`'s own writer term below and scenes/writer.ts's
 * `writerRunPrice` both call this, so the two cannot drift apart
 * (writer.test.ts's own drift-guard test pins that they agree).
 */
export function writerWorstMicros(book: PriceBook, writer: WriterCall, slotCount: number): number {
  const chunkCount = Math.ceil(slotCount / writer.slotsPerCall);
  return chunkCount * writer.maxAttempts * ceilingMicros(book, writer);
}

/**
 * A photo run. Expected: one attempt per slot on the primary model, an age
 * check per photo and the writer at one attempt, chat at typical tokens.
 * Worst: every attempt of every slot on the dearest model of the route, an
 * age check per attempt, and the writer chunked and retried
 * (writerWorstMicros: `ceil(photos / slotsPerCall) * maxAttempts` calls at
 * its ceiling — review round 3: a flat one-call ceiling regardless of
 * `photos` priced the writer's worst case too low). The worst case is the
 * run's default cap.
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
  const { writer } = plan;
  const writerTypical =
    writer === null
      ? 0
      : book.chatCost({
          model: writer.model,
          images: writer.images,
          inputTokens: writer.typicalPerScene.inputTokens * plan.photos,
          outputTokens: writer.typicalPerScene.outputTokens * plan.photos,
        });
  return {
    expectedMicros: safe(plan.photos * (imageMicros(book, primary) + typicalMicros(book, plan.ageChecks)) + writerTypical),
    worstMicros: safe(
      plan.photos * plan.attemptsPerSlot * (dearestAttempt + ceilingMicros(book, plan.ageChecks)) + (writer === null ? 0 : writerWorstMicros(book, writer, plan.photos)),
    ),
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
  // Never priced when nothing is sent (rewrite-descriptor): an image model
  // with no price loaded must not block a job that never touches it.
  const image = job.candidates > 0 ? imageMicros(book, job.image) : 0;
  const descriptorExpected = descriptor === null ? 0 : typicalMicros(book, descriptor.call);
  const descriptorWorst = descriptor === null ? 0 : descriptor.maxAttempts * ceilingMicros(book, descriptor.call);
  return {
    expectedMicros: safe(job.candidates * (image + typicalMicros(book, job.ageChecks)) + descriptorExpected),
    worstMicros: safe(job.candidates * (image + ceilingMicros(book, job.ageChecks)) + descriptorWorst),
    priceSource: book.source,
  };
}
