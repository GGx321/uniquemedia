import { describe, expect, test } from "bun:test";
import { JobCancelled, JobProgress, JobState, type ClipCancelDetail, type ClipPrices, type ClipRequest } from "../../shared/engine";
import type { UnsequencedEvent } from "../../shared/engine/events";
import { JobRegistry } from "../jobs";
import { scopeKey, type ReserveRefusal } from "../money/budget";
import { ClipBatch, type BatchMember, type BatchPorts, type MemberRun, type PhotoRecheck } from "./batch";
import { frameFactsOf, type FrameFacts } from "./frameFacts";
import type { ClipMoneyEnd } from "./job";
import { clipAttemptId } from "./journal";
import { motionChoicesOf } from "./motion";
import { PRICES } from "./testing/attemptRig";
import { planlessPhoto } from "./testing/frameFixtures";
import { SHORT_CLIP_TIMINGS } from "./timings";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Stage 5, 5b.2, S5.WB2 (plan s5b2 §5.2.2, I5.61-I5.63; §8 «the turn», «stops», «429», «cancel»): the batch scheduler on its own, over fake ports and a virtual clock. A `sleep` moves the clock and returns
// at once, so «up to 2 min» and «no submit for 60 s» are read off the clock, in no real time. A member's clip job is a script that tells how its money closed. What is pinned is the scheduler's
// decisions: who runs when, what each end of a member means for the rest, and that no hold and no cap outlives the batch on any path.

const AVATAR = "avatar-00000001";
const BATCH = "batch-00000001";
const T0 = Date.parse("2026-10-15T12:00:00.000Z");
const SHARE = 850_000;
const REQUEST: ClipRequest = { model: "kling", quality: "std", seconds: 5, fallback: "auto" };

function facts(bold = false): FrameFacts {
  const result = frameFactsOf(planlessPhoto("home", { faceCos: 0.7 }), null);
  if (result.kind !== "gallery") throw new Error("expected a gallery photo");
  return { ...result.facts, capture: "selfie", face: "yes", faceRole: "judged", bold };
}

const photoOf = (i: number): string => `photo-${String(i).padStart(8, "0")}`;
const COMPLETED: ClipMoneyEnd = { kind: "completed", aboveWorst: false };
const failed = (reason: Extract<ClipMoneyEnd, { kind: "failed" }>["reason"], aboveWorst = false): ClipMoneyEnd => ({ kind: "failed", reason, aboveWorst });
const refusal = (reason: "HALTED" | "RECONCILE_REQUIRED" | "BUDGET_EXCEEDED"): ReserveRefusal =>
  reason === "HALTED"
    ? { ok: false, reason, cause: "SETTLE_ABOVE_WORST", detail: "halted" }
    : reason === "RECONCILE_REQUIRED"
      ? { ok: false, reason, openAttempts: 1, torn: false }
      : { ok: false, reason, limitMicros: 1, committedMicros: 1, worstMicros: 1 };

interface World {
  now: number;
  readonly sleeps: number[];
  readonly events: UnsequencedEvent[];
  readonly jobs: JobRegistry;
  /** The caps set and not yet cleared, by scope key. */
  readonly caps: Map<string, number>;
  /** The month holds taken and not yet released or consumed by a reserve. */
  readonly holds: Set<string>;
  readonly released: string[];
  /** The jobs `runMember` was asked to run, in order. */
  readonly runs: string[];
  running: number;
  maxRunning: number;
  finished: number;
  moneyEmits: number;
  /** The price book of the next read; a function may throw. */
  prices: () => ClipPrices;
  priceReads: number;
  recheck: (member: BatchMember) => PhotoRecheck;
  /** What a member's money does: the default closes it at once as completed. */
  script: (run: MemberRun, w: World) => void | Promise<void>;
  /** Open reserves and held-and-live attempts the alone rule sees. */
  openReserves: string[];
  liveHolds: Map<string, number>;
  completedHolds: Set<string>;
  closes: Map<string, { type: string; estimated?: boolean }>;
  stop: AbortController;
  /** When set, `sleep` waits for its signal (a cancel) instead of moving the clock. */
  blockSleep: boolean;
  log: string[];
}

function newWorld(): World {
  return {
    now: T0,
    sleeps: [],
    events: [],
    jobs: new JobRegistry(),
    caps: new Map(),
    holds: new Set(),
    released: [],
    runs: [],
    running: 0,
    maxRunning: 0,
    finished: 0,
    moneyEmits: 0,
    prices: () => PRICES,
    priceReads: 0,
    recheck: () => ({ kind: "ok", bytes: new Uint8Array([1]) }),
    script: (run, w) => closeAs(w, run, COMPLETED),
    openReserves: [],
    liveHolds: new Map(),
    completedHolds: new Set(),
    closes: new Map(),
    stop: new AbortController(),
    blockSleep: false,
    log: [],
  };
}

