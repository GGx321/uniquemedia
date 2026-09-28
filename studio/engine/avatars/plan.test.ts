import { describe, expect, test } from "bun:test";
import { Estimate, IMPORT_FALLBACK_PRICE } from "../../shared/engine";
import { PriceBook, type ChatPrice, type ImagePrice, type PriceEntry } from "../money/prices";
import {
  avatarJobEstimate,
  avatarPriceModels,
  candidateImage,
  CANDIDATES_PER_BATCH,
  descriptorJobCap,
  importDescribeCall,
  IMPORT_DESCRIBE_MAX_ATTEMPTS,
  importJobEstimate,
  importPriceModels,
  type AvatarModels,
} from "./plan";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

const DEFAULTS: AvatarModels = { imageModel: "x-ai/grok-imagine-image-2.0", textModel: "x-ai/grok-4.3" };
const FALLBACK = { book: PriceBook.fallback(), asOf: "2026-09-24" };

// From the dated fallback table: grok-imagine-image-2.0 low 1K = $0.04, no
// reference; grok-4.3 $1.25/M prompt, $2.50/M completion.
const PORTRAIT = 40_000;
const AGE_CHECK = { expected: 1_660, worst: 5_250 }; // 658 in / 335 out; ceilings 2.2K in / 1K out
const DESCRIPTOR = { expected: 2_625, worst: 13_750 }; // 900 in / 600 out; ceilings 5K in / 3K out

test("a candidate is a 1K low-quality portrait without a reference, on the settings' image model", () => {
  expect(candidateImage("bytedance-seed/seedream-5-0-pro")).toEqual({ model: "bytedance-seed/seedream-5-0-pro", quality: "low", refs: 0 });
  expect(CANDIDATES_PER_BATCH).toBe(4);
});

test("a new avatar: the descriptor (asked at most twice), 4 portraits and 4 age checks — $0.169 expected, $0.2085 worst", () => {
  const estimate = avatarJobEstimate(FALLBACK, DEFAULTS, "new-avatar", "on");

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
  expect(avatarJobEstimate(FALLBACK, DEFAULTS, "next-batch", "on")).toEqual({
    expectedMicros: 166_640,
    worstMicros: 181_000,
    prices: "fallback",
    pricesAsOf: "2026-09-24",
  });
});

test("the image model comes from the settings", () => {
  // grok-imagine-image-quality has no quality variants: its 1K price is $0.05.
  expect(avatarJobEstimate(FALLBACK, { ...DEFAULTS, imageModel: "x-ai/grok-imagine-image-quality" }, "next-batch", "on").worstMicros).toBe(4 * (50_000 + AGE_CHECK.worst));
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

  const estimate = avatarJobEstimate({ book, asOf: "2026-10-01" }, { ...DEFAULTS, textModel: "acme/writer" }, "new-avatar", "on");

  expect(estimate).toEqual({
    expectedMicros: 4 * (PORTRAIT + AGE_CHECK.expected) + (900 + 600),
    worstMicros: 4 * (PORTRAIT + AGE_CHECK.worst) + 2 * (5_000 + 3_000),
    prices: "live",
    pricesAsOf: "2026-10-01",
  });
});

test("the models to price: the image model, the text model and the age checks' model, each once", () => {
  expect(avatarPriceModels(DEFAULTS, "new-avatar", "on")).toEqual({ imageModels: ["x-ai/grok-imagine-image-2.0"], chatModels: ["x-ai/grok-4.3"] });
  expect(avatarPriceModels({ ...DEFAULTS, textModel: "acme/writer" }, "new-avatar", "on")).toEqual({
    imageModels: ["x-ai/grok-imagine-image-2.0"],
    chatModels: ["acme/writer", "x-ai/grok-4.3"],
  });
});

