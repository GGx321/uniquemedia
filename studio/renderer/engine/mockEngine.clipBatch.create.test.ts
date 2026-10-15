import { describe, expect, test } from "bun:test";
import { ClipBatchOptions, clipBatchExpectedMicros, clipBatchWorstMicros, type ClipPrices } from "../../shared/engine";
import { AGED_FRAME, AVATAR, BOLD_FRAME, batchOptions, createBatch, endsOf, jobState, makeBatchMock, money, phasesOf, refusal, runUntilEnds, startBatch, stepUntil, unwrap } from "./mockEngine.clipBatch.testkit";

// Stage 5, 5b.2, S5.WB3 (plan s5b2 §5.2.1, I5.62): `clips.batchOptions` and `clips.createBatch` in the mock, refusal for refusal and number for number as the engine answers them
// (engine.clipBatch.create.test.ts is the reference: every figure below is one of its figures). Every refusal of `clips.createBatch` is free and leaves nothing behind.

const BOOK: ClipPrices = { std: { perSecondMicros: 84_000, perInputImageMicros: 0 }, pro: { perSecondMicros: 112_000, perInputImageMicros: 0 }, grok: { perSecondMicros: 140_000, perInputImageMicros: 10_000 } };

/** Nothing of a batch was left behind: no ledger line, no month hold, no job, and the unit is free. */
async function nothingLeft(m: ReturnType<typeof makeBatchMock>): Promise<void> {
  expect(m.engine.peekClips().attempts).toEqual([]);
  expect([...m.engine.peekClips().monthHolds]).toEqual([]);
  const snapshot = await unwrap(m.client.request("engine.snapshot", {}));
  expect(snapshot.jobs.filter((job) => job.kind === "clip")).toEqual([]);
  expect(m.engine.peekClips().unit).toBeNull();
  const reconcile = await m.client.request("money.reconcile", {});
  expect(reconcile.ok === false && reconcile.error.code === "IN_FLIGHT").toBe(false);
}

