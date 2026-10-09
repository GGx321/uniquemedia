import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Scope } from "../money/ledger";
import { SceneSetStore, type StoredSceneSet } from "../library/sceneSets";
import { sampleSet } from "../library/testing/sceneSetSample";
import { useTempDir } from "../library/testing/helpers";
import { until } from "../testing/engineHarness";
import { chatBody, fakeFetch, makeClient, setupMoney, type FetchCall, type Money, type Reply, type Step } from "../openrouter/testing/fakes";
import { NetworkPool } from "../runs/pools";
import { withChunkGivenUp, withChunkWritten } from "./mutations";
import type { Budget } from "../money/budget";
import { chunkState } from "./chunks";
import { runSceneWrite, type SceneWriteEnd } from "./writeJob";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// CS.4a: the set's writer job. It drives the run's own writer phase one pending chunk at a time (the run's phase stops at its first unwritable chunk; this
// job goes on past one), writes every accepted chunk into the set before it asks the next, and never resends a reserved id or gives a chunk a fresh pair
// of attempts after an interruption: answered attempts per chunk are counted across jobs from the ledger.

const root = useTempDir("studio-scene-write-");
const AVATAR = "avatar-aaaa-0001";
const SET = "set-aaaa-0001";
const id = (chunk: number, n: number) => `${SET}:writer-${chunk}#${n}`;
const SENTENCE = "A friend catches her mid-laugh at the kitchen counter as morning light spills across the table.";

let money: Money;
let store: SceneSetStore;
beforeEach(async () => {
  money = await setupMoney();
  store = new SceneSetStore(root());
});
afterEach(async () => {
  await money.cleanup();
});

async function seed(count = 30, change: (set: StoredSceneSet) => StoredSceneSet = (s) => s): Promise<void> {
  const made = await store.create(sampleSet({ count }));
  if (change !== undefined) await store.update(AVATAR, made.sceneSetId, change);
}

/** A good answer for the slots the request asked about (read from its own prompt). */
function slotsAskedFor(call: FetchCall): number[] {
  const body = call.json();
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const user = messages.find((m: unknown) => typeof m === "object" && m !== null && "role" in m && m.role === "user");
  const text = typeof user === "object" && user !== null && "content" in user && typeof user.content === "string" ? user.content : "";
  return (JSON.parse(text.slice(text.indexOf("["), text.lastIndexOf("]") + 1)) as { slotIndex: number }[]).map((s) => s.slotIndex);
}

function answerFor(call: FetchCall): Reply {
  return { status: 200, body: chatBody(JSON.stringify({ scenes: slotsAskedFor(call).map((slotIndex) => ({ slotIndex, sentence: SENTENCE })) }), { cost: 0.0112 }) };
}

const good: Step = (call) => answerFor(call);
const rejected: Step = { status: 200, body: chatBody(JSON.stringify({ scenes: [] }), { cost: 0.002 }) };
const refusal: Step = { status: 400, body: { error: { message: "xAI blocked this request through content moderation." } } };
const rateLimited: Step = { status: 429, headers: { "retry-after": "120" }, body: { error: { message: "rate limited" } } };
const unavailable: Step = { status: 503, body: { error: { message: "upstream unavailable" } } };
const offline: Step = { reject: new TypeError("fetch failed") };

