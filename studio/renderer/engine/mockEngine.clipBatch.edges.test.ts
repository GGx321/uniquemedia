import { describe, expect, test } from "bun:test";
import { DEFAULT_TRAITS } from "../lib/traits";
import { makeBatchMock, refusal, runUntilEnds, startBatch, unwrap, type BatchMock } from "./mockEngine.clipBatch.testkit";


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

