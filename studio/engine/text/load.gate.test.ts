import { afterEach, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { loadTextRasteriser } from "./load";
import { SELF_TEST_FINGERPRINT } from "./selfTest";
import { createTextGate, type TextGate } from "./worker/textGate";
useNativeGlobals();

// The engine entry creates the gate synchronously, hands it to the Engine, and lets the loader warm it up: the loader must
// use THAT gate, so the Engine and the loader talk to one worker and the Engine has its gate even when the load is slow.

const SCRIPT = fileURLToPath(new URL("./testing/scriptedTextWorker.ts", import.meta.url));

const gates: TextGate[] = [];
const running = new Set<Worker>();
afterEach(async () => {
  await Promise.all(gates.splice(0).map((g) => g.dispose()));
  await Promise.all([...running].map((w) => Worker.prototype.terminate.call(w)));
  running.clear();
});

function spawner(): () => Worker {
  return () => {
    const worker = new Worker(SCRIPT, { workerData: { startup: "ok", probe: new SharedArrayBuffer(8) } });
    running.add(worker);
    worker.on("exit", () => running.delete(worker));
    return worker;
  };
}

const quiet = { info: () => {}, error: () => {} };
const passing = (): Promise<string> => Promise.resolve(SELF_TEST_FINGERPRINT);

describe("loadTextRasteriser with a gate the caller made", () => {
  test("loads through that very gate and returns it", async () => {
    const mine = createTextGate({ spawnWorker: spawner() });
    gates.push(mine);
    const result = await loadTextRasteriser({ gate: mine, log: quiet, selfTest: passing });
    expect(result.gate).toBe(mine);
    expect("fingerprint" in result).toBe(true);
  });

  test("returns the same gate after a failed load, so the engine's gate is still the one that retries", async () => {
    const mine = createTextGate({
      spawnWorker: () => {
        const worker = new Worker(SCRIPT, { workerData: { startup: "load-failed", probe: new SharedArrayBuffer(8) } });
        running.add(worker);
        worker.on("exit", () => running.delete(worker));
        return worker;
      },
    });
    gates.push(mine);
    const result = await loadTextRasteriser({ gate: mine, log: quiet, selfTest: passing });
    expect(result.gate).toBe(mine);
    expect("error" in result).toBe(true);
  });

  test("still builds its own gate from spawnWorker when it is given none", async () => {
    const result = await loadTextRasteriser({ spawnWorker: spawner(), log: quiet, selfTest: passing });
    gates.push(result.gate);
    expect("fingerprint" in result).toBe(true);
  });

  test("refuses a config with neither a gate nor a way to spawn a worker", async () => {
    await expect(loadTextRasteriser({ log: quiet })).rejects.toThrow(TypeError);
  });
});
