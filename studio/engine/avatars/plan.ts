import type { Estimate, ImageAgeCheck } from "../../shared/engine";
import { AGE_CHECK_CALL, estimateAvatarJob, type AvatarJobInput, type ChatCall, type ImageChoice } from "../money/estimate";
import type { PricedBook, PriceModels } from "../money/priceCache";
import { descriptorCall, DESCRIPTOR_MAX_ATTEMPTS } from "./descriptor";

// What an avatar job consists of, in one place: the estimate commands price
// it, the paid commands compare the user's accepted worst case with it and
// cap the job at it, and the candidate job (T6a part 2b) sends exactly these
// calls, so the reserves never exceed what the user was shown.

/** The models in the settings that an avatar job uses. */
export interface AvatarModels {
  imageModel: string;
  textModel: string;
}

/**
 * `new-avatar`: the descriptor call and the first batch. `next-batch`:
 * another batch for an existing draft. `rewrite-descriptor`: the descriptor
 * call alone, for an avatar whose stored descriptor fails today's rules —
 * no candidates, no age checks, master photo and name untouched.
 */
export type AvatarJobKind = "new-avatar" | "next-batch" | "rewrite-descriptor";

/** Candidate portraits per batch. */
export const CANDIDATES_PER_BATCH = 4;

/** A candidate portrait: 1K, 3:4, quality low, no reference (there is no face yet). */
export const CANDIDATE_ASPECT_RATIO = "3:4";

export function candidateImage(imageModel: string): ImageChoice {
  return { model: imageModel, quality: "low", refs: 0 };
}

/**
 * The models to price: the image model, the text model and, when the image
 * age check is on, its own model too (fixed decision: grok-4.3) for
 * `new-avatar`/`next-batch`. `rewrite-descriptor` sends neither an image nor
 * an age check (plan.ts's `jobInput`), so it needs only the text model priced
 * regardless of the toggle — an image model with no price loaded (unknown,
 * renamed, or the live fetch failed with nothing in the fallback table) must
 * never block a rewrite that never touches it. Both `kind` and `imageAgeCheck`
 * are required, not defaulted: a caller must always say which job and which
 * mode it means, so a forgotten argument fails loudly instead of silently
 * pricing (or, worse, spending) the wrong thing.
 */
export function avatarPriceModels(models: AvatarModels, kind: AvatarJobKind, imageAgeCheck: ImageAgeCheck): PriceModels {
  if (kind === "rewrite-descriptor") return { imageModels: [], chatModels: [models.textModel] };
  const chatModels = imageAgeCheck === "on" ? [models.textModel, AGE_CHECK_CALL.model] : [models.textModel];
  return { imageModels: [models.imageModel], chatModels: [...new Set(chatModels)] };
}

function jobInput(models: AvatarModels, kind: AvatarJobKind, imageAgeCheck: ImageAgeCheck): AvatarJobInput {
  return {
    candidates: kind === "rewrite-descriptor" ? 0 : CANDIDATES_PER_BATCH,
    image: candidateImage(models.imageModel),
    descriptor: kind === "next-batch" ? null : { call: descriptorCall(models.textModel), maxAttempts: DESCRIPTOR_MAX_ATTEMPTS },
    // rewrite-descriptor never touches candidates or age checks, whatever the
    // toggle; otherwise the owner's decision (2026-09-27) applies: off by
    // default, no age check at all.
    ageChecks: kind === "rewrite-descriptor" || imageAgeCheck === "off" ? null : AGE_CHECK_CALL,
  };
}

/**
 * The job's expected and worst cost in the contract's shape. The same models,
 * prices and toggle always give the same numbers: the traits do not enter it
 * (the descriptor prompt's size is bounded by its ceiling). `imageAgeCheck` is
 * required, not defaulted, for the same reason as `avatarPriceModels`'s own.
 */
export function avatarJobEstimate(priced: PricedBook, models: AvatarModels, kind: AvatarJobKind, imageAgeCheck: ImageAgeCheck): Estimate {
  const estimate = estimateAvatarJob(priced.book, jobInput(models, kind, imageAgeCheck));
  return {
    expectedMicros: estimate.expectedMicros,
    worstMicros: estimate.worstMicros,
    prices: estimate.priceSource,
    pricesAsOf: priced.asOf,
  };
}