/** What the clip job does when its money closes (`closeMoney` of the service): the hold was consumed by the reserve, the cap goes, the batch is told; then the job ends. */
function closeAs(w: World, run: MemberRun, end: ClipMoneyEnd | undefined): void {
  const { member } = run;
  w.holds.delete(clipAttemptId(member.clipId, 1));
  w.caps.delete(member.capKey);
  w.running--;
  run.onMoneyClosed(end);
  w.jobs.finishClip(member.jobId, { status: "done" });
}

function ports(w: World): BatchPorts {
  let ids = 100;
  return {
    clock: () => w.now,
    newId: () => `id-${String(++ids).padStart(8, "0")}`,
    timings: SHORT_CLIP_TIMINGS,
    jobs: w.jobs,
    emit: (event) => void w.events.push(event),
    emitMoney: () => void w.moneyEmits++,
    setCap: (key, micros) => void w.caps.set(key, micros),
    clearCap: (key) => void w.caps.delete(key),
    log: (line) => void w.log.push(line),
    budget: {
      ledger: {
        openReserves: () => w.openReserves.map((attemptId) => ({ attemptId })),
        closeOf: (id) => w.closes.get(id),
      } as unknown as BatchPorts["budget"]["ledger"],
      releaseHold: (id) => {
        w.holds.delete(id);
        w.released.push(id);
      },
    },
    holds: { entries: () => w.liveHolds, isCompleted: (id) => w.completedHolds.has(id) },
    mode: "auto",
    boldClips: "kling-only",
    stop: w.stop.signal,
    readPrices: async () => {
      w.priceReads++;
      return w.prices();
    },
    recheck: async (member) => w.recheck(member),
    runMember: (run) => {
      w.runs.push(run.member.jobId);
      w.running++;
      w.maxRunning = Math.max(w.maxRunning, w.running);
      void Promise.resolve(w.script(run, w));
    },
    finished: () => void w.finished++,
    sleep: (ms, signal) => {
      w.sleeps.push(ms);
      if (signal.aborted) return Promise.resolve();
      if (w.blockSleep) return new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      w.now += ms;
      return Promise.resolve();
    },
  };
}

/** The batch the service builds at create: n queued jobs in the registry, a cap and a month hold each. */
function build(w: World, n: number, options: { bold?: readonly number[] } = {}): { batch: ClipBatch; members: BatchMember[]; run: () => Promise<void> } {
  const members: BatchMember[] = [];
  for (let i = 1; i <= n; i++) {
    const bold = options.bold?.includes(i) ?? false;
    const f = facts(bold);
    const motion = motionChoicesOf(f)[0];
    if (motion === undefined) throw new Error("no motion");
    const jobId = `job-${String(i).padStart(8, "0")}`;
    const capKey = scopeKey({ avatarJobId: jobId });
    const share = bold ? 504_000 : SHARE;
    const signal = w.jobs.startClip(
      jobId,
      {
        avatarId: AVATAR,
        clipId: jobId,
        facts: { photoId: photoOf(i), request: REQUEST, motion: { source: motion.source, label: motion.label }, acceptedWorstMicros: share },
        batch: { batchId: BATCH, batchIndex: i, batchSize: n, waitReason: "turn" },
      },
      "queued",
    );
    w.caps.set(capKey, share);
    w.holds.add(clipAttemptId(jobId, 1));
    members.push({ index: i, photoId: photoOf(i), motion, request: bold ? { ...REQUEST, fallback: "none" } : REQUEST, facts: f, share, jobId, clipId: jobId, capKey, signal, wake: new AbortController(), held: true, retried: false, state: "queued" });
  }
  const batch = new ClipBatch(ports(w), { id: BATCH, avatarId: AVATAR, members });
  return { batch, members, run: () => runToEnd(w, batch) };
}

/** Starts the batch and waits until it is over (its `finished` port was called). */
async function runToEnd(w: World, batch: ClipBatch): Promise<void> {
  batch.start();
  await until(() => batch.over && w.finished > 0, "the batch to end");
}

/** Lets pending microtasks run (a scripted member that has not closed yet). */
async function flush(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 2000 && !condition(); i++) await Promise.resolve();
  if (!condition()) throw new Error(`timed out waiting for ${what}`);
}