describe("clips.batchOptions", () => {
  test("answers each photo's own options, the four sums by the one formula, and the month's room", async () => {
    const m = makeBatchMock(3);
    const answer = await unwrap(batchOptions(m, m.photoIds));
    expect(ClipBatchOptions.safeParse(answer).success).toBe(true);
    expect(answer.items.map((item) => item.photoId)).toEqual(m.photoIds);
    expect(answer.items.every((item) => item.suitable)).toBe(true);
    const members = [{ bold: false }, { bold: false }, { bold: false }];
    const parts = { quality: "std" as const, seconds: 5 as const, mode: "auto" as const, boldClips: "kling-only" as const, prices: BOOK };
    expect(answer.sums.std5).toEqual({
      expected: clipBatchExpectedMicros(members, { ...parts, fallback: "auto" }),
      worst: clipBatchWorstMicros(members, { ...parts, fallback: "auto" }),
      worstNoFallback: clipBatchWorstMicros(members, { ...parts, fallback: "none" }),
    });
    // The figures themselves, once, so the formula is not the only witness: 3 x (420 000 expected | 850 000 worst with Grok | 504 000 worst on Kling alone).
    expect(answer.sums.std5).toEqual({ expected: 1_260_000, worst: 2_550_000, worstNoFallback: 1_512_000 });
    expect(answer.monthRoomMicros).toBe((await money(m)).monthlyBudgetMicros);
  });

  test("counts only the photos that can be made, and says why the others cannot", async () => {
    const m = makeBatchMock(2);
    const answer = await unwrap(batchOptions(m, [m.photoIds[0] ?? "", "photo-mia-master", "photo-nobody-0001", m.photoIds[1] ?? ""]));
    expect(answer.items.map((item) => (item.suitable ? "ok" : item.reason))).toEqual(["ok", "not-a-gallery-photo", "not-a-gallery-photo", "ok"]);
    expect(answer.sums.std5).toEqual({ expected: 840_000, worst: 1_700_000, worstNoFallback: 1_008_000 });
  });

  test("says the month takes the batch with its fallback, without it, or not at all, from the one room figure", async () => {
    const roomy = await unwrap(batchOptions(makeBatchMock(3, { money: { monthlyBudgetMicros: 3_000_000 } }), makeBatchMock(3).photoIds));
    expect(roomy.monthRoomMicros).toBe(3_000_000);
    expect(roomy.monthFits.std5).toBe("with-fallback");
    const tight = await unwrap(batchOptions(makeBatchMock(3, { money: { monthlyBudgetMicros: 2_000_000 } }), makeBatchMock(3).photoIds));
    expect(tight.monthFits).toEqual({ std5: "without-fallback", pro5: "none", std10: "none", pro10: "none" });
    const empty = await unwrap(batchOptions(makeBatchMock(3, { money: { monthlyBudgetMicros: 1_000_000 } }), makeBatchMock(3).photoIds));
    expect(empty.monthFits).toEqual({ std5: "none", pro5: "none", std10: "none", pro10: "none" });
    for (const answer of [roomy, tight, empty]) expect(ClipBatchOptions.safeParse(answer).success).toBe(true);
  });

  test("the boundary: a room exactly the sum fits, one micro-dollar less does not (with the fallback, and without it)", async () => {
    const fits = async (budget: number) => (await unwrap(batchOptions(makeBatchMock(3, { money: { monthlyBudgetMicros: budget } }), makeBatchMock(3).photoIds))).monthFits.std5;
    // With Grok behind them the three need 2 550 000; on Kling alone, 1 512 000.
    expect(await fits(2_550_000)).toBe("with-fallback");
    expect(await fits(2_550_000 - 1)).toBe("without-fallback");
    expect(await fits(1_512_000)).toBe("without-fallback");
    expect(await fits(1_512_000 - 1)).toBe("none");
  });

  test("never says with-fallback for a batch of «Смелая» frames, which are Kling's alone", async () => {
    const m = makeBatchMock(0, {}, [BOLD_FRAME, { ...BOLD_FRAME, photoId: "photo-mia-0022" }]);
    const answer = await unwrap(batchOptions(m, m.photoIds));
    expect(answer.sums.std5.worst).toBe(answer.sums.std5.worstNoFallback);
    expect(answer.sums.std5.worst).toBe(1_008_000);
    expect(answer.monthFits.std5).toBe("without-fallback");
    expect(ClipBatchOptions.safeParse(answer).success).toBe(true);
  });

  test("reads the room net of what a running batch holds and has reserved, and the answer passes the contract's own refines", async () => {
    const m = makeBatchMock(4, { money: { monthlyBudgetMicros: 3_000_000 } });
    const { jobIds } = await startBatch(m, m.photoIds.slice(0, 2));
    stepUntil(m, () => phasesOf(m.events, jobIds[0] ?? "").includes("rendering"), "member 1 rendering");

    const answer = await unwrap(batchOptions(m, m.photoIds.slice(2)));
    // 3 000 000 - the first member's open Kling reserve 504 000 - the second member's hold 850 000.
    expect(answer.monthRoomMicros).toBe(3_000_000 - 504_000 - 850_000);
    expect(ClipBatchOptions.safeParse(answer).success).toBe(true);
    // Two more frames would need 1 700 000 with Grok behind them, and the room is 1 646 000: Kling alone fits.
    expect(answer.monthFits.std5).toBe("without-fallback");
    runUntilEnds(m, jobIds);
  });

  test("each photo's own sheet is derived from the same room figure as the batch's", async () => {
    const m = makeBatchMock(4, { money: { monthlyBudgetMicros: 3_000_000 } });
    const answer = await unwrap(batchOptions(m, m.photoIds));
    expect(answer.items.every((item) => item.suitable && item.monthFits.std5 === "with-fallback")).toBe(true);
  });

  test("is free: no ledger line, no hold, no job", async () => {
    const m = makeBatchMock(2);
    await unwrap(batchOptions(m, m.photoIds));
    await nothingLeft(m);
  });

  test("NOT_FOUND for an avatar the library does not have", async () => {
    const m = makeBatchMock(1);
    expect((await refusal(batchOptions(m, m.photoIds, "avatar-nope-0001"))).code).toBe("NOT_FOUND");
  });

  test("PRICE_UNAVAILABLE with `priceScope: \"video\"` for a listing that reads and lacks a price", async () => {
    const m = makeBatchMock(1);
    m.engine.setVideoPrices("missing");
    expect(await refusal(batchOptions(m, m.photoIds))).toMatchObject({ code: "PRICE_UNAVAILABLE", priceScope: "video" });
  });
});

