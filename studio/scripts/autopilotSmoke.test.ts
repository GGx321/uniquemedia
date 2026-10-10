import { describe, expect, test } from "bun:test";
import {
  acceptedRemainingProblems,
  launchIsActive,
  ledgerProblems,
  midRenderProblems,
  oneSetOneRunProblems,
  photoAttemptProblems,
  postsByModel,
  quietRestartProblems,
  readLedger,
  restartNoticeProblems,
  restartPauseProblems,
  reviewRowOf,
  videosOnDiskProblems,
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

describe("readLedger", () => {
  test("lists every reserve in order, with the attempts that were released and settled", () => {
    const facts = readLedger(ledgerText(reserve("a:slot-1#1"), reserve("a:slot-2#1"), settle("a:slot-1#1"), release("a:slot-2#1")));
    expect(facts.reserved).toEqual(["a:slot-1#1", "a:slot-2#1"]);
    expect([...facts.settled]).toEqual(["a:slot-1#1"]);
    expect([...facts.released]).toEqual(["a:slot-2#1"]);
  });

  test("remembers the model each attempt reserved for", () => {
    const facts = readLedger(ledgerText(reserve("a", "image-model"), reserve("b", "chat-model")));
    expect([...facts.models]).toEqual([["a", "image-model"], ["b", "chat-model"]]);
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

describe("postsByModel", () => {
  test("counts the POST requests by the model in their body, and leaves the reads out", () => {
    const requests = [
      { method: "POST", body: { model: "image-model" } },
      { method: "POST", body: { model: "image-model" } },
      { method: "POST", body: { model: "chat-model" } },
      { method: "GET", body: null },
    ];
    expect([...postsByModel(requests)]).toEqual([["image-model", 2], ["chat-model", 1]]);
  });

  test("a POST with no model in its body is counted apart, never lost", () => {
    expect([...postsByModel([{ method: "POST", body: null }])]).toEqual([["(no model)", 1]]);
  });
});

describe("ledgerProblems", () => {
  test("none when every request the mock received has one reserve that was not released, kind by kind", () => {
    const facts = readLedger(ledgerText(reserve("a", "img"), reserve("b", "img"), reserve("c", "chat"), settle("a"), release("b"), settle("c"), reserve("d", "img")));
    expect(ledgerProblems(facts, counts({ img: 2, chat: 1 }))).toEqual([]);
  });

  test("names an attempt id that was reserved twice", () => {
    const facts = readLedger(ledgerText(reserve("a"), reserve("a")));
    expect(ledgerProblems(facts, counts({ m: 2 })).join(" ")).toContain("reserved more than once: a");
  });

  test("names a request that has no reserve of its own", () => {
    const facts = readLedger(ledgerText(reserve("a")));
    expect(ledgerProblems(facts, counts({ m: 2 })).join(" ")).toContain("m: the mock received 2 paid requests, the ledger holds 1");
  });

  test("names a reserve that no request answers for", () => {
    const facts = readLedger(ledgerText(reserve("a"), reserve("b")));
    expect(ledgerProblems(facts, counts({ m: 1 })).join(" ")).toContain("m: the mock received 1 paid requests, the ledger holds 2");
  });

  test("a surplus of one kind is not hidden by a deficit of another that makes the totals equal", () => {
    const facts = readLedger(ledgerText(reserve("a", "img"), reserve("b", "img"), reserve("c", "chat")));
    const problems = ledgerProblems(facts, counts({ img: 1, chat: 2 }));
    expect(problems.join(" ")).toContain("img:");
    expect(problems.join(" ")).toContain("chat:");
  });

  test("a model the mock saw and the ledger never reserved is named", () => {
    expect(ledgerProblems(readLedger(""), counts({ ghost: 1 })).join(" ")).toContain("ghost: the mock received 1 paid requests, the ledger holds 0");
  });

  test("a released reserve is a request that never left, so it needs no request", () => {
    const facts = readLedger(ledgerText(reserve("a"), release("a")));
    expect(ledgerProblems(facts, counts({}))).toEqual([]);
  });
});

describe("photoAttemptProblems", () => {
  test("none when every saved photo came from its own attempt, whose reserve was settled", () => {
    const facts = readLedger(ledgerText(reserve("r:slot-1#1"), reserve("r:slot-2#1"), settle("r:slot-1#1"), settle("r:slot-2#1")));
    expect(photoAttemptProblems(["r:slot-1#1", "r:slot-2#1"], facts)).toEqual([]);
  });

  test("two photos from one attempt are named", () => {
    const facts = readLedger(ledgerText(reserve("a"), settle("a")));
    expect(photoAttemptProblems(["a", "a"], facts).join(" ")).toContain("more than one photo: a");
  });

  test("a photo whose attempt has no reserve is named", () => {
    expect(photoAttemptProblems(["ghost"], readLedger("")).join(" ")).toContain("no reserve: ghost");
  });

  test("a photo whose attempt was released, not settled, is named", () => {
    const facts = readLedger(ledgerText(reserve("a"), release("a")));
    expect(photoAttemptProblems(["a"], facts).join(" ")).toContain("not settled: a");
  });

  test("a photo whose reserve is still open is named", () => {
    expect(photoAttemptProblems(["a"], readLedger(ledgerText(reserve("a")))).join(" ")).toContain("not settled: a");
  });
});

const view = (over: Partial<Parameters<typeof restartPauseProblems>[0]> = {}): Parameters<typeof restartPauseProblems>[0] => ({
  status: "paused",
  paused: { cause: "engine-restart", at: "2026-10-10T00:00:00.000Z" },
  resumeBlockedBy: null,
  inFlight: { requests: 0, openMicros: 0 },
  unsettled: { requests: 0, openMicros: 0 },
  ...over,
});

describe("restartPauseProblems", () => {
  test("none for a launch paused by an engine restart with nothing lost", () => {
    expect(restartPauseProblems(view(), 0)).toEqual([]);
  });

  test("a launch still running is not paused", () => {
    expect(restartPauseProblems(view({ status: "running", paused: null }), 0).join(" ")).toContain("status is running");
  });

  test("a launch paused by the owner is not a restart pause", () => {
    expect(restartPauseProblems(view({ paused: { cause: "owner", at: "2026-10-10T00:00:00.000Z" } }), 0).join(" ")).toContain("cause is owner");
  });

  test("a reconcile that is asked for is fine: it is what a lost request leaves", () => {
    expect(restartPauseProblems(view({ resumeBlockedBy: "reconcile-required", unsettled: { requests: 6, openMicros: 600 } }), 6)).toEqual([]);
  });

  test("any other block means the click would be refused for a reason the scenario does not answer", () => {
    expect(restartPauseProblems(view({ resumeBlockedBy: "halt" }), 0).join(" ")).toContain("halt");
  });

  test("a request in flight in a restarted engine is a request it sent on its own", () => {
    expect(restartPauseProblems(view({ inFlight: { requests: 1, openMicros: 100 } }), 0).join(" ")).toContain("inFlight is 1");
  });

  test("exactly the requests that were in flight at the kill are unsettled: fewer is a lost reserve", () => {
    expect(restartPauseProblems(view({ unsettled: { requests: 5, openMicros: 500 } }), 6).join(" ")).toContain("unsettled is 5, expected 6");
  });

  test("exactly the requests that were in flight at the kill are unsettled: more is a reserve of a request nobody sent", () => {
    expect(restartPauseProblems(view({ unsettled: { requests: 7, openMicros: 700 } }), 6).join(" ")).toContain("unsettled is 7, expected 6");
  });

  test("a view that does not say how many are unsettled counts as none", () => {
    expect(restartPauseProblems(view({ unsettled: undefined }), 0)).toEqual([]);
  });
});

describe("quietRestartProblems", () => {
  test("none when the mock saw no more paid requests at the click than at the kill and no render moved", () => {
    expect(quietRestartProblems({ postsAtKill: 10, postsBeforeClick: 10, renderProgressAfterRestart: 0 })).toEqual([]);
  });

  test("a paid request after the kill and before the click is named", () => {
    expect(quietRestartProblems({ postsAtKill: 10, postsBeforeClick: 11, renderProgressAfterRestart: 0 }).join(" ")).toContain("11 paid requests at the click, 10 at the kill");
  });

  test("a render that made progress before the click is named", () => {
    expect(quietRestartProblems({ postsAtKill: 10, postsBeforeClick: 10, renderProgressAfterRestart: 2 }).join(" ")).toContain("2 render progress events");
  });
});

describe("midRenderProblems", () => {
  test("none when the launch had a video still to finish and the render the kill met never ended", () => {
    expect(midRenderProblems({ videosDone: 0, planned: 2, endedBeforeKill: false })).toEqual([]);
  });

  test("a launch whose videos were all finished was not killed mid-render", () => {
    expect(midRenderProblems({ videosDone: 2, planned: 2, endedBeforeKill: false }).join(" ")).toContain("2 of 2 videos");
  });

  test("a render that ended before the kill was not killed mid-way", () => {
    expect(midRenderProblems({ videosDone: 0, planned: 2, endedBeforeKill: true }).join(" ")).toContain("ended before");
  });
});

describe("restartNoticeProblems", () => {
  test("none for no notice before the kill and exactly one after", () => {
    expect(restartNoticeProblems(0, 1)).toEqual([]);
  });

  test("a notice already there before the kill makes the count meaningless", () => {
    expect(restartNoticeProblems(1, 2).join(" ")).toContain("before the kill");
  });

  test("a second restart is named", () => {
    expect(restartNoticeProblems(0, 2).join(" ")).toContain("2 engine-restarted notices");
  });

  test("no notice at all is named", () => {
    expect(restartNoticeProblems(0, 0).join(" ")).toContain("0 engine-restarted notices");
  });
});

describe("launchIsActive", () => {
  test("running, pausing and stopping are active; the rest are not", () => {
    expect(["running", "pausing", "stopping", "paused", "done", "stopped"].map(launchIsActive)).toEqual([true, true, true, false, false, false]);
  });
});

describe("reviewRowOf", () => {
  const row = (over: { phase?: string } = {}) => ({
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
