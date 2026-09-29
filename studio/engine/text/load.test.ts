import { afterEach, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { TEXT_RASTERISER_LOAD_FAILURE, loadTextRasteriser, TEXT_RASTERISER_READY_PREFIX, type TextRuntimeLoad, type TextRuntimeLog } from "./load";
import { SELF_TEST_FINGERPRINT } from "./selfTest";
import type { TextGate } from "./worker/textGate";
useNativeGlobals();

// The loader's own logic against the scripted worker (testing/scriptedTextWorker.ts): the real thread, with resvg,
// is loaded through it by worker/textGate.real.test.ts, which runs apart from this suite (a Bun crash on terminating
// a worker that runs wasm).

const SCRIPT = fileURLToPath(new URL("./testing/scriptedTextWorker.ts", import.meta.url));

const gates: TextGate[] = [];
const running = new Set<Worker>();
afterEach(async () => {
  await Promise.all(gates.splice(0).map((g) => g.dispose()));
  await Promise.all([...running].map((w) => Worker.prototype.terminate.call(w)));
  running.clear();
});

function spawner(startups: string[]): () => Worker {
  const remaining = [...startups];
  return () => {
    const worker = new Worker(SCRIPT, { workerData: { startup: remaining.shift() ?? "ok", probe: new SharedArrayBuffer(8) } });
    running.add(worker);
    worker.on("exit", () => running.delete(worker));
    return worker;
  };
}

function recordingLog(): TextRuntimeLog & { infos: string[]; errors: string[] } {
  const infos: string[] = [];
  const errors: string[] = [];
  return { infos, errors, info: (m) => infos.push(m), error: (m) => errors.push(m) };
}

const passingSelfTest = (): Promise<string> => Promise.resolve(SELF_TEST_FINGERPRINT);

async function load(startups: string[], over: Partial<Parameters<typeof loadTextRasteriser>[0]> = {}): Promise<{ result: TextRuntimeLoad; log: ReturnType<typeof recordingLog> }> {
  const log = recordingLog();
  const result = await loadTextRasteriser({ spawnWorker: spawner(startups), log, selfTest: passingSelfTest, ...over });
  gates.push(result.gate);
  return { result, log };
}

describe("loadTextRasteriser", () => {
  test("starts the worker, runs the self-test through it and reports the fingerprint", async () => {
    const { result, log } = await load(["ok"]);
    expect("error" in result).toBe(false);
    expect("fingerprint" in result && result.fingerprint).toBe(SELF_TEST_FINGERPRINT);
    expect(log.infos[0]).toBe(`${TEXT_RASTERISER_READY_PREFIX}${SELF_TEST_FINGERPRINT}`);
    expect(log.errors).toEqual([]);
  });

  test("hands the self-test the gate itself, so the check crosses the worker", async () => {
    let seen: unknown = null;
    const { result } = await load(["ok"], {
      selfTest: (gate) => {
        seen = gate;
        return passingSelfTest();
      },
    });
    expect(seen).toBe(result.gate);
  });

  test("logs one timing line: the worker's start-up and a render's round trip against the worker's own time", async () => {
    const { result, log } = await load(["ok"]);
    expect("timings" in result && result.timings.startMs).toBeGreaterThan(0);
    expect("timings" in result && result.timings.roundTripMs).toBeGreaterThan(0);
    const line = log.infos.find((l) => l.includes("timing"));
    expect(line).toMatch(/started in \d+(\.\d+)? ms.*round trip \d+(\.\d+)? ms.*worker \d+(\.\d+)? ms/);
  });

  test("never throws: a worker that cannot load is an error result, one logged line, and no ready line", async () => {
    const { result, log } = await load(["load-failed"]);
    expect("error" in result && result.error).toContain("no wasm here");
    expect(log.errors).toHaveLength(1);
    expect(log.errors[0]).toContain(TEXT_RASTERISER_LOAD_FAILURE);
    expect(log.infos.some((l) => l.startsWith(TEXT_RASTERISER_READY_PREFIX))).toBe(false);
  });

  test("keeps the gate on failure, so a later call can retry instead of the feature being gone for good", async () => {
    const { result } = await load(["load-failed", "ok"]);
    expect("error" in result).toBe(true);
    expect((await result.gate.render({ svg: "again", font: "manrope" })).width).toBe(10);
  });

  test("reports a self-test that draws something else as an error result, with no ready line", async () => {
    const { result, log } = await load(["ok"], { selfTest: () => Promise.reject(new Error("text self-test: oswald did not match")) });
    expect("error" in result && result.error).toContain("oswald");
    expect(log.errors).toHaveLength(1);
    expect(log.infos.some((l) => l.startsWith(TEXT_RASTERISER_READY_PREFIX))).toBe(false);
  });

  test("gives up on a worker that never becomes ready, so the engine can start without it", async () => {
    const started = performance.now();
    const { result } = await load(["never-ready"], { timeoutMs: 80 });
    expect("error" in result && result.error).toContain("80 ms");
    expect(performance.now() - started).toBeLessThan(2000);
  });

  test("gives up on a self-test that hangs", async () => {
    const { result } = await load(["ok"], { timeoutMs: 80, selfTest: () => new Promise(() => {}) });
    expect("error" in result && result.error).toContain("80 ms");
  });
});
