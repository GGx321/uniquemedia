import { describe, expect, test } from "bun:test";
import type { LaunchFile } from "./launchFile";
import { composeSteps, guardFreeChange } from "./stepsComposer";
import { FakeSteps } from "./testing/fakeSteps";
import { IDLE_STEPS, type LaunchStepsContext } from "./steps";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Stage 4, S4.6b1 (fix round 1): the composer puts the paid and the free steps behind the engine's one seam, decides the finish jointly, and keeps the two parts to their own
// fields of the launch file.

const row = (over: Record<string, unknown> = {}) => ({ avatarId: "avatar-a", phase: "montage", waiting: null, skipped: null, photosDone: 3, videos: [], ...over });
const fileWith = (...rows: Record<string, unknown>[]): LaunchFile => ({ launchId: "launch-x", avatars: rows }) as unknown as LaunchFile;

interface RawCtx {
  ctx: LaunchStepsContext;
  finishes: () => number;
  failNextFinish(): void;
  lastUpdate(): LaunchFile | null;
  setFile(file: LaunchFile): void;
}

/** A bare core-side context: `finish` and `update` are spies, `file` is whatever the test sets. */
function rawContext(initial: LaunchFile = fileWith(row())): RawCtx {
  let file = initial;
  let finishes = 0;
  let fail = false;
  let updated: LaunchFile | null = null;
  const ctx = {
    launchId: "launch-x",
    file: () => file,
    isRunning: () => true,
    update: (change: (f: LaunchFile) => LaunchFile | null) => {
      updated = change(file);
      return Promise.resolve(updated ?? file);
    },
    finish: () => {
      finishes += 1;
      if (fail) {
        fail = false;
        return Promise.reject(new Error("still has work in flight"));
      }
      return Promise.resolve(file);
    },
  } as unknown as LaunchStepsContext;
  return { ctx, finishes: () => finishes, failNextFinish: () => void (fail = true), lastUpdate: () => updated, setFile: (f) => void (file = f) };
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
  function gate() {
    const paid = new FakeSteps();
    const free = new FakeSteps();
    let paidReady = false;
    paid.finishReady = () => paidReady;
    let freeCtx: LaunchStepsContext | null = null;
    free.onBegin = (ctx) => {
      freeCtx = ctx;
    };
    const told: string[] = [];
    const steps = composeSteps(paid, free, { warn: (line) => told.push(line) });
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
    expect(guarded.avatars[0]).toMatchObject({ phase: "drawing", waiting: null, skipped: null, photosDone: 2, videos: [{ key: "0-1", state: "done" }] });
  });

  test("the free part may finish an avatar (montage to done) only while the paid part has nothing live for it", () => {
    const before = fileWith(row({ phase: "montage" }));
    const after = fileWith(row({ phase: "done" }));
    expect(guardFreeChange(before, after, () => true).avatars[0]?.phase).toBe("done");
    expect(guardFreeChange(before, after, () => false).avatars[0]?.phase).toBe("montage");
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
    expect(raw.lastUpdate()?.avatars[0]).toMatchObject({ phase: "montage", photosDone: 3 });
    await held.paid?.update((f) => ({ ...f, avatars: f.avatars.map((a) => ({ ...a, photosDone: 5 })) }));
    expect(raw.lastUpdate()?.avatars[0]).toMatchObject({ photosDone: 5 });
  });
});