function run(steps: Step[], opts: { jobId?: string; signal?: AbortSignal; stop?: AbortSignal; scope?: Scope; afterSave?: (chunk: number) => void; budget?: Budget; pool?: NetworkPool; afterAcquire?: () => void } = {}) {
  const net = fakeFetch(steps);
  const { client } = makeClient(net.fetch);
  const pool = opts.pool ?? new NetworkPool({ max: 6 });
  const progress: number[] = [];
  const saves: { chunk: number; size: number; callsSoFar: number }[] = [];
  const gaveUp: { chunk: number; by: string }[] = [];
  const jobId = opts.jobId ?? "job-aaaa-0001";
  const end = runSceneWrite(
    {
      chat: client.chat,
      budget: opts.budget ?? money.budget,
      priceBook: money.priceBook,
      acquire: async (signal) => {
        const release = await pool.acquire(signal);
        opts.afterAcquire?.();
        return release;
      },
      load: async () => {
        const set = await store.get(AVATAR, SET);
        if (set === null) throw new Error("the set is gone");
        return set;
      },
      saveChunk: async (chunk, sentences) => {
        saves.push({ chunk, size: sentences.size, callsSoFar: net.calls.length });
        await store.update(AVATAR, SET, (s) => withChunkWritten(s, sentences));
        opts.afterSave?.(chunk);
      },
      giveUp: async (chunk, by) => {
        gaveUp.push({ chunk, by });
        await store.update(AVATAR, SET, (s) => withChunkGivenUp(s, chunk, by));
      },
      progress: (done) => progress.push(done),
    },
    { jobId, scope: opts.scope ?? { avatarJobId: jobId }, signal: opts.signal ?? new AbortController().signal, ...(opts.stop === undefined ? {} : { stop: opts.stop }) },
  );
  return { net, end, progress, saves, gaveUp, pool };
}

function reserveIds(): string[] {
  return money.lines().flatMap((l) => (l.type === "reserve" && typeof l.attemptId === "string" ? [l.attemptId] : []));
}

async function setNow(): Promise<StoredSceneSet> {
  const set = await store.get(AVATAR, SET);
  if (set === null) throw new Error("the set is gone");
  return set;
}

const textsOf = (set: StoredSceneSet) => set.scenes.map((s) => s.text);

describe("runSceneWrite: a compose", () => {
  test("asks once per pending chunk under the set's own ids and writes each chunk into the set before it asks the next", async () => {
    await seed(30);
    const { saves, progress, end } = run([good, good]);

    expect(await end).toEqual({ status: "done", written: 30, unwritten: 0 });
    expect(reserveIds()).toEqual([id(1, 1), id(2, 1)]);
    expect(saves).toEqual([
      { chunk: 1, size: 25, callsSoFar: 1 },
      { chunk: 2, size: 5, callsSoFar: 2 },
    ]);
    expect(progress).toEqual([25, 30]);
    expect((await setNow()).scenes.every((s) => s.text === SENTENCE)).toBe(true);
  });

  test("a rejected answer is asked again under the chunk's next id", async () => {
    await seed(3);
    const { net, end } = run([rejected, good]);
    expect(await end).toEqual({ status: "done", written: 3, unwritten: 0 });
    expect(reserveIds()).toEqual([id(1, 1), id(1, 2)]);
    expect(JSON.stringify(net.calls[1]?.json())).toContain("An earlier answer was rejected");
  });

  test("every call takes a network slot and gives it back", async () => {
    await seed(30);
    const { pool, end } = run([good, good]);
    await end;
    expect(pool.active).toBe(0);
  });
});

describe("runSceneWrite: a chunk that cannot be written does not block the others", () => {
  test("a chunk rejected twice is given up and the job goes on with the next chunk", async () => {
    await seed(30);
    const { net, gaveUp, end } = run([rejected, rejected, good]);

    expect(await end).toEqual({ status: "done", written: 5, unwritten: 25 });
    expect(gaveUp).toEqual([{ chunk: 1, by: "rejected" }]);
    expect(net.calls).toHaveLength(3);
    expect(reserveIds()).toEqual([id(1, 1), id(1, 2), id(2, 1)]);
    const set = await setNow();
    expect(set.chunks.map((c) => c.gaveUp)).toEqual(["rejected", undefined]);
    expect(textsOf(set).slice(0, 25).every((t) => t === null)).toBe(true);
    expect(textsOf(set).slice(25).every((t) => t === SENTENCE)).toBe(true);
  });

  test("a provider's refusal is final for its chunk: one call, given up as refused, and the next chunk is asked", async () => {
    await seed(30);
    const { net, gaveUp, end } = run([refusal, good]);

    expect(await end).toEqual({ status: "done", written: 5, unwritten: 25 });
    expect(gaveUp).toEqual([{ chunk: 1, by: "refused" }]);
    expect(net.calls).toHaveLength(2);
  });

  test("a later job does not retry a chunk a job gave up on", async () => {
    await seed(30);
    await run([rejected, rejected, good]).end;
    const again = run([good]);

    expect(await again.end).toEqual({ status: "done", written: 0, unwritten: 0 });
    expect(again.net.calls).toHaveLength(0);
  });

  test("a chunk out of attempts is skipped without a call and the next chunk is asked", async () => {
    await seed(30);
    // Chunk 1 has two answered attempts in the ledger already (one of them an interrupted request), though no job gave up on it.
    await run([rejected, offline]).end;
    const second = run([good]);

    expect(await second.end).toMatchObject({ status: "done", written: 5 });
    expect(second.net.calls).toHaveLength(1);
    expect(slotsAskedFor(second.net.calls[0] as FetchCall)).toEqual([26, 27, 28, 29, 30]);
  });
});