test("rewriting a descriptor needs only the text model priced: no image, no age-check model (L8)", () => {
  expect(avatarPriceModels(DEFAULTS, "rewrite-descriptor", "on")).toEqual({ imageModels: [], chatModels: ["x-ai/grok-4.3"] });
  expect(avatarPriceModels({ ...DEFAULTS, textModel: "acme/writer" }, "rewrite-descriptor", "on")).toEqual({ imageModels: [], chatModels: ["acme/writer"] });
  // Ignored either way (rewrite-descriptor never touches the age check), so "off" gives the exact same models.
  expect(avatarPriceModels(DEFAULTS, "rewrite-descriptor", "off")).toEqual(avatarPriceModels(DEFAULTS, "rewrite-descriptor", "on"));
});

test("estimateAvatarJob for rewrite-descriptor never prices the image model, even one with no fallback price", () => {
  const book = new PriceBook(
    new Map(), // no image price loaded at all
    new Map([["x-ai/grok-4.3", { price: { promptPico: 1_250_000, completionPico: 2_500_000, imagePico: 0, requestPico: 0, overrides: [] }, source: "live" }]]),
  );
  expect(() => avatarJobEstimate({ book, asOf: "2026-10-01" }, DEFAULTS, "rewrite-descriptor", "on")).not.toThrow();
});

test("the descriptor job's cap is what it can send: every attempt at its ceiling, on the settings' text model", () => {
  expect(descriptorJobCap(FALLBACK, DEFAULTS)).toBe(2 * DESCRIPTOR.worst);
});

describe("the image age check off (owner's decision, 2026-09-27: off by default)", () => {
  test("a new avatar: the descriptor and 4 portraits, no age checks — $0.1875 worst, down from $0.2085 on", () => {
    const estimate = avatarJobEstimate(FALLBACK, DEFAULTS, "new-avatar", "off");

    expect(estimate).toEqual({
      expectedMicros: 4 * PORTRAIT + DESCRIPTOR.expected,
      worstMicros: 4 * PORTRAIT + 2 * DESCRIPTOR.worst,
      prices: "fallback",
      pricesAsOf: "2026-09-24",
    });
    expect([estimate.expectedMicros, estimate.worstMicros]).toEqual([162_625, 187_500]);
  });

  test("another batch for a draft: 4 portraits, no age checks, no descriptor — $0.16 worst, down from $0.181 on", () => {
    expect(avatarJobEstimate(FALLBACK, DEFAULTS, "next-batch", "off")).toEqual({
      expectedMicros: 160_000,
      worstMicros: 160_000,
      prices: "fallback",
      pricesAsOf: "2026-09-24",
    });
  });

  test("rewriting a descriptor is unaffected by the toggle either way: it never touched candidates or age checks", () => {
    expect(avatarJobEstimate(FALLBACK, DEFAULTS, "rewrite-descriptor", "off")).toEqual(avatarJobEstimate(FALLBACK, DEFAULTS, "rewrite-descriptor", "on"));
  });

  test("the age check's model is not even priced: only the image and text models", () => {
    expect(avatarPriceModels(DEFAULTS, "new-avatar", "off")).toEqual({ imageModels: ["x-ai/grok-imagine-image-2.0"], chatModels: ["x-ai/grok-4.3"] });
    expect(avatarPriceModels({ ...DEFAULTS, textModel: "acme/writer" }, "new-avatar", "off")).toEqual({
      imageModels: ["x-ai/grok-imagine-image-2.0"],
      chatModels: ["acme/writer"],
    });
  });
});

// ---------- T6c: import an existing avatar ----------

// Same fallback prices (grok-4.3): $1.25/M prompt, $2.50/M completion. The
// vision describe call is longer than the plain descriptor call (every trait
// field, not just one string) and carries one attached image.
const IMPORT_DESCRIBE = { expected: 3_875, worst: 16_250 }; // 1_800 in / 650 out; ceilings 7K in / 3K out

