import type { ImageQuality, ImageResolution, PriceBook, PriceSource } from "./prices";

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
  /** 5a.3 (S5.9d): absent = 1K. Only the «Смелая» route's choice says 2K. */
  resolution?: ImageResolution;
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
  /**
   * 5a.4 (S5.BA5a round 2, M1): the typical tokens of one request whatever its scenes (the system prompt and schema in, the reasoning out), on top of
   * `typicalPerScene` × its scenes; absent = none. The expected figure only, never a reserve or a cap (`writerExpectedMicros`). WRITER_CALL has none:
   * its own typical was measured on a full chunk, the fixed part shared by its 25 scenes, so every ordinary figure is unchanged.
   */
  typicalPerCall?: TokenCounts;
  /** The most slots one call takes; chunked past this. */
  slotsPerCall: number;
  /** Attempts per chunk before the writer job gives up on it. */
  maxAttempts: number;
  /**
   * 5a.4 (S5.BA5, plan s5a4 §5.3.4, r2.1 N1): the reasoning allowance, in tokens; absent = 0. grok-4.3 bills its reasoning as completion on top of
   * `max_tokens` (S5.WCX), so an attempt is priced and reserved at `maxTokens + reasoningTokens` completion tokens (`writerAttemptWorstMicros` here,
   * openrouter/chat.ts's `chatAttemptWorstMicros` for the reserve). Never sent. WRITER_CALL has none, so every ordinary figure is unchanged.
   */
  reasoningTokens?: number;
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
/**
 * 5a.4 (S5.BA5, plan s5a4 r2.4 §5.3.4 «The decision: (c)», I5.77): the scene writer in bold mode, a custom category at «Смелая». Its prompt is larger
 * (the bold rules, each slot's `world` and capture label, the bold refusal reasons), so a full chunk of 25 does not fit WRITER_CALL's 14 000: the worst
 * bold chunk measured 16 156 tokens with every refusal reason (S5.BAT), and the ceiling is 17 000 (r2.2 P4). `maxTokens` is the ordinary 8 000, plus a
 * reasoning allowance of 3 000 tokens priced as completion on top of it (grok-4.3 bills its reasoning as completion, S5.WCX's figure for SUGGEST and
 * TRANSLATE, money/motionEstimate.ts). One attempt at the fallback prices: 17 000 × $1.25/M + 11 000 × $2.50/M = 48 750 µ$; a chunk, two attempts,
 * 97 500 µ$ («до $0.098»). The chunk size and the attempts are the ordinary ones, so no chunking moves (estimate.writerCall.test.ts pins both).
 *
 * The typical tokens (the expected figure only; never a reserve or a cap; round 2, M1) come from the five bold calls measured on grok-4.3 with the real
 * 3 764-byte system prompt (2026-10-26): two 2-slot calls at effort «low», 1 258 / 2 060 (1 935 of them reasoning) and 1 274 / 1 577 (1 460), and one
 * 25-slot chunk three ways, 2 963 / 1 887 (435) with no reasoning field, 2 963 / 2 463 (1 018) at «low» and 2 955 / 1 123 (0) at «none». The reasoning
 * does not grow with the slots (it is 0 to 1 935 a call), so a figure per scene alone cannot fit both sizes; the figure is a per-call term plus a
 * per-scene term, each fitted so every measured call is expected at or above its tokens (and so its list price and its bill):
 * - `typicalPerScene`: in, the steepest growth from a 2-slot to a 25-slot call, ⌈(2 963 − 1 258) / 23⌉ = 75 (a slot's JSON); out, the largest visible
 *   answer a slot with the reasoning left out, ⌈(2 060 − 1 935) / 2⌉ = 63 (its sentence).
 * - `typicalPerCall`: the largest residual over the five calls, 1 274 − 2 × 75 = 1 124 in (the system prompt and the schema) and 2 060 − 2 × 63 = 1 934
 *   out (the reasoning).
 * So one request of 2 scenes expects 1 274 / 2 060, 6 743 µ$ (bills $0.0066 and $0.0054), and a full chunk of 25 expects 2 999 / 3 509, 12 522 µ$ (bills
 * $0.0064 to $0.0083), under its 17 000 / 11 000 ceilings; 20 scenes in one request expect 11 265 µ$. C-BA re-measures it on the final prompt.
 */