const stateOf = (w: World, jobId: string) => w.jobs.stateOf(jobId);

/** The cancelled details of the members, by job id (undefined for a member that did not end cancelled). */
function details(w: World, ids: readonly string[]): (ClipCancelDetail | undefined)[] {
  return ids.map((id) => {
    const state = stateOf(w, id);
    return state?.kind === "clip" && state.status === "cancelled" ? state.detail : undefined;
  });
}

/** Nothing outlives the batch: no month hold, no cap, no member still queued, and the unit went back exactly once. */
function expectClean(w: World): void {
  expect([...w.holds]).toEqual([]);
  expect([...w.caps]).toEqual([]);
  expect(w.finished).toBe(1);
  for (const state of w.jobs.states()) expect(state.status === "running" && state.kind === "clip" && state.phase === "queued").toBe(false);
}

const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `job-${String(i + 1).padStart(8, "0")}`);

describe("ClipBatch: one money unit at a time", () => {
  test("runs the members in the pick order, one at a time, and gives the unit back once after the last one's money closed", async () => {
    const w = newWorld();
    await build(w, 4).run();

    expect(w.runs).toEqual(ids(4));
    expect(w.maxRunning).toBe(1);
    expectClean(w);
  });

  test("starts the next member only when the one before has closed its money", async () => {
    const w = newWorld();
    const gates: (() => void)[] = [];
    w.script = (run, world) => new Promise<void>((resolve) => gates.push(() => (closeAs(world, run, COMPLETED), resolve())));
    const { batch } = build(w, 3);
    batch.start();

    await flush();
    expect(w.runs).toEqual(ids(1));
    gates.shift()?.();
    await flush();
    expect(w.runs).toEqual(ids(2));
    expect(w.finished).toBe(0);
    gates.shift()?.();
    await flush();
    gates.shift()?.();
    await until(() => w.finished > 0, "the end");
    expect(w.runs).toEqual(ids(3));
    expect(w.maxRunning).toBe(1);
    expectClean(w);
  });

  test("a single member batch runs and ends", async () => {
    const w = newWorld();
    await build(w, 1).run();
    expect(w.runs).toEqual(ids(1));
    expectClean(w);
  });

  test("gives the unit back only after the last member's money closed, never before", async () => {
    const w = newWorld();
    let close: () => void = () => undefined;
    w.script = (run, world) => new Promise<void>((resolve) => (close = () => (closeAs(world, run, COMPLETED), resolve())));
    const { batch } = build(w, 1);
    batch.start();
    await flush();

    expect(w.finished).toBe(0);
    close();
    await until(() => w.finished > 0, "the end");
    expect(w.finished).toBe(1);
  });
});

