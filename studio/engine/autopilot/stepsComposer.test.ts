import { describe, expect, test } from "bun:test";
import type { LaunchFile } from "./launchFile";
import { composeSteps, guardFreeChange } from "./stepsComposer";
import { FakeSteps } from "./testing/fakeSteps";
import { IDLE_STEPS, type LaunchStepsContext } from "./steps";
import { FakeTimers } from "./testing/paidRig";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Stage 4, S4.6b1 (fix round 1): the composer puts the paid and the free steps behind the engine's one seam, decides the finish jointly, and keeps the two parts to their own
// fields of the launch file.

const NO_VIDEOS: never[] = [];
const row = (over: Record<string, unknown> = {}) => ({ avatarId: "avatar-a", phase: "montage", waiting: null, skipped: null, photosDone: 3, videos: NO_VIDEOS, generation: { sceneSetId: "set-x" }, ...over });
const fileWith = (...rows: Record<string, unknown>[]): LaunchFile => ({ launchId: "launch-x", avatars: rows }) as unknown as LaunchFile;

interface RawCtx {
  ctx: LaunchStepsContext;
  finishes: () => number;
  failNextFinish(): void;
  /** The next finish fails AND the launch is paused by then: the pause landed while the finish was under way. */
  failNextFinishWhilePaused(): void;
  lastUpdate(): LaunchFile | null;
  setFile(file: LaunchFile): void;
  /** Whether the core reports the launch as running (a pause, a stop and a sleep make it false). */
  setRunning(running: boolean): void;
}

/** A bare core-side context: `finish` and `update` are spies, `file` is whatever the test sets. */
function rawContext(initial: LaunchFile = fileWith(row())): RawCtx {
  let file = initial;
  let finishes = 0;
  let fail = false;
  let pauseOnFail = false;
  let updated: LaunchFile | null = null;
  let running = true;
  const ctx = {
    launchId: "launch-x",
    file: () => file,
    isRunning: () => running,
    update: (change: (f: LaunchFile) => LaunchFile | null) => {
      updated = change(file);
      return Promise.resolve(updated ?? file);
    },
    finish: () => {
      finishes += 1;
      if (fail) {
        fail = false;
        if (pauseOnFail) running = false;
        return Promise.reject(new Error("still has work in flight"));
      }
      return Promise.resolve(file);
    },
  } as unknown as LaunchStepsContext;
  return { ctx, finishes: () => finishes, failNextFinish: () => void (fail = true),
    failNextFinishWhilePaused: () => {
      fail = true;
      pauseOnFail = true;
    }, lastUpdate: () => updated, setFile: (f) => void (file = f), setRunning: (value) => void (running = value) };
}

