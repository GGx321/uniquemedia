import { describe, expect, test } from "bun:test";
import { DEFAULT_TRAITS } from "../lib/traits";
import { endOf, makeBatchMock, refusal, runUntilEnds, startBatch, stepUntil, unwrap, type BatchMock } from "./mockEngine.clipBatch.testkit";


async function draftWorst(m: BatchMock): Promise<number> {
  return (await unwrap(m.client.request("avatars.estimate", { traits: DEFAULT_TRAITS }))).worstMicros;
}

describe("a batch's month holds are seen by every other paid command", () => {
  test("a draft whose worst case fits the month without the holds and not with them is BUDGET_EXCEEDED while the batch runs, and goes through once it ended", async () => {
    const probe = makeBatchMock(1);
    const worst = await draftWorst(probe);
    // Room for the three held shares (3 x 850 000) and, beyond them, one micro-dollar less than the draft needs.
    const m = makeBatchMock(4, { money: { monthlyBudgetMicros: 3 * 850_000 + worst - 1 } });
    expect(worst).toBeGreaterThan(0);
    const { jobIds } = await startBatch(m, m.photoIds.slice(0, 3));
    expect(await refusal(m.client.request("avatars.createDraft", { traits: DEFAULT_TRAITS, acceptedWorstMicros: worst }))).toMatchObject({ code: "BUDGET_EXCEEDED" });
    runUntilEnds(m, jobIds);
    // The batch settled 3 x 420 000 and held nothing: the same draft fits now.
    expect((await m.client.request("avatars.createDraft", { traits: DEFAULT_TRAITS, acceptedWorstMicros: worst })).ok).toBe(true);
  });

});

describe("a member requeued after a 429 takes no month hold", () => {
  test("its reserve checks the month itself: the room another job took meanwhile makes it a free BUDGET_EXCEEDED, and the unit comes back", async () => {
    const m = makeBatchMock(1, { money: { monthlyBudgetMicros: 1_500_000 } });
    m.engine.scriptNextBatch(["rate-limited", "ok"]);
    const { jobIds } = await startBatch(m, m.photoIds);
    stepUntil(m, () => endOf(m.events, jobIds[0] ?? "") !== undefined, "the first member's end");
    // The 429 gave its room back; another kind of job takes almost all of it before the retry's reserve.
    m.engine.openForeignReserve("photo-run-0009:slot-1#1", 1_400_000);
    const retry = m.events.flatMap((e) => (e.type === "job.progress" && e.payload.kind === "clip" && !jobIds.includes(e.payload.jobId) ? [e.payload.jobId] : []))[0] ?? "";
    expect(retry).not.toBe("");
    stepUntil(m, () => endOf(m.events, retry) !== undefined, "the retry's end");
    expect(endOf(m.events, retry)).toMatchObject({ type: "job.failed", payload: { error: { code: "BUDGET_EXCEEDED" } } });
    expect(m.engine.peekClips().posts).toHaveLength(1);
    expect(m.engine.peekClips().unit).toBeNull();
    expect([...m.engine.peekClips().monthHolds]).toEqual([]);
  });
});