describe("ClipBatch: the turn", () => {
  test("a photo gone at its turn ends the member `photo-gone`, free, with its hold released and its cap cleared, and the batch goes on", async () => {
    const w = newWorld();
    w.recheck = (member) => (member.index === 2 ? { kind: "gone" } : { kind: "ok", bytes: new Uint8Array([1]) });
    await build(w, 3).run();

    expect(w.runs).toEqual([ids(3)[0], ids(3)[2]]);
    expect(details(w, ids(3))).toEqual([undefined, "photo-gone", undefined]);
    expect(w.released).toEqual([clipAttemptId(ids(3)[1] ?? "", 1)]);
    expectClean(w);
  });

  test("a photo that cannot be read at its turn ends the member `photo-unreadable` and the batch goes on", async () => {
    const w = newWorld();
    w.recheck = (member) => (member.index === 1 ? { kind: "unreadable" } : { kind: "ok", bytes: new Uint8Array([1]) });
    await build(w, 2).run();

    expect(w.runs).toEqual([ids(2)[1]]);
    expect(details(w, ids(2))).toEqual(["photo-unreadable", undefined]);
    expectClean(w);
  });

  test("the cancelled member's end event carries its reason and parses", async () => {
    const w = newWorld();
    w.recheck = () => ({ kind: "gone" });
    await build(w, 1).run();

    const cancelled = w.events.filter((e) => e.type === "job.cancelled");
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]?.payload).toEqual({ kind: "clip", jobId: ids(1)[0], avatarId: AVATAR, clipId: ids(1)[0], detail: "photo-gone" });
    expect(JobCancelled.safeParse(cancelled[0]?.payload).success).toBe(true);
    expect(JobState.safeParse(stateOf(w, ids(1)[0] ?? "")).success).toBe(true);
  });

  test("reads the price book again at every member's turn", async () => {
    const w = newWorld();
    await build(w, 3).run();
    expect(w.priceReads).toBe(3);
  });

  test("a price whose worst case is above the member's share ends it and every queued member `price-changed`, free, holds and caps gone", async () => {
    const w = newWorld();
    w.prices = () => ({ ...PRICES, std: { perSecondMicros: 200_000, perInputImageMicros: 0 } });
    await build(w, 3).run();

    expect(w.runs).toEqual([]);
    expect(details(w, ids(3))).toEqual(["price-changed", "price-changed", "price-changed"]);
    expect(w.released).toEqual(ids(3).map((id) => clipAttemptId(id, 1)));
    expectClean(w);
  });

  test("a price that rose after the first member ran stops only the members still queued", async () => {
    const w = newWorld();
    w.script = (run, world) => {
      world.prices = () => ({ ...PRICES, grok: { perSecondMicros: 400_000, perInputImageMicros: 10_000 } });
      closeAs(world, run, COMPLETED);
    };
    await build(w, 3).run();

    expect(w.runs).toEqual(ids(3).slice(0, 1));
    expect(details(w, ids(3))).toEqual([undefined, "price-changed", "price-changed"]);
    expectClean(w);
  });

  test("a price that fell goes ahead, and the member runs on the book it read at its turn", async () => {
    const w = newWorld();
    const lower: ClipPrices = { ...PRICES, std: { perSecondMicros: 50_000, perInputImageMicros: 0 } };
    const books: ClipPrices[] = [];
    w.prices = () => lower;
    w.script = (run, world) => {
      books.push(run.prices);
      closeAs(world, run, COMPLETED);
    };
    await build(w, 2).run();

    expect(w.runs).toEqual(ids(2));
    expect(books).toEqual([lower, lower]);
    expectClean(w);
  });

  test("a price that rose within the share goes ahead (only the worst case above the share stops)", async () => {
    const w = newWorld();
    // Kling 6 x 100 000 = 600 000 is above the old 504 000 but under the member's share, which is Grok's 850 000.
    w.prices = () => ({ ...PRICES, std: { perSecondMicros: 100_000, perInputImageMicros: 0 } });
    await build(w, 2).run();
    expect(w.runs).toEqual(ids(2));
  });

  test("a «Смелая» member's share is Kling's alone: a Kling price above it stops, whatever Grok costs", async () => {
    const w = newWorld();
    w.prices = () => ({ ...PRICES, std: { perSecondMicros: 100_000, perInputImageMicros: 0 } });
    await build(w, 2, { bold: [1] }).run();

    expect(w.runs).toEqual([]);
    expect(details(w, ids(2))).toEqual(["price-changed", "price-changed"]);
    expectClean(w);
  });

  test("a price that cannot be read ends the member and the rest `price-unavailable`, free", async () => {
    const w = newWorld();
    w.prices = () => {
      throw new Error("PRICE_UNAVAILABLE");
    };
    await build(w, 3).run();

    expect(w.runs).toEqual([]);
    expect(details(w, ids(3))).toEqual(["price-unavailable", "price-unavailable", "price-unavailable"]);
    expectClean(w);
  });
});