describe("composeSteps: the parts", () => {
  test("begins, drains and releases every part, and adds up what is in flight", async () => {
    const paid = new FakeSteps();
    const free = new FakeSteps();
    paid.inflight = { requests: 2, renders: 0 };
    free.inflight = { requests: 0, renders: 3 };
    const steps = composeSteps(paid, free);
    const raw = rawContext();
    steps.begin(raw.ctx);
    await steps.drain();
    await steps.release(raw.ctx);
    expect(paid.calls).toEqual(["begin", "drain", "release"]);
    expect(free.calls).toEqual(["begin", "drain", "release"]);
    expect(steps.inFlight()).toEqual({ requests: 2, renders: 3 });
  });

  test("a part that cannot begin does not stop the others from beginning; the failure is told", () => {
    const broken = new FakeSteps();
    broken.onBegin = () => {
      throw new Error("a defect");
    };
    const other = new FakeSteps();
    const told: string[] = [];
    const steps = composeSteps(broken, other, { warn: (line) => told.push(line) });
    steps.begin(rawContext().ctx);
    expect(other.calls).toEqual(["begin"]);
    expect(told).toHaveLength(1);
    expect(told[0]).toContain("a defect");
  });

  test("a part whose drain rejects does not leave the others undrained", async () => {
    const broken = new FakeSteps();
    broken.drain = () => Promise.reject(new Error("a defect"));
    const other = new FakeSteps();
    await composeSteps(broken, other).drain();
    expect(other.calls).toEqual(["drain"]);
  });

  test("every part releases even when one fails, and the failure is told after", async () => {
    const broken = new FakeSteps();
    broken.release = () => Promise.reject(new Error("could not unlink"));
    const other = new FakeSteps();
    await expect(composeSteps(broken, other).release(rawContext().ctx)).rejects.toThrow("could not unlink");
    expect(other.calls).toEqual(["release"]);
  });

  test("the review hand-off and the mirrors come from the first part that has them; a part without them is skipped", async () => {
    const paid = new FakeSteps();
    paid.mirrors.set("avatar-a", { sceneSetId: "set-a", setRevision: 2, scenes: 3, scenesWithoutText: 0, continuePhotos: 3, slice: null, undrawnScenes: 0, resumableSlots: 0 });
    paid.continueAnswer = { draw: "started", photos: 3 };
    const steps = composeSteps(IDLE_STEPS, paid);
    expect(await steps.continueAfterReview?.(rawContext().ctx, { avatarId: "avatar-a", sceneSetId: "set-a", revision: 2 })).toEqual({ draw: "started", photos: 3 });
    expect(steps.mirror?.("launch-x", "avatar-a")?.sceneSetId).toBe("set-a");
    expect(steps.mirror?.("launch-x", "avatar-b")).toBeNull();
  });

  test("without any part that has them, the optional hooks are absent", () => {
    const steps = composeSteps(IDLE_STEPS, IDLE_STEPS);
    expect(steps.continueAfterReview).toBeUndefined();
    expect(steps.mirror).toBeUndefined();
  });
});

