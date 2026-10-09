import { describe, expect, test } from "bun:test";
import { LaunchView, PAID_HOLD_REASONS } from "../../shared/engine";
import { errorOf, MIA, resumeRun, runUntil, runWorld, SOFIA, startRun, tick, toDone, unwrap, viewOf, type Mock } from "./mockLaunchRun.testkit";

// Stage 4, S4.8: every hold of the plan's §4.6 and its release, on the launch the mock RUNS. A hold is raised by a fault the testkit armed (`failLaunchPaidStep`) or by the world (the key,
// the ledger, the month); free work goes on through every one; «Продолжить · до $R» is the way out, and `resumeBlockedBy` says when it is closed. The table at the bottom of this file
// is the reason → switch table the S4.8 report states.

const KEY = "sk-or-v1-abcdef0123456789-test";

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
    const started = await startRun(mock, MIXED);
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
    expect((await toDone(mock, started.launchId)).avatars[0]).toMatchObject({ phase: "done", videos: { done: 2, total: 2 } });
  });

  test("«Продолжить» on a launch that runs with no hold is refused; a launch whose hold the click cleared is not held again unless the cause is still there", async () => {
    const mock = runWorld();
    const started = await startRun(mock);
    expect((await errorOf(mock.client.request("autopilot.resume", { launchId: started.launchId, acceptedRemainingMicros: 10_000_000 }))).code).toBe("VALIDATION");
    mock.engine.failLaunchPaidStep("credits", 2);
    await heldBy(mock, started.launchId, "credits");
    await continueAt(mock, started.launchId);
    // The cause is still there (the second armed fault): the answer decides, and the launch is held again.
    const again = await heldBy(mock, started.launchId, "credits");
    expect(again.paidHold?.reason).toBe("credits");
    await continueAt(mock, started.launchId);
    expect((await toDone(mock, started.launchId)).status).toBe("done");
  });
});

describe("key (401)", () => {
  test("holds the launch, marks the stored key rejected, and closes «Продолжить» (resumeBlockedBy key) until a new key is stored; the settings change tells the window", async () => {
    const mock = runWorld();
    mock.engine.failLaunchPaidStep("key");
    const started = await startRun(mock);
    const held = await heldBy(mock, started.launchId, "key");
    expect(held.resumeBlockedBy).toBe("key");
    expect((await unwrap(mock.client.request("settings.get", {}))).apiKey.rejected).toBe(true);
    expect(held.logTail.map((l) => l.kind)).toContain("hold-key");
    expect((await errorOf(mock.client.request("autopilot.resume", { launchId: started.launchId, acceptedRemainingMicros: held.remainingMicros }))).code).toBe("AUTH_INVALID");
    const before = mock.events.filter((e) => e.type === "autopilot.changed").length;
    await unwrap(mock.client.request("settings.setApiKey", { key: KEY }));
    const told = mock.events.filter((e) => e.type === "autopilot.changed").slice(before);
    expect(told.at(-1)?.payload).toMatchObject({ launch: { launchId: started.launchId, resumeBlockedBy: null } });
    await continueAt(mock, started.launchId);
    expect((await toDone(mock, started.launchId)).status).toBe("done");
  });

  test("a key the world rejects mid-run (OpenRouter's 401 elsewhere) holds the next paid step without any armed fault", async () => {
    const mock = runWorld();
    const started = await startRun(mock, { sceneReview: false });
    mock.engine.rejectKey();
    const held = await heldBy(mock, started.launchId, "key");
    expect(held.resumeBlockedBy).toBe("key");
  });
});

