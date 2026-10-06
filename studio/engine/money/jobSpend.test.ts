import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { setupMoney, type Money } from "../openrouter/testing/fakes";
import { jobOpenReserveMicros, jobSpentMicros } from "./jobSpend";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// What a job cost, as the ledger books it: a settled attempt at its cost, an attempt still open at its worst case, a released one at nothing.

const AT = "2026-10-05T12:00:00.000Z";
const SCOPE = { avatarJobId: "job-00000001" };

let money: Money;
beforeEach(async () => {
  money = await setupMoney();
});
afterEach(async () => {
  await money.cleanup();
});

async function reserve(attemptId: string, jobId: string, worstMicros: number): Promise<void> {
  await money.ledger.append({ type: "reserve", attemptId, jobId, scope: { avatarJobId: jobId }, model: "x-ai/grok-4.3", worstMicros, at: AT });
}
const settle = (attemptId: string, costMicros: number, estimated = false) => money.ledger.append({ type: "settle", attemptId, costMicros, estimated, at: AT });
const release = (attemptId: string) => money.ledger.append({ type: "release", attemptId, reason: "never sent", at: AT });

describe("jobSpentMicros", () => {
  test("is nothing for a job the ledger has never heard of", async () => {
    expect(jobSpentMicros(money.ledger, "job-00000001")).toBe(0);
  });

  test("sums the settled cost of the job's attempts", async () => {
    await reserve("job-00000001:pool#1", "job-00000001", 22_500);
    await settle("job-00000001:pool#1", 5_000);
    await reserve("job-00000001:pool#2", "job-00000001", 22_500);
    await settle("job-00000001:pool#2", 6_000);
    expect(jobSpentMicros(money.ledger, "job-00000001")).toBe(11_000);
  });

  test("counts an attempt still open at its worst case", async () => {
    await reserve("job-00000001:pool#1", "job-00000001", 22_500);
    await settle("job-00000001:pool#1", 5_000);
    await reserve("job-00000001:pool#2", "job-00000001", 22_500);
    expect(jobSpentMicros(money.ledger, "job-00000001")).toBe(27_500);
  });

  test("counts a reconcile's estimated settle at what it settled", async () => {
    await reserve("job-00000001:pool#1", "job-00000001", 22_500);
    await settle("job-00000001:pool#1", 22_500, true);
    expect(jobSpentMicros(money.ledger, "job-00000001")).toBe(22_500);
  });

  test("counts a released attempt (it never left) as nothing", async () => {
    await reserve("job-00000001:pool#1", "job-00000001", 22_500);
    await release("job-00000001:pool#1");
    expect(jobSpentMicros(money.ledger, "job-00000001")).toBe(0);
  });

  test("never counts another job's attempts", async () => {
    await reserve("job-00000001:pool#1", "job-00000001", 22_500);
    await settle("job-00000001:pool#1", 5_000);
    await reserve("job-00000002:pool#1", "job-00000002", 22_500);
    await settle("job-00000002:pool#1", 7_000);
    expect(jobSpentMicros(money.ledger, "job-00000001")).toBe(5_000);
    expect(jobSpentMicros(money.ledger, "job-00000002")).toBe(7_000);
    void SCOPE;
  });
});

describe("jobOpenReserveMicros", () => {
  test("is nothing for a job the ledger has never heard of", async () => {
    expect(jobOpenReserveMicros(money.ledger, "job-00000001")).toBe(0);
  });

  test("is the worst case of an attempt still open: the part of the job's spend that is counted at a worst-case price until the reconcile", async () => {
    await reserve("job-00000001:pool#1", "job-00000001", 22_500);
    await settle("job-00000001:pool#1", 5_000);
    await reserve("job-00000001:pool#2", "job-00000001", 22_500);
    expect(jobOpenReserveMicros(money.ledger, "job-00000001")).toBe(22_500);
    expect(jobSpentMicros(money.ledger, "job-00000001")).toBe(27_500);
  });

  test("is nothing once every attempt is settled, a reconcile's estimated settle included", async () => {
    await reserve("job-00000001:pool#1", "job-00000001", 22_500);
    await settle("job-00000001:pool#1", 22_500, true);
    expect(jobOpenReserveMicros(money.ledger, "job-00000001")).toBe(0);
  });

  test("is nothing for a released attempt, and never counts another job's open one", async () => {
    await reserve("job-00000001:pool#1", "job-00000001", 22_500);
    await release("job-00000001:pool#1");
    await reserve("job-00000002:pool#1", "job-00000002", 22_500);
    expect(jobOpenReserveMicros(money.ledger, "job-00000001")).toBe(0);
  });
});