describe("composeSteps: the finish is a joint decision", () => {
  /** Paid is a passive voter whose readiness a test sets; free is an active one that votes through its context. */
  function gate(retryMs = 60_000) {
    const paid = new FakeSteps();
    const free = new FakeSteps();
    let paidReady = false;
    paid.finishReady = () => paidReady;
    let freeCtx: LaunchStepsContext | null = null;
    free.onBegin = (ctx) => {
      freeCtx = ctx;
    };
    const told: string[] = [];
    const steps = composeSteps(paid, free, { warn: (line) => told.push(line), retryMs });
    const raw = rawContext();
    steps.begin(raw.ctx);
    const vote = (): Promise<LaunchFile> => {
      if (freeCtx === null) throw new Error("the free part was not begun");
      return freeCtx.finish();
    };
    return {
      paid,
      raw,
      steps,
      told,
      vote,
      paidIsReady: async () => {
        paidReady = true;
        for (const listener of paid.readyListeners) listener();
        await steps.settled();
      },
    };
  }

  test("the free part votes while the paid part still has a live slice: no finish, and the vote itself is answered at once", async () => {
    const g = gate();
    const answered = await g.vote();
    expect(answered).toBeDefined();
    await g.steps.settled();
    expect(g.raw.finishes()).toBe(0);
  });

  test("when the paid part becomes ready after the free part voted, the launch finishes exactly once", async () => {
    const g = gate();
    await g.vote();
    await g.paidIsReady();
    expect(g.raw.finishes()).toBe(1);
    await g.vote();
    await g.paidIsReady();
    await g.steps.settled();
    expect(g.raw.finishes()).toBe(1);
  });

  test("the paid part ready first, the free part's vote finishes the launch", async () => {
    const g = gate();
    await g.paidIsReady();
    expect(g.raw.finishes()).toBe(0);
    await g.vote();
    await g.steps.settled();
    expect(g.raw.finishes()).toBe(1);
  });

  test("a finish that is refused leaves the votes standing: the next vote tries again, and the refusal is told", async () => {
    const g = gate();
    await g.paidIsReady();
    g.raw.failNextFinish();
    await g.vote();
    await g.steps.settled();
    expect(g.raw.finishes()).toBe(1);
    expect(g.told.some((line) => line.includes("could not finish yet"))).toBe(true);
    await g.vote();
    await g.steps.settled();
    expect(g.raw.finishes()).toBe(2);
  });

  test("a finish that fails with both parts ready is tried again by the composer itself, with no new vote", async () => {
    const g = gate(5);
    await g.paidIsReady();
    g.raw.failNextFinish();
    await g.vote();
    await g.steps.settled();
    const deadline = Date.now() + 1_000;
    while (g.raw.finishes() < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(g.raw.finishes()).toBe(2);
  });

  test("a resume forgets the votes: a vote of the earlier epoch does not finish the launch", async () => {
    const g = gate();
    await g.vote();
    g.steps.begin(g.raw.ctx);
    await g.paidIsReady();
    expect(g.raw.finishes()).toBe(0);
  });
});

describe("composeSteps: who owns which field", () => {
  test("the free part cannot change what the paid part owns: phase, waiting, skipped, photosDone", () => {
    const before = fileWith(row({ phase: "drawing", waiting: null, skipped: null, photosDone: 2 }));
    const after = fileWith(row({ phase: "montage", waiting: { reason: "paid-hold" }, skipped: { reason: "archived" }, photosDone: 9, videos: [{ key: "0-1", state: "done" }] }));
    const guarded = guardFreeChange(before, after, () => true);
    expect(guarded?.avatars[0]).toMatchObject({ phase: "drawing", waiting: null, skipped: null, photosDone: 2, videos: [{ key: "0-1", state: "done" }] });
  });

  test("a row with no generation is the free part's entirely: its phase moves freely", () => {
    const before = fileWith(row({ phase: "planned", generation: null }));
    const after = fileWith(row({ phase: "montage", generation: null }));
    expect(guardFreeChange(before, after, () => false)?.avatars[0]?.phase).toBe("montage");
  });

  test("a change the filter rolls back entirely is no change: null, so nothing is written", () => {
    const before = fileWith(row({ phase: "drawing", photosDone: 2 }));
    const after = fileWith(row({ phase: "done", photosDone: 9 }));
    expect(guardFreeChange(before, after, () => false)).toBeNull();
  });

  test("the free part may finish an avatar (montage to done) only while the paid part has nothing live for it", () => {
    const before = fileWith(row({ phase: "montage" }));
    const after = fileWith(row({ phase: "done" }));
    expect(guardFreeChange(before, after, () => true)?.avatars[0]?.phase).toBe("done");
    expect(guardFreeChange(before, after, () => false)).toBeNull();
  });

  test("the composer filters the free part's own rewrite, and leaves the paid part's alone", async () => {
    const paid = new FakeSteps();
    const free = new FakeSteps();
    const held: { paid: LaunchStepsContext | null; free: LaunchStepsContext | null } = { paid: null, free: null };
    paid.onBegin = (ctx) => {
      held.paid = ctx;
    };
    free.onBegin = (ctx) => {
      held.free = ctx;
    };
    paid.busyAvatars.add("avatar-a");
    const steps = composeSteps(paid, free);
    const raw = rawContext(fileWith(row({ phase: "montage", photosDone: 3 })));
    steps.begin(raw.ctx);
    await held.free?.update((f) => ({ ...f, avatars: f.avatars.map((a) => ({ ...a, phase: "done" as const, photosDone: 0 })) }));
    // Everything the free part asked for belongs to the paid part: nothing is left of it, so nothing is written.
    expect(raw.lastUpdate()).toBeNull();
    await held.paid?.update((f) => ({ ...f, avatars: f.avatars.map((a) => ({ ...a, photosDone: 5 })) }));
    expect(raw.lastUpdate()?.avatars[0]).toMatchObject({ photosDone: 5 });
  });
});

describe("composeSteps: the finish retry runs only while the launch runs (S4.6b2, review)", () => {
  /** Both parts ready, so a vote reaches the real finish; the retry timer is the test's. */
  function ready(timers: FakeTimers, retryMs = 1_000) {
    const paid = new FakeSteps();
    const free = new FakeSteps();
    paid.finishReady = () => true;
    let freeCtx: LaunchStepsContext | null = null;
    free.onBegin = (ctx) => {
      freeCtx = ctx;
    };
    const steps = composeSteps(paid, free, { warn: () => undefined, retryMs, timers });
    const raw = rawContext();
    steps.begin(raw.ctx);
    const vote = async (): Promise<void> => {
      if (freeCtx === null) throw new Error("the free part was not begun");
      await freeCtx.finish();
      await steps.settled();
    };
    return { steps, raw, vote };
  }

  test("a finish that fails while the launch runs arms one retry", async () => {
    const timers = new FakeTimers();
    const g = ready(timers);
    g.raw.failNextFinish();
    await g.vote();
    expect(timers.pending()).toBe(1);
  });

  test("a finish that fails and finds the launch paused meanwhile arms no retry", async () => {
    const timers = new FakeTimers();
    const g = ready(timers);
    g.raw.failNextFinish();
    g.raw.setRunning(false);
    await g.vote();
    expect(timers.pending()).toBe(0);
  });

  test("a finish that fails because a pause landed while it was under way arms no retry (the branch inside the failure handler)", async () => {
    const timers = new FakeTimers();
    const g = ready(timers);
    g.raw.failNextFinishWhilePaused();
    await g.vote();
    expect(g.raw.finishes()).toBe(1);
    expect(timers.pending()).toBe(0);
  });

  test("a retry that falls due after a pause tries nothing", async () => {
    const timers = new FakeTimers();
    const g = ready(timers);
    g.raw.failNextFinish();
    await g.vote();
    expect(g.raw.finishes()).toBe(1);
    g.raw.setRunning(false);
    timers.advance(1_000);
    await g.steps.settled();
    expect(g.raw.finishes()).toBe(1);
  });

  test("a vote while the launch does not run reaches no finish", async () => {
    const timers = new FakeTimers();
    const g = ready(timers);
    g.raw.setRunning(false);
    await g.vote();
    expect(g.raw.finishes()).toBe(0);
  });

  test.each(["begin", "release", "complete", "drain"] as const)("%s takes the pending retry back", async (call) => {
    const timers = new FakeTimers();
    const g = ready(timers);
    g.raw.failNextFinish();
    await g.vote();
    expect(timers.pending()).toBe(1);
    if (call === "begin") g.steps.begin(g.raw.ctx);
    else if (call === "release") await g.steps.release(g.raw.ctx);
    else if (call === "complete") await g.steps.complete?.(g.raw.ctx);
    else await g.steps.drain();
    expect(timers.pending()).toBe(0);
  });
});

describe("composeSteps: host.power reaches both parts", () => {
  test("suspend is forwarded to every part that answers it, and a part that throws does not stop the others", () => {
    const paid = new FakeSteps();
    const free = new FakeSteps();
    paid.suspend = () => {
      throw new Error("a part that cannot be told");
    };
    free.suspend = () => void free.calls.push("suspend");
    const told: string[] = [];
    const steps = composeSteps(paid, free, { warn: (line) => told.push(line) });
    steps.suspend?.();
    expect(free.calls).toContain("suspend");
    expect(told.some((line) => line.includes("could not be told of the sleep"))).toBe(true);
  });

  test("wake hands the paid part its re-check and begins a part that has none, without forgetting the votes", async () => {
    const paid = new FakeSteps();
    const free = new FakeSteps();
    paid.wake = async () => void paid.calls.push("wake");
    const steps = composeSteps(paid, free);
    const raw = rawContext();
    steps.begin(raw.ctx);
    await steps.wake?.(raw.ctx);
    expect(paid.calls.filter((c) => c === "begin")).toHaveLength(1);
    expect(paid.calls).toContain("wake");
    expect(free.calls.filter((c) => c === "begin")).toHaveLength(2);
  });

  test("without any part that answers a sleep, the composer has no suspend or wake of its own", () => {
    const steps = composeSteps(new FakeSteps(), new FakeSteps());
    expect(steps.suspend).toBeUndefined();
    expect(steps.wake).toBeUndefined();
  });
});
