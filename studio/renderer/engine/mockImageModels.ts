import type { ImageModelCatalogue } from "../../shared/engine";

/**
 * The catalogue the mock serves for `settings.imageModels`: fixed, and exactly what the real engine answers when OpenRouter's
 * list cannot be read (engine/imageModels/catalogue.ts's bundled list: the models of the dated price table at their dated
 * prices, flagged a fallback). The parity suite plays the real engine offline against this mock, so the two cannot drift. The
 * renderer never imports the engine, hence the copy.
 */
export const MOCK_IMAGE_CATALOGUE: ImageModelCatalogue = {
  source: "fallback",
  models: [
    {
      id: "x-ai/grok-imagine-image-2.0",
      name: "Grok Imagine Image 2.0",
      qualities: ["low", "medium"],
      prices: [
        { quality: "low", micros: 50_000 },
        { quality: "medium", micros: 70_000 },
      ],
      tested: true,
    },
    { id: "x-ai/grok-imagine-image-quality", name: "Grok Imagine Image Quality", qualities: [], prices: [{ quality: null, micros: 60_000 }], tested: true },
    { id: "bytedance-seed/seedream-5-0-pro", name: "Seedream 5.0 Pro", qualities: [], prices: [{ quality: null, micros: 48_000 }], tested: true },
  ],
};