describe("import an existing avatar (T6c)", () => {
  test("at most 2 describe attempts, mirroring the descriptor job's own retry limit", () => {
    expect(IMPORT_DESCRIBE_MAX_ATTEMPTS).toBe(2);
  });

  test("one describe attempt on the settings' text model, with one attached image", () => {
    expect(importDescribeCall("acme/vision")).toEqual({
      model: "acme/vision",
      maxTokens: 3_000,
      inputTokens: 7_000,
      images: 1,
      typical: { inputTokens: 1_800, outputTokens: 650 },
    });
  });

  test("prices the settings' text model and the age check's own fixed model, whatever imageAgeCheck says — the import's own age check is mandatory", () => {
    expect(importPriceModels(DEFAULTS)).toEqual({ imageModels: [], chatModels: ["x-ai/grok-4.3"] });
    expect(importPriceModels({ ...DEFAULTS, textModel: "acme/vision" })).toEqual({
      imageModels: [],
      chatModels: ["acme/vision", "x-ai/grok-4.3"],
    });
  });

  test("worst case: one mandatory age check + up to 2 describe attempts — $0.037750 worst, $0.005535 expected", () => {
    const estimate = importJobEstimate(FALLBACK, DEFAULTS);

    expect(estimate).toEqual({
      expectedMicros: AGE_CHECK.expected + IMPORT_DESCRIBE.expected,
      worstMicros: AGE_CHECK.worst + IMPORT_DESCRIBE_MAX_ATTEMPTS * IMPORT_DESCRIBE.worst,
      prices: "fallback",
      pricesAsOf: "2026-09-24",
    });
    expect([estimate.expectedMicros, estimate.worstMicros]).toEqual([5_535, 37_750]);
    expect(Estimate.safeParse(estimate).success).toBe(true);
  });

  // L8: the mock (mockEngine.ts) and the static UI text before any photo is
  // picked (AvatarsScreen.tsx) both read IMPORT_FALLBACK_PRICE instead of
  // keeping their own copy of these numbers — this proves the shared
  // constant actually matches the real engine's own computation, at the
  // fallback prices, so none of the three can drift from each other unnoticed.
  test("L8: IMPORT_FALLBACK_PRICE (shared with the renderer's mock and its UI text) matches the real computation exactly", () => {
    const estimate = importJobEstimate(FALLBACK, DEFAULTS);
    expect({ expectedMicros: AGE_CHECK.expected, worstMicros: AGE_CHECK.worst }).toEqual(IMPORT_FALLBACK_PRICE.ageCheck);
    expect({ expectedMicros: IMPORT_DESCRIBE.expected, worstMicros: IMPORT_DESCRIBE.worst }).toEqual(IMPORT_FALLBACK_PRICE.describe);
    expect({ expectedMicros: estimate.expectedMicros, worstMicros: estimate.worstMicros }).toEqual(IMPORT_FALLBACK_PRICE.whole);
    expect(estimate.pricesAsOf).toBe(IMPORT_FALLBACK_PRICE.asOf);
  });

  test("no image model is ever priced: the import never generates an image, only reads the staged one", () => {
    const book = new PriceBook(
      new Map(), // no image price loaded at all
      new Map([["x-ai/grok-4.3", { price: { promptPico: 1_250_000, completionPico: 2_500_000, imagePico: 0, requestPico: 0, overrides: [] }, source: "live" }]]),
    );
    expect(() => importJobEstimate({ book, asOf: "2026-10-01" }, DEFAULTS)).not.toThrow();
  });

  test("the text model from the settings prices the describe call; the age check stays on grok-4.3", () => {
    const rates = (promptPico: number, completionPico: number): PriceEntry<ChatPrice> => ({
      price: { promptPico, completionPico, imagePico: 0, requestPico: 0, overrides: [] },
      source: "live",
    });
    const book = new PriceBook(
      new Map(),
      new Map([
        ["x-ai/grok-4.3", rates(1_250_000, 2_500_000)],
        ["acme/vision", rates(1_000_000, 1_000_000)],
      ]),
    );

    const estimate = importJobEstimate({ book, asOf: "2026-10-01" }, { ...DEFAULTS, textModel: "acme/vision" });

    expect(estimate).toEqual({
      expectedMicros: AGE_CHECK.expected + (1_800 + 650),
      worstMicros: AGE_CHECK.worst + 2 * (7_000 + 3_000),
      prices: "live",
      pricesAsOf: "2026-10-01",
    });
  });
});

test("rewriting a descriptor: the descriptor call alone (asked at most twice), no candidates and no age checks", () => {
  const estimate = avatarJobEstimate(FALLBACK, DEFAULTS, "rewrite-descriptor", "on");

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