/**
 * The cap of createDraft's own scope: every descriptor attempt at its
 * ceiling, which is all that scope ever sends. PRICE_CHANGED and the room in
 * the month are checked against the whole new-avatar job instead.
 */
export function descriptorJobCap(priced: PricedBook, models: AvatarModels): number {
  const call = descriptorCall(models.textModel);
  const attempt = priced.book.chatWorstCase({ model: call.model, maxTokens: call.maxTokens, inputTokens: call.inputTokens, images: call.images });
  return DESCRIPTOR_MAX_ATTEMPTS * attempt;
}

// ---------- T6c: import an existing avatar ----------

// The owner uploads one master photo he already has, instead of generating
// one from a prompt. A one-off vision call reads the staged photo and writes
// both her typed traits and her descriptor in one strict JSON answer
// (importDescribe.ts), gated by the same AvatarDescriptor/AvatarTraits rules
// as a generated avatar's. Two mandatory safeguards precede it: the owner's
// confirmation that the photo is an AI persona (a contract-level requirement,
// commands.ts's `confirmedAiPersona: z.literal(true)`) and, whatever the
// `imageAgeCheck` toggle says, the one-time image age check (ageCheck.ts) on
// the imported photo itself — an imported image bypasses the prompt's own
// 21+ anchoring, so this check is never optional here.

/** At most 2 describe attempts, mirroring the descriptor job's own retry limit (descriptor.ts's DESCRIPTOR_MAX_ATTEMPTS). */
export const IMPORT_DESCRIBE_MAX_ATTEMPTS = 2;

/**
 * The describe call's limits: longer than the plain descriptor call's (every
 * trait field, not just one string) and carries one attached image (the
 * staged photo, downscaled to its own — larger — side than the age check's
 * own image: importStaging.ts's IMPORT_DESCRIBE_MAX_SIDE, 1024, not
 * ageCheck.ts's AGE_CHECK_MAX_SIDE, 768). Typical counts are an estimate,
 * like the descriptor call's own.
 */
const IMPORT_DESCRIBE_LIMITS = { maxTokens: 3_000, inputTokens: 7_000, images: 1, typical: { inputTokens: 1_800, outputTokens: 650 } } as const;

/** One describe attempt on the settings' text model. */
export function importDescribeCall(textModel: string): ChatCall {
  return { model: textModel, ...IMPORT_DESCRIBE_LIMITS, typical: { ...IMPORT_DESCRIBE_LIMITS.typical } };
}

/**
 * The models an import job prices: the settings' text model (the vision
 * describe call) and the age check's own fixed model (AGE_CHECK_CALL) —
 * always both, whatever `imageAgeCheck` says: the import's own one-time age
 * check is mandatory regardless of that toggle (unlike a candidate batch's
 * optional one), so it is always priced.
 */
export function importPriceModels(models: AvatarModels): PriceModels {
  return { imageModels: [], chatModels: [...new Set([models.textModel, AGE_CHECK_CALL.model])] };
}

/**
 * The import job's expected and worst cost: one mandatory age check plus up
 * to IMPORT_DESCRIBE_MAX_ATTEMPTS describe attempts. Unlike createDraft or
 * generateCandidates, there is no separate batch scope: the whole command
 * runs in one scope, so this estimate's own `worstMicros` is exactly that
 * scope's cap.
 */
export function importJobEstimate(priced: PricedBook, models: AvatarModels): Estimate {
  const { book } = priced;
  const describe = importDescribeCall(models.textModel);
  const ageWorst = book.chatWorstCase({ model: AGE_CHECK_CALL.model, maxTokens: AGE_CHECK_CALL.maxTokens, inputTokens: AGE_CHECK_CALL.inputTokens, images: AGE_CHECK_CALL.images });
  const ageExpected = book.chatCost({ model: AGE_CHECK_CALL.model, images: AGE_CHECK_CALL.images, ...AGE_CHECK_CALL.typical });
  const describeWorst = book.chatWorstCase({ model: describe.model, maxTokens: describe.maxTokens, inputTokens: describe.inputTokens, images: describe.images });
  const describeExpected = book.chatCost({ model: describe.model, images: describe.images, ...describe.typical });
  return {
    expectedMicros: ageExpected + describeExpected,
    worstMicros: ageWorst + IMPORT_DESCRIBE_MAX_ATTEMPTS * describeWorst,
    prices: book.source,
    pricesAsOf: priced.asOf,
  };
}
