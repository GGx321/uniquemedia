import { afterEach, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { useNativeGlobals } from "../../../testing/nativeGlobals";
import type { CaptionRequest } from "../caption/types";
import { RasterError } from "../rasterTypes";
import { createTextGate, type TextGate } from "./textGate";
useNativeGlobals();

// The gate's `caption` call against the scripted worker (testing/scriptedTextWorker.ts): the same lane, deadline and
// restart rules as `render`, plus what is new: the layout that comes back, a caption rule that rides on the error, the
// `onStart` hook the preview's cancelling depends on, and a request refused before it reaches a worker that would die on it.

const SCRIPT = fileURLToPath(new URL("../testing/scriptedTextWorker.ts", import.meta.url));

const gates: TextGate[] = [];
const running = new Set<Worker>();
afterEach(async () => {
  await Promise.all(gates.splice(0).map((g) => g.dispose()));
  await Promise.all([...running].map((w) => Worker.prototype.terminate.call(w)));
  running.clear();
});

function harness(options: { renderTimeoutMs?: number } = {}) {
  const probe = new SharedArrayBuffer(8);
  let spawned = 0;
  const gate = createTextGate({
    renderTimeoutMs: options.renderTimeoutMs,
    spawnWorker: () => {
      spawned += 1;
      const worker = new Worker(SCRIPT, { workerData: { startup: "ok", probe } });
      running.add(worker);
      worker.on("exit", () => running.delete(worker));
      return worker;
    },
  });
  gates.push(gate);
  return { gate, spawned: () => spawned };
}

const layer = (value: string, over: Partial<CaptionRequest> = {}): CaptionRequest => ({ value, font: "manrope", style: "plaque", color: "#ffffff", scale: 1, ...over });
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (e: unknown) => e,
  );
}

