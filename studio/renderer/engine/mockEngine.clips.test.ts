import { describe, expect, test } from "bun:test";
import { ClipOptions } from "../../shared/engine";
import { CODE_MOTIONS } from "../../engine/clips/motion";
import { ALL_CLIP_PHOTOS, AVATAR, CLIP_PHOTOS, create, listClips, makeClipMock, money, optionsOf, refusal, suitable, unwrap } from "./mockEngine.clips.testkit";

// Stage 5, 5b.1, S5.V7: `clips.options` and `clips.create` in the mock, refusal for refusal and number for number as the engine answers them (engine.clips.create.test.ts is the reference:
// every figure below is one of its figures). The mock plays a photo with no run plan, which is what the parity rig seeds; its motions are the planless ones.

const MASTER = "photo-mia-master";

describe("clips.options", () => {
  test("a gallery photo is suitable: its three code motions, the six prices, the engine's mode and the month's fit, free", async () => {
    const m = makeClipMock();
    const answer = await suitable(m);
    expect(ClipOptions.safeParse(answer).success).toBe(true);
    expect(answer.motions.map((x) => x.id)).toEqual(["g-blink", "g-tilt", "g-breath"]);
    expect(answer.motions[0]).toEqual({ id: "g-blink", source: "code", label: "Моргает и улыбается", text: "she slowly blinks and gives a small smile" });
    expect(answer).toMatchObject({ photoId: CLIP_PHOTOS.plain.photoId, fallback: "auto", bold: false });
    expect(answer.prices.std5).toMatchObject({ expectedMicros: 420_000, worstMicros: 850_000, prices: "live" });
    expect(answer.prices.pro5).toMatchObject({ expectedMicros: 560_000, worstMicros: 850_000 });
    expect(answer.prices.std10).toMatchObject({ expectedMicros: 840_000, worstMicros: 1_550_000 });
    expect(answer.prices.pro10).toMatchObject({ expectedMicros: 1_120_000, worstMicros: 1_550_000 });
    expect(answer.noFallbackPrices.std5).toMatchObject({ expectedMicros: 420_000, worstMicros: 504_000 });
    expect(answer.noFallbackPrices.pro5.worstMicros).toBe(672_000);
    expect(answer.noFallbackPrices.std10.worstMicros).toBe(924_000);
    expect(answer.noFallbackPrices.pro10.worstMicros).toBe(1_232_000);
    expect(answer.prices.grok5).toMatchObject({ expectedMicros: 710_000, worstMicros: 850_000 });
    expect(answer.prices.grok10).toMatchObject({ expectedMicros: 1_410_000, worstMicros: 1_550_000 });
    expect(answer.monthFits).toEqual({ std5: "with-fallback", pro5: "with-fallback", std10: "with-fallback", pro10: "with-fallback" });
    expect((await money(m)).spentMicros).toBe(0);
  });

  test("the three code motions are the engine's own, label and text", async () => {
    const offered = (await suitable(makeClipMock())).motions;
    for (const motion of offered) {
      const engines = CODE_MOTIONS.find((m) => m.id === motion.id);
      if (engines === undefined) throw new Error(`the engine has no code motion ${motion.id}`);
      expect(motion).toEqual({ id: engines.id, source: "code", label: engines.label, text: engines.text });
    }
  });

  test("a frame of «Смелая» under kling-only has no fallback: its worst is Kling's alone", async () => {
    const answer = await suitable(makeClipMock(), CLIP_PHOTOS.bold.photoId);
    expect(answer).toMatchObject({ fallback: "none", bold: true });
    expect(answer.prices.std5.worstMicros).toBe(504_000);
    expect(answer.prices.pro10.worstMicros).toBe(1_232_000);
    expect(answer.monthFits.std5).toBe("without-fallback");
    expect((await suitable(makeClipMock(), CLIP_PHOTOS.beach.photoId)).bold).toBe(true);
  });

  test("a frame of «Смелая» under off is not suitable: `bold-off`", async () => {
    expect(await optionsOf(makeClipMock({ clips: { boldClips: "off" } }), CLIP_PHOTOS.bold.photoId)).toEqual({ suitable: false, photoId: CLIP_PHOTOS.bold.photoId, reason: "bold-off" });
  });

  test("in mode offer the sheet's worst is Kling's alone, and no month fits with a fallback", async () => {
    const answer = await suitable(makeClipMock({ clips: { mode: "offer" } }));
    expect(answer.fallback).toBe("offer");
    expect(answer.prices.std5.worstMicros).toBe(504_000);
    expect(answer.prices.grok5.worstMicros).toBe(850_000);
    expect(answer.monthFits.std5).toBe("without-fallback");
  });

  test("an unsuitable photo is an answer with its reason, not an error", async () => {
    const m = makeClipMock();
    expect(await optionsOf(m, MASTER)).toEqual({ suitable: false, photoId: MASTER, reason: "not-a-gallery-photo" });
    expect(await optionsOf(m, CLIP_PHOTOS.unknown.photoId)).toEqual({ suitable: false, photoId: CLIP_PHOTOS.unknown.photoId, reason: "no-motion" });
    expect(await optionsOf(m, CLIP_PHOTOS.hidden.photoId)).toEqual({ suitable: false, photoId: CLIP_PHOTOS.hidden.photoId, reason: "no-motion" });
    expect(await optionsOf(m, CLIP_PHOTOS.aged.photoId)).toEqual({ suitable: false, photoId: CLIP_PHOTOS.aged.photoId, reason: "age-unverified" });
  });

  test("a photo whose pixels the first frame cannot use is not suitable: unreadable, or not vertical", async () => {
    const m = makeClipMock();
    m.engine.setClipPhotoPixels(CLIP_PHOTOS.plain.photoId, "unreadable");
    m.engine.setClipPhotoPixels(CLIP_PHOTOS.beach.photoId, "not-vertical");
    expect(await optionsOf(m, CLIP_PHOTOS.plain.photoId)).toMatchObject({ suitable: false, reason: "photo-unreadable" });
    expect(await optionsOf(m, CLIP_PHOTOS.beach.photoId)).toMatchObject({ suitable: false, reason: "not-vertical" });
    m.engine.setClipPhotoPixels(CLIP_PHOTOS.plain.photoId, "ok");
    expect((await optionsOf(m, CLIP_PHOTOS.plain.photoId)).suitable).toBe(true);
  });

  test("the age verdict is read before the pixels, and the pixels before «Смелая» off", async () => {
    const m = makeClipMock({ clips: { boldClips: "off" } });
    m.engine.setClipPhotoPixels(CLIP_PHOTOS.aged.photoId, "unreadable");
    expect(await optionsOf(m, CLIP_PHOTOS.aged.photoId)).toMatchObject({ reason: "age-unverified" });
    m.engine.setClipPhotoPixels(CLIP_PHOTOS.bold.photoId, "not-vertical");
    expect(await optionsOf(m, CLIP_PHOTOS.bold.photoId)).toMatchObject({ reason: "not-vertical" });
  });

  test("PRICE_UNAVAILABLE `video` for a listing that reads and lacks a price; NOT_FOUND for an unknown photo or avatar", async () => {
    const m = makeClipMock();
    m.engine.setVideoPrices("missing");
    expect(await refusal(m.client.request("clips.options", { avatarId: AVATAR, photoId: CLIP_PHOTOS.plain.photoId }))).toMatchObject({ code: "PRICE_UNAVAILABLE", priceScope: "video" });
    expect((await refusal(m.client.request("clips.options", { avatarId: AVATAR, photoId: "photo-nope-0001" }))).code).toBe("NOT_FOUND");
    expect((await refusal(m.client.request("clips.options", { avatarId: "avatar-nope-0001", photoId: CLIP_PHOTOS.plain.photoId }))).code).toBe("NOT_FOUND");
  });

  test("an unreadable listing prices from the dated table, and says so", async () => {
    const m = makeClipMock();
    m.engine.setVideoPrices("fallback");
    expect((await suitable(m)).prices.std5).toMatchObject({ worstMicros: 850_000, prices: "fallback", pricesAsOf: "2026-10-10" });
  });

  test.each([
    [850_000, "with-fallback"],
    [849_999, "without-fallback"],
    [504_000, "without-fallback"],
    [503_999, "none"],
  ] as const)("a monthly budget of %d µ$: the std 5 s option fits %s", async (budget, fit) => {
    const m = makeClipMock({ money: { monthlyBudgetMicros: budget } });
    expect((await suitable(m)).monthFits.std5).toBe(fit);
  });

  test("the month counts what is spent and what is open", async () => {
    const m = makeClipMock({ money: { spentMicros: 100_000, monthlyBudgetMicros: 950_000 } });
    expect((await suitable(m)).monthFits.std5).toBe("with-fallback");
    const tight = makeClipMock({ money: { spentMicros: 100_001, monthlyBudgetMicros: 950_000 } });
    expect((await suitable(tight)).monthFits.std5).toBe("without-fallback");
  });
});

