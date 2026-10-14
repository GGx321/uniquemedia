import { describe, expect, test } from "bun:test";
import { create, makeClipMock, money, onlyClip, runUntilEnd, unwrap } from "./mockEngine.clips.testkit";

// engine/clips/service.ts: the price list is read ONCE per create (`clipPricesOf`) and the same list prices the estimate, the reserve and the charge (`runClipJob({ prices: job.prices })`). A listing
// that moves moves all three together — and a clip already reserved keeps the list it was reserved by.

const DEARER_KLING = { std: { perSecondMicros: 200_000, perInputImageMicros: 0 }, pro: { perSecondMicros: 112_000, perInputImageMicros: 0 }, grok: { perSecondMicros: 140_000, perInputImageMicros: 10_000 } };

describe("a moved price list in the mock", () => {
  test("the reserve and the charge of a clip follow the list the estimate was read from", async () => {
    const m = makeClipMock();
    m.engine.setClipRates(DEARER_KLING);
    const { jobId } = await unwrap(create(m, { acceptedWorstMicros: 2_000_000 }));
    for (let i = 0; i < 100 && (await money(m)).unsettledMicros === 0; i++) m.scheduler.next();
    // Kling's reserve: 5 s at the new rate, with the engine's 20 % margin (504 000 at the old 84 000).
    expect((await money(m)).unsettledMicros).toBe(1_200_000);
    runUntilEnd(m, jobId);
    expect(await onlyClip(m)).toMatchObject({ cost: { micros: 1_000_000, kind: "billed" } });
    expect(await money(m)).toMatchObject({ spentMicros: 1_000_000, unsettledMicros: 0 });
  });

  test("a list that moves after the create does not re-price the clip already reserved", async () => {
    const m = makeClipMock();
    const { jobId } = await unwrap(create(m));
    for (let i = 0; i < 100 && (await money(m)).unsettledMicros === 0; i++) m.scheduler.next();
    m.engine.setClipRates(DEARER_KLING);
    runUntilEnd(m, jobId);
    expect(await onlyClip(m)).toMatchObject({ cost: { micros: 420_000, kind: "billed" } });
  });
});