async function until(what: string, probe: () => boolean, ms = 1_000): Promise<void> {
  const started = performance.now();
  while (!probe()) {
    if (performance.now() - started > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

describe("a caption call", () => {
  test("answers with the picture, its size and its resolved layout, and the time the worker spent", async () => {
    const h = harness();
    const image = await h.gate.caption(layer("sunday reset"));
    expect(image.width).toBe(10);
    expect(image.height).toBe(5);
    expect(image.png.byteLength).toBe(1); // request id 0
    expect(image.layout).toEqual({ fontSize: 56, lines: ["sunday reset"], width: 10, height: 5 });
    expect(image.workerMs).toBeGreaterThan(0);
  });

  test("shares the worker and the id sequence with render and measure", async () => {
    const h = harness();
    await h.gate.render({ svg: "a", font: "manrope" });
    const image = await h.gate.caption(layer("b"));
    expect(image.png.byteLength).toBe(2); // request id 1
    expect(h.spawned()).toBe(1);
  });

  test("runs one at a time in the order asked, with render calls", async () => {
    const h = harness();
    const order: string[] = [];
    await Promise.all([
      h.gate.caption(layer("slow:60")).then(() => order.push("first")),
      h.gate.render({ svg: "x", font: "manrope" }).then(() => order.push("second")),
      h.gate.caption(layer("z")).then(() => order.push("third")),
    ]);
    expect(order).toEqual(["first", "second", "third"]);
  });
});

describe("a caption rule the worker names", () => {
  test("rejects with CAPTION_INVALID and the rule, and keeps the worker", async () => {
    const h = harness();
    const error = await failure(h.gate.caption(layer("invalid")));
    expect(error).toBeInstanceOf(RasterError);
    expect((error as RasterError).code).toBe("CAPTION_INVALID");
    expect((error as RasterError).captionIssue).toBe("charset");
    await h.gate.caption(layer("fine"));
    expect(h.spawned()).toBe(1);
  });

  test("any other failure carries no rule", async () => {
    const h = harness();
    const error = await failure(h.gate.caption(layer("fail")));
    expect((error as RasterError).code).toBe("RENDER_FAILED");
    expect((error as RasterError).captionIssue).toBeUndefined();
  });

  test("a fatal failure replaces the worker before the next call", async () => {
    const h = harness();
    await failure(h.gate.caption(layer("fatal")));
    await h.gate.caption(layer("fine"));
    expect(h.spawned()).toBe(2);
  });
});

describe("the deadline", () => {
  test("a caption that overruns it is RENDER_TIMEOUT and the worker is terminated", async () => {
    const h = harness({ renderTimeoutMs: 150 });
    const error = await failure(h.gate.caption(layer("hang")));
    expect((error as RasterError).code).toBe("RENDER_TIMEOUT");
    await h.gate.caption(layer("fine"));
    expect(h.spawned()).toBe(2);
  });
});

describe("cancelling and onStart", () => {
  test("onStart runs once, when the call has the lane, before it is answered", async () => {
    const h = harness();
    const events: string[] = [];
    await h.gate.caption(layer("slow:40"), { onStart: () => events.push("start") }).then(() => events.push("answer"));
    expect(events).toEqual(["start", "answer"]);
  });

  test("a call queued behind another starts only when the first is done", async () => {
    const h = harness();
    const events: string[] = [];
    const first = h.gate.caption(layer("slow:80"), { onStart: () => events.push("first starts") }).then(() => events.push("first answers"));
    const second = h.gate.caption(layer("b"), { onStart: () => events.push("second starts") }).then(() => events.push("second answers"));
    await Promise.all([first, second]);
    const at = (event: string): number => events.indexOf(event);
    expect(events).toHaveLength(4);
    expect(at("first starts")).toBe(0);
    expect(at("second starts")).toBeGreaterThan(at("first starts"));
    expect(at("second answers")).toBeGreaterThan(at("second starts"));
    expect(at("second answers")).toBeGreaterThan(at("first answers"));
  });

  test("a call aborted while it is queued leaves the queue, never starts, and does not disturb the running one", async () => {
    const h = harness();
    const controller = new AbortController();
    let started = 0;
    const running1 = h.gate.caption(layer("slow:120"), { onStart: () => (started += 1) });
    await until("the first call to be running", () => started === 1);
    const queued = h.gate.caption(layer("queued"), { signal: controller.signal, onStart: () => (started += 100) });
    const outcome = failure(queued);
    controller.abort(new Error("stale"));
    expect(((await outcome) as Error).message).toBe("stale");
    const finished = await running1;
    expect(finished.layout.lines).toEqual(["slow:120"]);
    expect(started).toBe(1);
    expect(h.spawned()).toBe(1);
  });

  test("aborting a call that is already running terminates the worker: only a queued call may be cancelled for free", async () => {
    const h = harness();
    const controller = new AbortController();
    let started = false;
    const call = h.gate.caption(layer("hang"), { signal: controller.signal, onStart: () => (started = true) });
    const outcome = failure(call);
    await until("the call to start", () => started);
    controller.abort(new Error("gone"));
    expect(((await outcome) as Error).message).toBe("gone");
    await h.gate.caption(layer("fine"));
    expect(h.spawned()).toBe(2);
  });

  test("an already aborted signal rejects without spawning or starting anything", async () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort(new Error("already"));
    let started = false;
    const error = await failure(h.gate.caption(layer("x"), { signal: controller.signal, onStart: () => (started = true) }));
    expect((error as Error).message).toBe("already");
    expect(started).toBe(false);
    expect(h.spawned()).toBe(0);
  });

  test("an onStart that throws does not leave the lane held", async () => {
    const h = harness();
    const first = await failure(
      h.gate.caption(layer("a"), {
        onStart: () => {
          throw new Error("hook broke");
        },
      }),
    );
    expect(first).toBeInstanceOf(Error);
    await h.gate.caption(layer("b"));
  });
});

describe("a request the worker would refuse", () => {
  test.each([
    ["a colour that is not lowercase #rrggbb", { color: "#FFFFFF" }],
    ["markup in a colour", { color: '#ffffff" onload="x' }],
    ["a scale over 2", { scale: 2.5 }],
    ["a scale of NaN", { scale: Number.NaN }],
    ["an unknown style", { style: "neon" as never }],
    ["an unknown font", { font: "comic" as never }],
  ])("%s is RENDER_FAILED before anything is sent, so the worker neither dies nor is spawned", async (_name, over) => {
    const h = harness();
    const error = await failure(h.gate.caption(layer("x", over)));
    expect(error).toBeInstanceOf(RasterError);
    expect((error as RasterError).code).toBe("RENDER_FAILED");
    expect(h.spawned()).toBe(0);
  });
});

describe("a worker that misbehaves", () => {
  test("an answer outside the protocol is WORKER_FAILED and the worker is replaced", async () => {
    const h = harness();
    const error = await failure(h.gate.caption(layer("garbage")));
    expect((error as RasterError).code).toBe("WORKER_FAILED");
    await h.gate.caption(layer("fine"));
    expect(h.spawned()).toBe(2);
  });

  test("dying mid-call is WORKER_FAILED and the next call respawns", async () => {
    const h = harness();
    const error = await failure(h.gate.caption(layer("crash")));
    expect((error as RasterError).code).toBe("WORKER_FAILED");
    await h.gate.caption(layer("fine"));
    expect(h.spawned()).toBe(2);
  });
});