export const WRITER_BOLD_CALL: WriterCall = {
  model: "x-ai/grok-4.3",
  maxTokens: 8_000,
  reasoningTokens: 3_000,
  inputTokens: 17_000,
  images: 0,
  typicalPerScene: { inputTokens: 75, outputTokens: 63 },
  typicalPerCall: { inputTokens: 1_124, outputTokens: 1_934 },
  slotsPerCall: 25,
  maxAttempts: 2,
};

/** The scene writer's two modes: «ordinary» for every request below «Смелая» and every built-in category, «bold» for a custom category at «Смелая». */
export type WriterMode = "ordinary" | "bold";

/**
 * 5a.4 (S5.BA5, r2.1 L2): the ONE door to the writer's call shape. Every site that prices, reserves or bounds a writer attempt asks it for the mode's
 * shape (writerCall.static.test.ts holds every other module to `slotsPerCall` and `maxAttempts` reads alone). «ordinary» is WRITER_CALL itself, so
 * every ordinary figure stays byte-identical; a mode outside the two (untyped data) throws rather than price as the cheaper shape.
 */
export function writerCallOf(mode: WriterMode): WriterCall {
  switch (mode) {
    case "ordinary":
      return WRITER_CALL;
    case "bold":
      return WRITER_BOLD_CALL;
    default:
      throw new RangeError(`no writer call for mode ${String(mode satisfies never)}`);
  }
}

export const AGE_CHECK_CALL: ChatCall = {
  model: "x-ai/grok-4.3",
  maxTokens: 1_000,
  inputTokens: 2_200,
  images: 1,
  typical: { inputTokens: 658, outputTokens: 335 },
};

/**
 * Stage 5, S5.0c: one descriptor-vs-master check attempt (avatars/plan.ts's `descriptorCheckCall` swaps the model for the settings' text model): the master photo
 * (the import's downscaled JPEG) and the stored descriptor in, a short JSON verdict out. 1.5K out at the ceiling: room for a 600-char proposal, the four aspects and the
 * model's reasoning (1K may truncate it). The input ceiling is 7K, not the 3K the plan first said: the reserve never goes below the prompt's byte floor (chat.ts's
 * `promptTokenFloor`: a token per byte of the system prompt, the schema and the message, plus the image allowance), which is about 5.3K for the shortest descriptor and 6.7K
 * for the longest one the contract allows, so a 3K ceiling would reserve more than the estimate priced and the scope's cap would refuse the call (descriptorCheck.test.ts
 * holds the longest prompt under this number). Typical (the expected figure, ≈ $0.0034) is 1.7K in / 500 out, by analogy with the describe call's measured 1.8K / 650 (the check prompt is about 85% of the describe's, with the same 1024 px image);
 * the first live check measures it.
 */
export const DESCRIPTOR_CHECK_CALL: ChatCall = {
  model: "x-ai/grok-4.3",
  maxTokens: 1_500,
  inputTokens: 7_000,
  images: 1,
  typical: { inputTokens: 1_700, outputTokens: 500 },
};

