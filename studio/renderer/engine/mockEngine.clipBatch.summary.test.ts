import { describe, expect, test } from "bun:test";
import { ClipBatchSummary } from "../../shared/engine";
import { BOLD_FRAME, cancelBatch, endOf, makeBatchMock, phasesOf, runUntilEnds, script, startBatch, stepUntil, unwrap, AVATAR, type BatchMock } from "./mockEngine.clipBatch.testkit";

// Stage 5, 5b.2, S5.WB2c (plan s5b2 §5.2, I5.62, I5.63): the batch's own summary in the mock, the mirror of engine.clipBatch.summary.test.ts. Every number and state is the engine's (Grok bills at the mock's own
// price table, $0.71 for 5 s, where the engine's fake provider bills a flat $0.42); the rules are the one shared set (shared/engine/clipBatchSummary.ts).

const MIN = 60_000;

async function listOf(m: BatchMock): Promise<{ clips: { clipId: string }[]; batches?: ClipBatchSummary[] }> {
  return unwrap(m.client.request("clips.list", { avatarId: AVATAR }));
}

async function summaryOf(m: BatchMock, batchId: string): Promise<ClipBatchSummary> {
  const found = (await listOf(m)).batches?.find((summary) => summary.batchId === batchId);
  if (found === undefined) throw new Error(`clips.list carries no summary of batch ${batchId}`);
  expect(ClipBatchSummary.safeParse(found).success).toBe(true);
  return found;
}

const shape = (summary: ClipBatchSummary): [number, string, number, string, number][] => summary.members.map((m) => [m.batchIndex, m.outcome, m.costMicros, m.costKind, m.clipIds.length]);

describe("the mock writes a batch's summary, and clips.list carries it", () => {
  test("a clean batch: every member made at its bill, the batch's one total and its end", async () => {
    const m = makeBatchMock(3);
    const { batchId, jobIds } = await startBatch(m, m.photoIds);
    runUntilEnds(m, jobIds);

    const summary = await summaryOf(m, batchId);
    expect(summary).toMatchObject({ batchId, avatarId: AVATAR, size: 3, cost: { micros: 1_260_000, kind: "billed" } });
    expect(summary.members).toEqual(jobIds.map((clipId, i) => ({ batchIndex: i + 1, outcome: "ready", costMicros: 420_000, costKind: "billed", clipIds: [clipId] })));
    expect(summary.endedAt).toBeDefined();
    expect(summary.stop).toBeUndefined();
  });

  test("while the batch runs, the members still waiting are queued in it and the queue has no end", async () => {
    const m = makeBatchMock(3);
    const { batchId, jobIds } = await startBatch(m, m.photoIds);
    stepUntil(m, () => phasesOf(m.events, jobIds[0] ?? "").includes("rendering"), "member 1 rendering");

    const summary = await summaryOf(m, batchId);
    expect(summary.members.map((member) => member.outcome)).toEqual(["running", "queued", "queued"]);
    expect(summary.members[0]).toMatchObject({ costMicros: 504_000, costKind: "open" });
    expect(summary.cost).toEqual({ micros: 504_000, kind: "open" });
    expect(summary.endedAt).toBeUndefined();
  });

  test("an avatar that made no batch has no `batches` in its list", async () => {
    const m = makeBatchMock(1);
    expect(await listOf(m)).toEqual({ clips: [] });
  });
});

describe("a batch clip the owner deletes (the UI review's money MEDIUM)", () => {
  test("stays made in the summary, with its cost in the batch's total, and a restart leaves it so", async () => {
    const m = makeBatchMock(3);
    const { batchId, jobIds } = await startBatch(m, m.photoIds);
    runUntilEnds(m, jobIds);
    const before = await summaryOf(m, batchId);

    await unwrap(m.client.request("clips.delete", { avatarId: AVATAR, clipId: jobIds[1] ?? "" }));
    const listed = await listOf(m);
    expect(listed.clips.map((clip) => clip.clipId)).not.toContain(jobIds[1]);
    expect(listed.batches?.find((summary) => summary.batchId === batchId)).toEqual(before);
    expect(before.members[1]).toMatchObject({ outcome: "ready", costMicros: 420_000, costKind: "billed" });

    m.engine.restart();
    m.scheduler.runAll();
    const after = await summaryOf(m, batchId);
    expect(after).toEqual(before);
    expect(after.cost).toEqual({ micros: 1_260_000, kind: "billed" });
  });
});

