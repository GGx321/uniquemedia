import { describe, expect, test } from "bun:test";
import {
  catalogueTtlMs,
  checkImageChoice,
  FALLBACK_CATALOGUE_TTL_MS,
  ImageModelCatalogue,
  LIVE_CATALOGUE_TTL_MS,
  ImageQuality,
  UNKNOWN_IMAGE_MODEL_RU,
  UNSUPPORTED_IMAGE_QUALITY_RU,
  type ImageModelEntry,
} from "./imageModels";

const GROK = "x-ai/grok-imagine-image-2.0";
const SEEDREAM = "bytedance-seed/seedream-5-0-pro";

const GROK_ENTRY: ImageModelEntry = {
  id: GROK,
  name: "Grok Imagine Image 2.0",
  qualities: ["low", "medium"],
  prices: [
    { quality: "low", micros: 50_000 },
    { quality: "medium", micros: 70_000 },
  ],
  tested: true,
};
const SEEDREAM_ENTRY: ImageModelEntry = {
  id: SEEDREAM,
  name: "Seedream 5.0 Pro",
  qualities: [],
  prices: [{ quality: null, micros: 48_000 }],
  tested: true,
};
const CATALOGUE = { models: [GROK_ENTRY, SEEDREAM_ENTRY], source: "live", complete: true } as const;
const CURRENT = { imageModel: GROK, imageQuality: "low" } as const;

describe("ImageModelCatalogue", () => {
  test("accepts a catalogue of entries with and without a quality knob", () => {
    expect(ImageModelCatalogue.safeParse(CATALOGUE).success).toBe(true);
  });

  test("refuses a catalogue that does not say whether it is complete", () => {
    const { complete: _complete, ...bad } = CATALOGUE;
    expect(ImageModelCatalogue.safeParse(bad).success).toBe(false);
  });

  test("refuses an entry that names a quality twice", () => {
    const bad = { ...CATALOGUE, models: [{ ...GROK_ENTRY, qualities: ["low", "low"] }] };
    expect(ImageModelCatalogue.safeParse(bad).success).toBe(false);
  });

  test("refuses an entry that prices a quality it does not list", () => {
    const bad = { ...CATALOGUE, models: [{ ...SEEDREAM_ENTRY, prices: [{ quality: "low", micros: 1 }] }] };
    expect(ImageModelCatalogue.safeParse(bad).success).toBe(false);
  });

  test("refuses an entry with a quality knob that lacks the price of one of its qualities", () => {
    const bad = { ...CATALOGUE, models: [{ ...GROK_ENTRY, prices: [{ quality: "low", micros: 50_000 }] }] };
    expect(ImageModelCatalogue.safeParse(bad).success).toBe(false);
  });

  test("refuses the same model twice", () => {
    const bad = { ...CATALOGUE, models: [GROK_ENTRY, GROK_ENTRY] };
    expect(ImageModelCatalogue.safeParse(bad).success).toBe(false);
  });

  test("ImageQuality is exactly low or medium", () => {
    expect(ImageQuality.options).toEqual(["low", "medium"]);
  });
});

describe("checkImageChoice", () => {
  test("keeps the current quality when the same model is chosen and no quality is sent", () => {
    expect(checkImageChoice(CATALOGUE, { ...CURRENT, imageQuality: "medium" }, { imageModel: GROK })).toEqual({ ok: true, imageQuality: "medium" });
  });

  test("takes the requested quality when the model lists it", () => {
    expect(checkImageChoice(CATALOGUE, CURRENT, { imageModel: GROK, imageQuality: "medium" })).toEqual({ ok: true, imageQuality: "medium" });
  });

  test("stores null for a model with no quality knob when no quality is sent", () => {
    expect(checkImageChoice(CATALOGUE, CURRENT, { imageModel: SEEDREAM })).toEqual({ ok: true, imageQuality: null });
  });

  test("stores null for a model with no quality knob when null is sent", () => {
    expect(checkImageChoice(CATALOGUE, CURRENT, { imageModel: SEEDREAM, imageQuality: null })).toEqual({ ok: true, imageQuality: null });
  });

  test("falls back to low for a model with a knob when the current quality is null and none is sent", () => {
    expect(checkImageChoice(CATALOGUE, { imageModel: SEEDREAM, imageQuality: null }, { imageModel: GROK })).toEqual({ ok: true, imageQuality: "low" });
  });

  test("refuses an unknown model with a Russian text", () => {
    const result = checkImageChoice(CATALOGUE, CURRENT, { imageModel: "acme/unknown-image" });
    expect(result).toEqual({ ok: false, detail: UNKNOWN_IMAGE_MODEL_RU });
    expect(UNKNOWN_IMAGE_MODEL_RU).toMatch(/[а-я]/i);
  });

  test("lets the model that is already set be saved again even when the catalogue no longer lists it", () => {
    const current = { imageModel: "acme/old-image", imageQuality: "low" } as const;
    expect(checkImageChoice(CATALOGUE, current, { imageModel: "acme/old-image" })).toEqual({ ok: true, imageQuality: "low" });
  });

  test("refuses a quality the model does not list, with a Russian text", () => {
    const result = checkImageChoice(CATALOGUE, CURRENT, { imageModel: SEEDREAM, imageQuality: "medium" });
    expect(result).toEqual({ ok: false, detail: UNSUPPORTED_IMAGE_QUALITY_RU });
    expect(UNSUPPORTED_IMAGE_QUALITY_RU).toMatch(/[а-я]/i);
  });

  test("refuses null as the quality of a model that has a knob", () => {
    expect(checkImageChoice(CATALOGUE, CURRENT, { imageModel: GROK, imageQuality: null })).toEqual({ ok: false, detail: UNSUPPORTED_IMAGE_QUALITY_RU });
  });

  test("refuses a quality for the unlisted current model when it is a change", () => {
    const current = { imageModel: "acme/old-image", imageQuality: "low" } as const;
    expect(checkImageChoice(CATALOGUE, current, { imageModel: "acme/old-image", imageQuality: "medium" })).toEqual({ ok: false, detail: UNKNOWN_IMAGE_MODEL_RU });
  });
});

describe("catalogueTtlMs", () => {
  test("30 minutes only for a live catalogue whose every candidate was priced", () => {
    expect(catalogueTtlMs({ source: "live", complete: true })).toBe(LIVE_CATALOGUE_TTL_MS);
  });

  test("a minute for a bundled catalogue and for a live one with a candidate left out (the outage may be over)", () => {
    expect(catalogueTtlMs({ source: "fallback", complete: false })).toBe(FALLBACK_CATALOGUE_TTL_MS);
    expect(catalogueTtlMs({ source: "live", complete: false })).toBe(FALLBACK_CATALOGUE_TTL_MS);
  });

  test("the live window is longer than the retry window", () => {
    expect(LIVE_CATALOGUE_TTL_MS).toBeGreaterThan(FALLBACK_CATALOGUE_TTL_MS);
  });
});