describe("clips.create refuses, free and in order", () => {
  async function nothingHappened(m: ReturnType<typeof makeClipMock>): Promise<void> {
    expect(await listClips(m)).toEqual([]);
    expect(m.events.filter((e) => e.type === "job.progress")).toEqual([]);
    expect(await money(m)).toMatchObject({ spentMicros: 0, unsettledMicros: 0, unsettledCount: 0 });
  }

  test("AUTH_INVALID without a key", async () => {
    const m = makeClipMock();
    await m.client.request("settings.clearApiKey", {});
    expect((await refusal(create(m))).code).toBe("AUTH_INVALID");
    await nothingHappened(m);
  });

  test("RECONCILE_REQUIRED while an earlier process's reserve is open", async () => {
    const m = makeClipMock();
    m.engine.requireReconcile(["open-reserves"]);
    expect((await refusal(create(m))).code).toBe("RECONCILE_REQUIRED");
    await nothingHappened(m);
  });

  test("NOT_FOUND for an avatar or a photo the library does not have, or another avatar's photo", async () => {
    const m = makeClipMock();
    expect((await refusal(create(m, { avatarId: "avatar-nope-0001" }))).code).toBe("NOT_FOUND");
    expect((await refusal(create(m, { photoId: "photo-nope-0001" }))).code).toBe("NOT_FOUND");
    expect((await refusal(create(m, { avatarId: "avatar-sofia-0002" }))).code).toBe("NOT_FOUND");
    await nothingHappened(m);
  });

  test.each([
    ["the master portrait", MASTER, {}, "not-a-gallery-photo"],
    ["a photo the age check did not call adult", CLIP_PHOTOS.aged.photoId, {}, "age-unverified"],
    ["a frame with no known face", CLIP_PHOTOS.unknown.photoId, {}, "no-motion"],
    ["a frame whose face is hidden", CLIP_PHOTOS.hidden.photoId, {}, "no-motion"],
  ] as const)("VALIDATION `%s`", async (_name, photoId, over, reason) => {
    const m = makeClipMock();
    expect(await refusal(create(m, { photoId, ...over }))).toMatchObject({ code: "VALIDATION", clipReason: reason });
    await nothingHappened(m);
  });

  test("VALIDATION `photo-unreadable` and `not-vertical` for a photo the first frame cannot use", async () => {
    const m = makeClipMock();
    m.engine.setClipPhotoPixels(CLIP_PHOTOS.plain.photoId, "unreadable");
    expect(await refusal(create(m))).toMatchObject({ code: "VALIDATION", clipReason: "photo-unreadable" });
    m.engine.setClipPhotoPixels(CLIP_PHOTOS.plain.photoId, "not-vertical");
    expect(await refusal(create(m))).toMatchObject({ code: "VALIDATION", clipReason: "not-vertical" });
    await nothingHappened(m);
  });

  test("VALIDATION `bold-off` for a frame of «Смелая» while BOLD_CLIPS is off", async () => {
    const m = makeClipMock({ clips: { boldClips: "off" } });
    expect(await refusal(create(m, { photoId: CLIP_PHOTOS.bold.photoId, fallback: "none", acceptedWorstMicros: 504_000 }))).toMatchObject({ code: "VALIDATION", clipReason: "bold-off" });
    await nothingHappened(m);
  });

  test("VALIDATION `unknown-motion` for a motion the sheet did not list for this photo", async () => {
    const m = makeClipMock();
    expect(await refusal(create(m, { motionId: "g-hips" }))).toMatchObject({ code: "VALIDATION", clipReason: "unknown-motion" });
    expect(await refusal(create(m, { motionId: "scene" }))).toMatchObject({ code: "VALIDATION", clipReason: "unknown-motion" });
    await nothingHappened(m);
  });

  test("VALIDATION `grok-not-offered` for a Grok clip in mode auto, and for a frame of «Смелая» in mode offer", async () => {
    const auto = makeClipMock();
    expect(await refusal(create(auto, { model: "grok", fallback: "none" }))).toMatchObject({ code: "VALIDATION", clipReason: "grok-not-offered" });
    await nothingHappened(auto);
    const offer = makeClipMock({ clips: { mode: "offer" } });
    expect(await refusal(create(offer, { photoId: CLIP_PHOTOS.bold.photoId, model: "grok", fallback: "none" }))).toMatchObject({ code: "VALIDATION", clipReason: "grok-not-offered" });
    await nothingHappened(offer);
  });

  test("PRICE_UNAVAILABLE `video` when the listing reads and lacks a price", async () => {
    const m = makeClipMock();
    m.engine.setVideoPrices("missing");
    expect(await refusal(create(m))).toMatchObject({ code: "PRICE_UNAVAILABLE", priceScope: "video" });
    await nothingHappened(m);
  });

  test("PRICE_CHANGED when the worst case is above the accepted one; a higher accepted one passes", async () => {
    const m = makeClipMock();
    expect((await refusal(create(m, { acceptedWorstMicros: 849_999 }))).code).toBe("PRICE_CHANGED");
    await nothingHappened(m);
    expect((await unwrap(create(m, { acceptedWorstMicros: 900_000 }))).jobId).toMatch(/^job-/);
  });

  test("BUDGET_EXCEEDED when the month has no room for the clip's worst case", async () => {
    const m = makeClipMock({ money: { monthlyBudgetMicros: 849_999 } });
    expect((await refusal(create(m))).code).toBe("BUDGET_EXCEEDED");
    await nothingHappened(m);
  });

  test.each([
    [504_000, true],
    [503_999, false],
  ] as const)("a monthly budget of %d µ$: the create without a fallback is accepted: %s, as the sheet's `without-fallback` says", async (budget, accepted) => {
    const m = makeClipMock({ money: { monthlyBudgetMicros: budget } });
    const reply = await create(m, { fallback: "none", acceptedWorstMicros: 504_000 });
    expect(reply.ok).toBe(accepted);
    if (!reply.ok) expect(reply.error.code).toBe("BUDGET_EXCEEDED");
  });

  test("the order: the key before the photo's own reason, the photo's before the price, the price change before the month", async () => {
    const keyless = makeClipMock();
    await keyless.client.request("settings.clearApiKey", {});
    expect((await refusal(create(keyless, { photoId: MASTER }))).code).toBe("AUTH_INVALID");
    const priced = makeClipMock({ money: { monthlyBudgetMicros: 1 } });
    priced.engine.setVideoPrices("missing");
    expect(await refusal(create(priced, { photoId: MASTER }))).toMatchObject({ code: "VALIDATION", clipReason: "not-a-gallery-photo" });
    expect(await refusal(create(priced))).toMatchObject({ code: "PRICE_UNAVAILABLE" });
    const changed = makeClipMock({ money: { monthlyBudgetMicros: 1 } });
    expect((await refusal(create(changed, { acceptedWorstMicros: 1 }))).code).toBe("PRICE_CHANGED");
    expect((await refusal(create(changed))).code).toBe("BUDGET_EXCEEDED");
  });
});

describe("what a request becomes", () => {
  test("a frame of «Смелая» under kling-only runs as fallback none whatever the payload says", async () => {
    const m = makeClipMock();
    await unwrap(create(m, { photoId: CLIP_PHOTOS.bold.photoId, fallback: "auto", acceptedWorstMicros: 504_000 }));
    m.scheduler.runAll();
    const [clip] = await listClips(m);
    expect(clip?.request).toEqual({ model: "kling", quality: "std", seconds: 5, fallback: "none" });
  });

  test("a Grok clip in mode offer on an ordinary photo is accepted, and runs with no fallback", async () => {
    const m = makeClipMock({ clips: { mode: "offer" } });
    await unwrap(create(m, { model: "grok", fallback: "auto", acceptedWorstMicros: 850_000 }));
    m.scheduler.runAll();
    const [clip] = await listClips(m);
    expect(clip).toMatchObject({ status: "ready", model: "grok", request: { model: "grok", fallback: "none" } });
  });

  test("every photo of the mock's world has a verdict of its own, none of them an error", async () => {
    const m = makeClipMock();
    for (const photo of ALL_CLIP_PHOTOS) expect(ClipOptions.safeParse(await optionsOf(m, photo.photoId)).success).toBe(true);
  });
});