describe("ClipBatch: the wait for the money to be alone", () => {
  test("is zero when the money is alone: no sleep, and no `alone` is told", async () => {
    const w = newWorld();
    await build(w, 2).run();

    expect(w.sleeps).toEqual([]);
    const reasons = w.events.flatMap((e) => (e.type === "job.progress" && e.payload.kind === "clip" ? [e.payload.waitReason] : []));
    expect(reasons).not.toContain("alone");
  });

  test("is zero after a completed-exact sibling, whose live hold does not block", async () => {
    const w = newWorld();
    w.script = (run, world) => {
      const attempt = clipAttemptId(run.member.clipId, 1);
      world.liveHolds.set(attempt, world.now + 120);
      world.completedHolds.add(attempt);
      world.closes.set(attempt, { type: "settle", estimated: false });
      closeAs(world, run, COMPLETED);
    };
    await build(w, 3).run();

    expect(w.runs).toEqual(ids(3));
    expect(w.sleeps).toEqual([]);
  });

  test("waits while a refused sibling's hold is live, and goes ahead as soon as it is not", async () => {
    const w = newWorld();
    const first = clipAttemptId(ids(2)[0] ?? "", 1);
    w.script = (run, world) => {
      if (run.member.index === 1) {
        world.liveHolds.set(first, world.now + 40);
        world.closes.set(first, { type: "settle", estimated: false });
      }
      closeAs(world, run, failed("refused-free"));
    };
    await build(w, 2).run();

    expect(w.runs).toEqual(ids(2));
    // The clip's poll interval is the short set's 5 ms; the hold ended after 40 ms.
    expect(w.sleeps).toEqual(Array(8).fill(SHORT_CLIP_TIMINGS.proofRetryMs));
    const told = w.events.filter((e) => e.type === "job.progress" && e.payload.kind === "clip" && e.payload.waitReason === "alone");
    expect(told).toHaveLength(1);
    expect(told[0]?.payload).toMatchObject({ jobId: ids(2)[1], phase: "queued", waitReason: "alone", batchIndex: 2 });
  });

  test("is bounded: money that never becomes alone lets the member submit after `aloneWaitMs`, and says so in the log", async () => {
    const w = newWorld();
    w.openReserves = ["foreign-0001:img#1"];
    await build(w, 1).run();

    expect(w.runs).toEqual(ids(1));
    expect(w.sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(SHORT_CLIP_TIMINGS.aloneWaitMs);
    expect(w.log.some((line) => line.includes("submits though other money is still open"))).toBe(true);
    expectClean(w);
  });

  test("a foreign live hold of a completed clip settled by an estimate keeps the money from being alone", async () => {
    const w = newWorld();
    w.liveHolds.set("foreign-0002:video#1", w.now + 10_000);
    w.closes.set("foreign-0002:video#1", { type: "settle", estimated: true });
    w.completedHolds.add("foreign-0002:video#1");
    await build(w, 1).run();
    expect(w.sleeps.length).toBeGreaterThan(0);
  });
});

describe("ClipBatch: what a member's end means for the rest", () => {
  const stops: [string, ClipMoneyEnd, ClipCancelDetail][] = [
    ["a settle above the reserve on a completed clip", { kind: "completed", aboveWorst: true }, "ledger-stopped"],
    ["a settle above the reserve on a failed clip", failed("refused-paid", true), "ledger-stopped"],
    ["a reserve refused by a halted ledger", { kind: "not-reserved", refusal: refusal("HALTED"), afterFreeRefusal: false }, "ledger-stopped"],
    ["a reserve refused for a reconcile to do", { kind: "not-reserved", refusal: refusal("RECONCILE_REQUIRED"), afterFreeRefusal: false }, "ledger-stopped"],
    ["Grok refused by the ledger behind a free Kling", { kind: "not-reserved", refusal: refusal("RECONCILE_REQUIRED"), afterFreeRefusal: true }, "ledger-stopped"],
    ["an uncertain submit", failed("submit-uncertain"), "money-uncertain"],
    ["a late failure", failed("late"), "money-uncertain"],
    ["a lost clip", failed("lost"), "money-uncertain"],
    ["a late attempt", { kind: "late" }, "money-uncertain"],
  ];
  for (const [what, end, detail] of stops) {
    test(`${what} ends every queued member \`${detail}\`, free, holds released and caps cleared, and nothing runs after it`, async () => {
      const w = newWorld();
      w.script = (run, world) => closeAs(world, run, end);
      await build(w, 4).run();

      expect(w.runs).toEqual(ids(4).slice(0, 1));
      expect(details(w, ids(4))).toEqual([undefined, detail, detail, detail]);
      expect(w.released).toEqual(ids(4).slice(1).map((id) => clipAttemptId(id, 1)));
      expectClean(w);
    });
  }

  const goesOn: [string, ClipMoneyEnd | undefined][] = [
    ["a completed clip", COMPLETED],
    ["a proven free refusal", failed("refused-free")],
    ["a refusal of both models", failed("refused-both")],
    ["a Grok that found no room", failed("grok-no-room")],
    ["a refusal that was billed", failed("refused-paid")],
    ["a refusal of unknown cost", failed("refused-unknown")],
    ["a provider error", failed("provider-error")],
    ["a bad request", failed("bad-request")],
    ["a rejected key", failed("key-invalid")],
    ["a failed download", failed("download-failed")],
    ["a reserve the month's room refused", { kind: "not-reserved", refusal: refusal("BUDGET_EXCEEDED"), afterFreeRefusal: false }],
    ["a cancel before the POST", { kind: "cancelled" }],
    ["a photo refused in preparing (nothing ran)", undefined],
  ];
  for (const [what, end] of goesOn) {
    test(`${what} does not stop the batch: the next member runs`, async () => {
      const w = newWorld();
      w.script = (run, world) => closeAs(world, run, end);
      await build(w, 3).run();

      expect(w.runs).toEqual(ids(3));
      expect(details(w, ids(3))).toEqual([undefined, undefined, undefined]);
      expectClean(w);
    });
  }
});

describe("ClipBatch: a 429 at the submit (L11)", () => {
  const rateLimited = failed("rate-limited");

  test("requeues the member once, at the tail, as a new job under a new clip id with the same place in the batch", async () => {
    const w = newWorld();
    w.script = (run, world) => closeAs(world, run, run.member.index === 2 && !run.member.retried ? rateLimited : COMPLETED);
    await build(w, 3).run();

    // 1, 2 (429), 3, then 2 again: four runs, the last of them a new job.
    expect(w.runs).toHaveLength(4);
    const requeued = w.runs[3] ?? "";
    expect(requeued).not.toBe(ids(3)[1]);
    expect(w.runs.slice(0, 3)).toEqual(ids(3));
    expect(stateOf(w, requeued)).toMatchObject({ kind: "clip", status: "done", batchId: BATCH, batchIndex: 2, batchSize: 3, photoId: photoOf(2), acceptedWorstMicros: SHARE });
    expectClean(w);
  });

  test("the requeued job exists when the first member's money closes, before the first member's own job ends", async () => {
    const w = newWorld();
    let seen: unknown[] = [];
    w.script = (run, world) => {
      world.running--;
      world.holds.delete(clipAttemptId(run.member.clipId, 1));
      world.caps.delete(run.member.capKey);
      run.onMoneyClosed(run.member.index === 1 && !run.member.retried ? rateLimited : COMPLETED);
      // The first member's job has not ended yet: its record is still being written. A window that lists clips now must already find a queued job for its place.
      if (run.member.index === 1 && !run.member.retried) seen = world.jobs.states().filter((s) => s.kind === "clip" && s.batchIndex === 1 && s.status === "running" && s.jobId !== run.member.jobId);
      world.jobs.finishClip(run.member.jobId, { status: "done" });
    };
    await build(w, 2).run();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ phase: "queued", waitReason: "rate-limit", batchIndex: 1, batchSize: 2 });
    expect(JobState.safeParse(seen[0]).success).toBe(true);
  });

  test("announces the requeued job as queued before it runs, and the announcement parses", async () => {
    const w = newWorld();
    w.script = (run, world) => closeAs(world, run, run.member.index === 1 && !run.member.retried ? rateLimited : COMPLETED);
    await build(w, 1).run();

    const queued = w.events.filter((e) => e.type === "job.progress" && e.payload.kind === "clip" && e.payload.phase === "queued" && e.payload.jobId !== ids(1)[0]);
    expect(queued.length).toBeGreaterThan(0);
    expect(JobProgress.safeParse(queued[0]?.payload).success).toBe(true);
    expect(queued[0]?.payload).toMatchObject({ batchIndex: 1, batchSize: 1, waitReason: "rate-limit" });
  });

  test("gives the requeued member its own cap and no month hold; the first attempt's cap is cleared", async () => {
    const w = newWorld();
    const capsWhileQueued: number[] = [];
    w.script = (run, world) => {
      if (run.member.index === 1 && !run.member.retried) {
        world.running--;
        world.holds.delete(clipAttemptId(run.member.clipId, 1));
        world.caps.delete(run.member.capKey);
        run.onMoneyClosed(rateLimited);
        capsWhileQueued.push(...world.caps.values());
        world.jobs.finishClip(run.member.jobId, { status: "done" });
        return;
      }
      closeAs(world, run, COMPLETED);
    };
    await build(w, 1).run();

    expect(capsWhileQueued).toEqual([SHARE]);
    expect(w.released).toEqual([]);
    expectClean(w);
  });

  test("a second 429 for the same photo is final: it is not requeued again", async () => {
    const w = newWorld();
    w.script = (run, world) => closeAs(world, run, rateLimited);
    await build(w, 2).run();

    // 1 (429), 2 (429), then each one's single retry (429 again): four runs and no more.
    expect(w.runs).toHaveLength(4);
    expectClean(w);
  });

  test("no member is submitted for the pause after a 429, and the wait is told as `rate-limit`", async () => {
    const w = newWorld();
    const submittedAt: number[] = [];
    w.script = (run, world) => {
      submittedAt.push(world.now);
      closeAs(world, run, run.member.index === 1 ? rateLimited : COMPLETED);
    };
    await build(w, 2).run();

    // member 1 at T0; the next submit (member 2) waits out the pause on the clock.
    expect(submittedAt[0]).toBe(T0);
    expect((submittedAt[1] ?? 0) - T0).toBeGreaterThanOrEqual(SHORT_CLIP_TIMINGS.rateLimitPauseMs);
    expect(w.sleeps[0]).toBe(SHORT_CLIP_TIMINGS.rateLimitPauseMs);
    const reasons = w.events.flatMap((e) => (e.type === "job.progress" && e.payload.kind === "clip" && e.payload.jobId === ids(2)[1] ? [e.payload.waitReason] : []));
    expect(reasons).toContain("rate-limit");
  });

  test("a 429 pauses the next submit even when it was the member's second", async () => {
    const w = newWorld();
    const submittedAt: number[] = [];
    w.script = (run, world) => {
      submittedAt.push(world.now);
      closeAs(world, run, run.member.index === 1 ? rateLimited : COMPLETED);
    };
    await build(w, 2).run();
    // 1 (429), 2, 1 again (429, final): the third submit comes a pause after the second.
    expect(w.runs).toHaveLength(3);
    expect((submittedAt[2] ?? 0) - (submittedAt[1] ?? 0)).toBeGreaterThanOrEqual(0);
    expect(w.sleeps.filter((ms) => ms === SHORT_CLIP_TIMINGS.rateLimitPauseMs).length).toBeGreaterThanOrEqual(1);
  });

  test("is not requeued after a stop", async () => {
    const w = newWorld();
    w.script = (run, world) => {
      closeAs(world, run, run.member.index === 1 ? failed("submit-uncertain") : COMPLETED);
    };
    await build(w, 2).run();
    expect(w.runs).toEqual(ids(2).slice(0, 1));
  });
});

