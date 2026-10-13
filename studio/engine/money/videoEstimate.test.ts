import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { clipReserveMicros, type BoldClipsMode, type ClipQuality, type ClipSeconds } from "../../shared/engine/clips";
import { Estimate } from "../../shared/engine/estimate";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { MoneyError } from "./errors";
import { PriceCache, type PricedBook } from "./priceCache";
import { FALLBACK_VIDEO_DATE, loadPriceBook, VIDEO_TIERS, type FetchLike } from "./prices";
import { clipOptionPrices, clipPricesOf, estimateClip, type ClipEstimateRequest } from "./videoEstimate";
useNativeGlobals();

// S5.V2 (plan s5b1 §5.9): the clip's estimate over the price book, through the shared formulas of `shared/engine/clips.ts`. The figures are the table of §5.9:
//   std 5 s: expected 420 000, worst 850 000 (mode auto, with Grok behind it) or 504 000 (offer, fallback none, a frame of «Смелая»).
// The owner sees them rounded UP to the cent: 504 000 reads «$0.51», 850 000 reads «$0.85».

const LISTING = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/videos-models-2026-10-10.json", import.meta.url)), "utf8")) as unknown;
const BASE = "http://127.0.0.1:9/api/v1";
const LISTING_URL = `${BASE}/videos/models`;
const VIDEO_MODELS = Object.values(VIDEO_TIERS).map((tier) => tier.model);

function fetchOf(routes: Record<string, unknown>): FetchLike {
  return async (url) => {
    const route = routes[url];
    if (route instanceof Error) throw route;
    if (route === undefined) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => route };
  };
}

async function pricedFrom(routes: Record<string, unknown>, asOf = "2026-10-13"): Promise<PricedBook> {
  const book = await loadPriceBook({ fetch: fetchOf(routes), baseUrl: BASE, imageModels: [], chatModels: [], videoModels: VIDEO_MODELS });
  return { book, asOf: book.fallbackDate ?? asOf };
}

const live = (): Promise<PricedBook> => pricedFrom({ [LISTING_URL]: LISTING });
const dated = (): Promise<PricedBook> => pricedFrom({ [LISTING_URL]: new Error("offline") });

/** A listing where Kling std at 720p costs `perSecond` USD and nothing else changes. */
function listingWithStd(perSecond: string): unknown {
  const copy = structuredClone(LISTING) as { data: { id: string; pricing_skus: Record<string, unknown> }[] };
  const entry = copy.data.find((item) => item.id === VIDEO_TIERS.std.model);
  if (entry === undefined) throw new Error("the fixture lacks Kling std");
  entry.pricing_skus.image_to_video_duration_seconds_720p = perSecond;
  return copy;
}

/** What the owner reads: micro-dollars rounded UP to a whole cent. */
const ceilToCent = (micros: number): number => Math.ceil(micros / 10_000) * 10_000;

const kling = (quality: ClipQuality, seconds: ClipSeconds, fallback: "auto" | "none" = "auto", bold = false): ClipEstimateRequest => ({ model: "kling", quality, seconds, fallback, bold });
const grok = (seconds: ClipSeconds): ClipEstimateRequest => ({ model: "grok", quality: "std", seconds, fallback: "none" });

// ---------- mode auto ----------

test("mode auto, std 5 s: expected $0.42, worst $0.85 (a free Kling refusal, then Grok 5 s)", async () => {
  const estimate = estimateClip(await live(), kling("std", 5), { mode: "auto" });

  expect([estimate.expectedMicros, estimate.worstMicros]).toEqual([420_000, 850_000]);
});

test("mode auto, pro 5 s: expected $0.56, worst $0.85", async () => {
  const estimate = estimateClip(await live(), kling("pro", 5), { mode: "auto" });

  expect([estimate.expectedMicros, estimate.worstMicros]).toEqual([560_000, 850_000]);
});

test("mode auto, std 10 s: expected $0.84, worst $1.55", async () => {
  const estimate = estimateClip(await live(), kling("std", 10), { mode: "auto" });

  expect([estimate.expectedMicros, estimate.worstMicros]).toEqual([840_000, 1_550_000]);
});

test("mode auto, pro 10 s: expected $1.12, worst $1.55", async () => {
  const estimate = estimateClip(await live(), kling("pro", 10), { mode: "auto" });

  expect([estimate.expectedMicros, estimate.worstMicros]).toEqual([1_120_000, 1_550_000]);
});