describe("each end of a member, as the summary tells it", () => {
  test("a member refused for free and made on Grok is made, at Grok's bill; a «Смелая» member refused is refused, free", async () => {
    const m = makeBatchMock(1, {}, [BOLD_FRAME]);
    const [plain, bold] = m.photoIds;
    script(m, [{ first: "refused-free" }, { first: "refused-free" }]);
    const { batchId, jobIds } = await startBatch(m, [plain ?? "", bold ?? ""], { acceptedWorstMicros: 850_000 + 504_000 });
    runUntilEnds(m, jobIds);

    const summary = await summaryOf(m, batchId);
    expect(shape(summary)).toEqual([
      [1, "ready", 710_000, "billed", 1],
      [2, "refused", 0, "free", 1],
    ]);
    expect(summary.cost).toEqual({ micros: 710_000, kind: "billed" });
  });

  test("a 429 at a member's submit: the member names both its clips, and its money is the second's bill (the first was free)", async () => {
    const m = makeBatchMock(2);
    script(m, ["ok", "rate-limited", "ok"]);
    const { batchId, jobIds } = await startBatch(m, m.photoIds);
    stepUntil(m, () => m.engine.peekClips().unit === null, "the end of the batch");
    m.scheduler.runAll();

    const summary = await summaryOf(m, batchId);
    expect(summary.members[1]?.clipIds[0]).toBe(jobIds[1]);
    expect(summary.members[1]).toMatchObject({ batchIndex: 2, outcome: "ready", costMicros: 420_000, costKind: "billed" });
    expect(summary.members[1]?.clipIds).toHaveLength(2);
    expect(summary.cost).toEqual({ micros: 840_000, kind: "billed" });
  });

  test("a price stop: the members it cancelled say why, free, and the batch tells the stop", async () => {
    const m = makeBatchMock(3);
    const { batchId, jobIds } = await startBatch(m, m.photoIds);
    stepUntil(m, () => phasesOf(m.events, jobIds[0] ?? "").includes("rendering"), "member 1 rendering");
    m.engine.setClipRates({ std: { perSecondMicros: 200_000, perInputImageMicros: 0 }, pro: { perSecondMicros: 112_000, perInputImageMicros: 0 }, grok: { perSecondMicros: 140_000, perInputImageMicros: 10_000 } });
    m.engine.passClipTime(11 * MIN);
    runUntilEnds(m, jobIds);

    const summary = await summaryOf(m, batchId);
    expect(summary.stop).toBe("price-changed");
    expect(summary.members.map((member) => [member.outcome, member.detail, member.costKind])).toEqual([
      ["ready", undefined, "billed"],
      ["cancelled", "price-changed", "free"],
      ["cancelled", "price-changed", "free"],
    ]);
    expect(summary.endedAt).toBeDefined();
  });

  test("the owner's cancel is the batch's stop `cancelled`; one queued member cancelled alone stops nothing", async () => {
    const m = makeBatchMock(4);
    const { batchId, jobIds } = await startBatch(m, m.photoIds);
    stepUntil(m, () => phasesOf(m.events, jobIds[0] ?? "").includes("rendering"), "member 1 rendering");
    await unwrap(m.client.request("avatars.cancel", { jobId: jobIds[1] ?? "" }));
    expect((await summaryOf(m, batchId)).stop).toBeUndefined();
    expect(await cancelBatch(m, batchId)).toMatchObject({ ok: true, result: { cancelled: 2 } });
    runUntilEnds(m, jobIds);

    const summary = await summaryOf(m, batchId);
    expect(summary.stop).toBe("cancelled");
    expect(summary.members.map((member) => [member.outcome, member.detail])).toEqual([
      ["ready", undefined],
      ["cancelled", "cancelled"],
      ["cancelled", "cancelled"],
      ["cancelled", "cancelled"],
    ]);
  });

  test("an uncertain submit: the member failed with its reserve open at worst, the queue stopped money-uncertain, the total open", async () => {
    const m = makeBatchMock(3);
    script(m, ["uncertain"]);
    const { batchId, jobIds } = await startBatch(m, m.photoIds);
    runUntilEnds(m, jobIds);

    const summary = await summaryOf(m, batchId);
    expect(summary.stop).toBe("money-uncertain");
    expect(shape(summary)).toEqual([
      [1, "failed", 504_000, "open", 1],
      [2, "cancelled", 0, "free", 1],
      [3, "cancelled", 0, "free", 1],
    ]);
    expect(summary.cost).toEqual({ micros: 504_000, kind: "open" });
  });
});

