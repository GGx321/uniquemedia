import { describe, expect, test } from "bun:test";
import { scenePhoto } from "./mockEngine.testkit";
import { makeClipMock, suitable } from "./mockEngine.clips.testkit";

// 5a.4 (S5.BA6, plan s5a4 §5.10, §8, I5.79, QB-5): the mock reads a «Смелая» frame as the engine does, by the photo's own marker (`isBoldFrame`: its category or its Seedream route), so a
// routed photo of any category is Kling-only with Kling's reserve alone, and the same category stored before 5a.4 (no route) keeps today's fallback and price.

const CUSTOM = "cat-testcustom01";
const PHOTOS = {
  routedHome: scenePhoto(1, { category: "home", route: "seedream" }),
  oldHome: scenePhoto(3, { category: "home" }),
  routedCustom: scenePhoto(5, { category: CUSTOM, route: "seedream" }),
  oldCustom: scenePhoto(7, { category: CUSTOM }),
  oldNightwear: scenePhoto(9, { category: "nightwear" }),
  routedNightwear: scenePhoto(11, { category: "nightwear", route: "seedream" }),
  routedBeach: scenePhoto(13, { category: "beach", route: "seedream" }),
  routedFitness: scenePhoto(15, { category: "fit", route: "seedream" }),
};

function mock(options: Parameters<typeof makeClipMock>[0] = {}) {
  const photos = Object.values(PHOTOS);
  return makeClipMock({ photos, ...options });
}

describe("the mock's clip facts follow the photo's own route (S5.BA6)", () => {
  test("a routed «Дом» photo is bold, Kling-only, with Kling's reserve alone", async () => {
    const answer = await suitable(mock(), PHOTOS.routedHome.photoId);
    expect(answer).toMatchObject({ fallback: "none", bold: true });
    expect(answer.prices.std5.worstMicros).toBe(504_000);
  });

});