test("mode auto: the worst is the dearer branch, not the sum of Kling and Grok", async () => {
  const estimate = estimateClip(await live(), kling("std", 5), { mode: "auto" });

  expect(estimate.worstMicros).toBeLessThan(504_000 + 850_000);
});

test("mode auto, pro 10 s: Kling's own reserve (1 232 000) is below Grok's (1 550 000), so Grok's is the worst", async () => {
  const priced = await live();

  expect(clipReserveMicros(clipPricesOf(priced).pro, 10)).toBe(1_232_000);
  expect(estimateClip(priced, kling("pro", 10), { mode: "auto" }).worstMicros).toBe(1_550_000);
});

// ---------- mode offer ----------

test("mode offer, std 5 s: worst is Kling alone, 504 000, shown as $0.51", async () => {
  const estimate = estimateClip(await live(), kling("std", 5), { mode: "offer" });

  expect(estimate.worstMicros).toBe(504_000);
  expect(ceilToCent(estimate.worstMicros)).toBe(510_000);
});

test("mode offer: the worst of the four Kling options is each option's own reserve", async () => {
  const priced = await live();
  const worst = (quality: ClipQuality, seconds: ClipSeconds): number => estimateClip(priced, kling(quality, seconds), { mode: "offer" }).worstMicros;

  expect([worst("std", 5), worst("pro", 5), worst("std", 10), worst("pro", 10)]).toEqual([504_000, 672_000, 924_000, 1_232_000]);
});

test("mode offer: the expected cost does not change", async () => {
  const estimate = estimateClip(await live(), kling("std", 5), { mode: "offer" });

  expect(estimate.expectedMicros).toBe(420_000);
});

// ---------- Grok as the model (the offer) ----------

test("a Grok 5 s clip: expected $0.71, worst $0.85, in either mode", async () => {
  const priced = await live();

  for (const mode of ["auto", "offer"] as const) {
    const estimate = estimateClip(priced, grok(5), { mode });
    expect([estimate.expectedMicros, estimate.worstMicros]).toEqual([710_000, 850_000]);
  }
});

test("a Grok 10 s clip: expected $1.41, worst $1.55", async () => {
  const estimate = estimateClip(await live(), grok(10), { mode: "offer" });

  expect([estimate.expectedMicros, estimate.worstMicros]).toEqual([1_410_000, 1_550_000]);
});

test("the Grok worst of 5 s is $0.85 exactly, with no rounding up needed", async () => {
  expect(ceilToCent(estimateClip(await live(), grok(5), { mode: "offer" }).worstMicros)).toBe(850_000);
});

// ---------- fallback none ----------

test("mode auto with fallback none: worst is Kling's reserve alone, 504 000 for std 5 s", async () => {
  const estimate = estimateClip(await live(), kling("std", 5, "none"), { mode: "auto" });

  expect(estimate.worstMicros).toBe(504_000);
});

test("mode auto with fallback none: all four options are their own reserves", async () => {
  const priced = await live();
  const worst = (quality: ClipQuality, seconds: ClipSeconds): number => estimateClip(priced, kling(quality, seconds, "none"), { mode: "auto" }).worstMicros;

  expect([worst("std", 5), worst("pro", 5), worst("std", 10), worst("pro", 10)]).toEqual([504_000, 672_000, 924_000, 1_232_000]);
});

// ---------- a frame of «Смелая» ----------

test("a frame of «Смелая» under kling-only is Kling alone even in mode auto with fallback auto", async () => {
  const estimate = estimateClip(await live(), kling("std", 5, "auto", true), { mode: "auto", boldClips: "kling-only" });

  expect(estimate.worstMicros).toBe(504_000);
});

test("a frame of «Смелая» follows the default BOLD_CLIPS, which is kling-only", async () => {
  const estimate = estimateClip(await live(), kling("std", 5, "auto", true), { mode: "auto" });

  expect(estimate.worstMicros).toBe(504_000);
});

test("a frame of «Смелая» under with-fallback is a frame like any other: worst $0.85 in mode auto", async () => {
  const estimate = estimateClip(await live(), kling("std", 5, "auto", true), { mode: "auto", boldClips: "with-fallback" });

  expect(estimate.worstMicros).toBe(850_000);
});

test("a frame of «Смелая» under with-fallback in mode offer is Kling alone", async () => {
  const estimate = estimateClip(await live(), kling("std", 5, "auto", true), { mode: "offer", boldClips: "with-fallback" });

  expect(estimate.worstMicros).toBe(504_000);
});

