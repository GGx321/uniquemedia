import { expect, test } from "bun:test";
import { Estimate } from "../../shared/engine";
import { PriceBook, type ChatPrice, type ImagePrice, type PriceEntry } from "../money/prices";
import { avatarJobEstimate, avatarPriceModels, candidateImage, CANDIDATES_PER_BATCH, descriptorJobCap, type AvatarModels } from "./plan";

const DEFAULTS: AvatarModels = { imageModel: "x-ai/grok-imagine-image-2.0", textModel: "x-ai/grok-4.3" };
const FALLBACK = { book: PriceBook.fallback(), asOf: "2026-09-24" };

// From the dated fallback table: grok-imagine-image-2.0 low 1K = $0.04, no
// reference; grok-4.3 $1.25/M prompt, $2.50/M completion.
const PORTRAIT = 40_000;
const AGE_CHECK = { expected: 1_660, worst: 5_250 }; // 658 in / 335 out; ceilings 2.2K in / 1K out
const DESCRIPTOR = { expected: 2_625, worst: 13_750 }; // 900 in / 600 out; ceilings 5K in / 3K out

test("a candidate is a 1K low-quality portrait without a reference, on the settings' image model", () => {
  expect(candidateImage("bytedance-seed/seedream-5-0-pro")).toEqual({ model: "bytedance-seed/seedream-5-0-pro", resolution: "1K", quality: "low", refs: 0 });
  expect(CANDIDATES_PER_BATCH).toBe(4);
});

test("a new avatar: the descriptor (asked at most twice), 4 portraits and 4 age checks — $0.169 expected, $0.2085 worst", () => {
  const estimate = avatarJobEstimate(FALLBACK, DEFAULTS, "new-avatar");

  expect(estimate).toEqual({
    expectedMicros: 4 * (PORTRAIT + AGE_CHECK.expected) + DESCRIPTOR.expected,
    worstMicros: 4 * (PORTRAIT + AGE_CHECK.worst) + 2 * DESCRIPTOR.worst,
    prices: "fallback",
    pricesAsOf: "2026-09-24",
  });
  expect([estimate.expectedMicros, estimate.worstMicros]).toEqual([169_265, 208_500]);
  expect(Estimate.safeParse(estimate).success).toBe(true);
});

test("another batch for a draft: 4 portraits and 4 age checks, no descriptor — $0.167 expected, $0.181 worst", () => {
  expect(avatarJobEstimate(FALLBACK, DEFAULTS, "next-batch")).toEqual({
    expectedMicros: 166_640,
    worstMicros: 181_000,
    prices: "fallback",
    pricesAsOf: "2026-09-24",
  });
});

test("the image model comes from the settings", () => {
  // grok-imagine-image-quality has no quality variants: its 1K price is $0.05.
  expect(avatarJobEstimate(FALLBACK, { ...DEFAULTS, imageModel: "x-ai/grok-imagine-image-quality" }, "next-batch").worstMicros).toBe(4 * (50_000 + AGE_CHECK.worst));
});

test("the text model from the settings prices the descriptor; the age checks stay on grok-4.3", () => {
  const image: PriceEntry<ImagePrice> = { price: { outputs: [{ variant: "low_1k", micros: PORTRAIT }], inputImageMicros: 10_000 }, source: "live" };
  const rates = (promptPico: number, completionPico: number): PriceEntry<ChatPrice> => ({
    price: { promptPico, completionPico, imagePico: 0, requestPico: 0, overrides: [] },
    source: "live",
  });
  const book = new PriceBook(
    new Map([["x-ai/grok-imagine-image-2.0", image]]),
    new Map([
      ["x-ai/grok-4.3", rates(1_250_000, 2_500_000)],
      ["acme/writer", rates(1_000_000, 1_000_000)],
    ]),
  );

  const estimate = avatarJobEstimate({ book, asOf: "2026-10-01" }, { ...DEFAULTS, textModel: "acme/writer" }, "new-avatar");

  expect(estimate).toEqual({
    expectedMicros: 4 * (PORTRAIT + AGE_CHECK.expected) + (900 + 600),
    worstMicros: 4 * (PORTRAIT + AGE_CHECK.worst) + 2 * (5_000 + 3_000),
    prices: "live",
    pricesAsOf: "2026-10-01",
  });
});

test("the models to price: the image model, the text model and the age checks' model, each once", () => {
  expect(avatarPriceModels(DEFAULTS)).toEqual({ imageModels: ["x-ai/grok-imagine-image-2.0"], chatModels: ["x-ai/grok-4.3"] });
  expect(avatarPriceModels({ ...DEFAULTS, textModel: "acme/writer" })).toEqual({
    imageModels: ["x-ai/grok-imagine-image-2.0"],
    chatModels: ["acme/writer", "x-ai/grok-4.3"],
  });
});

test("rewriting a descriptor needs only the text model priced: no image, no age-check model (L8)", () => {
  expect(avatarPriceModels(DEFAULTS, "rewrite-descriptor")).toEqual({ imageModels: [], chatModels: ["x-ai/grok-4.3"] });
  expect(avatarPriceModels({ ...DEFAULTS, textModel: "acme/writer" }, "rewrite-descriptor")).toEqual({ imageModels: [], chatModels: ["acme/writer"] });
});

test("estimateAvatarJob for rewrite-descriptor never prices the image model, even one with no fallback price", () => {
  const book = new PriceBook(
    new Map(), // no image price loaded at all
    new Map([["x-ai/grok-4.3", { price: { promptPico: 1_250_000, completionPico: 2_500_000, imagePico: 0, requestPico: 0, overrides: [] }, source: "live" }]]),
  );
  expect(() => avatarJobEstimate({ book, asOf: "2026-10-01" }, DEFAULTS, "rewrite-descriptor")).not.toThrow();
});

test("the descriptor job's cap is what it can send: every attempt at its ceiling, on the settings' text model", () => {
  expect(descriptorJobCap(FALLBACK, DEFAULTS)).toBe(2 * DESCRIPTOR.worst);
});

test("rewriting a descriptor: the descriptor call alone (asked at most twice), no candidates and no age checks", () => {
  const estimate = avatarJobEstimate(FALLBACK, DEFAULTS, "rewrite-descriptor");

  expect(estimate).toEqual({
    expectedMicros: DESCRIPTOR.expected,
    worstMicros: 2 * DESCRIPTOR.worst,
    prices: "fallback",
    pricesAsOf: "2026-09-24",
  });
  // Exactly the descriptor job's cap: the command's own scope never sends anything else.
  expect(estimate.worstMicros).toBe(descriptorJobCap(FALLBACK, DEFAULTS));
  expect(Estimate.safeParse(estimate).success).toBe(true);
});
