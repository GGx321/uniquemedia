import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { AGE_CHECK_FALLBACK_PRICE, Estimate, IMPORT_FALLBACK_PRICE } from "../../shared/engine";
import { REQUEST_TIMEOUT_MS } from "../money/budget";
import { MAX_ATTEMPT_MS } from "../openrouter/transport";
import { PriceBook, type ChatPrice, type ImagePrice, type PriceEntry } from "../money/prices";
import {
  avatarJobEstimate,
  avatarPriceModels,
  candidateImage,
  CANDIDATES_PER_BATCH,
  descriptorCheckCall,
  descriptorCheckEstimate,
  descriptorCheckPriceModels,
  DESCRIPTOR_CHECK_MAX_ATTEMPTS,
  DESCRIPTOR_CHECK_MAX_ATTEMPT_MS,
  DESCRIPTOR_CHECK_TIMEOUT_MS,
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

test("a candidate takes the settings' image quality: medium, or none for a model with no quality knob", () => {
  expect(candidateImage("x-ai/grok-imagine-image-2.0", "medium")).toEqual({ model: "x-ai/grok-imagine-image-2.0", quality: "medium", refs: 0 });
  expect(candidateImage("black-forest-labs/flux-3-image", null)).toEqual({ model: "black-forest-labs/flux-3-image", quality: null, refs: 0 });
});

test("the job's estimate prices the portraits at the chosen quality: medium is $0.06 each with no reference, not $0.04 (low)", () => {
  const low = avatarJobEstimate(FALLBACK, { ...DEFAULTS, imageQuality: "low" }, "next-batch", "off").worstMicros;
  const medium = avatarJobEstimate(FALLBACK, { ...DEFAULTS, imageQuality: "medium" }, "next-batch", "off").worstMicros;
  expect(low).toBe(4 * 40_000);
  expect(medium).toBe(4 * 60_000);
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
const IMPORT_DESCRIBE = { expected: 3_875, worst: 17_500 }; // 1_800 in / 650 out; ceilings 8K in / 3K out (S5.R1: 7K to 8K, room for the body proposal)
// S5.0c: the descriptor-vs-master check, one vision call: 1_700 in / 500 out typical (by analogy with the describe call's measured 1_800 / 650); ceilings 7K in / 1.5K out.
const DESCRIPTOR_CHECK = { expected: 3_375, worst: 12_500 };

describe("import an existing avatar (T6c)", () => {
  test("at most 2 describe attempts, mirroring the descriptor job's own retry limit", () => {
    expect(IMPORT_DESCRIBE_MAX_ATTEMPTS).toBe(2);
  });

  test("one describe attempt on the settings' text model, with one attached image", () => {
    expect(importDescribeCall("acme/vision")).toEqual({
      model: "acme/vision",
      maxTokens: 3_000,
      inputTokens: 8_000,
      images: 1,
      typical: { inputTokens: 1_800, outputTokens: 650 },
    });
  });

  test("prices only the settings' text model: an import makes no age check, so the age check's model is never priced", () => {
    expect(importPriceModels(DEFAULTS)).toEqual({ imageModels: [], chatModels: ["x-ai/grok-4.3"] });
    expect(importPriceModels({ ...DEFAULTS, textModel: "acme/vision" })).toEqual({
      imageModels: [],
      chatModels: ["acme/vision"],
    });
  });

  // S5.0c (deliberate re-pin): the import also runs the descriptor check on the saved avatar, accepted by the same click, so its figures are in the import's.
  test("worst case: up to 2 describe attempts and up to 2 check attempts — $0.060000 worst, $0.007250 expected", () => {
    const estimate = importJobEstimate(FALLBACK, DEFAULTS);

    expect(estimate).toEqual({
      expectedMicros: IMPORT_DESCRIBE.expected + DESCRIPTOR_CHECK.expected,
      worstMicros: IMPORT_DESCRIBE_MAX_ATTEMPTS * IMPORT_DESCRIBE.worst + DESCRIPTOR_CHECK_MAX_ATTEMPTS * DESCRIPTOR_CHECK.worst,
      prices: "fallback",
      pricesAsOf: "2026-09-24",
    });
    expect([estimate.expectedMicros, estimate.worstMicros]).toEqual([7_250, 60_000]);
    expect(Estimate.safeParse(estimate).success).toBe(true);
  });

  // L8: the mock (mockEngine.ts) and the static UI text before any photo is
  // picked (AvatarsScreen.tsx) both read IMPORT_FALLBACK_PRICE instead of
  // keeping their own copy of these numbers — this proves the shared
  // constant actually matches the real engine's own computation, at the
  // fallback prices, so none of the three can drift from each other unnoticed.
  test("L8: IMPORT_FALLBACK_PRICE (shared with the renderer's mock and its UI text) matches the real computation exactly", () => {
    const estimate = importJobEstimate(FALLBACK, DEFAULTS);
    // The age check alone is still priced for the photo runs' own toggle (Settings text); it is no part of the import's whole.
    expect({ expectedMicros: AGE_CHECK.expected, worstMicros: AGE_CHECK.worst }).toEqual(AGE_CHECK_FALLBACK_PRICE);
    expect({ expectedMicros: IMPORT_DESCRIBE.expected, worstMicros: IMPORT_DESCRIBE.worst }).toEqual(IMPORT_FALLBACK_PRICE.describe);
    expect({ expectedMicros: DESCRIPTOR_CHECK.expected, worstMicros: DESCRIPTOR_CHECK.worst }).toEqual(IMPORT_FALLBACK_PRICE.check);
    expect({ expectedMicros: estimate.expectedMicros, worstMicros: estimate.worstMicros }).toEqual(IMPORT_FALLBACK_PRICE.whole);
    expect(estimate.pricesAsOf).toBe(IMPORT_FALLBACK_PRICE.asOf);
  });

  test("no image model and no age-check model is ever priced: an import needs only its text model's price", () => {
    const book = new PriceBook(
      new Map(), // no image price loaded at all
      new Map([["acme/vision", { price: { promptPico: 1_250_000, completionPico: 2_500_000, imagePico: 0, requestPico: 0, overrides: [] }, source: "live" }]]),
    );
    expect(() => importJobEstimate({ book, asOf: "2026-10-01" }, { ...DEFAULTS, textModel: "acme/vision" })).not.toThrow();
  });

  test("the text model from the settings prices the describe call and the check, and nothing else is added", () => {
    const rates = (promptPico: number, completionPico: number): PriceEntry<ChatPrice> => ({
      price: { promptPico, completionPico, imagePico: 0, requestPico: 0, overrides: [] },
      source: "live",
    });
    const book = new PriceBook(
      new Map(),
      new Map([
        ["acme/vision", rates(1_000_000, 1_000_000)],
      ]),
    );

    const estimate = importJobEstimate({ book, asOf: "2026-10-01" }, { ...DEFAULTS, textModel: "acme/vision" });

    expect(estimate).toEqual({
      expectedMicros: 1_800 + 650 + 1_700 + 500,
      worstMicros: 2 * (8_000 + 3_000) + 2 * (7_000 + 1_500),
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

describe("the descriptor-vs-master check (Stage 5, S5.0c)", () => {
  test("at most 2 attempts: an unparseable answer is asked once more", () => {
    expect(DESCRIPTOR_CHECK_MAX_ATTEMPTS).toBe(2);
  });

  test("one attempt on the settings' text model: 7K in and 1.5K out at the ceilings, one attached image", () => {
    expect(descriptorCheckCall("acme/vision")).toEqual({
      model: "acme/vision",
      maxTokens: 1_500,
      inputTokens: 7_000,
      images: 1,
      typical: { inputTokens: 1_700, outputTokens: 500 },
    });
  });

  test("one HTTP try waits 60 s for its answer, shorter than the 180 s default, so a stuck check does not hold the import for minutes", () => {
    expect(DESCRIPTOR_CHECK_TIMEOUT_MS).toBe(60_000);
  });

  test("one attempt at its slowest: three tries to their 60 s timeout and two retry waits at the 60 s Retry-After cap plus 1 s jitter", () => {
    expect(DESCRIPTOR_CHECK_MAX_ATTEMPT_MS).toBe(3 * 60_000 + 2 * 61_000);
    expect(DESCRIPTOR_CHECK_MAX_ATTEMPT_MS).toBeLessThan(MAX_ATTEMPT_MS);
  });

  // S5.R1: the E2E build shortens REQUEST_TIMEOUT_MS to 15 s and the client refuses a timeout above it, so a 60 s check timeout made «Проверить описание» fail INTERNAL there.
  test("a check never waits longer than the client allows a request to", () => {
    expect(DESCRIPTOR_CHECK_TIMEOUT_MS).toBeLessThanOrEqual(REQUEST_TIMEOUT_MS);
  });

  describe("in the E2E build (__STUDIO_E2E__ defined true)", () => {
    // The flag is a build-time constant, so the E2E values are read in a child process that defines it the way the build does.
    const E2E_SOURCE = `
      import { REQUEST_TIMEOUT_MS } from "./studio/engine/money/budget";
      import { MAX_ATTEMPT_MS, JITTER_MS, MAX_RETRY_AFTER_MS, MAX_TRANSPORT_RETRIES } from "./studio/engine/openrouter/transport";
      import { DESCRIPTOR_CHECK_MAX_ATTEMPT_MS, DESCRIPTOR_CHECK_TIMEOUT_MS } from "./studio/engine/avatars/plan";
      console.log(JSON.stringify({ REQUEST_TIMEOUT_MS, MAX_ATTEMPT_MS, JITTER_MS, MAX_RETRY_AFTER_MS, MAX_TRANSPORT_RETRIES, DESCRIPTOR_CHECK_MAX_ATTEMPT_MS, DESCRIPTOR_CHECK_TIMEOUT_MS }));
    `;
    const e2e = (): Record<string, number> => {
      const run = spawnSync("bun", ["--define", "__STUDIO_E2E__=true", "-e", E2E_SOURCE], { cwd: resolve(import.meta.dirname, "../../.."), encoding: "utf8" });
      if (run.status !== 0) throw new Error(`child failed:\n${run.stdout}\n${run.stderr}`);
      return JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "{}") as Record<string, number>;
    };

    test("the build really shortens the request timeout (so this test would catch a 60 s check)", () => {
      expect(e2e().REQUEST_TIMEOUT_MS).toBe(15_000);
    });

    test("the check's timeout fits inside the shortened request timeout", () => {
      const v = e2e();
      expect(v.DESCRIPTOR_CHECK_TIMEOUT_MS).toBeLessThanOrEqual(v.REQUEST_TIMEOUT_MS as number);
    });

    test("one check attempt at its slowest is sized from the shortened timeout, and stays within a request's own worst", () => {
      const v = e2e() as Record<string, number>;
      const t = v.DESCRIPTOR_CHECK_TIMEOUT_MS as number;
      expect(v.DESCRIPTOR_CHECK_MAX_ATTEMPT_MS).toBe(((v.MAX_TRANSPORT_RETRIES as number) + 1) * t + (v.MAX_TRANSPORT_RETRIES as number) * ((v.MAX_RETRY_AFTER_MS as number) + (v.JITTER_MS as number)));
      expect(v.DESCRIPTOR_CHECK_MAX_ATTEMPT_MS).toBeLessThanOrEqual(v.MAX_ATTEMPT_MS as number);
    });
  });

  test("prices only the settings' text model: no image model and no age-check model", () => {
    expect(descriptorCheckPriceModels(DEFAULTS)).toEqual({ imageModels: [], chatModels: ["x-ai/grok-4.3"] });
    expect(descriptorCheckPriceModels({ ...DEFAULTS, textModel: "acme/vision" })).toEqual({ imageModels: [], chatModels: ["acme/vision"] });
  });

  test("a check alone: 2 attempts at 12 500 µ$ worst, $0.003375 expected", () => {
    const estimate = descriptorCheckEstimate(FALLBACK, DEFAULTS);

    expect(estimate).toEqual({ expectedMicros: DESCRIPTOR_CHECK.expected, worstMicros: 2 * DESCRIPTOR_CHECK.worst, prices: "fallback", pricesAsOf: "2026-09-24" });
    expect(Estimate.safeParse(estimate).success).toBe(true);
  });

  test("it prices the text model alone, like the import: no image model is needed", () => {
    const book = new PriceBook(
      new Map(),
      new Map([["acme/vision", { price: { promptPico: 1_000_000, completionPico: 1_000_000, imagePico: 0, requestPico: 0, overrides: [] }, source: "live" }]]),
    );
    expect(descriptorCheckEstimate({ book, asOf: "2026-10-01" }, { ...DEFAULTS, textModel: "acme/vision" })).toEqual({
      expectedMicros: 1_700 + 500,
      worstMicros: 2 * (7_000 + 1_500),
      prices: "live",
      pricesAsOf: "2026-10-01",
    });
  });
});
