import { describe, expect, test } from "bun:test";
import { LaunchView } from "../../shared/engine";
import { errorOf, LLM_ONLY_REF, resumeRun, runUntil, runWorld, startRun, toDone, unwrap, viewOf, type Mock } from "./mockLaunchRun.testkit";

// Stage 4, S4.8: every hold of the plan's §4.6 and its release, on the launch the mock RUNS. A hold is raised by a fault the testkit armed (`failLaunchPaidStep`) or by the world (the key,
// the ledger, the month); free work goes on through every one; «Продолжить · до $R» is the way out, and `resumeBlockedBy` says when it is closed. The table at the bottom of this file
// is the reason → switch table the S4.8 report states.

// 5a.2 (S5.6e, m11): a launch on «Дом» is composed by the code template with no request, so a refusal at the compose WRITER (a 402, the price rising) is the fixture's: `cat-llm-only-fixture` is the
// category whose scenes only the model writes. A launch on «Дом» meets the same refusal at its first photo (the test after the 402 table).

// S5.6R: the plan deals the generated videos round the categories one video at a time (the engine's `generate`), so a launch reaches the fixture's writer only when two videos are generated: the first goes to «Дом», the second to the fixture.
/** A launch with one video from the library and one to generate, so free work (the library video) has something to do while the paid work is held. */
const MIXED = { library: true, mix: { single: 0, collage: 0, slides: 100 }, videosPerAvatar: 2 } as const;

async function heldBy(mock: Mock, launchId: string, reason: string): Promise<LaunchView> {
  return runUntil(mock, launchId, `the ${reason} hold`, (v) => v.paidHold?.reason === reason);
}

const continueAt = async (mock: Mock, launchId: string): Promise<LaunchView> => resumeRun(mock, launchId);

describe("credits (402)", () => {
  test("holds the paid work for a person: the avatar is parked, the library video is still made, «Продолжить» is open and clears the hold", async () => {
    const mock = runWorld();
    mock.engine.failLaunchPaidStep("credits");
    const started = await startRun(mock, { ...MIXED, videosPerAvatar: 3, categories: ["home", LLM_ONLY_REF] });
    const held = await heldBy(mock, started.launchId, "credits");
    expect(held).toMatchObject({ status: "running", paidHold: { reason: "credits", detail: {} }, resumeBlockedBy: null });
    expect(held.avatars[0]).toMatchObject({ phase: "waiting", waiting: { reason: "paid-hold" } });
    expect(held.logTail.map((l) => l.kind)).toContain("hold-credits");
    // Free work goes on through the hold: the library video renders and lands while nothing is bought.
    const withVideo = await runUntil(mock, started.launchId, "the library video", (v) => v.avatars[0]?.videos.done === 1);
    expect(withVideo.paidHold?.reason).toBe("credits");
    expect(withVideo.spentMicros).toBe(0);
    // Nothing is left for the clock to do: a hold for a person is not polled.
    mock.scheduler.runAll();
    expect(mock.scheduler.pending).toBe(0);
    expect((await viewOf(mock, started.launchId)).paidHold?.reason).toBe("credits");
    const resumed = await continueAt(mock, started.launchId);
    expect(resumed).toMatchObject({ status: "running", paidHold: null });
    expect(resumed.logTail.at(-1)).toMatchObject({ kind: "resumed" });
    expect((await toDone(mock, started.launchId)).avatars[0]).toMatchObject({ phase: "done", videos: { done: 3, total: 3 } });
  });

});

describe("budget", () => {
  test("a month with no room for the next step holds the launch; «Продолжить» is closed (resumeBlockedBy budget) until the budget is raised, and the raise tells the window", async () => {
    const mock = runWorld();
    const started = await startRun(mock);
    await unwrap(mock.client.request("settings.setBudget", { monthlyBudgetMicros: 10_000 }));
    const held = await heldBy(mock, started.launchId, "budget");
    expect(held.paidHold).toMatchObject({ reason: "budget", detail: { kind: "new-slice", freeMicros: 10_000 } });
    if (held.paidHold?.reason !== "budget") throw new Error("expected a budget hold");
    expect(held.paidHold.detail.needMicros).toBeGreaterThan(10_000);
    expect(held.resumeBlockedBy).toBe("budget");
    expect(held.logTail.map((l) => l.kind)).toContain("hold-budget");
    expect((await errorOf(mock.client.request("autopilot.resume", { launchId: started.launchId, acceptedRemainingMicros: held.remainingMicros }))).code).toBe("VALIDATION");
    const before = mock.events.filter((e) => e.type === "autopilot.changed").length;
    await unwrap(mock.client.request("settings.setBudget", { monthlyBudgetMicros: 10_000_000 }));
    const told = mock.events.filter((e) => e.type === "autopilot.changed").slice(before);
    expect(told.at(-1)?.payload).toMatchObject({ launch: { resumeBlockedBy: null, paidHold: { reason: "budget" } } });
    await continueAt(mock, started.launchId);
    expect((await toDone(mock, started.launchId)).status).toBe("done");
  });

});

describe("the ledger halts", () => {
  test("a settle above its reserve holds the launch (halt), closes «Продолжить» (resumeBlockedBy halt) until a reconcile, and the reconcile opens it", async () => {
    const mock = runWorld();
    const started = await startRun(mock);
    await runUntil(mock, started.launchId, "drawing", (v) => v.avatars[0]?.phase === "drawing");
    mock.engine.haltAboveWorst();
    const held = await heldBy(mock, started.launchId, "halt");
    expect(held.paidHold).toMatchObject({ reason: "halt", detail: { code: "SETTLE_ABOVE_WORST" } });
    expect(held.resumeBlockedBy).toBe("halt");
    expect(held.logTail.map((l) => l.kind)).toContain("hold-halt");
    expect((await errorOf(mock.client.request("autopilot.resume", { launchId: started.launchId, acceptedRemainingMicros: held.remainingMicros }))).code).toBe("SETTLE_ABOVE_WORST");
    await unwrap(mock.client.request("money.reconcile", {}));
    expect((await viewOf(mock, started.launchId)).resumeBlockedBy).toBeNull();
    await continueAt(mock, started.launchId);
    expect((await toDone(mock, started.launchId)).status).toBe("done");
  });

});

// ---------- the reason → switch table ----------

