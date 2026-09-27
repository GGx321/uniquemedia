import type { Estimate, ImageAgeCheck } from "../../shared/engine";
import { AGE_CHECK_CALL, estimateAvatarJob, type AvatarJobInput, type ImageChoice } from "../money/estimate";
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
  return { model: imageModel, resolution: "1K", quality: "low", refs: 0 };
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