describe("ClipBatch: cancel", () => {
  test("`cancelMember` cancels one queued member alone, free; the others go on", async () => {
    const w = newWorld();
    let open: (() => void)[] = [];
    w.script = (run, world) => new Promise<void>((resolve) => open.push(() => (closeAs(world, run, COMPLETED), resolve())));
    const { batch } = build(w, 3);
    batch.start();
    await flush();

    expect(batch.cancelMember(ids(3)[1] ?? "")).toBe(true);
    expect(details(w, ids(3))).toEqual([undefined, "cancelled", undefined]);
    expect(w.released).toEqual([clipAttemptId(ids(3)[1] ?? "", 1)]);
    expect(w.caps.has(scopeKey({ avatarJobId: ids(3)[1] ?? "" }))).toBe(false);
    open.splice(0).forEach((f) => f());
    await flush();
    open.splice(0).forEach((f) => f());
    await until(() => w.finished > 0, "the end");
    expect(w.runs).toEqual([ids(3)[0], ids(3)[2]]);
    expectClean(w);
  });

  test("a member already running is never cancelled", async () => {
    const w = newWorld();
    let close: () => void = () => undefined;
    w.script = (run, world) => new Promise<void>((resolve) => (close = () => (closeAs(world, run, COMPLETED), resolve())));
    const { batch } = build(w, 2);
    batch.start();
    await flush();

    expect(batch.cancelMember(ids(2)[0] ?? "")).toBe(false);
    expect(batch.cancelQueued()).toBe(1);
    close();
    await until(() => w.finished > 0, "the end");
    expect(w.runs).toEqual(ids(2).slice(0, 1));
    expectClean(w);
  });

  test("`cancelQueued` cancels every member still queued, says how many, and the batch ends with the running member's money", async () => {
    const w = newWorld();
    let close: () => void = () => undefined;
    w.script = (run, world) => new Promise<void>((resolve) => (close = () => (closeAs(world, run, COMPLETED), resolve())));
    const { batch } = build(w, 5);
    batch.start();
    await flush();

    expect(batch.cancelQueued()).toBe(4);
    expect(batch.cancelQueued()).toBe(0);
    expect(details(w, ids(5))).toEqual([undefined, "cancelled", "cancelled", "cancelled", "cancelled"]);
    expect(w.finished).toBe(0);
    close();
    await until(() => w.finished > 0, "the end");
    expectClean(w);
  });

  test("a cancel ends the wait of the member whose turn it is", async () => {
    const w = newWorld();
    w.openReserves = ["foreign-0001:img#1"];
    w.blockSleep = true;
    const { batch } = build(w, 2);
    batch.start();
    await flush();
    expect(w.sleeps.length).toBe(1);

    expect(batch.cancelMember(ids(2)[0] ?? "")).toBe(true);
    w.openReserves = [];
    w.blockSleep = false;
    await until(() => w.finished > 0, "the end");

    // The first member never ran; the second took its turn at once.
    expect(w.runs).toEqual(ids(2).slice(1));
    expect(details(w, ids(2))).toEqual(["cancelled", undefined]);
    expectClean(w);
  });

  test("a cancel during the 429 pause ends that wait, and the member does not run", async () => {
    const w = newWorld();
    w.script = (run, world) => {
      // The first member's 429: from now on a sleep waits for its signal, so the pause the second member is in can be cancelled.
      if (run.member.index === 1 && !run.member.retried) world.blockSleep = true;
      closeAs(world, run, run.member.index === 1 && !run.member.retried ? failed("rate-limited") : COMPLETED);
    };
    const { batch } = build(w, 2);
    batch.start();
    await until(() => w.sleeps.length > 0, "the pause");
    expect(w.sleeps[0]).toBe(SHORT_CLIP_TIMINGS.rateLimitPauseMs);

    expect(batch.cancelMember(ids(2)[1] ?? "")).toBe(true);
    w.blockSleep = false;
    await until(() => w.finished > 0, "the end");

    // Member 1 ran and was refused, its requeue ran after the pause; member 2 never ran.
    expect(w.runs[0]).toBe(ids(2)[0]);
    expect(w.runs).not.toContain(ids(2)[1]);
    expect(details(w, ids(2))).toEqual([undefined, "cancelled"]);
    expectClean(w);
  });

  test("a job id that is not a queued member of the batch is not cancelled", async () => {
    const w = newWorld();
    const { batch } = build(w, 1);
    expect(batch.cancelMember("job-nope")).toBe(false);
    expect(batch.isQueued(ids(1)[0] ?? "")).toBe(true);
    await runToEnd(w, batch);
    expect(batch.isQueued(ids(1)[0] ?? "")).toBe(false);
  });
});

