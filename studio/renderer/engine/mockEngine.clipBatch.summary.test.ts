import { describe, expect, test } from "bun:test";
import { ClipBatchSummary } from "../../shared/engine";
import { makeBatchMock, runUntilEnds, startBatch, unwrap, AVATAR, type BatchMock } from "./mockEngine.clipBatch.testkit";

// Stage 5, 5b.2, S5.WB2c (plan s5b2 §5.2, I5.62, I5.63): the batch's own summary in the mock, the mirror of engine.clipBatch.summary.test.ts. Every number and state is the engine's (Grok bills at the mock's own
// price table, $0.71 for 5 s, where the engine's fake provider bills a flat $0.42); the rules are the one shared set (shared/engine/clipBatchSummary.ts).


async function listOf(m: BatchMock): Promise<{ clips: { clipId: string }[]; batches?: ClipBatchSummary[] }> {
  return unwrap(m.client.request("clips.list", { avatarId: AVATAR }));
}

async function summaryOf(m: BatchMock, batchId: string): Promise<ClipBatchSummary> {
  const found = (await listOf(m)).batches?.find((summary) => summary.batchId === batchId);
  if (found === undefined) throw new Error(`clips.list carries no summary of batch ${batchId}`);
  expect(ClipBatchSummary.safeParse(found).success).toBe(true);
  return found;
}


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

