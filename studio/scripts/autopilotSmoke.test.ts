import { describe, expect, test } from "bun:test";
import {
  acceptedRemainingProblems,
  ledgerProblems,
  photoAttemptProblems,
  quietRestartProblems,
  readLedger,
  restartNoticeProblems,
} from "./autopilotSmoke";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// The pure half of the packaged autopilot scenario (S4.E2E): what it reads off the ledger and the disk, and what it requires of the launch's view. The scenario itself drives the
// packaged app (smoke-engine.ts); these are the judgements it makes, kept here so a wrong one fails in the suite and not twenty minutes into a CI run.

const reserve = (attemptId: string, model = "m"): string => JSON.stringify({ type: "reserve", attemptId, jobId: "job-1", scope: {}, model, worstMicros: 100, at: "2026-10-10T00:00:00.000Z" });
const settle = (attemptId: string): string => JSON.stringify({ type: "settle", attemptId, costMicros: 40, estimated: false, at: "2026-10-10T00:00:00.000Z" });
const release = (attemptId: string): string => JSON.stringify({ type: "release", attemptId, at: "2026-10-10T00:00:00.000Z" });
const ledgerText = (...lines: string[]): string => `${lines.join("\n")}\n`;
const counts = (entries: Record<string, number>): ReadonlyMap<string, number> => new Map(Object.entries(entries));

describe("the autopilot smoke's money and restart verifiers refuse what they are for", () => {
  test("names an attempt id that was reserved twice", () => {
    const facts = readLedger(ledgerText(reserve("a"), reserve("a")));
    expect(ledgerProblems(facts, counts({ m: 2 })).join(" ")).toContain("reserved more than once: a");
  });

  test("names a request that has no reserve of its own", () => {
    const facts = readLedger(ledgerText(reserve("a")));
    expect(ledgerProblems(facts, counts({ m: 2 })).join(" ")).toContain("m: the mock received 2 paid requests, the ledger holds 1");
  });

  test("a surplus of one kind is not hidden by a deficit of another that makes the totals equal", () => {
    const facts = readLedger(ledgerText(reserve("a", "img"), reserve("b", "img"), reserve("c", "chat")));
    const problems = ledgerProblems(facts, counts({ img: 1, chat: 2 }));
    expect(problems.join(" ")).toContain("img:");
    expect(problems.join(" ")).toContain("chat:");
  });

  test("two photos from one attempt are named", () => {
    const facts = readLedger(ledgerText(reserve("a"), settle("a")));
    expect(photoAttemptProblems(["a", "a"], facts).join(" ")).toContain("more than one photo: a");
  });

  test("a photo whose attempt was released, not settled, is named", () => {
    const facts = readLedger(ledgerText(reserve("a"), release("a")));
    expect(photoAttemptProblems(["a"], facts).join(" ")).toContain("not settled: a");
  });

  test("a photo whose reserve is still open is named", () => {
    expect(photoAttemptProblems(["a"], readLedger(ledgerText(reserve("a")))).join(" ")).toContain("not settled: a");
  });

  test("a paid request after the kill and before the click is named", () => {
    expect(quietRestartProblems({ postsAtKill: 10, postsBeforeClick: 11, renderProgressAfterRestart: 0 }).join(" ")).toContain("11 paid requests at the click, 10 at the kill");
  });

  test("a render that made progress before the click is named", () => {
    expect(quietRestartProblems({ postsAtKill: 10, postsBeforeClick: 10, renderProgressAfterRestart: 2 }).join(" ")).toContain("2 render progress events");
  });

  test("a second restart is named", () => {
    expect(restartNoticeProblems(0, 2).join(" ")).toContain("2 engine-restarted notices");
  });

  test("spending past W' is named", () => {
    expect(acceptedRemainingProblems({ plannedWorstMicros: 1_000, spentBeforeMicros: 300, acceptedMicros: 700, spentAfterMicros: 1_001 }).join(" ")).toContain("1001");
  });
});
