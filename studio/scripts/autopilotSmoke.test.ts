import { describe, expect, test } from "bun:test";
import {
  acceptedRemainingProblems,
  launchIsActive,
  ledgerProblems,
  oneSetOneRunProblems,
  readLedger,
  restartPauseProblems,
  reviewRowOf,
  videosOnDiskProblems,
} from "./autopilotSmoke";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// The pure half of the packaged autopilot scenario (S4.E2E): what it reads off the ledger and the disk, and what it requires of the launch's view. The scenario itself drives the
// packaged app (smoke-engine.ts); these are the judgements it makes, kept here so a wrong one fails in the suite and not twenty minutes into a CI run.

const reserve = (attemptId: string): string => JSON.stringify({ type: "reserve", attemptId, jobId: "job-1", scope: {}, model: "m", worstMicros: 100, at: "2026-10-10T00:00:00.000Z" });
const settle = (attemptId: string): string => JSON.stringify({ type: "settle", attemptId, costMicros: 40, estimated: false, at: "2026-10-10T00:00:00.000Z" });
const release = (attemptId: string): string => JSON.stringify({ type: "release", attemptId, at: "2026-10-10T00:00:00.000Z" });
const ledgerText = (...lines: string[]): string => `${lines.join("\n")}\n`;

describe("readLedger", () => {
  test("lists every reserve in order, with the attempts that were released and settled", () => {
    const facts = readLedger(ledgerText(reserve("a:slot-1#1"), reserve("a:slot-2#1"), settle("a:slot-1#1"), release("a:slot-2#1")));
    expect(facts.reserved).toEqual(["a:slot-1#1", "a:slot-2#1"]);
    expect([...facts.settled]).toEqual(["a:slot-1#1"]);
    expect([...facts.released]).toEqual(["a:slot-2#1"]);
  });

  test("keeps a reserve that appears twice, so a reused id is visible", () => {
    expect(readLedger(ledgerText(reserve("a"), reserve("a"))).reserved).toEqual(["a", "a"]);
  });

  test("an empty ledger has no attempts", () => {
    const facts = readLedger("");
    expect(facts.reserved).toEqual([]);
    expect(facts.released.size).toBe(0);
  });

  test("ignores a line of another type", () => {
    expect(readLedger(ledgerText(JSON.stringify({ type: "halt", code: "X" }), reserve("a"))).reserved).toEqual(["a"]);
  });

  test("tolerates a torn last line, as the engine's own reader does", () => {
    expect(readLedger(`${reserve("a")}\n{"type":"reser`).reserved).toEqual(["a"]);
  });

  test("a torn line in the middle is corruption and throws", () => {
    expect(() => readLedger(`${reserve("a")}\n{"type":"reser\n${reserve("b")}\n`)).toThrow(/line 2/);
  });
});

describe("ledgerProblems", () => {
  test("none when every request the mock received has one reserve that was not released", () => {
    const facts = readLedger(ledgerText(reserve("a"), reserve("b"), settle("a"), release("b"), reserve("c")));
    expect(ledgerProblems(facts, 2)).toEqual([]);
  });

  test("names an attempt id that was reserved twice", () => {
    const facts = readLedger(ledgerText(reserve("a"), reserve("a")));
    expect(ledgerProblems(facts, 2).join(" ")).toContain("reserved more than once: a");
  });

  test("names a request that has no reserve of its own", () => {
    const facts = readLedger(ledgerText(reserve("a")));
    expect(ledgerProblems(facts, 2).join(" ")).toContain("received 2 paid requests");
  });

  test("names a reserve that no request answers for", () => {
    const facts = readLedger(ledgerText(reserve("a"), reserve("b")));
    expect(ledgerProblems(facts, 1).join(" ")).toContain("1 paid requests");
  });

  test("a released reserve is a request that never left, so it needs no request", () => {
    const facts = readLedger(ledgerText(reserve("a"), release("a")));
    expect(ledgerProblems(facts, 0)).toEqual([]);
  });
});

const view = (over: Partial<Parameters<typeof restartPauseProblems>[0]> = {}): Parameters<typeof restartPauseProblems>[0] => ({
  status: "paused",
  paused: { cause: "engine-restart", at: "2026-10-10T00:00:00.000Z" },
  resumeBlockedBy: null,
  ...over,
});

describe("restartPauseProblems", () => {
  test("none for a launch paused by an engine restart", () => {
    expect(restartPauseProblems(view())).toEqual([]);
  });

  test("a launch still running is not paused", () => {
    expect(restartPauseProblems(view({ status: "running", paused: null })).join(" ")).toContain("status is running");
  });

  test("a launch paused by the owner is not a restart pause", () => {
    expect(restartPauseProblems(view({ paused: { cause: "owner", at: "2026-10-10T00:00:00.000Z" } })).join(" ")).toContain("cause is owner");
  });

  test("a reconcile that is asked for is fine: it is what a lost request leaves", () => {
    expect(restartPauseProblems(view({ resumeBlockedBy: "reconcile-required" }))).toEqual([]);
  });

  test("any other block means the click would be refused for a reason the scenario does not answer", () => {
    expect(restartPauseProblems(view({ resumeBlockedBy: "halt" })).join(" ")).toContain("halt");
  });
});

