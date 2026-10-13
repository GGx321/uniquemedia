import {
  BOLD_CLIPS,
  GROK_FALLBACK,
  clipExpectedMicros,
  clipWorstMicros,
  type BoldClipsMode,
  type ClipModelChoice,
  type ClipOptionKey,
  type ClipPriceParts,
  type ClipPrices,
  type ClipQuality,
  type ClipRates,
  type ClipSeconds,
} from "../../shared/engine/clips";
import type { Estimate } from "../../shared/engine/estimate";
import type { PricedBook } from "./priceCache";
import type { VideoTier } from "./prices";

// 5b.1 (S5.V2, plan s5b1 §5.9): the estimate of a clip over the price book, through the shared formulas of `shared/engine/clips.ts` (`clipWorstMicros`, `clipExpectedMicros`), the
// same ones the engine reserves with and the mock shows with. This module adds no arithmetic of its own, so the estimate can never sit below what the reserve will hold.
// Prices reach the formulas as the whole micro-dollars the parser rounded UP to (prices.ts, `videoMicros`); nothing here rounds, and a float would be refused (RangeError).

/** What the owner chose on the sheet, plus whether the photo is a frame of «Смелая» (I5.57). */
export interface ClipEstimateRequest {
  model: ClipModelChoice;
  quality: ClipQuality;
  seconds: ClipSeconds;
  /** `none`: the owner forbade a second model for this clip. */
  fallback: "auto" | "none";
  bold?: boolean;
}

export interface ClipEstimateOptions {
  /** The engine's mode (`GROK_FALLBACK`); a parameter so both modes can be tested. */
  mode?: "auto" | "offer";
  /** Defaults to `BOLD_CLIPS`; a parameter so every value can be tested. */
  boldClips?: BoldClipsMode;
}

/** The three rates of one clip's price book, read once at `clips.create` (I5.46). Throws PRICE_UNAVAILABLE for the video scope when the book was not loaded for a tier. */
export function clipPricesOf(priced: PricedBook): ClipPrices {
  const rates = (tier: VideoTier): ClipRates => {
    const price = priced.book.videoPrice(tier);
    return { perSecondMicros: price.perSecondMicros, perInputImageMicros: price.perInputImageMicros };
  };
  return { std: rates("std"), pro: rates("pro"), grok: rates("grok") };
}

function partsOf(prices: ClipPrices, req: ClipEstimateRequest, opts: ClipEstimateOptions): ClipPriceParts {
  return {
    model: req.model,
    quality: req.quality,
    seconds: req.seconds,
    mode: opts.mode ?? GROK_FALLBACK,
    fallback: req.fallback,
    ...(req.bold === undefined ? {} : { bold: req.bold }),
    boldClips: opts.boldClips ?? BOLD_CLIPS,
    prices,
  };
}

function estimateOver(priced: PricedBook, prices: ClipPrices, req: ClipEstimateRequest, opts: ClipEstimateOptions): Estimate {
  const parts = partsOf(prices, req, opts);
  return {
    expectedMicros: clipExpectedMicros(parts),
    worstMicros: clipWorstMicros(parts),
    prices: priced.book.videoSource,
    // The video part's own day (the video table's date when it stood in, else the load's day), never a mixed book's image-table date. A hand-built PricedBook without it: the
    // video table's date when it stood in, else `asOf`.
    pricesAsOf: priced.videoAsOf ?? priced.book.videoFallbackDate ?? priced.asOf,
  };
}

/**
 * The cost of one clip. Worst is the dearest branch that can run, not the sum: in mode `auto` with a fallback, max(Kling's reserve, Grok's reserve); in mode `offer`, with fallback
 * `none`, for a frame of «Смелая» under `kling-only` and for a `model: "grok"` clip, the first model's reserve alone.
 */
export function estimateClip(priced: PricedBook, req: ClipEstimateRequest, opts: ClipEstimateOptions = {}): Estimate {
  return estimateOver(priced, clipPricesOf(priced), req, opts);
}

export interface ClipOptionPrices {
  /** The Kling options as the sheet shows them (the worst includes Grok behind Kling where the mode and the photo allow it), and the Grok offer at 5 and 10 s. */
  prices: Record<ClipOptionKey | "grok5" | "grok10", Estimate>;
  /** The same Kling options with `fallback: "none"`: what «Оживить без запасной модели» shows. */
  noFallbackPrices: Record<ClipOptionKey, Estimate>;
}

/** The figures of `clips.options` (`ClipOptions.prices` and `.noFallbackPrices`) from one price book. */
export function clipOptionPrices(priced: PricedBook, opts: ClipEstimateOptions & { bold: boolean }): ClipOptionPrices {
  const prices = clipPricesOf(priced);
  const estimate = (req: ClipEstimateRequest): Estimate => estimateOver(priced, prices, req, opts);
  const kling = (quality: ClipQuality, seconds: ClipSeconds, fallback: "auto" | "none"): Estimate => estimate({ model: "kling", quality, seconds, fallback, bold: opts.bold });
  const grok = (seconds: ClipSeconds): Estimate => estimate({ model: "grok", quality: "std", seconds, fallback: "none", bold: opts.bold });
  const klingOptions = (fallback: "auto" | "none"): Record<ClipOptionKey, Estimate> => ({
    std5: kling("std", 5, fallback),
    pro5: kling("pro", 5, fallback),
    std10: kling("std", 10, fallback),
    pro10: kling("pro", 10, fallback),
  });
  return { prices: { ...klingOptions("auto"), grok5: grok(5), grok10: grok(10) }, noFallbackPrices: klingOptions("none") };
}
