import { afterEach, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { useNativeGlobals } from "../../../testing/nativeGlobals";
import { NoFaceInReferenceError } from "../gate";
import { Behaviour } from "../testing/behaviour";
import { EMBEDDING_LENGTH } from "./protocol";
import { createWorkerFaceGate, FaceLaneFullError, type WorkerFaceGate } from "./workerGate";
useNativeGlobals();

// T7c: the face worker's lifecycle, against a scripted worker
// (testing/scriptedFaceWorker.ts) that speaks the real wire protocol without
// any inference — so termination, respawn, the FIFO lane, crash and
// protocol-violation handling are pinned in milliseconds and without models.
// The real worker (models, decode, event-loop, parity) is pinned by
// face/testing/workerGate.real.node-test.ts and parity.test.ts.

const SCRIPT = fileURLToPath(new URL("../testing/scriptedFaceWorker.ts", import.meta.url));
const EMBEDDING = new Float32Array(EMBEDDING_LENGTH);
EMBEDDING[0] = 1;
/** A generous bound for "promptly": a terminate is milliseconds; CI machines are slow, not seconds-slow. */
const PROMPTLY_MS = 1_000;
/** How long a lane test waits for something that must happen: well under the 30 s per-test timeout, far over any scripted answer (80 ms). */
const LANE_WAIT_MS = 12_000;

/** `work`, or a rejection naming `what` when it has not settled after `ms`. The rejection of `work` itself is marked observed, so it can never surface as an unhandled error later. */
function settleWithin<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} within ${ms} ms`)), ms);
  });
  const settled = Promise.race([work, bound]).finally(() => clearTimeout(timer));
  settled.catch(() => undefined);
  return settled;
}

type Startup = "ok" | "load-failed" | "never-ready" | "crash";

interface Harness {
  gate: WorkerFaceGate;
  /** Every worker ever spawned. */
  readonly spawned: () => number;
  /** How many workers were still alive at the moment each spawn happened (every entry must be 0: no zombie overlap). */
  readonly aliveAtSpawn: readonly number[];
  readonly alive: () => number;
  /** The most computations that were ever in flight inside one worker at once. */
  readonly maxInFlight: () => number;
  /** Every worker ever spawned, in order. */
  readonly workers: readonly Worker[];
}

const gates: WorkerFaceGate[] = [];
/** Workers still running: the ones a test made unkillable (its own `terminate` replaced) are ended here with the real one. */
const running = new Set<Worker>();
afterEach(async () => {
  await Promise.all(gates.splice(0).map((g) => g.dispose()));
  await Promise.all([...running].map((w) => Worker.prototype.terminate.call(w)));
  running.clear();
});

function harness(options: { startups?: Startup[]; detectComputeTimeoutMs?: number; loadTimeoutMs?: number; idleRecycleMs?: number; killTimeoutMs?: number; tamper?: (worker: Worker) => void } = {}): Harness {
  const probe = new SharedArrayBuffer(8);
  const probeView = new Int32Array(probe);
  const startups = [...(options.startups ?? [])];
  let spawned = 0;
  let alive = 0;
  const aliveAtSpawn: number[] = [];
  const workers: Worker[] = [];
  const gate = createWorkerFaceGate({
    loadTimeoutMs: options.loadTimeoutMs,
    detectComputeTimeoutMs: options.detectComputeTimeoutMs,
    idleRecycleMs: options.idleRecycleMs,
    killTimeoutMs: options.killTimeoutMs,
    spawnWorker: () => {
      aliveAtSpawn.push(alive);
      spawned += 1;
      alive += 1;
      const worker = new Worker(SCRIPT, { workerData: { startup: startups.shift() ?? "ok", probe } });
      running.add(worker);
      worker.on("exit", () => {
        alive -= 1;
        running.delete(worker);
      });
      workers.push(worker);
      options.tamper?.(worker);
      return worker;
    },
  });
  gates.push(gate);
  return { gate, spawned: () => spawned, aliveAtSpawn, alive: () => alive, maxInFlight: () => Atomics.load(probeView, 1), workers };
}

const live = (): AbortSignal => new AbortController().signal;
const script = (behaviour: number): Uint8Array => Uint8Array.of(behaviour);
const checkInput = (behaviour: number = Behaviour.ok) => ({ pose: "front" as const, bytes: script(behaviour), masterEmbedding: EMBEDDING });

describe("a check and an embed through the worker", () => {
  test("check returns the worker's verdict", async () => {
    const { gate } = harness();
    expect(await gate.check(checkInput(), live())).toEqual({ kind: "match", similarity: 0.9, faces: 1, headRatio: 0.3 });
  });

  test("embed returns the worker's embedding", async () => {
    const { gate } = harness();
    expect(Array.from(await gate.embed(script(Behaviour.ok), live()))).toEqual(Array.from(EMBEDDING));
  });

  test("a reference the worker reports as faceless rejects embed with NoFaceInReferenceError", async () => {
    const { gate } = harness();
    await expect(gate.embed(script(Behaviour.noFace), live())).rejects.toBeInstanceOf(NoFaceInReferenceError);
  });

  test("an ordinary failure the worker reports rejects with its message and leaves the worker alive for the next check", async () => {
    const h = harness();
    await expect(h.gate.check(checkInput(Behaviour.fail), live())).rejects.toThrow("scripted failure");
    await h.gate.check(checkInput(), live());
    expect(h.spawned()).toBe(1);
  });

  test("the caller's bytes are still intact afterwards: what crosses to the worker is a copy, never the caller's own buffer", async () => {
    const { gate } = harness();
    const bytes = Uint8Array.of(Behaviour.ok, 7, 7, 7);
    await gate.check({ pose: "front", bytes, masterEmbedding: EMBEDDING }, live());
    expect(bytes.byteLength).toBe(4);
    expect(Array.from(bytes)).toEqual([Behaviour.ok, 7, 7, 7]);
  });

  test("a Node Buffer's memory is copied too, for check() and embed(): Buffer.slice() is a view, and transferring it would empty a paid image", async () => {
    const { gate } = harness();
    const forCheck = Buffer.alloc(10_000, 7);
    forCheck[0] = Behaviour.ok;
    await gate.check({ pose: "front", bytes: forCheck, masterEmbedding: EMBEDDING }, live());
    expect(forCheck.byteLength).toBe(10_000);
    expect(forCheck[9_999]).toBe(7);

    const forEmbed = Buffer.alloc(10_000, 7);
    forEmbed[0] = Behaviour.ok;
    await gate.embed(forEmbed, live());
    expect(forEmbed.byteLength).toBe(10_000);
    expect(forEmbed[9_999]).toBe(7);
  });

  test("a request that fails validation rejects the returned promise instead of throwing synchronously", async () => {
    const { gate } = harness();
    let call: Promise<unknown>;
    try {
      call = gate.check({ pose: "front", bytes: script(Behaviour.ok), masterEmbedding: new Float32Array(3) }, live());
    } catch {
      throw new Error("check() threw synchronously instead of rejecting");
    }
    await expect(call).rejects.toThrow();
  });

  test("a signal that is already aborted rejects without spawning a worker", async () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort(new Error("already cancelled"));
    await expect(h.gate.check(checkInput(), controller.signal)).rejects.toThrow("already cancelled");
    expect(h.spawned()).toBe(0);
  });
});

describe("interruption: a cancel or a timeout terminates the worker", () => {
  test("aborting a check that never returns rejects with the abort reason within a bounded time", async () => {
    const { gate } = harness();
    const controller = new AbortController();
    const running = gate.check(checkInput(Behaviour.hang), controller.signal);
    const outcome = running.then(
      () => "resolved",
      (error: unknown) => error,
    );
    await Bun.sleep(50); // let the worker actually block inside the request
    const abortedAt = performance.now();
    controller.abort(new Error("timed out"));
    const error = await outcome;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("timed out");
    expect(performance.now() - abortedAt).toBeLessThan(PROMPTLY_MS);
  });

  test("after the abort the worker is really gone — not merely abandoned", async () => {
    const h = harness();
    const controller = new AbortController();
    const running = h.gate.check(checkInput(Behaviour.hang), controller.signal).catch(() => {});
    await Bun.sleep(50);
    controller.abort(new Error("cancel"));
    await running;
    expect(h.alive()).toBe(0);
  });

  test("the next check after an abort succeeds on a freshly respawned worker", async () => {
    const h = harness();
    const controller = new AbortController();
    const running = h.gate.check(checkInput(Behaviour.hang), controller.signal).catch(() => {});
    await Bun.sleep(50);
    controller.abort(new Error("cancel"));
    await running;
    expect((await h.gate.check(checkInput(), live())).kind).toBe("match");
    expect(h.spawned()).toBe(2);
  });

  test("no zombie overlap: a replacement worker is only spawned once the old one has exited", async () => {
    const h = harness();
    for (let i = 0; i < 3; i++) {
      const controller = new AbortController();
      const running = h.gate.check(checkInput(Behaviour.hang), controller.signal).catch(() => {});
      await Bun.sleep(30);
      controller.abort(new Error("cancel"));
      await running;
    }
    await h.gate.check(checkInput(), live());
    expect(h.spawned()).toBe(4);
    expect(h.aliveAtSpawn).toEqual([0, 0, 0, 0]);
  });

  test("a check queued behind a hung one starts as soon as the hung one is cancelled", async () => {
    const h = harness();
    const controller = new AbortController();
    const hung = h.gate.check(checkInput(Behaviour.hang), controller.signal).catch(() => {});
    const waiting = h.gate.check(checkInput(), live());
    await Bun.sleep(50);
    controller.abort(new Error("cancel"));
    await hung;
    expect((await waiting).kind).toBe("match");
    expect(h.aliveAtSpawn).toEqual([0, 0]);
  });
});

describe("the lane: one computation at a time, FIFO, cancellable while queued", () => {
  test("concurrent checks never overlap inside the worker and finish in arrival order", async () => {
    const h = harness();
    const order: number[] = [];
    const runs = [0, 1, 2, 3].map((n) => h.gate.check(checkInput(Behaviour.slow), live()).then(() => order.push(n)));
    await Promise.all(runs);
    expect(order).toEqual([0, 1, 2, 3]);
    expect(h.maxInFlight()).toBe(1);
  });

  test("a waiter cancelled while queued rejects at once and leaves the running check untouched", async () => {
    const h = harness();
    // Both waits are bounded below the per-test timeout. This test once hit the 30 s timeout on a Windows runner (run 37112152411) with the
    // holder still waiting on its worker's answer when the gate was disposed; a bound names which of the two never settled, and the
    // holder's own rejection is observed so a late one cannot surface as an unhandled error after the test is over.
    const holder = settleWithin(h.gate.check(checkInput(Behaviour.slow), live()), LANE_WAIT_MS, "the holding check never got its worker's answer");
    const controller = new AbortController();
    const waiter = h.gate.check(checkInput(), controller.signal);
    const outcome = settleWithin(
      waiter.then(
        () => "resolved",
        (error: unknown) => (error instanceof Error ? error.message : "not an error"),
      ),
      LANE_WAIT_MS,
      "the cancelled waiter never rejected",
    );
    controller.abort(new Error("gave up waiting"));
    try {
      expect(await outcome).toBe("gave up waiting");
      expect((await holder).kind).toBe("match");
      expect(h.spawned()).toBe(1);
    } finally {
      await holder.catch(() => undefined);
    }
  });

  test("B1: a waiter cancelled BEHIND the holder never lets the waiter behind it overlap the holder", async () => {
    const h = harness();
    const holder = h.gate.check(checkInput(Behaviour.slow), live());
    const controller = new AbortController();
    const middle = h.gate.check(checkInput(), controller.signal).catch(() => "cancelled");
    const last = h.gate.check(checkInput(Behaviour.slow), live());
    controller.abort(new Error("cancel the middle one"));
    expect(await middle).toBe("cancelled");
    await Promise.all([holder, last]);
    expect(h.maxInFlight()).toBe(1);
  });

  test("an embed and a check share the lane too", async () => {
    const h = harness();
    await Promise.all([h.gate.embed(script(Behaviour.slow), live()), h.gate.check(checkInput(Behaviour.slow), live())]);
    expect(h.maxInFlight()).toBe(1);
  });
});

describe("the lane's priority (S4.P3): a run's checks go before focus detects, and few detects may wait", () => {
  /** A holder keeps the lane busy for ~80 ms while the test queues the rest behind it. */
  function holder(h: Harness): Promise<unknown> {
    return h.gate.check(checkInput(Behaviour.slow), live());
  }

  function finishing<T>(done: string[], name: string, work: Promise<T>): Promise<void> {
    return work.then(
      () => {
        done.push(name);
      },
      () => {
        done.push(`${name}:rejected`);
      },
    );
  }

  test("a check queued behind two waiting detects runs before both", async () => {
    const h = harness();
    const done: string[] = [];
    const running = finishing(done, "holder", holder(h));
    const d1 = finishing(done, "d1", h.gate.detect(script(Behaviour.slow), live()));
    const d2 = finishing(done, "d2", h.gate.detect(script(Behaviour.slow), live()));
    const check = finishing(done, "check", h.gate.check(checkInput(), live()));
    await Promise.all([running, d1, d2, check]);
    expect(done).toEqual(["holder", "check", "d1", "d2"]);
  });

  test("an embed also goes before a waiting detect", async () => {
    const h = harness();
    const done: string[] = [];
    const running = finishing(done, "holder", holder(h));
    const d1 = finishing(done, "d1", h.gate.detect(script(Behaviour.ok), live()));
    const embed = finishing(done, "embed", h.gate.embed(script(Behaviour.ok), live()));
    await Promise.all([running, d1, embed]);
    expect(done).toEqual(["holder", "embed", "d1"]);
  });

  test("with a check and five detects queued, the check runs before every detect that arrived after it, and the detects past the cap are refused", async () => {
    const h = harness();
    const done: string[] = [];
    const running = finishing(done, "holder", holder(h));
    const detects = [0, 1, 2, 3, 4].map((n) => finishing(done, `d${n}`, h.gate.detect(script(Behaviour.ok), live())));
    const check = finishing(done, "check", h.gate.check(checkInput(), live()));
    await Promise.all([running, check, ...detects]);
    expect(done.indexOf("check")).toBeLessThan(done.indexOf("d0"));
    expect(done.indexOf("check")).toBeLessThan(done.indexOf("d1"));
    expect(done.filter((entry) => entry.endsWith(":rejected")).sort()).toEqual(["d2:rejected", "d3:rejected", "d4:rejected"]);
  });

  test("runs of checks that arrive later still go before detects that were already waiting, and keep their own arrival order", async () => {
    const h = harness();
    const done: string[] = [];
    const running = finishing(done, "holder", holder(h));
    const d1 = finishing(done, "d1", h.gate.detect(script(Behaviour.ok), live()));
    const c1 = finishing(done, "c1", h.gate.check(checkInput(), live()));
    const c2 = finishing(done, "c2", h.gate.check(checkInput(), live()));
    await Promise.all([running, d1, c1, c2]);
    expect(done).toEqual(["holder", "c1", "c2", "d1"]);
  });

  test("a third detect is refused with FaceLaneFullError while two wait", async () => {
    const h = harness();
    const running = holder(h);
    const d1 = h.gate.detect(script(Behaviour.ok), live());
    const d2 = h.gate.detect(script(Behaviour.ok), live());
    await expect(h.gate.detect(script(Behaviour.ok), live())).rejects.toBeInstanceOf(FaceLaneFullError);
    await Promise.all([running, d1, d2]);
  });

  test("a refused detect leaves the two waiting ones and the holder untouched", async () => {
    const h = harness();
    const running = holder(h);
    const d1 = h.gate.detect(script(Behaviour.ok), live());
    const d2 = h.gate.detect(script(Behaviour.ok), live());
    await h.gate.detect(script(Behaviour.ok), live()).catch(() => undefined);
    expect((await running) as { kind: string }).toMatchObject({ kind: "match" });
    expect((await d1).face).not.toBeNull();
    expect((await d2).face).not.toBeNull();
    expect(h.spawned()).toBe(1);
    expect(h.maxInFlight()).toBe(1);
  });

  test("the detect that is running does not count as waiting: one running and two waiting are all accepted", async () => {
    const h = harness();
    const first = h.gate.detect(script(Behaviour.slow), live());
    const second = h.gate.detect(script(Behaviour.ok), live());
    const third = h.gate.detect(script(Behaviour.ok), live());
    expect((await Promise.all([first, second, third])).length).toBe(3);
  });

  test("a waiting detect that is cancelled frees its place for another", async () => {
    const h = harness();
    const running = holder(h);
    const controller = new AbortController();
    const d1 = h.gate.detect(script(Behaviour.ok), controller.signal).catch(() => "cancelled");
    const d2 = h.gate.detect(script(Behaviour.ok), live());
    controller.abort(new Error("gave up"));
    expect(await d1).toBe("cancelled");
    const d3 = h.gate.detect(script(Behaviour.ok), live());
    await Promise.all([running, d2, d3]);
  });

  test("a detect with an already aborted signal rejects with its reason, not FaceLaneFullError, even when the lane is full", async () => {
    const h = harness();
    const running = holder(h);
    const d1 = h.gate.detect(script(Behaviour.ok), live());
    const d2 = h.gate.detect(script(Behaviour.ok), live());
    const controller = new AbortController();
    controller.abort(new Error("already gone"));
    await expect(h.gate.detect(script(Behaviour.ok), controller.signal)).rejects.toThrow("already gone");
    await Promise.all([running, d1, d2]);
  });

  test("detects complete one after another when no check is waiting", async () => {
    const h = harness();
    const first = h.gate.detect(script(Behaviour.slow), live());
    const second = h.gate.detect(script(Behaviour.slow), live());
    const third = h.gate.detect(script(Behaviour.slow), live());
    for (const result of await Promise.all([first, second, third])) expect(result.face).not.toBeNull();
    expect(h.maxInFlight()).toBe(1);
  });

  test("a waiting detect runs as soon as the last waiting check has finished", async () => {
    const h = harness();
    const done: string[] = [];
    const checks = [0, 1, 2].map((n) => finishing(done, `c${n}`, h.gate.check(checkInput(Behaviour.slow), live())));
    const detect = finishing(done, "d", h.gate.detect(script(Behaviour.ok), live()));
    await settleWithin(Promise.all([...checks, detect]), LANE_WAIT_MS, "the waiting detect never ran after the checks");
    expect(done).toEqual(["c0", "c1", "c2", "d"]);
  });

  test("a waiting detect that its caller gives up on while checks keep the lane leaves with the caller's reason", async () => {
    const h = harness();
    const checks = [0, 1, 2].map(() => h.gate.check(checkInput(Behaviour.slow), live()));
    const controller = new AbortController();
    const detect = h.gate.detect(script(Behaviour.ok), controller.signal);
    const outcome = settleWithin(detect.then(() => "resolved", (error: unknown) => (error instanceof Error ? error.message : "not an error")), LANE_WAIT_MS, "the starved detect never left");
    controller.abort(new Error("detect timeout"));
    expect(await outcome).toBe("detect timeout");
    await Promise.all(checks);
  });

  test("a check that arrives while a detect is running waits for it: a running computation is never preempted", async () => {
    const h = harness();
    const done: string[] = [];
    const detect = finishing(done, "d", h.gate.detect(script(Behaviour.slow), live()));
    await Bun.sleep(20);
    const check = finishing(done, "c", h.gate.check(checkInput(), live()));
    await Promise.all([detect, check]);
    expect(done).toEqual(["d", "c"]);
    expect(h.spawned()).toBe(1);
  });
});

describe("a detect cannot hold the lane past a run check's timeout (S4.P3)", () => {
  test("a wedged detect whose caller never gives up is killed by the compute bound, and the check queued behind it completes", async () => {
    const h = harness({ detectComputeTimeoutMs: 300 });
    const wedged = h.gate.detect(script(Behaviour.hang), live()).then(
      () => "resolved",
      (error: unknown) => (error instanceof Error ? error.message : "not an error"),
    );
    await Bun.sleep(30);
    const startedAt = performance.now();
    const verdict = await settleWithin(h.gate.check(checkInput(), live()), LANE_WAIT_MS, "the check behind the wedged detect never ran");
    expect(verdict.kind).toBe("match");
    expect(performance.now() - startedAt).toBeLessThan(PROMPTLY_MS * 2);
    expect(await wedged).toMatch(/300 ms/);
    expect(h.aliveAtSpawn).toEqual([0, 0]);
  });

  test("a detect that answers within the bound is unaffected", async () => {
    const h = harness({ detectComputeTimeoutMs: 2_000 });
    expect((await h.gate.detect(script(Behaviour.slow), live())).face).not.toBeNull();
  });

  test("the bound counts from the lane being granted, not from the call: a detect that waited its turn still gets its full compute time", async () => {
    const h = harness({ detectComputeTimeoutMs: 400 });
    const holder = h.gate.check(checkInput(Behaviour.slow), live());
    const detect = h.gate.detect(script(Behaviour.slow), live());
    await Promise.all([holder, detect]);
    expect(h.spawned()).toBe(1);
  });
});

describe("detect (S8): the largest face's box, no embedding", () => {
  test("returns the box and the source size the worker reported", async () => {
    const { gate } = harness();
    expect(await gate.detect(script(Behaviour.ok), live())).toEqual({ width: 100, height: 200, face: { x: 10, y: 20, width: 30, height: 40 } });
  });

  test("returns a null face when the worker found none (an ordinary answer, not an error)", async () => {
    const { gate } = harness();
    expect(await gate.detect(script(Behaviour.noDetection), live())).toEqual({ width: 100, height: 200, face: null });
  });

  test("an ordinary failure rejects with its message and leaves the worker alive", async () => {
    const h = harness();
    await expect(h.gate.detect(script(Behaviour.fail), live())).rejects.toThrow("scripted failure");
    await h.gate.detect(script(Behaviour.ok), live());
    expect(h.spawned()).toBe(1);
  });

  test("aborting a detect that never returns terminates the worker within a bounded time", async () => {
    const h = harness();
    const controller = new AbortController();
    const outcome = h.gate.detect(script(Behaviour.hang), controller.signal).then(
      () => "resolved",
      (error: unknown) => (error instanceof Error ? error.message : "not an error"),
    );
    await Bun.sleep(50);
    const abortedAt = performance.now();
    controller.abort(new Error("gave up"));
    expect(await outcome).toBe("gave up");
    expect(performance.now() - abortedAt).toBeLessThan(PROMPTLY_MS);
    expect(h.alive()).toBe(0);
  });

  test("shares the one lane with check and embed: never two computations at once", async () => {
    const h = harness();
    await Promise.all([h.gate.detect(script(Behaviour.slow), live()), h.gate.check(checkInput(Behaviour.slow), live()), h.gate.embed(script(Behaviour.slow), live())]);
    expect(h.maxInFlight()).toBe(1);
  });

  test("the caller's bytes are still intact afterwards", async () => {
    const { gate } = harness();
    const bytes = Buffer.alloc(10_000, 7);
    bytes[0] = Behaviour.ok;
    await gate.detect(bytes, live());
    expect(bytes.byteLength).toBe(10_000);
    expect(bytes[9_999]).toBe(7);
  });

  test("a worker that answers a detect with a check verdict is a protocol violation, not a face", async () => {
    const h = harness();
    await expect(h.gate.detect(script(Behaviour.wrongKind), live())).rejects.toThrow(/unexpected/);
    expect(h.alive()).toBe(0); // the worker that broke the contract is terminated, not kept
    expect((await h.gate.detect(script(Behaviour.ok), live())).face).not.toBeNull(); // and the next detect starts a fresh one
    expect(h.spawned()).toBe(2);
  });
});

describe("failure classification: a dead or lying worker is systemic, and the next check starts fresh", () => {
  test("a worker that crashes mid-check rejects the check with an Error", async () => {
    const { gate } = harness();
    const error = await gate.check(checkInput(Behaviour.crash), live()).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(NoFaceInReferenceError);
  });

  test("the check after a crash respawns the worker and succeeds", async () => {
    const h = harness();
    await h.gate.check(checkInput(Behaviour.crash), live()).catch(() => {});
    expect((await h.gate.check(checkInput(), live())).kind).toBe("match");
    expect(h.spawned()).toBe(2);
    expect(h.aliveAtSpawn).toEqual([0, 0]);
  });

  test("a response outside the protocol rejects the check and kills that worker", async () => {
    const h = harness();
    await expect(h.gate.check(checkInput(Behaviour.garbage), live())).rejects.toThrow();
    expect(h.alive()).toBe(0);
    expect((await h.gate.check(checkInput(), live())).kind).toBe("match");
  });

  test("a worker that dies while a check is queued behind it fails only the running check; the queued one runs on a fresh worker", async () => {
    const h = harness();
    const crashing = h.gate.check(checkInput(Behaviour.crash), live()).catch(() => "crashed");
    const waiting = h.gate.check(checkInput(), live());
    expect(await crashing).toBe("crashed");
    expect((await waiting).kind).toBe("match");
  });
});

describe("start-up: a load failure or a timeout is reported with its detail", () => {
  test("start() resolves once the worker reports ready", async () => {
    const h = harness();
    await h.gate.start();
    expect(h.spawned()).toBe(1);
  });

  test("a worker that reports a load failure rejects start() with the worker's own message, and is gone", async () => {
    const h = harness({ startups: ["load-failed"] });
    await expect(h.gate.start()).rejects.toThrow("scripted load failure");
    expect(h.alive()).toBe(0);
  });

  test("a worker that never becomes ready rejects start() after loadTimeoutMs, naming the timeout, and is terminated", async () => {
    const h = harness({ startups: ["never-ready"], loadTimeoutMs: 100 });
    const startedAt = performance.now();
    await expect(h.gate.start()).rejects.toThrow(/100 ms/);
    expect(performance.now() - startedAt).toBeLessThan(PROMPTLY_MS);
    expect(h.alive()).toBe(0);
  });

  test("a worker that dies while loading rejects start() rather than hanging", async () => {
    const h = harness({ startups: ["crash"] });
    await expect(h.gate.start()).rejects.toThrow();
  });

  test("start()'s own signal aborting terminates a load in progress", async () => {
    const h = harness({ startups: ["never-ready"], loadTimeoutMs: 30_000 });
    const controller = new AbortController();
    const starting = h.gate.start(controller.signal).catch((e: unknown) => e);
    await Bun.sleep(30);
    controller.abort(new Error("the engine's 25 s bound"));
    expect(((await starting) as Error).message).toBe("the engine's 25 s bound");
    expect(h.alive()).toBe(0);
  });

  test("a lazy respawn whose load fails rejects that check (systemic) and the following check tries again", async () => {
    const h = harness({ startups: ["ok", "load-failed", "ok"] });
    await h.gate.check(checkInput(Behaviour.crash), live()).catch(() => {}); // worker 1 dies
    await expect(h.gate.check(checkInput(), live())).rejects.toThrow("scripted load failure"); // worker 2 fails to load
    expect((await h.gate.check(checkInput(), live())).kind).toBe("match"); // worker 3
    expect(h.spawned()).toBe(3);
  });
});

describe("dispose", () => {
  test("terminates the live worker", async () => {
    const h = harness();
    await h.gate.start();
    await h.gate.dispose();
    expect(h.alive()).toBe(0);
  });

  test("a check after dispose rejects instead of spawning a worker nobody owns", async () => {
    const h = harness();
    await h.gate.dispose();
    await expect(h.gate.check(checkInput(), live())).rejects.toThrow(/disposed/);
    expect(h.spawned()).toBe(0);
  });

  test("dispose while a check hangs terminates it and fails that check", async () => {
    const h = harness();
    const running = h.gate.check(checkInput(Behaviour.hang), live()).catch((e: unknown) => e);
    await Bun.sleep(50);
    await h.gate.dispose();
    expect(await running).toBeInstanceOf(Error);
    expect(h.alive()).toBe(0);
  });
});

/**
 * Settles when `worker` has exited. The harness's own `exit` listener (which counts `alive` down) was registered at spawn, before
 * this one, so `alive()` is already down when this resolves (a worker that is gone already has `threadId` -1). Waiting for the event, not for a fixed time, is what keeps these
 * tests off the clock: a terminate takes a few milliseconds on a quiet machine and far longer on a loaded one (a 150 ms sleep
 * failed on a macOS runner with `alive` still 1). 20 s only names a worker that never went.
 */
async function exited(worker: Worker | undefined): Promise<void> {
  if (worker === undefined) throw new Error("the harness spawned no worker");
  if (worker.threadId === -1) return; // already gone: its `exit` has fired
  let giveUp: ReturnType<typeof setTimeout> | undefined;
  const never = new Promise<never>((_resolve, reject) => {
    giveUp = setTimeout(() => reject(new Error("the worker was not terminated")), 20_000);
  });
  try {
    await Promise.race([new Promise<void>((resolve) => worker.once("exit", () => resolve())), never]);
  } finally {
    clearTimeout(giveUp);
  }
}

describe("idle recycling: an idle worker's memory is given back", () => {
  test("a worker left idle for idleRecycleMs is terminated, by the gate's own recycle and not before that timer fires", async () => {
    // The ORDER is asserted, never an elapsed time: a wall-clock lower bound on a timer fails on a coarse clock (Windows' 15.6 ms
    // granularity can fire a timer early against `performance.now()`; a 45 ms bound failed there, and a 35 ms one before it). The gate's
    // idle timer (the one setTimeout with this test's unique delay) is captured and NOT scheduled; the test then
    //  1. waits well past the idle time and sees the worker still alive: nothing but that timer may recycle it,
    //  2. fires the captured callback itself and sees the gate's own `terminate` called and the worker gone.
    // Spying on `terminate` keeps a worker that died for any other reason from passing as "recycled".
    const IDLE_MS = 47;
    let terminated = 0;
    const armed: { delay: number | null; fire: (() => void) | null } = { delay: null, fire: null };
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const parked: ReturnType<typeof setTimeout>[] = [];
    let clearedParked = false; // the gate cancelled its own idle timer: firing it afterwards would prove nothing
    globalThis.clearTimeout = ((handle?: Parameters<typeof clearTimeout>[0]) => {
      if (handle !== undefined && parked.includes(handle as ReturnType<typeof setTimeout>)) clearedParked = true;
      return realClearTimeout(handle);
    }) as typeof clearTimeout;
    globalThis.setTimeout = Object.assign(
      (...args: Parameters<typeof setTimeout>) => {
        if (args[1] === IDLE_MS && armed.fire === null) {
          armed.delay = args[1];
          const callback = args[0];
          armed.fire = () => void (callback as () => void)();
          const handle = realSetTimeout(() => undefined, 2 ** 30); // a real handle for the gate's unref/clearTimeout; never fires
          parked.push(handle);
          return handle;
        }
        return realSetTimeout(...args);
      },
      realSetTimeout,
    );
    try {
      const h = harness({
        idleRecycleMs: IDLE_MS,
        tamper: (worker) => {
          const real = worker.terminate.bind(worker);
          worker.terminate = () => {
            terminated += 1;
            return real();
          };
        },
      });
      await h.gate.check(checkInput(), live());
      expect(armed.delay).toBe(IDLE_MS);
      await Bun.sleep(IDLE_MS * 4); // far past the idle time, with the gate's timer held back
      expect(h.alive()).toBe(1);
      expect(terminated).toBe(0);
      expect(clearedParked).toBe(false);

      if (armed.fire === null) throw new Error("the gate did not arm its idle timer");
      armed.fire();
      await exited(h.workers[0]);
      expect(h.alive()).toBe(0);
      expect(terminated).toBe(1);
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
      for (const handle of parked) clearTimeout(handle);
    }
  });

  test("the next check after a recycle respawns a worker and succeeds, with no overlap between the two workers", async () => {
    const h = harness({ idleRecycleMs: 40 });
    await h.gate.check(checkInput(), live());
    await exited(h.workers[0]);
    expect((await h.gate.check(checkInput(), live())).kind).toBe("match");
    expect(h.spawned()).toBe(2);
    expect(h.aliveAtSpawn).toEqual([0, 0]);
  });

  test("a check inside the idle window keeps the same worker", async () => {
    const h = harness({ idleRecycleMs: 2_000 });
    await h.gate.check(checkInput(), live());
    await Bun.sleep(50);
    await h.gate.check(checkInput(), live());
    expect(h.spawned()).toBe(1);
  });

  test("the idle timer never fires during a computation, however long it outlasts idleRecycleMs", async () => {
    const h = harness({ idleRecycleMs: 20 });
    await h.gate.start();
    await Bun.sleep(5);
    // ~80 ms of work against a 20 ms idle window: the worker must survive it and answer.
    expect((await h.gate.check(checkInput(Behaviour.slow), live())).kind).toBe("match");
    expect(h.spawned()).toBe(1);
  });

  test("without idleRecycleMs a worker is never recycled", async () => {
    const h = harness();
    await h.gate.check(checkInput(), live());
    await Bun.sleep(150);
    expect(h.alive()).toBe(1);
  });

  test("an unsolicited-message kill takes the lane: a check arriving mid-kill never overlaps the dying worker", async () => {
    // The kill is held for 150 ms inside `terminate`; the check is sent as soon as the gate has CALLED terminate (an event, not a
    // sleep that guessed when the worker's out-of-turn message would land), so it arrives during the kill on any runner.
    let terminateCalled: () => void = () => undefined;
    const killStarted = new Promise<void>((resolve) => {
      terminateCalled = resolve;
    });
    const h = harness({
      tamper: (worker) => {
        const real = worker.terminate.bind(worker);
        worker.terminate = async () => {
          terminateCalled();
          await Bun.sleep(150);
          return real();
        };
      },
    });
    await h.gate.check(checkInput(Behaviour.chatty), live());
    await killStarted; // the worker speaks out of turn ~20 ms after answering; the gate answers by terminating it
    expect((await h.gate.check(checkInput(), live())).kind).toBe("match");
    expect(h.spawned()).toBe(2);
    expect(h.aliveAtSpawn.every((n) => n === 0)).toBe(true);
  });

  test("a check that arrives while a recycle is terminating the worker waits for it to be gone before a new one starts", async () => {
    const h = harness({ idleRecycleMs: 30 });
    await h.gate.check(checkInput(), live());
    await Bun.sleep(30); // land right around the timer
    await h.gate.check(checkInput(), live());
    expect(h.aliveAtSpawn.every((n) => n === 0)).toBe(true);
  });
});

describe("a worker that misbehaves while idle or cannot be deserialized is killed", () => {
  test("an unsolicited message from an idle worker kills it, and the next check respawns", async () => {
    const h = harness();
    await h.gate.check(checkInput(Behaviour.chatty), live());
    await Bun.sleep(120); // the worker speaks out of turn ~20 ms after answering
    expect(h.alive()).toBe(0);
    expect((await h.gate.check(checkInput(), live())).kind).toBe("match");
    expect(h.spawned()).toBe(2);
  });

  test("a messageerror while a check is in flight rejects it at once, kills the worker, and the next check respawns", async () => {
    const h = harness();
    const running = h.gate.check(checkInput(Behaviour.hang), live()).then(
      () => "resolved",
      (error: unknown) => (error instanceof Error ? error.message : "not an error"),
    );
    await Bun.sleep(50);
    h.workers[0]?.emit("messageerror", new Error("could not deserialize"));
    expect(await running).toMatch(/could not be deserialized|messageerror|outside the protocol/);
    expect(h.alive()).toBe(0);
    expect((await h.gate.check(checkInput(), live())).kind).toBe("match");
  });
});

describe("terminate() that does not finish", () => {
  const hangTerminate = (worker: Worker): void => {
    worker.terminate = () => new Promise<number>(() => {});
  };

  test("the kill is bounded: the cancelled check settles within killTimeoutMs and the gate is broken from then on", async () => {
    const h = harness({ killTimeoutMs: 60, tamper: hangTerminate });
    const controller = new AbortController();
    const running = h.gate.check(checkInput(Behaviour.hang), controller.signal).then(
      () => "resolved",
      (error: unknown) => (error instanceof Error ? error.message : "not an error"),
    );
    await Bun.sleep(50);
    const abortedAt = performance.now();
    controller.abort(new Error("cancelled"));
    await running;
    expect(performance.now() - abortedAt).toBeLessThan(PROMPTLY_MS);
    await expect(h.gate.check(checkInput(), live())).rejects.toThrow(/could not be terminated/);
    expect(h.spawned()).toBe(1); // never a second worker next to one that would not die
  });

  test("a check queued behind the stuck kill is rejected as GateBroken material, not left hanging", async () => {
    const h = harness({ killTimeoutMs: 60, tamper: hangTerminate });
    const controller = new AbortController();
    const running = h.gate.check(checkInput(Behaviour.hang), controller.signal).catch(() => {});
    const waiting = h.gate.check(checkInput(), live());
    await Bun.sleep(50);
    controller.abort(new Error("cancelled"));
    await running;
    await expect(waiting).rejects.toThrow(/could not be terminated/);
  });

  test("dispose() awaits a kill already in progress: the worker is gone when it resolves", async () => {
    const h = harness({
      tamper: (worker) => {
        const real = worker.terminate.bind(worker);
        worker.terminate = async () => {
          await Bun.sleep(100);
          return real();
        };
      },
    });
    const controller = new AbortController();
    const running = h.gate.check(checkInput(Behaviour.hang), controller.signal).catch(() => {});
    await Bun.sleep(50);
    controller.abort(new Error("cancelled")); // starts a kill that takes ~100 ms
    await Bun.sleep(10);
    await h.gate.dispose();
    expect(h.alive()).toBe(0);
    await running;
  });
});

describe("isBroken", () => {
  test("is false for a fresh gate and after a healthy check and abort", async () => {
    const h = harness();
    expect(h.gate.isBroken()).toBe(false);
    const controller = new AbortController();
    const running = h.gate.check(checkInput(Behaviour.hang), controller.signal).catch(() => {});
    await Bun.sleep(50);
    controller.abort(new Error("cancelled"));
    await running;
    expect(h.gate.isBroken()).toBe(false);
  });

  test("is true once a terminate() never finishes", async () => {
    const h = harness({ killTimeoutMs: 60, tamper: (worker) => void (worker.terminate = () => new Promise<number>(() => {})) });
    const controller = new AbortController();
    const running = h.gate.check(checkInput(Behaviour.hang), controller.signal).catch(() => {});
    await Bun.sleep(50);
    controller.abort(new Error("cancelled"));
    await running;
    expect(h.gate.isBroken()).toBe(true);
  });

  test("is true once a terminate() rejects", async () => {
    const h = harness({ tamper: (worker) => void (worker.terminate = () => Promise.reject(new Error("terminate refused"))) });
    const controller = new AbortController();
    const running = h.gate.check(checkInput(Behaviour.hang), controller.signal).catch(() => {});
    await Bun.sleep(50);
    controller.abort(new Error("cancelled"));
    await running;
    expect(h.gate.isBroken()).toBe(true);
  });
});

describe("a kill that fails is treated like a kill that times out", () => {
  /** Collects every unhandled rejection for the duration of one test. */
  function watchUnhandled(): { seen: unknown[]; stop: () => void } {
    const seen: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      seen.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    return { seen, stop: () => process.off("unhandledRejection", onUnhandled) };
  }
  const rejectTerminate = (worker: Worker): void => {
    worker.terminate = () => Promise.reject(new Error("terminate refused"));
  };

  test("a terminate() that rejects breaks the gate: no second worker, and no unhandled rejection", async () => {
    const unhandled = watchUnhandled();
    try {
      const h = harness({ tamper: rejectTerminate });
      const controller = new AbortController();
      const running = h.gate.check(checkInput(Behaviour.hang), controller.signal).catch(() => {});
      await Bun.sleep(50);
      controller.abort(new Error("cancelled"));
      await running;
      await expect(h.gate.check(checkInput(), live())).rejects.toThrow(/could not be terminated/);
      expect(h.spawned()).toBe(1); // never a second worker next to one that would not die
      await Bun.sleep(20); // a leaked rejection surfaces on a later tick
      expect(unhandled.seen).toEqual([]);
    } finally {
      unhandled.stop();
    }
  });

  test("a terminate() that rejects on an idle worker's kill breaks the gate without an unhandled rejection", async () => {
    const unhandled = watchUnhandled();
    try {
      const h = harness({ tamper: rejectTerminate });
      await h.gate.check(checkInput(), live());
      h.workers[0]?.emit("messageerror", new Error("could not deserialize")); // idle: killed under the lane
      await Bun.sleep(50);
      await expect(h.gate.check(checkInput(), live())).rejects.toThrow(/could not be terminated/);
      expect(h.spawned()).toBe(1);
      expect(unhandled.seen).toEqual([]);
    } finally {
      unhandled.stop();
    }
  });

  test("dispose() while an idle worker's kill is queued behind another kill leaves no unhandled rejection", async () => {
    const unhandled = watchUnhandled();
    try {
      const h = harness({
        tamper: (worker) => {
          const real = worker.terminate.bind(worker);
          worker.terminate = async () => {
            await Bun.sleep(100);
            return real();
          };
        },
      });
      await h.gate.check(checkInput(), live());
      h.workers[0]?.emit("messageerror", new Error("first")); // takes the lane, terminate takes ~100 ms
      h.workers[0]?.emit("messageerror", new Error("second")); // its lane request queues behind the first
      await Bun.sleep(10);
      await h.gate.dispose(); // rejects the queued lane request
      await Bun.sleep(20);
      expect(unhandled.seen).toEqual([]);
    } finally {
      unhandled.stop();
    }
  });
});
