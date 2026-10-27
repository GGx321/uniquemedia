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

  test("an old unrouted «Дом» photo is not bold and keeps today's fallback and price", async () => {
    const answer = await suitable(mock(), PHOTOS.oldHome.photoId);
    expect(answer).toMatchObject({ fallback: "auto", bold: false });
    expect(answer.prices.std5.worstMicros).toBe(850_000);
  });

  test("a routed photo of a custom category is bold; an unrouted one is not", async () => {
    expect(await suitable(mock(), PHOTOS.routedCustom.photoId)).toMatchObject({ fallback: "none", bold: true });
    expect(await suitable(mock(), PHOTOS.oldCustom.photoId)).toMatchObject({ fallback: "auto", bold: false });
  });

  test("a nightwear or a beach photo is bold with the route and without it", async () => {
    for (const photo of [PHOTOS.oldNightwear, PHOTOS.routedNightwear, PHOTOS.routedBeach]) expect(await suitable(mock(), photo.photoId)).toMatchObject({ fallback: "none", bold: true });
  });

  test("a «Смелая» frame of the five never falls back, at any engine mode", async () => {
    for (const mode of ["auto", "offer"] as const) {
      const m = mock({ clips: { mode } });
      for (const photo of [PHOTOS.routedHome, PHOTOS.routedFitness]) expect(await suitable(m, photo.photoId)).toMatchObject({ fallback: "none", bold: true });
    }
  });

  test("under `off` a routed «Дом» photo is refused as a frame of «Смелая», and an old one is not", async () => {
    const m = mock({ clips: { boldClips: "off" } });
    expect(await suitable(m, PHOTOS.oldHome.photoId)).toMatchObject({ bold: false });
    const refused = await m.client.request("clips.options", { avatarId: PHOTOS.routedHome.avatarId, photoId: PHOTOS.routedHome.photoId });
    expect(refused).toMatchObject({ ok: true, result: { suitable: false, reason: "bold-off" } });
  });
});