describe("launchIsActive", () => {
  test("running, pausing and stopping are active; the rest are not", () => {
    expect(["running", "pausing", "stopping", "paused", "done", "stopped"].map(launchIsActive)).toEqual([true, true, true, false, false, false]);
  });
});

describe("reviewRowOf", () => {
  const row = (over: Partial<NonNullable<ReturnType<typeof reviewRowOf>>> & { phase?: string } = {}) => ({
    avatarId: "av-1",
    phase: over.phase ?? "awaiting-review",
    sceneSetId: "set-1",
    setRevision: 3,
  });

  test("names the avatar, set and revision of a row that waits for the review", () => {
    expect(reviewRowOf({ avatars: [row()] })).toEqual({ avatarId: "av-1", sceneSetId: "set-1", revision: 3 });
  });

  test("null while no row waits", () => {
    expect(reviewRowOf({ avatars: [row({ phase: "composing" })] })).toBeNull();
  });

  test("null for a waiting row that has no set yet", () => {
    expect(reviewRowOf({ avatars: [{ avatarId: "av-1", phase: "awaiting-review", sceneSetId: null, setRevision: null }] })).toBeNull();
  });
});

describe("oneSetOneRunProblems", () => {
  test("none when the avatar's folder holds exactly the set and the run the launch named", () => {
    expect(oneSetOneRunProblems([{ sceneSetId: "set-1", setRunId: "run-1" }], { setIds: ["set-1"], runIds: ["run-1"] })).toEqual([]);
  });

  test("two launches of one avatar are two sets and two runs", () => {
    const named = [
      { sceneSetId: "set-1", setRunId: "run-1" },
      { sceneSetId: "set-2", setRunId: "run-2" },
    ];
    expect(oneSetOneRunProblems(named, { setIds: ["set-2", "set-1"], runIds: ["run-1", "run-2"] })).toEqual([]);
  });

  test("a second set on disk is a second compose", () => {
    expect(oneSetOneRunProblems([{ sceneSetId: "set-1", setRunId: "run-1" }], { setIds: ["set-1", "set-9"], runIds: ["run-1"] }).join(" ")).toContain("set-9");
  });

  test("a second run on disk is a second slice", () => {
    expect(oneSetOneRunProblems([{ sceneSetId: "set-1", setRunId: "run-1" }], { setIds: ["set-1"], runIds: ["run-1", "run-9"] }).join(" ")).toContain("run-9");
  });

  test("a set the launch named but the disk lacks is missing", () => {
    expect(oneSetOneRunProblems([{ sceneSetId: "set-1", setRunId: "run-1" }], { setIds: [], runIds: ["run-1"] }).join(" ")).toContain("set-1");
  });
});

describe("videosOnDiskProblems", () => {
  test("none when the files are the plan less the dropped ones", () => {
    expect(videosOnDiskProblems({ planned: 6, dropped: 1, files: 5 })).toEqual([]);
  });

  test("one video too many", () => {
    expect(videosOnDiskProblems({ planned: 3, dropped: 0, files: 4 }).join(" ")).toContain("4 videos");
  });

  test("one video too few", () => {
    expect(videosOnDiskProblems({ planned: 3, dropped: 0, files: 2 }).join(" ")).toContain("2 videos");
  });
});

describe("acceptedRemainingProblems", () => {
  test("none when R is what was left of W' and the launch spent no more than W'", () => {
    expect(acceptedRemainingProblems({ plannedWorstMicros: 1_000, spentBeforeMicros: 300, acceptedMicros: 700, spentAfterMicros: 900 })).toEqual([]);
  });

  test("R is zero when W' is already spent", () => {
    expect(acceptedRemainingProblems({ plannedWorstMicros: 1_000, spentBeforeMicros: 1_000, acceptedMicros: 0, spentAfterMicros: 1_000 })).toEqual([]);
  });

  test("an R that is not W' less the spent is named", () => {
    expect(acceptedRemainingProblems({ plannedWorstMicros: 1_000, spentBeforeMicros: 300, acceptedMicros: 800, spentAfterMicros: 900 }).join(" ")).toContain("800");
  });

  test("spending past W' is named", () => {
    expect(acceptedRemainingProblems({ plannedWorstMicros: 1_000, spentBeforeMicros: 300, acceptedMicros: 700, spentAfterMicros: 1_001 }).join(" ")).toContain("1001");
  });

  test("spending exactly W' is allowed", () => {
    expect(acceptedRemainingProblems({ plannedWorstMicros: 1_000, spentBeforeMicros: 300, acceptedMicros: 700, spentAfterMicros: 1_000 })).toEqual([]);
  });
});