test("a frame of «Смелая» under off is priced as Kling alone, because nothing else could ever run", async () => {
  const estimate = estimateClip(await live(), kling("std", 5, "auto", true), { mode: "auto", boldClips: "off" });

  expect(estimate.worstMicros).toBe(504_000);
});

test("an ordinary frame is not held to Kling by the bold switch", async () => {
  const estimate = estimateClip(await live(), kling("std", 5, "auto", false), { mode: "auto", boldClips: "kling-only" });

  expect(estimate.worstMicros).toBe(850_000);
});

// ---------- the mode defaults to the engine's switch ----------

test("with no mode given the estimate follows GROK_FALLBACK, whose default is auto", async () => {
  const estimate = estimateClip(await live(), kling("std", 5));

  expect(estimate.worstMicros).toBe(850_000);
});

// ---------- where the figures come from ----------

test("a live book gives prices live, dated by the load's day", async () => {
  const estimate = estimateClip(await live(), kling("std", 5), { mode: "auto" });

  expect([estimate.prices, estimate.pricesAsOf]).toEqual(["live", "2026-10-13"]);
});

test("an unreadable listing gives the dated table's figures, flagged fallback, dated 2026-10-10", async () => {
  const estimate = estimateClip(await dated(), kling("std", 5), { mode: "auto" });

  expect([estimate.expectedMicros, estimate.worstMicros, estimate.prices, estimate.pricesAsOf]).toEqual([420_000, 850_000, "fallback", FALLBACK_VIDEO_DATE]);
});

