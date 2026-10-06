import type { Scenario } from "./scenarios";

// The image model choice, told through the commands the Settings «Модели» card sends: the catalogue (the mock serves the
// bundled list, which is what the real engine answers offline), a model saved with a quality, a model with no quality knob, a
// model and a quality that are refused, and «Реализм камеры». The real side runs main's own settings flow (rigs.ts) over the
// real engine and a real settings file.

const GROK = "x-ai/grok-imagine-image-2.0";
const SEEDREAM = "bytedance-seed/seedream-5-0-pro";
const TEXT = "x-ai/grok-4.3";

export const IMAGE_MODEL_SCENARIOS: readonly Scenario[] = [
  {
    name: "image model: the catalogue, a quality saved, a model with no quality, refusals, and camera realism",
    async run(t) {
      t.note("the catalogue Settings offers");
      await t.call("settings.imageModels", {});
      t.note("the default model at medium");
      await t.call("settings.setModels", { imageModel: GROK, imageQuality: "medium", textModel: TEXT });
      await t.call("settings.get", {});
      t.note("a model with no quality knob stores a null quality");
      await t.call("settings.setModels", { imageModel: SEEDREAM, textModel: TEXT });
      await t.call("settings.get", {});
      t.note("an unknown model and a quality the model does not list are refused, nothing changes");
      await t.call("settings.setModels", { imageModel: "acme/not-listed", textModel: TEXT });
      await t.call("settings.setModels", { imageModel: SEEDREAM, imageQuality: "medium", textModel: TEXT });
      t.note("back to a model with a knob, with no quality sent: low");
      await t.call("settings.setModels", { imageModel: GROK, textModel: TEXT });
      t.note("camera realism on");
      await t.call("settings.setCameraRealism", { cameraRealism: true });
      await t.call("settings.get", {});
    },
  },
];
