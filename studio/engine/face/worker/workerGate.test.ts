import { afterEach, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { useNativeGlobals } from "../../../testing/nativeGlobals";
import { NoFaceInReferenceError } from "../gate";
import { Behaviour } from "../testing/behaviour";
import { createWorkerFaceGate, type WorkerFaceGate } from "./workerGate";
useNativeGlobals();

// T7c: the face worker's lifecycle, against a scripted worker
// (testing/scriptedFaceWorker.ts) that speaks the real wire protocol without
// any inference — so termination, respawn, the FIFO lane, crash and
// protocol-violation handling are pinned in milliseconds and without models.
// The real worker (models, decode, event-loop, parity) is pinned by
// workerGate.real.test.ts and parity.test.ts.

const SCRIPT = fileURLToPath(new URL("../testing/scriptedFaceWorker.ts", import.meta.url));
const EMBEDDING = new Float32Array([1, 0, 0]);
/** A generous bound for "promptly": a terminate is milliseconds; CI machines are slow, not seconds-slow. */
const PROMPTLY_MS = 1_000;

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
}

const gates: WorkerFaceGate[] = [];
afterEach(async () => {
  await Promise.all(gates.splice(0).map((g) => g.dispose()));
});

function harness(options: { startups?: Startup[]; loadTimeoutMs?: number } = {}): Harness {
  const probe = new SharedArrayBuffer(8);
  const probeView = new Int32Array(probe);
  const startups = [...(options.startups ?? [])];
  let spawned = 0;
  let alive = 0;
  const aliveAtSpawn: number[] = [];
  const gate = createWorkerFaceGate({
    loadTimeoutMs: options.loadTimeoutMs,
    spawnWorker: () => {
      aliveAtSpawn.push(alive);
      spawned += 1;
      alive += 1;
      const worker = new Worker(SCRIPT, { workerData: { startup: startups.shift() ?? "ok", probe } });
      worker.on("exit", () => {
        alive -= 1;
      });
      return worker;
    },
  });
  gates.push(gate);
  return { gate, spawned: () => spawned, aliveAtSpawn, alive: () => alive, maxInFlight: () => Atomics.load(probeView, 1) };
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
    expect(Array.from(await gate.embed(script(Behaviour.ok), live()))).toEqual([1, 0, 0]);
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
    const holder = h.gate.check(checkInput(Behaviour.slow), live());
    const controller = new AbortController();
    const waiter = h.gate.check(checkInput(), controller.signal);
    const outcome = waiter.then(
      () => "resolved",
      (error: unknown) => (error instanceof Error ? error.message : "not an error"),
    );
    controller.abort(new Error("gave up waiting"));
    expect(await outcome).toBe("gave up waiting");
    expect((await holder).kind).toBe("match");
    expect(h.spawned()).toBe(1);
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