describe("clips.createBatch refuses, free and in order", () => {
  test("AUTH_INVALID without a key", async () => {
    const m = makeBatchMock(2);
    await m.client.request("settings.clearApiKey", {});
    expect((await refusal(createBatch(m, m.photoIds))).code).toBe("AUTH_INVALID");
    await nothingLeft(m);
  });

  test("RECONCILE_REQUIRED while an earlier process's reserve is open", async () => {
    const m = makeBatchMock(2);
    m.engine.requireReconcile(["open-reserves"]);
    expect((await refusal(createBatch(m, m.photoIds))).code).toBe("RECONCILE_REQUIRED");
    expect([...m.engine.peekClips().monthHolds]).toEqual([]);
  });

  test("NOT_FOUND means the avatar and nothing else", async () => {
    const m = makeBatchMock(2);
    expect((await refusal(createBatch(m, m.photoIds, { avatarId: "avatar-nope-0001" }))).code).toBe("NOT_FOUND");
  });

  test("a photo that is missing is VALIDATION `not-a-gallery-photo` at its own path, never NOT_FOUND, and nothing is held", async () => {
    const m = makeBatchMock(2);
    const missing = await refusal(createBatch(m, [m.photoIds[0] ?? "", "photo-nobody-0001"]));
    expect(missing).toMatchObject({ code: "VALIDATION", clipReason: "not-a-gallery-photo", path: ["items", 1] });
    await nothingLeft(m);
  });

  test("an item's own reason comes with its path, the lowest item first, and nothing is held", async () => {
    const m = makeBatchMock(2, {}, [AGED_FRAME]);
    const [a, b, aged] = m.photoIds;
    const both = await refusal(createBatch(m, [a ?? "", "photo-mia-master", aged ?? ""]));
    expect(both).toMatchObject({ code: "VALIDATION", clipReason: "not-a-gallery-photo", path: ["items", 1] });
    const age = await refusal(createBatch(m, [a ?? "", b ?? "", aged ?? ""]));
    expect(age).toMatchObject({ code: "VALIDATION", clipReason: "age-unverified", path: ["items", 2] });
    const motion = await refusal(createBatch(m, [a ?? "", b ?? ""], { motionIds: { 1: "g-hips" } }));
    expect(motion).toMatchObject({ code: "VALIDATION", clipReason: "unknown-motion", path: ["items", 1] });
    await nothingLeft(m);
  });

  test("an unknown motion of an earlier item is told before the refused photo of a later one (per item, in order)", async () => {
    const m = makeBatchMock(2, {}, [AGED_FRAME]);
    const [a, b, aged] = m.photoIds;
    const told = await refusal(createBatch(m, [a ?? "", b ?? "", aged ?? ""], { motionIds: { 0: "g-hips" } }));
    expect(told).toMatchObject({ clipReason: "unknown-motion", path: ["items", 0] });
  });

  test("`bold-off` is the item's own reason too, while «Смелая» is off", async () => {
    const m = makeBatchMock(1, { clips: { timings: "short", boldClips: "off" } }, [BOLD_FRAME]);
    expect(await refusal(createBatch(m, m.photoIds))).toMatchObject({ code: "VALIDATION", clipReason: "bold-off", path: ["items", 1] });
    await nothingLeft(m);
  });

  test("PRICE_UNAVAILABLE `video` for a listing that lacks a price", async () => {
    const m = makeBatchMock(2);
    m.engine.setVideoPrices("missing");
    expect(await refusal(createBatch(m, m.photoIds))).toMatchObject({ code: "PRICE_UNAVAILABLE", priceScope: "video" });
    await nothingLeft(m);
  });

  test("PRICE_CHANGED when the sum is above what the owner accepted by one micro-dollar, with nothing held; the exact sum is accepted", async () => {
    const m = makeBatchMock(3);
    expect((await refusal(createBatch(m, m.photoIds, { acceptedWorstMicros: 2_550_000 - 1 }))).code).toBe("PRICE_CHANGED");
    await nothingLeft(m);
    const { jobIds } = await startBatch(m, m.photoIds, { acceptedWorstMicros: 2_550_000 });
    runUntilEnds(m, jobIds);
  });

  test("BUDGET_EXCEEDED from the month hold when the sum does not fit, with nothing held", async () => {
    const m = makeBatchMock(3, { money: { monthlyBudgetMicros: 2_550_000 - 1 } });
    expect((await refusal(createBatch(m, m.photoIds))).code).toBe("BUDGET_EXCEEDED");
    await nothingLeft(m);
    // The unit came back: a batch that fits is taken at once.
    const { jobIds } = await startBatch(m, m.photoIds.slice(0, 2), { acceptedWorstMicros: 1_700_000 });
    expect(jobIds).toHaveLength(2);
    runUntilEnds(m, jobIds);
  });

  test("a month room exactly the sum is accepted", async () => {
    const m = makeBatchMock(3, { money: { monthlyBudgetMicros: 2_550_000 } });
    const { jobIds } = await startBatch(m, m.photoIds);
    expect(jobIds).toHaveLength(3);
    runUntilEnds(m, jobIds);
    expect(endsOf(m, jobIds).map((e) => e?.type)).toEqual(["job.done", "job.done", "job.done"]);
  });

  test("every refusal gives the unit back, so the next batch is taken", async () => {
    const m = makeBatchMock(2);
    for (let round = 0; round < 3; round++) expect((await createBatch(m, ["photo-mia-master"])).ok).toBe(false);
    const { jobIds } = await startBatch(m, m.photoIds);
    runUntilEnds(m, jobIds);
    expect(endsOf(m, jobIds).map((e) => e?.type)).toEqual(["job.done", "job.done"]);
  });
});