describe("runSceneWrite: an attempt that got no answer stops the job, resumable", () => {
  test("a final 429 stops it at once, with nothing given up and the next chunk not asked", async () => {
    await seed(30);
    const { net, gaveUp, end } = run([rateLimited]);

    expect(await end).toMatchObject({ status: "failed", stoppedBy: "rate-limited", error: { code: "RATE_LIMITED", retryAfterMs: 120_000 } });
    expect(net.calls).toHaveLength(1);
    expect(gaveUp).toEqual([]);
    expect(reserveIds()).toEqual([id(1, 1)]);
    expect((await setNow()).chunks.map((c) => c.gaveUp)).toEqual([undefined, undefined]);
  });

  test("a 5xx that outlasts the transport retries is the provider's error: a free settle, told apart from a dropped connection", async () => {
    await seed(3);
    const { end } = run([unavailable, unavailable, unavailable]);
    expect(await end).toMatchObject({ status: "failed", stoppedBy: "provider-error", error: { code: "NETWORK" } });
  });

  test("a dropped connection leaves its reserve open at the worst case and stops the job as a network failure", async () => {
    await seed(3);
    const { end } = run([offline]);
    expect(await end).toMatchObject({ status: "failed", stoppedBy: "network", error: { code: "NETWORK" } });
    expect(money.budget.status()).toMatchObject({ openAttempts: 1, openReserveMicros: 37_500 });
  });

  test("a failure that is the key's or ours is a plain failure with its error", async () => {
    await seed(3);
    const { end } = run([{ status: 401, body: { error: { message: "bad key" } } }]);
    expect(await end).toMatchObject({ status: "failed", stoppedBy: "failed", error: { code: "AUTH_INVALID" } });
  });

  test("the next job resumes a free-failed chunk from its next unused id and never resends the one that failed", async () => {
    await seed(3);
    await run([rateLimited]).end;
    const second = run([good]);

    expect(await second.end).toEqual({ status: "done", written: 3, unwritten: 0 });
    expect(reserveIds()).toEqual([id(1, 1), id(1, 2)]);
  });

  test("never a fresh pair: after one answered attempt was interrupted, the chunk gets ONE more and then is done for", async () => {
    await seed(3);
    await run([offline], { jobId: "job-aaaa-0001" }).end;
    const second = run([rejected, good], { jobId: "job-aaaa-0002" });

    expect(await second.end).toEqual({ status: "done", written: 0, unwritten: 3 });
    expect(second.net.calls).toHaveLength(1);
    expect(reserveIds()).toEqual([id(1, 1), id(1, 2)]);
    expect((await setNow()).chunks[0]?.gaveUp).toBe("rejected");
  });

  test("a reconcile's estimated settle of the interrupted request counts as answered too", async () => {
    await seed(3);
    await run([offline]).end;
    await money.ledger.append({ type: "settle", attemptId: id(1, 1), costMicros: 37_500, estimated: true, at: "2026-10-07T12:00:00.000Z" });
    const second = run([rejected, good], { jobId: "job-aaaa-0002" });

    expect(await second.end).toEqual({ status: "done", written: 0, unwritten: 3 });
    expect(second.net.calls).toHaveLength(1);
  });
});

