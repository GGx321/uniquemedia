import { createHash } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { useNativeGlobals } from "../../../testing/nativeGlobals";
import { RASTER_WASM, RasterError } from "../rasterTypes";
import { loadTextRasteriser } from "../load";
import { SELF_TEST_FINGERPRINT, SELF_TEST_HASHES, selfTestSvg } from "../selfTest";
import { createTextWorkerSpawner } from "./spawn";
import { createTextGate, type TextGate } from "./textGate";
useNativeGlobals();

// The real worker thread, with resvg, the fonts and the wire protocol: what the scripted tests cannot show. The
// packaged smoke proves the same thing inside a real utilityProcess under the fuses.

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const WORKER = new URL("./textWorker.ts", import.meta.url);
const INIT = { wasmPath: join(ROOT, "node_modules", "@resvg", "resvg-wasm", RASTER_WASM.file), fontDir: join(ROOT, "studio", "assets", "fonts") };

const gates: TextGate[] = [];
afterEach(async () => {
  await Promise.all(gates.splice(0).map((g) => g.dispose()));
});

function gate(over: { renderTimeoutMs?: number } = {}): { gate: TextGate; spawned: () => number } {
  const spawn = createTextWorkerSpawner(WORKER, INIT);
  let spawned = 0;
  const g = createTextGate({ spawnWorker: () => ((spawned += 1), spawn()), renderTimeoutMs: over.renderTimeoutMs });
  gates.push(g);
  return { gate: g, spawned: () => spawned };
}

const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex").slice(0, 16);
const svgOf = (text: string): string => `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="64"><text x="8" y="44" font-family="Manrope" font-weight="800" font-size="36" fill="#fff">${text}</text></svg>`;

/** The review's probe: N blurred rects on a 1080x600 canvas, which costs seconds inside resvg. */
function blurred(n: number): string {
  const rects = Array.from({ length: n }, (_, i) => `<rect x="${20 + i * 30}" y="40" width="400" height="400" fill="#f00" filter="url(#b)"/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="600"><defs><filter id="b" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="14"/></filter></defs>${rects}</svg>`;
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (e: unknown) => e,
  );
}

// These tests terminate a real worker running wasm, which makes Bun itself segfault in ~2% of runs (a Bun bug; see
// studio/scripts/realWorkerTests.ts). So they run only when that script sets the flag, alone in their own CI step
// with a retry for that crash and nothing else, and are skipped in the main `bun test ./studio` run.
const RUN_REAL_WORKER_TESTS = process.env.STUDIO_REAL_WORKER_TESTS === "1";

describe.skipIf(!RUN_REAL_WORKER_TESTS)("the real worker", () => {
  test("draws the Cyrillic self-test string to the very bytes the in-process rasteriser draws", async () => {
    const { gate: g } = gate();
    const image = await g.render({ svg: selfTestSvg("manrope"), font: "manrope" });
    expect(sha(image.png)).toBe(SELF_TEST_HASHES.manrope);
    expect(image.width).toBe(800);
    expect(image.height).toBe(96);
  });

  test("measures with resvg's own getBBox", async () => {
    const { gate: g } = gate();
    const box = await g.measure({ svg: svgOf("Привет"), font: "manrope" });
    expect(box?.width).toBeGreaterThan(50);
  });

  test("rejects a control character with RENDER_FAILED and keeps the same worker", async () => {
    const { gate: g, spawned } = gate();
    const error = await failure(g.render({ svg: svgOf("a\u0001b"), font: "manrope" }));
    expect(error instanceof RasterError && error.code).toBe("RENDER_FAILED");
    expect((await g.render({ svg: svgOf("fine"), font: "manrope" })).width).toBe(240);
    expect(spawned()).toBe(1);
  });

  test("rejects a frame-sized canvas with RASTER_TOO_LARGE, before resvg paints it", async () => {
    const { gate: g } = gate();
    const error = await failure(g.render({ svg: '<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920"/>', font: "manrope" }));
    expect(error instanceof RasterError && error.code).toBe("RASTER_TOO_LARGE");
  });

  test("cuts a render that overruns the deadline, in a fraction of its cost, and the next call works on a fresh worker", async () => {
    const { gate: g, spawned } = gate({ renderTimeoutMs: 200 });
    await g.render({ svg: svgOf("warm"), font: "manrope" });
    const started = performance.now();
    const error = await failure(g.render({ svg: blurred(24), font: "manrope" }));
    const cut = performance.now() - started;
    expect(error instanceof RasterError && error.code).toBe("RENDER_TIMEOUT");
    expect(cut).toBeLessThan(1500);
    expect((await g.render({ svg: svgOf("after"), font: "manrope" })).width).toBe(240);
    expect(spawned()).toBe(2);
  });

  test("keeps this thread responsive while a heavy render runs", async () => {
    const { gate: g } = gate({ renderTimeoutMs: 20_000 });
    await g.render({ svg: svgOf("warm"), font: "manrope" });
    let last = performance.now();
    let worstGap = 0;
    const timer = setInterval(() => {
      const now = performance.now();
      worstGap = Math.max(worstGap, now - last);
      last = now;
    }, 5);
    const started = performance.now();
    await g.render({ svg: blurred(4), font: "manrope" });
    const took = performance.now() - started;
    clearInterval(timer);
    // The render itself blocks a worker for hundreds of ms; this thread's own timer must not notice.
    expect(took).toBeGreaterThan(100);
    expect(worstGap).toBeLessThan(Math.max(100, took / 3));
  });

  test("the loader starts it, and the self-test through the worker gives the pinned fingerprint", async () => {
    const infos: string[] = [];
    const loaded = await loadTextRasteriser({ spawnWorker: createTextWorkerSpawner(WORKER, INIT), log: { info: (m) => infos.push(m), error: () => {} } });
    gates.push(loaded.gate);
    expect("fingerprint" in loaded && loaded.fingerprint).toBe(SELF_TEST_FINGERPRINT);
    console.log(infos.join("\n"));
  });
});
