import { describe, expect, test } from "bun:test";
import { ClipOptions } from "../../shared/engine";
import { CLIP_PHOTOS, create, listClips, makeClipMock, money, refusal, suitable, unwrap } from "./mockEngine.clips.testkit";

// Stage 5, 5b.1, S5.V7: `clips.options` and `clips.create` in the mock, refusal for refusal and number for number as the engine answers them (engine.clips.create.test.ts is the reference:
// every figure below is one of its figures). The mock plays a photo with no run plan, which is what the parity rig seeds; its motions are the planless ones.


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

});