describe("clips.createBatch accepts", () => {
  test("answers the batch id and one job id per item in pick order; the first member runs and the rest wait `queued` with the trio", async () => {
    const m = makeBatchMock(3);
    const { batchId, jobIds } = await startBatch(m, m.photoIds);
    expect(jobIds).toHaveLength(3);
    expect(new Set(jobIds).size).toBe(3);
    stepUntil(m, () => phasesOf(m.events, jobIds[0] ?? "").includes("rendering"), "member 1 rendering");

    const states = await Promise.all(jobIds.map((id) => jobState(m, id)));
    expect(states.map((s) => [s?.phase, s?.batchId, s?.batchIndex, s?.batchSize, s?.photoId])).toEqual([
      ["rendering", batchId, 1, 3, m.photoIds[0]],
      ["queued", batchId, 2, 3, m.photoIds[1]],
      ["queued", batchId, 3, 3, m.photoIds[2]],
    ]);
    expect(states[1]).toMatchObject({ status: "running", done: 0, waitReason: "turn", acceptedWorstMicros: 850_000, request: { model: "kling", quality: "std", seconds: 5, fallback: "auto" } });
    // The queued members were announced before they ever ran, and a queued job tells no model, no submit time, no proof window and no open reserve.
    expect(phasesOf(m.events, jobIds[1] ?? "")[0]).toBe("queued");
    const queued = m.events.flatMap((e) => (e.type === "job.progress" && e.payload.kind === "clip" && e.payload.phase === "queued" ? [e.payload] : []));
    for (const p of queued) expect([p.model, p.submittedAt, p.proveUntil, p.openReserveMicros, p.done]).toEqual([undefined, undefined, undefined, undefined, 0]);
    expect(m.engine.peekClips().posts).toHaveLength(1);
    runUntilEnds(m, jobIds);
  });

  test("a member's share is its worst case under the batch's book: a month hold each, and the first reserve takes its hold", async () => {
    const m = makeBatchMock(3);
    const { jobIds } = await startBatch(m, m.photoIds);
    expect([...m.engine.peekClips().monthHolds]).toEqual(jobIds.map((id) => [`${id}:video#1`, 850_000]));
    stepUntil(m, () => phasesOf(m.events, jobIds[0] ?? "").includes("rendering"), "member 1 rendering");
    // The first member reserved Kling's 504 000 (its hold went with the reserve); the other two hold their 850 000 shares.
    const status = await money(m);
    expect(status.unsettledMicros).toBe(504_000);
    expect([...m.engine.peekClips().monthHolds].map(([, micros]) => micros)).toEqual([850_000, 850_000]);
    runUntilEnds(m, jobIds);
  });

  test("a «Смелая» member's share is Kling's alone, and the batch's sum is the sum of the shares", async () => {
    const m = makeBatchMock(1, {}, [BOLD_FRAME]);
    // 850 000 for the plain frame (Grok behind Kling) + 504 000 for the frame of «Смелая».
    expect((await refusal(createBatch(m, m.photoIds, { acceptedWorstMicros: 850_000 + 504_000 - 1 }))).code).toBe("PRICE_CHANGED");
    const { jobIds } = await startBatch(m, m.photoIds, { acceptedWorstMicros: 850_000 + 504_000 });
    stepUntil(m, () => phasesOf(m.events, jobIds[0] ?? "").includes("rendering"), "member 1 rendering");
    const bold = await jobState(m, jobIds[1] ?? "");
    expect(bold?.acceptedWorstMicros).toBe(504_000);
    expect(bold?.request).toMatchObject({ fallback: "none" });
    expect([...m.engine.peekClips().monthHolds].map(([, micros]) => micros)).toEqual([504_000]);
    runUntilEnds(m, jobIds);
  });

  test("the avatar is the engine's: the master photo of the avatar is not a gallery photo", async () => {
    const m = makeBatchMock(1);
    expect(await refusal(createBatch(m, ["photo-mia-master"]))).toMatchObject({ clipReason: "not-a-gallery-photo", path: ["items", 0] });
    expect(AVATAR).toBe("avatar-mia-0001");
  });
});
