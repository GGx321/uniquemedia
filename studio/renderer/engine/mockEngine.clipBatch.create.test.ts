import { describe, expect, test } from "bun:test";
import { batchOptions, createBatch, jobState, makeBatchMock, phasesOf, refusal, runUntilEnds, startBatch, stepUntil, unwrap } from "./mockEngine.clipBatch.testkit";

// Stage 5, 5b.2, S5.WB3 (plan s5b2 §5.2.1, I5.62): `clips.batchOptions` and `clips.createBatch` in the mock, refusal for refusal and number for number as the engine answers them
// (engine.clipBatch.create.test.ts is the reference: every figure below is one of its figures). Every refusal of `clips.createBatch` is free and leaves nothing behind.


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

  test("the boundary: a room exactly the sum fits, one micro-dollar less does not (with the fallback, and without it)", async () => {
    const fits = async (budget: number) => (await unwrap(batchOptions(makeBatchMock(3, { money: { monthlyBudgetMicros: budget } }), makeBatchMock(3).photoIds))).monthFits.std5;
    // With Grok behind them the three need 2 550 000; on Kling alone, 1 512 000.
    expect(await fits(2_550_000)).toBe("with-fallback");
    expect(await fits(2_550_000 - 1)).toBe("without-fallback");
    expect(await fits(1_512_000)).toBe("without-fallback");
    expect(await fits(1_512_000 - 1)).toBe("none");
  });

});

describe("clips.createBatch refuses, free and in order", () => {

  test("PRICE_CHANGED when the sum is above what the owner accepted by one micro-dollar, with nothing held; the exact sum is accepted", async () => {
    const m = makeBatchMock(3);
    expect((await refusal(createBatch(m, m.photoIds, { acceptedWorstMicros: 2_550_000 - 1 }))).code).toBe("PRICE_CHANGED");
    await nothingLeft(m);
    const { jobIds } = await startBatch(m, m.photoIds, { acceptedWorstMicros: 2_550_000 });
    runUntilEnds(m, jobIds);
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

});