test("a book without video prices cannot be estimated: PRICE_UNAVAILABLE for the video scope", async () => {
  const book = await loadPriceBook({ fetch: fetchOf({}), baseUrl: BASE, imageModels: [], chatModels: [] });

  let thrown: unknown;
  try {
    estimateClip({ book, asOf: "2026-10-13" }, kling("std", 5), { mode: "auto" });
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(MoneyError);
  expect((thrown as MoneyError).scope).toBe("video");
});

test("every estimate is a valid Estimate", async () => {
  const priced = await live();

  for (const mode of ["auto", "offer"] as const) {
    for (const request of [kling("std", 5), kling("pro", 10, "none"), grok(5), kling("std", 10, "auto", true)]) {
      expect(Estimate.safeParse(estimateClip(priced, request, { mode })).success).toBe(true);
    }
  }
});

// ---------- rounding up, once, at the parser ----------

test("a listed price with digits below a micro-dollar is rounded up once, and the estimate is built from the rounded price", async () => {
  const priced = await pricedFrom({ [LISTING_URL]: listingWithStd("0.0840001") });

  expect(clipPricesOf(priced).std.perSecondMicros).toBe(84_001);
  const estimate = estimateClip(priced, kling("std", 5, "none"), { mode: "offer" });
  expect([estimate.expectedMicros, estimate.worstMicros]).toEqual([420_005, 504_006]);
});

test("the clip prices are whole numbers, so the shared formulas accept them", async () => {
  const prices = clipPricesOf(await pricedFrom({ [LISTING_URL]: listingWithStd("0.0840001") }));

  for (const rates of [prices.std, prices.pro, prices.grok]) {
    expect(Number.isSafeInteger(rates.perSecondMicros)).toBe(true);
    expect(Number.isSafeInteger(rates.perInputImageMicros)).toBe(true);
  }
});

test("the clip prices carry the input-image price of Grok and none for Kling", async () => {
  const prices = clipPricesOf(await live());

  expect([prices.std.perInputImageMicros, prices.pro.perInputImageMicros, prices.grok.perInputImageMicros]).toEqual([0, 0, 10_000]);
});

// ---------- the estimate never sits below what the reserve will hold ----------

test("the estimate's worst is never below the reserve of the attempt that runs first, over every option, mode and fallback", async () => {
  const books = [await live(), await dated(), await pricedFrom({ [LISTING_URL]: listingWithStd("0.0840001") })];
  const boldModes: BoldClipsMode[] = ["kling-only", "with-fallback", "off"];

  for (const priced of books) {
    const prices = clipPricesOf(priced);
    for (const mode of ["auto", "offer"] as const) {
      for (const quality of ["std", "pro"] as const) {
        for (const seconds of [5, 10] as const) {
          for (const fallback of ["auto", "none"] as const) {
            for (const bold of [false, true]) {
              for (const boldClips of boldModes) {
                const estimate = estimateClip(priced, kling(quality, seconds, fallback, bold), { mode, boldClips });
                expect(estimate.worstMicros).toBeGreaterThanOrEqual(clipReserveMicros(prices[quality], seconds));
                expect(estimate.expectedMicros).toBeLessThanOrEqual(estimate.worstMicros);
              }
            }
          }
        }
      }
      for (const seconds of [5, 10] as const) {
        expect(estimateClip(priced, grok(seconds), { mode }).worstMicros).toBeGreaterThanOrEqual(clipReserveMicros(prices.grok, seconds));
      }
    }
  }
});

test("in mode auto with a fallback the worst is never below Grok's reserve either", async () => {
  const priced = await live();
  const prices = clipPricesOf(priced);

  for (const seconds of [5, 10] as const) {
    expect(estimateClip(priced, kling("std", seconds), { mode: "auto" }).worstMicros).toBeGreaterThanOrEqual(clipReserveMicros(prices.grok, seconds));
  }
});

// ---------- the sheet's option figures ----------

test("the option prices in mode auto: Kling options carry Grok behind them, the no-fallback figures do not", async () => {
  const options = clipOptionPrices(await live(), { mode: "auto", bold: false });

  expect(options.prices.std5.worstMicros).toBe(850_000);
  expect(options.prices.pro10.worstMicros).toBe(1_550_000);
  expect(options.noFallbackPrices.std5.worstMicros).toBe(504_000);
  expect(options.noFallbackPrices.pro10.worstMicros).toBe(1_232_000);
});

test("the option prices carry the Grok offer figures: 5 s up to $0.85, 10 s up to $1.55", async () => {
  const options = clipOptionPrices(await live(), { mode: "offer", bold: false });

  expect([options.prices.grok5.expectedMicros, options.prices.grok5.worstMicros]).toEqual([710_000, 850_000]);
  expect([options.prices.grok10.expectedMicros, options.prices.grok10.worstMicros]).toEqual([1_410_000, 1_550_000]);
});

test("the option prices in mode offer: Kling alone everywhere", async () => {
  const options = clipOptionPrices(await live(), { mode: "offer", bold: false });

  expect(options.prices.std5.worstMicros).toBe(504_000);
  expect(options.noFallbackPrices.std5.worstMicros).toBe(504_000);
});

test("the option prices of a frame of «Смелая» are Kling alone in mode auto", async () => {
  const options = clipOptionPrices(await live(), { mode: "auto", bold: true });

  expect(options.prices.std5.worstMicros).toBe(504_000);
  expect(options.prices.pro5.worstMicros).toBe(672_000);
});

test("every option price is a valid Estimate and the four Kling keys are there", async () => {
  const options = clipOptionPrices(await live(), { mode: "auto", bold: false });

  expect(Object.keys(options.prices).sort()).toEqual(["grok10", "grok5", "pro10", "pro5", "std10", "std5"]);
  expect(Object.keys(options.noFallbackPrices).sort()).toEqual(["pro10", "pro5", "std10", "std5"]);
  for (const estimate of [...Object.values(options.prices), ...Object.values(options.noFallbackPrices)]) expect(Estimate.safeParse(estimate).success).toBe(true);
});

// ---------- round 2: a mixed book dates the video part by its own day ----------

test("a live video estimate from a mixed book (image fallback) is dated by the load day, not the image table's date", async () => {
  const book = await loadPriceBook({ fetch: fetchOf({ [LISTING_URL]: LISTING }), baseUrl: BASE, imageModels: ["x-ai/grok-imagine-image-2.0"], chatModels: [], videoModels: VIDEO_MODELS });
  const cache = new PriceCache({ load: async () => book, clock: () => Date.parse("2026-10-13T10:00:00.000Z"), monotonic: () => 0 });
  const priced = await cache.get({ imageModels: ["x-ai/grok-imagine-image-2.0"], chatModels: [], videoModels: VIDEO_MODELS });

  const estimate = estimateClip(priced, kling("std", 5), { mode: "auto" });

  expect([estimate.prices, estimate.pricesAsOf]).toEqual(["live", "2026-10-13"]);
});

test("a dated video part keeps the video table's date", async () => {
  const book = await loadPriceBook({ fetch: fetchOf({ [LISTING_URL]: new Error("offline") }), baseUrl: BASE, imageModels: [], chatModels: [], videoModels: VIDEO_MODELS });
  const cache = new PriceCache({ load: async () => book, clock: () => Date.parse("2026-10-13T10:00:00.000Z"), monotonic: () => 0 });
  const priced = await cache.get({ imageModels: [], chatModels: [], videoModels: VIDEO_MODELS });

  expect(estimateClip(priced, kling("std", 5), { mode: "auto" }).pricesAsOf).toBe(FALLBACK_VIDEO_DATE);
});