describe("runSceneWrite: cancel", () => {
  test("a cancel while a request is out ends the job cancelled, keeps the chunks already written and leaves the reserve open", async () => {
    await seed(30);
    const controller = new AbortController();
    const hang: Step = { hang: true };
    const first: Step = (call) => answerFor(call);
    const { saves, end } = run([first, hang], { signal: controller.signal });
    while (saves.length < 1) await new Promise((resolve) => setTimeout(resolve, 5));
    await until(() => money.budget.status().openAttempts === 1, "the second request's reserve");
    controller.abort();

    expect(await end).toEqual({ status: "cancelled" });
    const set = await setNow();
    expect(textsOf(set).slice(0, 25).every((t) => t === SENTENCE)).toBe(true);
    expect(textsOf(set).slice(25).every((t) => t === null)).toBe(true);
    expect(money.budget.status().openAttempts).toBe(1);
  });

  test("a job cancelled before its first call sends nothing", async () => {
    await seed(30);
    const controller = new AbortController();
    controller.abort();
    const { net, end } = run([good], { signal: controller.signal });
    expect(await end).toEqual({ status: "cancelled" });
    expect(net.calls).toHaveLength(0);
  });
});

/** A writer answer that arrives only when the test lets it, after its request has been sent. */
function heldAnswer(): { step: (call: FetchCall) => Promise<Reply>; release: () => void; arrived: () => number } {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let arrived = 0;
  return {
    step: async (call) => {
      arrived++;
      await gate;
      return answerFor(call);
    },
    release,
    arrived: () => arrived,
  };
}