describe("price", () => {
  test("at the compose the price rose past what the allocation leaves: a price hold at the compose stage, cleared by «Продолжить»", async () => {
    const mock = runWorld();
    mock.engine.failLaunchPaidStep("price");
    const started = await startRun(mock);
    const held = await heldBy(mock, started.launchId, "price");
    expect(held.paidHold).toMatchObject({ reason: "price", detail: { stage: "compose" } });
    if (held.paidHold?.reason !== "price" || held.paidHold.detail.stage === "slice") throw new Error("expected a compose price hold");
    expect(held.paidHold.detail.leftMicros).toBeLessThan(held.paidHold.detail.needMicros);
    expect(held.resumeBlockedBy).toBeNull();
    expect(held.logTail.map((l) => l.kind)).toContain("hold-price");
    await continueAt(mock, started.launchId);
    expect((await toDone(mock, started.launchId)).status).toBe("done");
  });

  test("at a slice the price rose and the slice shrank to nothing: a price hold at the slice stage", async () => {
    const mock = runWorld();
    const started = await startRun(mock);
    await runUntil(mock, started.launchId, "drawing", (v) => v.avatars[0]?.phase === "drawing");
    mock.engine.failLaunchPaidStep("price");
    const held = await heldBy(mock, started.launchId, "price");
    expect(held.paidHold).toMatchObject({ reason: "price", detail: { stage: "slice", toPhotos: 0 } });
    await continueAt(mock, started.launchId);
    expect((await toDone(mock, started.launchId)).avatars[0]?.photos).toEqual({ done: 10, total: 10 });
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

  test("a month that ends in the middle of a slice holds with the resume-slice kind and writes the «budget-ended» line", async () => {
    const mock = runWorld();
    const started = await startRun(mock);
    // The first batch of six is in flight; the step that follows its settlement is the second batch of the SAME slice.
    await runUntil(mock, started.launchId, "the first batch in flight", (v) => v.avatars[0]?.phase === "drawing" && v.inFlight.requests > 0);
    mock.engine.failLaunchPaidStep("budget");
    const held = await heldBy(mock, started.launchId, "budget");
    expect(held.paidHold).toMatchObject({ reason: "budget", detail: { kind: "resume-slice" } });
    expect(held.logTail.map((l) => l.kind)).toEqual(expect.arrayContaining(["hold-budget", "budget-ended"]));
  });
});

describe("price list unavailable", () => {
  test("is retried after 5, 15 and 60 minutes, each a waiting hold with its time, and then holds for a person with no retry left", async () => {
    const mock = runWorld();
    mock.engine.failLaunchPaidStep("price-unavailable", 4);
    const started = await startRun(mock);
    const attempts: (number | undefined)[] = [];
    const nextAts: (string | null | undefined)[] = [];
    let view = await viewOf(mock, started.launchId);
    for (let i = 0; i < 200 && !(view.paidHold?.reason === "price-unavailable" && view.paidHold.detail.nextAt === null); i++) {
      tick(mock);
      view = await viewOf(mock, started.launchId);
      if (view.paidHold?.reason === "price-unavailable" && attempts.at(-1) !== view.paidHold.detail.attempt) {
        attempts.push(view.paidHold.detail.attempt);
        nextAts.push(view.paidHold.detail.nextAt);
      }
    }
    expect(attempts).toEqual([1, 2, 3]);
    expect(nextAts.slice(0, 2).every((at) => typeof at === "string")).toBe(true);
    expect(view.paidHold).toMatchObject({ reason: "price-unavailable", detail: { attempt: 3, nextAt: null } });
    expect(view.resumeBlockedBy).toBeNull();
    expect(view.logTail.map((l) => l.kind)).toContain("hold-price-unavailable");
    await continueAt(mock, started.launchId);
    expect((await toDone(mock, started.launchId)).status).toBe("done");
  });

  test("one failure is only a wait: the launch goes on by itself when the retry comes", async () => {
    const mock = runWorld();
    mock.engine.failLaunchPaidStep("price-unavailable");
    const started = await startRun(mock);
    const waiting = await heldBy(mock, started.launchId, "price-unavailable");
    expect(waiting.paidHold).toMatchObject({ detail: { attempt: 1 } });
    expect((await toDone(mock, started.launchId)).status).toBe("done");
  });
});

describe("no answer (network)", () => {
  test("the first and the second drop continue by themselves after 1 and 5 minutes; the requests' reserves stay open, unsettled, inside what was spent", async () => {
    const mock = runWorld();
    mock.engine.failLaunchPaidStep("network", 2);
    const started = await startRun(mock);
    const first = await heldBy(mock, started.launchId, "network");
    expect(first.paidHold).toMatchObject({ reason: "network", detail: { drops: 1, attempt: 1 } });
    if (first.paidHold?.reason !== "network") throw new Error("expected a network hold");
    expect(typeof first.paidHold.detail.nextAt).toBe("string");
    expect(first.inFlight).toEqual({ requests: 0, openMicros: 0 });
    expect(first.unsettled?.requests).toBeGreaterThan(0);
    expect(first.unsettled?.openMicros).toBeLessThanOrEqual(first.spentMicros);
    expect(first.resumeBlockedBy).toBeNull();
    expect(first.logTail.map((l) => l.kind)).toEqual(expect.arrayContaining(["network-retry", "hold-network"]));
    const second = await runUntil(mock, started.launchId, "the second drop", (v) => v.paidHold?.reason === "network" && v.paidHold.detail.drops === 2);
    expect(second.paidHold).toMatchObject({ detail: { drops: 2, attempt: 2 } });
    const done = await toDone(mock, started.launchId);
    expect(done.status).toBe("done");
    // The two abandoned writer requests stay in the figure at their worst case.
    expect(done.spentMicros).toBeGreaterThan(0);
  });

  test("the third drop holds for a person: no retry, «Продолжить» closed (resumeBlockedBy network) until a reconcile settles the open reserves, which the window is told", async () => {
    const mock = runWorld();
    mock.engine.failLaunchPaidStep("network", 3);
    const started = await startRun(mock);
    const held = await runUntil(mock, started.launchId, "the third drop", (v) => v.paidHold?.reason === "network" && v.paidHold.detail.nextAt === null);
    expect(held.paidHold).toMatchObject({ reason: "network", detail: { drops: 3, attempt: 2, nextAt: null } });
    expect(held.resumeBlockedBy).toBe("network");
    expect(held.unsettled?.requests).toBeGreaterThanOrEqual(3);
    mock.scheduler.runAll();
    expect(mock.scheduler.pending).toBe(0);
    expect((await errorOf(mock.client.request("autopilot.resume", { launchId: started.launchId, acceptedRemainingMicros: held.remainingMicros }))).code).toBe("VALIDATION");
    const before = mock.events.filter((e) => e.type === "autopilot.changed").length;
    await unwrap(mock.client.request("money.reconcile", {}));
    const told = mock.events.filter((e) => e.type === "autopilot.changed").slice(before);
    expect(told.at(-1)?.payload).toMatchObject({ launch: { resumeBlockedBy: null, unsettled: { requests: 0, openMicros: 0 } } });
    const reconciled = await viewOf(mock, started.launchId);
    expect(reconciled.spentMicros).toBe(held.spentMicros);
    await continueAt(mock, started.launchId);
    expect((await toDone(mock, started.launchId)).status).toBe("done");
  });

  test("a drop of the draw (not the compose) leaves the batch's reserves open and the photos undrawn; the launch continues and draws them", async () => {
    const mock = runWorld();
    const started = await startRun(mock);
    await runUntil(mock, started.launchId, "the first batch in flight", (v) => v.avatars[0]?.phase === "drawing" && v.inFlight.requests > 0);
    mock.engine.failLaunchPaidStep("network");
    const held = await heldBy(mock, started.launchId, "network");
    // The first batch of six settled; the second (the four photos left) was sent and got no answer.
    expect(held.avatars[0]?.photos.done).toBe(6);
    expect(held.unsettled?.requests).toBe(4);
    const done = await toDone(mock, started.launchId);
    expect(done.avatars[0]?.photos).toEqual({ done: 10, total: 10 });
  });
});

describe("the launch's cap (W′)", () => {
  test("requests that would commit more than the planned worst case are not sent: the draw ends with the photos it has, the video they cannot fill is dropped, and spent never passes W′", async () => {
    const mock = runWorld();
    // One single video: W′ is one writer chunk and the three attempts of one photo. Every drop leaves an attempt's reserve open at its worst case, so repeated drops reach the cap.
    mock.engine.failLaunchPaidStep("network", 12);
    const started = await startRun(mock, { videosPerAvatar: 1, mix: { single: 100, collage: 0, slides: 0 } });
    let view = started;
    for (let i = 0; i < 80 && view.status !== "done"; i++) {
      tick(mock);
      view = await viewOf(mock, started.launchId);
      expect(view.spentMicros).toBeLessThanOrEqual(view.plannedWorstMicros);
      if (view.paidHold?.reason === "network" && view.paidHold.detail.nextAt === null) {
        await unwrap(mock.client.request("money.reconcile", {}));
        await resumeRun(mock, started.launchId);
      }
    }
    expect(view.status).toBe("done");
    expect(view.avatars[0]).toMatchObject({ videos: { done: 0, total: 0 }, dropped: { count: 1, reason: "not-enough-photos" } });
    const got = await unwrap(mock.client.request("autopilot.get", { launchId: started.launchId }));
    expect(got.log.map((l) => l.kind)).toContain("degrade");
    expect(view.spentMicros).toBeLessThanOrEqual(view.plannedWorstMicros);
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

  test("the testkit's halt switch is the same thing, armed for the next paid step", async () => {
    const mock = runWorld();
    mock.engine.failLaunchPaidStep("halt");
    const started = await startRun(mock);
    const held = await heldBy(mock, started.launchId, "halt");
    expect(held.resumeBlockedBy).toBe("halt");
  });
});

describe("the launch's own check (internal)", () => {
  test("holds with no exit but «Стоп»: «Продолжить» is closed (resumeBlockedBy internal), and a stop ends the launch", async () => {
    const mock = runWorld();
    mock.engine.failLaunchPaidStep("internal");
    const started = await startRun(mock);
    const held = await heldBy(mock, started.launchId, "internal");
    expect(held.paidHold).toMatchObject({ reason: "internal", detail: { kind: "allocation-exceeded" } });
    expect(held.resumeBlockedBy).toBe("internal");
    expect(held.logTail.map((l) => l.kind)).toContain("hold-internal");
    expect((await errorOf(mock.client.request("autopilot.resume", { launchId: started.launchId, acceptedRemainingMicros: held.remainingMicros }))).code).toBe("VALIDATION");
    const stopped = (await unwrap(mock.client.request("autopilot.stop", { launchId: started.launchId }))).launch;
    expect(stopped).toMatchObject({ status: "stopped", paidHold: null });
  });
});

describe("pausing and stopping under a hold", () => {
  test("a pause under a hold is a pause: the owner's «Продолжить» then clears both", async () => {
    const mock = runWorld();
    mock.engine.failLaunchPaidStep("credits");
    const started = await startRun(mock);
    await heldBy(mock, started.launchId, "credits");
    const paused = (await unwrap(mock.client.request("autopilot.pause", { launchId: started.launchId }))).launch;
    expect(paused).toMatchObject({ status: "paused", paidHold: { reason: "credits" } });
    const resumed = await continueAt(mock, started.launchId);
    expect(resumed).toMatchObject({ status: "running", paidHold: null });
  });

  test("a stop under a hold ends the launch and clears the hold", async () => {
    const mock = runWorld();
    mock.engine.failLaunchPaidStep("credits");
    const started = await startRun(mock);
    await heldBy(mock, started.launchId, "credits");
    expect((await unwrap(mock.client.request("autopilot.stop", { launchId: started.launchId }))).launch).toMatchObject({ status: "stopped", paidHold: null });
  });

  test("a pause cancels the wait of an automatic continue: nothing is bought while paused, and «Продолжить» goes on", async () => {
    const mock = runWorld();
    mock.engine.failLaunchPaidStep("network");
    const started = await startRun(mock);
    await heldBy(mock, started.launchId, "network");
    await unwrap(mock.client.request("autopilot.pause", { launchId: started.launchId }));
    expect(mock.scheduler.pending).toBe(0);
    await continueAt(mock, started.launchId);
    expect((await toDone(mock, started.launchId)).status).toBe("done");
  });
});

describe("the other avatars go on", () => {
  test("a hold parks the avatars whose paid work it holds; an avatar that only uses the library finishes", async () => {
    const mock = runWorld();
    mock.engine.failLaunchPaidStep("credits");
    const started = await startRun(mock, { avatarIds: [SOFIA.avatarId, MIA.avatarId], library: true, videosPerAvatar: 2, mix: { single: 0, collage: 0, slides: 100 } });
    // Sofia (12 free photos) needs nothing generated; Mia (6) generates one video.
    const held = await heldBy(mock, started.launchId, "credits");
    expect(held.avatars.find((a) => a.avatarId === MIA.avatarId)).toMatchObject({ phase: "waiting", waiting: { reason: "paid-hold" } });
    const sofia = await runUntil(mock, started.launchId, "Sofia done", (v) => v.avatars.find((a) => a.avatarId === SOFIA.avatarId)?.phase === "done");
    expect(sofia.status).toBe("running");
    expect(sofia.paidHold?.reason).toBe("credits");
  });
});

// ---------- the reason → switch table ----------

describe("every paid hold of the contract is reachable by a switch", () => {
  const SWITCHES: Record<(typeof PAID_HOLD_REASONS)[number], (mock: Mock) => void> = {
    credits: (mock) => mock.engine.failLaunchPaidStep("credits"),
    key: (mock) => mock.engine.failLaunchPaidStep("key"),
    price: (mock) => mock.engine.failLaunchPaidStep("price"),
    budget: (mock) => mock.engine.failLaunchPaidStep("budget"),
    "price-unavailable": (mock) => mock.engine.failLaunchPaidStep("price-unavailable"),
    network: (mock) => mock.engine.failLaunchPaidStep("network"),
    halt: (mock) => mock.engine.failLaunchPaidStep("halt"),
    internal: (mock) => mock.engine.failLaunchPaidStep("internal"),
  };

  test.each([...PAID_HOLD_REASONS])("%s: raised, and the view that carries it meets the contract", async (reason) => {
    const mock = runWorld();
    SWITCHES[reason](mock);
    const started = await startRun(mock);
    const held = await heldBy(mock, started.launchId, reason);
    expect(LaunchView.safeParse(held).success).toBe(true);
    expect(String(held.logTail.at(-1)?.kind)).toBe(`hold-${reason}`);
  });
});