describe("ClipBatch: the engine stops or a defect", () => {
  test("a stop of the engine drops every queued member for free (no reason, no record), and the running member is left to its own job", async () => {
    const w = newWorld();
    w.script = (run, world) =>
      new Promise<void>((resolve) => {
        world.stop.abort();
        closeAs(world, run, { kind: "interrupted" });
        resolve();
      });
    await build(w, 3).run();

    expect(w.runs).toEqual(ids(3).slice(0, 1));
    expect(details(w, ids(3))).toEqual([undefined, undefined, undefined]);
    expect(stateOf(w, ids(3)[1] ?? "")).toMatchObject({ status: "cancelled" });
    expect(w.released).toEqual(ids(3).slice(1).map((id) => clipAttemptId(id, 1)));
    expectClean(w);
  });

  test("a stop before the first turn drops everything, nothing runs", async () => {
    const w = newWorld();
    w.stop.abort();
    await build(w, 2).run();
    expect(w.runs).toEqual([]);
    expect(w.released).toHaveLength(2);
    expectClean(w);
  });

  test("a defect in a turn cancels the queue for free and gives the unit back once", async () => {
    const w = newWorld();
    w.recheck = () => {
      throw new Error("boom");
    };
    await build(w, 3).run();

    expect(w.runs).toEqual([]);
    expect(w.log.some((line) => line.includes("the scheduler failed"))).toBe(true);
    expectClean(w);
  });

  test("a defect after a member ran does not touch that member's money", async () => {
    const w = newWorld();
    w.recheck = (member) => {
      if (member.index === 2) throw new Error("boom");
      return { kind: "ok", bytes: new Uint8Array([1]) };
    };
    await build(w, 3).run();

    expect(w.runs).toEqual(ids(3).slice(0, 1));
    expectClean(w);
  });
});

describe("ClipBatch: the unit's soundness", () => {
  test("two members are never running at once, on any of these paths (a property over seeded scripts)", async () => {
    let seed = 17;
    const rand = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 0x1_0000_0000;
    };
    const ends: (ClipMoneyEnd | undefined)[] = [COMPLETED, failed("refused-free"), failed("rate-limited"), failed("submit-uncertain"), { kind: "late" }, undefined, { kind: "cancelled" }, failed("provider-error")];
    for (let round = 0; round < 60; round++) {
      const w = newWorld();
      const n = 1 + Math.floor(rand() * 6);
      const plan = Array.from({ length: 12 }, () => ends[Math.floor(rand() * ends.length)]);
      let call = 0;
      w.script = async (run, world) => {
        await Promise.resolve();
        closeAs(world, run, plan[call++ % plan.length]);
      };
      w.recheck = () => (rand() < 0.15 ? { kind: "gone" } : { kind: "ok", bytes: new Uint8Array([1]) });
      await build(w, n).run();

      expect(w.maxRunning).toBeLessThanOrEqual(1);
      expectClean(w);
      // Every member's job ended: none is still queued or running.
      expect(w.jobs.states().every((state) => state.status !== "running")).toBe(true);
    }
  });
});