describe("a restart ends the batch it finds running (I5.63)", () => {
  test("the queued members are dropped, free; the member that was sent is made by its recovery, with its money still open (the reconcile's)", async () => {
    const m = makeBatchMock(3);
    const { batchId, jobIds } = await startBatch(m, m.photoIds);
    stepUntil(m, () => phasesOf(m.events, jobIds[0] ?? "").includes("rendering"), "member 1 rendering");
    m.engine.restart();
    m.scheduler.runAll();

    const summary = await summaryOf(m, batchId);
    expect(shape(summary)).toEqual([
      [1, "ready", 504_000, "open", 1],
      [2, "dropped", 0, "free", 1],
      [3, "dropped", 0, "free", 1],
    ]);
    expect(summary.endedAt).toBeDefined();
    expect(summary.cost).toEqual({ micros: 504_000, kind: "open" });
  });

  test("the member at work stays at work while its recovery runs: the queue is over, the member is not", async () => {
    const m = makeBatchMock(2);
    const { batchId, jobIds } = await startBatch(m, m.photoIds);
    stepUntil(m, () => phasesOf(m.events, jobIds[0] ?? "").includes("rendering"), "member 1 rendering");
    m.engine.restart();

    const summary = await summaryOf(m, batchId);
    expect(summary.members.map((member) => member.outcome)).toEqual(["running", "dropped"]);
    expect(summary.endedAt).toBeDefined();
  });
});

describe("a failed download fetched again", () => {
  test("turns its member from failed to made", async () => {
    const m = makeBatchMock(1);
    script(m, ["download-failed"]);
    const { batchId, jobIds } = await startBatch(m, m.photoIds);
    runUntilEnds(m, jobIds);
    expect((await summaryOf(m, batchId)).members[0]?.outcome).toBe("failed");

    const { jobId } = await unwrap(m.client.request("clips.retryDownload", { avatarId: AVATAR, clipId: jobIds[0] ?? "" }));
    stepUntil(m, () => endOf(m.events, jobId) !== undefined, "the retry's end");
    expect((await summaryOf(m, batchId)).members[0]).toMatchObject({ outcome: "ready", costKind: "billed" });
  });
});

describe("an avatar keeps its newest 20 batch summaries", () => {
  test("a new batch forgets the oldest past 20 whose queue ended and whose money is closed", async () => {
    const m = makeBatchMock(1);
    const made: string[] = [];
    for (let i = 0; i < 22; i++) {
      const { batchId, jobIds } = await startBatch(m, m.photoIds);
      runUntilEnds(m, jobIds);
      stepUntil(m, () => m.engine.peekClips().unit === null, "the unit back");
      made.push(batchId);
      m.engine.passClipTime(MIN);
    }
    const kept = (await listOf(m)).batches?.map((summary) => summary.batchId) ?? [];
    expect(kept).toEqual(made.slice(2).reverse());
  });
});
