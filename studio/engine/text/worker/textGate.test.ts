import { afterEach, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { useNativeGlobals } from "../../../testing/nativeGlobals";
import { RasterError, type RasterErrorCode } from "../rasterTypes";
import { createTextGate, type TextGate } from "./textGate";
useNativeGlobals();

// The text worker's lifecycle against a scripted worker (testing/scriptedTextWorker.ts) that speaks the real wire
// protocol with no resvg: the deadline, terminate and respawn, the FIFO lane, crashes and protocol violations are
// pinned in milliseconds. The real worker is pinned by textGate.real.node-test.ts.

const SCRIPT = fileURLToPath(new URL("../testing/scriptedTextWorker.ts", import.meta.url));
/** A terminate is milliseconds; CI machines are slow, not seconds-slow. */
const PROMPTLY_MS = 1_000;

type Startup = "ok" | "load-failed" | "never-ready" | "crash";

interface Harness {
  gate: TextGate;
  readonly spawned: () => number;
  /** How many workers were still alive when each spawn happened (every entry must be 0: no zombie overlap). */
  readonly aliveAtSpawn: readonly number[];
  readonly alive: () => number;
  readonly maxInFlight: () => number;
  readonly workers: readonly Worker[];
}

const gates: TextGate[] = [];
const running = new Set<Worker>();
afterEach(async () => {
  await Promise.all(gates.splice(0).map((g) => g.dispose()));
  await Promise.all([...running].map((w) => Worker.prototype.terminate.call(w)));
  running.clear();
});

function harness(options: { startups?: Startup[]; loadTimeoutMs?: number; renderTimeoutMs?: number; idleRecycleMs?: number; killTimeoutMs?: number; tamper?: (worker: Worker) => void } = {}): Harness {
  const probe = new SharedArrayBuffer(8);
  const view = new Int32Array(probe);
  const startups = [...(options.startups ?? [])];
  let spawned = 0;
  let alive = 0;
  const aliveAtSpawn: number[] = [];
  const workers: Worker[] = [];
  const gate = createTextGate({
    loadTimeoutMs: options.loadTimeoutMs,
    renderTimeoutMs: options.renderTimeoutMs,
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
  return { gate, spawned: () => spawned, aliveAtSpawn, alive: () => alive, maxInFlight: () => Atomics.load(view, 1), workers };
}

const live = (): AbortSignal => new AbortController().signal;
const req = (svg: string) => ({ svg, font: "manrope" as const });

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (e: unknown) => e,
  );
}

async function codeOf(promise: Promise<unknown>): Promise<RasterErrorCode | "not a RasterError"> {
  const error = await failure(promise);
  return error instanceof RasterError ? error.code : "not a RasterError";
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until(what: string, probe: () => boolean, ms = PROMPTLY_MS): Promise<void> {
  const started = performance.now();
  while (!probe()) {
    if (performance.now() - started > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

describe("a healthy worker", () => {
  test("starts on the first call, answers, and is reused", async () => {
    const h = harness();
    const first = await h.gate.render(req("a"));
    const second = await h.gate.render(req("b"));
    expect(first.width).toBe(10);
    expect(first.height).toBe(5);
    expect(first.png.byteLength).toBe(1); // request id 0
    expect(second.png.byteLength).toBe(2); // request id 1
    expect(h.spawned()).toBe(1);
  });

  test("start() spawns the worker and waits for ready; a second start is a no-op", async () => {
    const h = harness();
    await h.gate.start();
    await h.gate.start();
    expect(h.spawned()).toBe(1);
  });

  test("measure answers with the worker's box", async () => {
    const h = harness();
    expect(await h.gate.measure(req("x"))).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });

  test("reports the time the worker spent, apart from the round trip", async () => {
    const h = harness();
    const image = await h.gate.render(req("x"));
    expect(image.workerMs).toBeCloseTo(0.1, 5);
  });

  test("runs concurrent calls one at a time, in the order they were asked", async () => {
    const h = harness();
    const results = await Promise.all([h.gate.render(req("slow:30")), h.gate.render(req("slow:10")), h.gate.render(req("slow:1"))]);
    expect(results.map((r) => r.png.byteLength)).toEqual([1, 2, 3]);
    expect(h.maxInFlight()).toBe(1);
  });
});

describe("the deadline", () => {
  test("terminates a call that overruns it, rejects with RENDER_TIMEOUT and leaves no worker running", async () => {
    const h = harness({ renderTimeoutMs: 100 });
    const started = performance.now();
    expect(await codeOf(h.gate.render(req("hang")))).toBe("RENDER_TIMEOUT");
    expect(performance.now() - started).toBeLessThan(PROMPTLY_MS);
    await until("the worker to exit", () => h.alive() === 0);
  });

  test("the next call gets a fresh worker and works, with no overlap", async () => {
    const h = harness({ renderTimeoutMs: 100 });
    await codeOf(h.gate.render(req("hang")));
    expect((await h.gate.render(req("ok"))).width).toBe(10);
    expect(h.spawned()).toBe(2);
    expect(h.aliveAtSpawn.every((n) => n === 0)).toBe(true);
  });

  test("does not count the time a call waits behind another", async () => {
    const h = harness({ renderTimeoutMs: 150 });
    const results = await Promise.all([h.gate.render(req("slow:100")), h.gate.render(req("slow:100"))]);
    expect(results).toHaveLength(2);
    expect(h.spawned()).toBe(1);
  });

  test("does not count the time the worker takes to start", async () => {
    const h = harness({ renderTimeoutMs: 100 });
    // a cold worker takes tens of ms to start; the deadline only starts once the call is on it
    expect((await h.gate.render(req("slow:20"))).width).toBe(10);
  });
});

describe("an SVG over the byte cap", () => {
  const LIMIT = 512 * 1024;

  test("is refused with SVG_TOO_LARGE before anything is sent, and the worker is neither spawned nor killed", async () => {
    const h = harness();
    expect(await codeOf(h.gate.render(req("x".repeat(600 * 1024))))).toBe("SVG_TOO_LARGE");
    expect(await codeOf(h.gate.measure(req("x".repeat(600 * 1024))))).toBe("SVG_TOO_LARGE");
    expect(h.spawned()).toBe(0);
  });

  test("leaves a live worker alone", async () => {
    const h = harness();
    await h.gate.render(req("ok"));
    expect(await codeOf(h.gate.render(req("x".repeat(LIMIT + 1))))).toBe("SVG_TOO_LARGE");
    expect((await h.gate.render(req("ok"))).width).toBe(10);
    expect(h.spawned()).toBe(1);
  });

  test("counts UTF-8 bytes, not characters: 300 000 two-byte letters are over the cap", async () => {
    const h = harness();
    expect(await codeOf(h.gate.render(req("Ё".repeat(300_000))))).toBe("SVG_TOO_LARGE");
  });

  test("admits an SVG of exactly the cap and refuses one byte more", async () => {
    const h = harness();
    expect((await h.gate.render(req("x".repeat(LIMIT)))).width).toBe(10);
    expect(await codeOf(h.gate.render(req("x".repeat(LIMIT + 1))))).toBe("SVG_TOO_LARGE");
  });
});

describe("cancellation", () => {
  test("aborting a running call terminates the worker and rejects with the reason", async () => {
    const h = harness();
    const controller = new AbortController();
    const call = h.gate.render(req("hang"), controller.signal);
    await until("the worker to start", () => h.spawned() === 1);
    await sleep(30);
    controller.abort(new Error("cancelled by the owner"));
    const error = await failure(call);
    expect(error instanceof Error && error.message).toBe("cancelled by the owner");
    await until("the worker to exit", () => h.alive() === 0);
    expect((await h.gate.render(req("ok"))).width).toBe(10);
    expect(h.aliveAtSpawn.every((n) => n === 0)).toBe(true);
  });

  test("a call aborted while queued leaves the queue and does not disturb the one running", async () => {
    const h = harness();
    const running1 = h.gate.render(req("slow:80"));
    const controller = new AbortController();
    const queued = h.gate.render(req("queued"), controller.signal);
    const third = h.gate.render(req("third"));
    controller.abort(new Error("no longer needed"));
    expect(await failure(queued)).toBeInstanceOf(Error);
    expect((await running1).png.byteLength).toBe(1);
    expect((await third).width).toBe(10);
    expect(h.spawned()).toBe(1);
  });

  test("an already aborted signal rejects without spawning anything", async () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort(new Error("already"));
    expect(await failure(h.gate.render(req("x"), controller.signal))).toBeInstanceOf(Error);
    expect(h.spawned()).toBe(0);
  });
});

describe("failures the worker reports", () => {
  test("a clean failure rejects with its code and keeps the worker", async () => {
    const h = harness();
    expect(await codeOf(h.gate.render(req("fail")))).toBe("RENDER_FAILED");
    await h.gate.render(req("ok"));
    expect(h.spawned()).toBe(1);
  });

  test("a fatal failure rejects and replaces the worker before the next call", async () => {
    const h = harness();
    expect(await codeOf(h.gate.render(req("fatal")))).toBe("RENDER_FAILED");
    await until("the broken worker to exit", () => h.alive() === 0);
    expect((await h.gate.render(req("ok"))).width).toBe(10);
    expect(h.spawned()).toBe(2);
    expect(h.aliveAtSpawn.every((n) => n === 0)).toBe(true);
  });
});

describe("a worker that misbehaves", () => {
  test("dying mid-call rejects with WORKER_FAILED and the next call respawns", async () => {
    const h = harness();
    expect(await codeOf(h.gate.render(req("crash")))).toBe("WORKER_FAILED");
    expect((await h.gate.render(req("ok"))).width).toBe(10);
    expect(h.spawned()).toBe(2);
  });

  test("an answer outside the protocol rejects with WORKER_FAILED and kills the worker", async () => {
    const h = harness();
    expect(await codeOf(h.gate.render(req("garbage")))).toBe("WORKER_FAILED");
    await until("the worker to exit", () => h.alive() === 0);
  });

  test("a worker that reports load-failed rejects with its message, and a retry can succeed", async () => {
    const h = harness({ startups: ["load-failed", "ok"] });
    const error = await failure(h.gate.start());
    expect(error).toBeInstanceOf(RasterError);
    expect(error instanceof RasterError && error.code).toBe("WORKER_FAILED");
    expect(error instanceof Error && error.message).toContain("no wasm here");
    await until("the failed worker to exit", () => h.alive() === 0);
    await h.gate.start();
    expect(h.spawned()).toBe(2);
  });

  test("a worker that never becomes ready is given up on and killed", async () => {
    const h = harness({ startups: ["never-ready"], loadTimeoutMs: 100 });
    const error = await failure(h.gate.start());
    expect(error instanceof RasterError && error.code).toBe("WORKER_FAILED");
    expect(error instanceof Error && error.message).toContain("100 ms");
    await until("the worker to exit", () => h.alive() === 0);
  });

  test("a worker that dies while starting rejects with WORKER_FAILED", async () => {
    const h = harness({ startups: ["crash"] });
    expect(await codeOf(h.gate.start())).toBe("WORKER_FAILED");
  });

  test("a worker that cannot be terminated makes the gate broken, and every later call says so", async () => {
    const h = harness({
      killTimeoutMs: 50,
      renderTimeoutMs: 50,
      tamper: (worker) => {
        worker.terminate = () => new Promise<number>(() => {});
      },
    });
    expect(await codeOf(h.gate.render(req("hang")))).toBe("RENDER_TIMEOUT");
    expect(h.gate.isBroken()).toBe(true);
    expect(await codeOf(h.gate.render(req("ok")))).toBe("WORKER_FAILED");
    expect(h.spawned()).toBe(1);
  });
});

describe("recycling and disposal", () => {
  test("terminates an idle worker to give the wasm memory back, and starts a new one on demand", async () => {
    const h = harness({ idleRecycleMs: 60 });
    await h.gate.render(req("a"));
    await until("the idle worker to be recycled", () => h.alive() === 0);
    expect((await h.gate.render(req("b"))).width).toBe(10);
    expect(h.spawned()).toBe(2);
  });

  test("does not recycle a worker that is busy", async () => {
    const h = harness({ idleRecycleMs: 40 });
    const results = await Promise.all([h.gate.render(req("slow:120")), h.gate.render(req("slow:120"))]);
    expect(results).toHaveLength(2);
    expect(h.spawned()).toBe(1);
  });

  test("dispose ends the worker, fails a call in flight and refuses every later call", async () => {
    const h = harness();
    const inFlight = h.gate.render(req("hang"));
    await until("the worker to start", () => h.spawned() === 1);
    await sleep(30);
    await h.gate.dispose();
    expect(await failure(inFlight)).toBeInstanceOf(Error);
    expect(h.alive()).toBe(0);
    expect(await failure(h.gate.render(req("x")))).toBeInstanceOf(Error);
    expect(h.spawned()).toBe(1);
  });

  test("dispose with nothing running is harmless, and idempotent", async () => {
    const h = harness();
    await h.gate.dispose();
    await h.gate.dispose();
    expect(h.spawned()).toBe(0);
  });
});