export interface RunPlanInput {
  photos: number;
  attemptsPerSlot: number;
  /** The provider route of every slot: the primary model first, then its fallbacks (e.g. Seedream on a refusal). */
  route: readonly [ImageChoice, ...ImageChoice[]];
  /** The scene writer; null for a run whose sentences already exist (CS.5, a run from a scene set): no writer term in either figure. */
  writer: WriterCall | null;
  /** 5a.2: the model's share of the slots; absent, every photo can go to the writer (a plan with no template in it). */
  writerLoad?: WriterLoad;
  /** The age check run on every returned image; null when age checks are off. */
  ageChecks: ChatCall | null;
  /**
   * 5a.3 (S5.9d, plan s5a3 §10.2): how many of the photos are drawn on the «Смелая» route and the choice they are sent with (2K, one reference). Such a photo is priced
   * at that choice, never below the dearest model of the route, three attempts, with no fallback; the other photos are priced as before. Absent = none.
   */
  bold?: { photos: number; image: ImageChoice };
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
  /** 5a.3 (S5.9d): the price of one attempt on the «Смелая» route (list, 2K, the master as its reference); present only when a photo is on that route. */
  boldAttemptMicros?: number;
}

function assertCount(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative integer, got ${value}`);
}

function safe(value: number): number {
  if (!Number.isSafeInteger(value)) throw new RangeError("estimate is out of range");
  return value;
}

function imageMicros(book: PriceBook, image: ImageChoice): number {
  return book.imageWorstCase({ model: image.model, quality: image.quality, refs: image.refs, ...(image.resolution === undefined ? {} : { resolution: image.resolution }) });
}

function typicalMicros(book: PriceBook, call: ChatCall | null): number {
  return call ? book.chatCost({ model: call.model, images: call.images, ...call.typical }) : 0;
}

function ceilingMicros(book: PriceBook, call: Omit<ChatCall, "typical"> | null): number {
  return call ? book.chatWorstCase({ model: call.model, maxTokens: call.maxTokens, inputTokens: call.inputTokens, images: call.images }) : 0;
}

/**
 * 5a.4 (S5.BA5, r2.1 N1): ONE writer attempt at its ceilings: the prompt at `inputTokens` and the completion at `maxTokens` plus the reasoning allowance
 * (`reasoningTokens`, absent = 0), which grok-4.3 bills as completion on top of `max_tokens`. The one price of a writer attempt: `writerChunksMicros`
 * here, a scene set's compose, «Дописать» and write (sceneSets/estimate.ts, and through it the launch unit) and a resume (runs/remaining.ts) all read it,
 * and the reserve chat() makes for the same call (openrouter/chat.ts's `chatAttemptWorstMicros`) adds the same allowance, so the reserve equals the
 * estimate. For WRITER_CALL (no allowance) it is today's ceiling exactly, 37 500 µ$ at the fallback prices.
 */
export function writerAttemptWorstMicros(book: PriceBook, call: WriterCall): number {
  const reasoningTokens = call.reasoningTokens ?? 0;
  if (!Number.isSafeInteger(reasoningTokens) || reasoningTokens < 0) throw new TypeError(`reasoningTokens must be a non-negative integer, got ${reasoningTokens}`);
  return book.chatWorstCase({ model: call.model, maxTokens: call.maxTokens + reasoningTokens, inputTokens: call.inputTokens, images: call.images });
}

const NO_TOKENS: TokenCounts = Object.freeze({ inputTokens: 0, outputTokens: 0 });

/**
 * 5a.4 (S5.BA5a round 2, M1): the writer's expected cost for `requests` requests carrying `scenes` scenes in all, one attempt each at the typical tokens:
 * `typicalPerCall` once a request plus `typicalPerScene` a scene, priced in one call of the book. The one place the writer's typical tokens are read:
 * `estimateRun`'s writer term, `writerRunPrice`, a scene set's compose, «Дописать» and write (and through them the launch unit's table) and a resume all
 * ask it (writerCall.static.test.ts). For WRITER_CALL (no per-call term) it is today's figure exactly, whatever the requests.
 */
export function writerExpectedMicros(book: PriceBook, call: WriterCall, requests: number, scenes: number): number {
  assertCount("writer requests", requests);
  assertCount("writer scenes", scenes);
  const perCall = call.typicalPerCall ?? NO_TOKENS;
  return book.chatCost({
    model: call.model,
    images: call.images,
    inputTokens: perCall.inputTokens * requests + call.typicalPerScene.inputTokens * scenes,
    outputTokens: perCall.outputTokens * requests + call.typicalPerScene.outputTokens * scenes,
  });
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
  return writerChunksMicros(book, writer, Math.ceil(slotCount / writer.slotsPerCall));
}

/**
 * 5a.2 (S5.6c2): the writer's worst case for `chunkCount` requests, each retried up to `maxAttempts` times at the ceiling. `writerWorstMicros` is this for
 * a plan whose every slot can go to the model; a plan whose built-in and covered slots render in code asks `writerChunksWorst` (shared/scenes) for the
 * count. No request prices nothing, so the writer's model needs no price then.
 */
export function writerChunksMicros(book: PriceBook, writer: WriterCall, chunkCount: number): number {
  assertCount("writer chunks", chunkCount);
  return chunkCount === 0 ? 0 : chunkCount * writer.maxAttempts * writerAttemptWorstMicros(book, writer);
}

/** The model's share of a run's slots: the requests it can need at worst, and the scenes those requests can carry (shared/scenes' `writerChunksWorst` and `llmPossibleSlots`). */
export interface WriterLoad {
  chunks: number;
  scenes: number;
}

function checkWriterLoad(writer: WriterCall, load: WriterLoad): void {
  assertCount("writer chunks", load.chunks);
  assertCount("writer scenes", load.scenes);
  if (load.scenes > load.chunks * writer.slotsPerCall) throw new RangeError(`${load.chunks} writer chunks cannot carry ${load.scenes} scenes`);
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
  // 5a.3 (S5.9d): the photos on the «Смелая» route, priced at their own 2K choice. None: not a price is read for it, so a price list with no 2K line still prices every other run.
  const boldPhotos = plan.bold?.photos ?? 0;
  assertCount("bold photos", boldPhotos);
  if (boldPhotos > plan.photos) throw new RangeError(`bold photos (${boldPhotos}) cannot exceed photos (${plan.photos})`);
  const boldAttempt = plan.bold === undefined || boldPhotos === 0 ? null : imageMicros(book, plan.bold.image);
  const plainPhotos = plan.photos - boldPhotos;

  const dearestAttempt = Math.max(...plan.route.map((choice) => imageMicros(book, choice)));
  const { writer } = plan;
  // 5a.2: without a load every photo is a model scene (the old figure); with one, only the model's share is priced.
  const load: WriterLoad | null = writer === null ? null : (plan.writerLoad ?? { chunks: Math.ceil(plan.photos / writer.slotsPerCall), scenes: plan.photos });
  if (writer !== null && load !== null) checkWriterLoad(writer, load);
  // Round 2 (M1): one attempt of each request the load can need, at the typical tokens.
  const writerTypical = writer === null || load === null || load.scenes === 0 ? 0 : writerExpectedMicros(book, writer, load.chunks, load.scenes);
  const ageTypical = typicalMicros(book, plan.ageChecks);
  const ageCeiling = ceilingMicros(book, plan.ageChecks);
  // A bold photo is never priced below the dearest model of the route (the settings' model may cost more than Seedream 2K), and has no fallback attempt.
  const boldWorst = boldAttempt === null ? 0 : boldPhotos * plan.attemptsPerSlot * (Math.max(boldAttempt, dearestAttempt) + ageCeiling);
  // The expected figure never falls below the owner's model either: an ordinary frame of a «Смелая» category is drawn on it, one attempt.
  const boldExpected = boldAttempt === null ? 0 : boldPhotos * (Math.max(boldAttempt, imageMicros(book, primary)) + ageTypical);
  return {
    expectedMicros: safe(plainPhotos * (imageMicros(book, primary) + ageTypical) + boldExpected + writerTypical),
    worstMicros: safe(plainPhotos * plan.attemptsPerSlot * (dearestAttempt + ageCeiling) + boldWorst + (writer === null || load === null ? 0 : writerChunksMicros(book, writer, load.chunks))),
    priceSource: book.source,
    ...(boldAttempt === null ? {} : { boldAttemptMicros: boldAttempt }),
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
