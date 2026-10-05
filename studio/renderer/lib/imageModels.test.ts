import { describe, expect, test } from "bun:test";
import type { ImageModelEntry } from "../../shared/engine";
import { modelOptionLabel, photoPriceMicros, qualityOptionLabel, QUALITY_LABEL_RU } from "./imageModels";

const GROK: ImageModelEntry = {
  id: "x-ai/grok-imagine-image-2.0",
  name: "Grok Imagine Image 2.0",
  qualities: ["low", "medium"],
  prices: [
    { quality: "low", micros: 50_000 },
    { quality: "medium", micros: 70_000 },
  ],
  tested: true,
};
const FLUX: ImageModelEntry = { id: "black-forest-labs/flux-3-image", name: "FLUX.3", qualities: [], prices: [{ quality: null, micros: 48_000 }], tested: false };

describe("photoPriceMicros", () => {
  test("is the price of the chosen quality", () => {
    expect(photoPriceMicros(GROK, "medium")).toBe(70_000);
    expect(photoPriceMicros(GROK, "low")).toBe(50_000);
  });

  test("is the one price of a model with no quality knob, whatever quality is asked", () => {
    expect(photoPriceMicros(FLUX, null)).toBe(48_000);
    expect(photoPriceMicros(FLUX, "low")).toBe(48_000);
  });

  test("is the dearest price when the quality asked is not one the model lists (never an underestimate)", () => {
    expect(photoPriceMicros(GROK, null)).toBe(70_000);
  });
});

describe("modelOptionLabel", () => {
  test("names the model and its price, «от» the cheapest when it has two qualities", () => {
    expect(modelOptionLabel(GROK)).toBe("Grok Imagine Image 2.0 · от $0.050");
  });

  test("a model nobody has tried says so", () => {
    expect(modelOptionLabel(FLUX)).toBe("FLUX.3 · $0.048 · не проверена");
  });
});

describe("qualityOptionLabel", () => {
  test("names the quality in Russian with its price", () => {
    expect(qualityOptionLabel(GROK, "low")).toBe("Низкое · $0.050");
    expect(qualityOptionLabel(GROK, "medium")).toBe("Среднее · $0.070");
  });

  test("has a Russian word for each quality the contract knows", () => {
    expect(Object.keys(QUALITY_LABEL_RU).sort()).toEqual(["low", "medium"]);
  });
});