/** A Budget whose reserve reaches the disk and then the stop fires: the window between a reserve and its send. */
function stoppingAfterReserve(budget: Budget, stop: AbortController): Budget {
  return new Proxy(budget, {
    get(target, prop) {
      if (prop === "tryReserve") {
        return async (req: Parameters<Budget["tryReserve"]>[0]) => {
          const reserved = await target.tryReserve(req);
          stop.abort();
          return reserved;
        };
      }
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("runSceneWrite: soft stop, the residual windows (S4.5b fix round 1, M1)", () => {
  test("a stop that lands after the reserve is on disk releases it unsent: no request, no open reserve, the id is spent but not counted as answered, the next job takes the next id", async () => {
    await seed(3);
    const stop = new AbortController();
    const { net, end } = run([good], { stop: stop.signal, budget: stoppingAfterReserve(money.budget, stop) });

    expect(await end).toEqual({ status: "cancelled" });
    expect(money.lines().map((l) => l.type)).toEqual(["reserve", "release"]);
    expect(net.calls).toHaveLength(0);
    expect(money.budget.status().openAttempts).toBe(0);
    const set = await setNow();
    const chunk = set.chunks[0];
    if (chunk === undefined) throw new Error("no chunk");
    expect(chunkState(set, chunk, money.budget.ledger).answered).toBe(0);

    const later = run([good], { jobId: "job-aaaa-0002" });
    expect(await later.end).toEqual({ status: "done", written: 3, unwritten: 0 });
    expect(reserveIds()).toEqual([id(1, 1), id(1, 2)]);
  });

  test("a stop that lands right after the network slot is granted writes no reserve at all", async () => {
    await seed(3);
    const stop = new AbortController();
    const { net, end } = run([good], { stop: stop.signal, afterAcquire: () => stop.abort() });

    expect(await end).toEqual({ status: "cancelled" });
    expect(money.lines()).toEqual([]);
    expect(net.calls).toHaveLength(0);
  });

  test("S4.5b L1: a job queued behind other holders of the network pool ends at once on a stop, with nothing reserved", async () => {
    await seed(3);
    const pool = new NetworkPool({ max: 1 });
    const holder = await pool.acquire(new AbortController().signal);
    const stop = new AbortController();
    const { net, end } = run([good], { stop: stop.signal, pool });
    await new Promise((resolve) => setTimeout(resolve, 20));

    stop.abort();

    const result = await Promise.race([end, new Promise<string>((resolve) => setTimeout(() => resolve("still queued"), 2_000))]);
    holder();
    expect(result).toEqual({ status: "cancelled" });
    expect(net.calls).toHaveLength(0);
    expect(money.lines()).toEqual([]);
  });
});

describe("runSceneWrite: soft stop (S4.5b)", () => {
  test("a stop during a chunk's request lets that attempt finish, saves the accepted chunk, and asks no next chunk", async () => {
    await seed(55); // three chunks: 25 + 25 + 5
    const stop = new AbortController();
    const held = heldAnswer();
    const { net, saves, end } = run([good, held.step, good], { stop: stop.signal });
    await until(() => held.arrived() === 1, "the second chunk's request");

    stop.abort();
    held.release();

    expect(await end).toEqual({ status: "cancelled" });
    expect(saves.map((s) => s.chunk)).toEqual([1, 2]);
    expect(net.calls).toHaveLength(2);
    expect(reserveIds()).toEqual([id(1, 1), id(2, 1)]);
    const set = await setNow();
    expect(textsOf(set).slice(0, 50).every((t) => t === SENTENCE)).toBe(true);
    expect(textsOf(set).slice(50).every((t) => t === null)).toBe(true);
  });

  test("the request in flight settles normally: the stop leaves no open reserve", async () => {
    await seed(30);
    const stop = new AbortController();
    const held = heldAnswer();
    const { end } = run([held.step, good], { stop: stop.signal });
    await until(() => held.arrived() === 1, "the first request");

    stop.abort();
    held.release();
    await end;

    expect(money.budget.status().openAttempts).toBe(0);
    expect(money.lines().map((l) => l.type)).toEqual(["reserve", "settle"]);
  });

  test("a stop between a rejected answer and its re-ask sends no second attempt; the chunk stays pending for the next job's next unused id", async () => {
    await seed(3);
    const stop = new AbortController();
    const held = heldAnswer();
    const { net, gaveUp, end } = run([async (call) => {
      await held.step(call);
      return rejected as Reply;
    }, good], { stop: stop.signal });
    await until(() => held.arrived() === 1, "the first request");

    stop.abort();
    held.release();

    expect(await end).toEqual({ status: "cancelled" });
    expect(net.calls).toHaveLength(1);
    expect(gaveUp).toEqual([]);
    expect((await setNow()).chunks[0]?.gaveUp).toBeUndefined();

    const later = run([good], { jobId: "job-aaaa-0002" });
    expect(await later.end).toEqual({ status: "done", written: 3, unwritten: 0 });
    expect(reserveIds()).toEqual([id(1, 1), id(1, 2)]);
  });

  test("a stop before the first request sends nothing and reserves nothing", async () => {
    await seed(30);
    const stop = new AbortController();
    stop.abort();
    const { net, end } = run([good], { stop: stop.signal });

    expect(await end).toEqual({ status: "cancelled" });
    expect(net.calls).toHaveLength(0);
    expect(money.lines()).toEqual([]);
  });

  test("a stop that lands as the last chunk is saved changes nothing: the job is done, not cancelled", async () => {
    await seed(30);
    const stop = new AbortController();
    const { end } = run([good, good], { stop: stop.signal, afterSave: (chunk) => chunk === 2 && stop.abort() });

    expect(await end).toEqual({ status: "done", written: 30, unwritten: 0 });
  });

  test("a stop that lands after chunk 1 is saved leaves chunk 2 unasked and unreserved", async () => {
    await seed(30);
    const stop = new AbortController();
    const { net, end } = run([good, good], { stop: stop.signal, afterSave: (chunk) => chunk === 1 && stop.abort() });

    expect(await end).toEqual({ status: "cancelled" });
    expect(net.calls).toHaveLength(1);
    expect(reserveIds()).toEqual([id(1, 1)]);
  });

  test("a stop that is never given changes nothing: the signal is optional", async () => {
    await seed(3);
    expect(await run([good]).end).toEqual({ status: "done", written: 3, unwritten: 0 });
  });
});

describe("runSceneWrite: what a request covers", () => {
  test("only the scenes still without text: a typed text is a written scene and a removed scene is never sent", async () => {
    await seed(5, (set) => ({ ...set, scenes: set.scenes.map((s) => (s.sceneId === 1 ? { ...s, text: "Typed.", edited: true } : s.sceneId === 2 ? { ...s, removed: true } : s)) }));
    const { net, end } = run([good]);

    expect(await end).toEqual({ status: "done", written: 3, unwritten: 0 });
    expect(slotsAskedFor(net.calls[0] as FetchCall)).toEqual([3, 4, 5]);
    const set = await setNow();
    expect(set.scenes[0]).toMatchObject({ text: "Typed.", edited: true });
    expect(set.scenes[1]?.text).toBeNull();
  });

  test("a chunk whose scenes all have text is not requested", async () => {
    await seed(30, (set) => ({ ...set, scenes: set.scenes.map((s) => (s.sceneId <= 25 ? { ...s, text: "Typed.", edited: true } : s)) }));
    const { net, end } = run([good]);

    expect(await end).toEqual({ status: "done", written: 5, unwritten: 0 });
    expect(net.calls).toHaveLength(1);
    expect(reserveIds()).toEqual([id(2, 1)]);
  });

  test("a set with nothing to write sends nothing and ends done", async () => {
    await seed(3, (set) => ({ ...set, scenes: set.scenes.map((s) => ({ ...s, text: "A sentence." })) }));
    const { net, end } = run([good]);
    expect(await end).toEqual({ status: "done", written: 0, unwritten: 0 });
    expect(net.calls).toHaveLength(0);
  });
});

describe("runSceneWrite: money", () => {
  test("every request reserves its worst case before it is sent and settles after, under the job's own scope", async () => {
    await seed(3);
    await run([good], { jobId: "job-aaaa-0007" }).end;

    const lines = money.lines();
    expect(lines.map((l) => l.type)).toEqual(["reserve", "settle"]);
    expect(lines[0]).toMatchObject({ attemptId: id(1, 1), jobId: "job-aaaa-0007", scope: { avatarJobId: "job-aaaa-0007" }, worstMicros: 37_500 });
  });

  test("the cap of the job's scope bounds it: a second attempt that does not fit is refused, nothing is sent for it", async () => {
    const capped = await setupMoney({ runCapMicros: 37_500 });
    await money.cleanup();
    money = capped;
    await seed(3);
    const { net, end } = run([rejected, good]);

    expect(await end).toMatchObject({ status: "failed", stoppedBy: "failed", error: { code: "RUN_CAP_EXCEEDED" } });
    expect(net.calls).toHaveLength(1);
  });

  test("a bill above the worst case is a failure that halts every later reserve", async () => {
    await seed(3);
    const dear: Step = (call) => ({ status: 200, body: chatBody(JSON.stringify({ scenes: slotsAskedFor(call).map((slotIndex) => ({ slotIndex, sentence: SENTENCE })) }), { cost: 5 }) });
    const { end } = run([dear]);
    expect(await end).toMatchObject({ status: "failed", stoppedBy: "failed", error: { code: "SETTLE_ABOVE_WORST" } });
  });
});

describe("runSceneWrite: progress", () => {
  test("counts the scenes this job wrote and never goes past what it set out to write", async () => {
    await seed(30);
    const { progress, end } = run([rejected, rejected, good]);
    const result = (await end) as Extract<SceneWriteEnd, { status: "done" }>;
    expect(progress).toEqual([5]);
    expect(progress.every((done) => done <= result.written + result.unwritten)).toBe(true);
  });
});
