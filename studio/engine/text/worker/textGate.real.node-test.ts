import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, describe, test } from "node:test";
import { join } from "node:path";
import { loadTextRasteriser } from "../load";
import { RASTER_WASM, RasterError, TEXT_RENDER_DEADLINE_MS } from "../rasterTypes";
import { SELF_TEST_FINGERPRINT, SELF_TEST_HASHES, selfTestSvg } from "../selfTest";
import { createTextWorkerSpawner } from "./spawn";
import { createTextGate, type TextGate } from "./textGate";

// The REAL text worker thread, with resvg, the fonts and the wire protocol, run under ELECTRON'S NODE: the
// product's own runtime (the engine is an Electron utilityProcess). Not under Bun, on purpose: in Bun
// `worker.terminate()` does not interrupt running wasm, so a deadline test there measures Bun, and terminating a
// worker that runs wasm crashes Bun in ~2% of runs. This file is bundled by studio/scripts/electronNodeTests.ts
// (`bun build --target=node`) and run as `ELECTRON_RUN_AS_NODE=1 <electron> --test <bundle>`, with the built worker
// next to it; the runner sets STUDIO_ROOT. It is named `.node-test.ts` so `bun test` never loads it.

const root = process.env.STUDIO_ROOT;
if (root === undefined || root === "") throw new Error("STUDIO_ROOT is not set: run this through studio/scripts/electronNodeTests.ts");
const WORKER = new URL("./textWorker.js", import.meta.url);
const INIT = { wasmPath: join(root, "node_modules", "@resvg", "resvg-wasm", RASTER_WASM.file), fontDir: join(root, "studio", "assets", "fonts") };

const gates: TextGate[] = [];
// After each test, so a test that fails or times out cannot leave a worker running under the next one.
afterEach(async () => {
  await Promise.all(gates.splice(0).map((g) => g.dispose()));
});

function gate(over: { renderTimeoutMs?: number } = {}): { gate: TextGate; spawned: () => number } {
  const spawn = createTextWorkerSpawner(WORKER, INIT);
  let spawned = 0;
  const g = createTextGate({
    spawnWorker: () => {
      spawned += 1;
      return spawn();
    },
    ...(over.renderTimeoutMs === undefined ? {} : { renderTimeoutMs: over.renderTimeoutMs }),
  });
  gates.push(g);
  return { gate: g, spawned: () => spawned };
}

const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex").slice(0, 16);
const svgOf = (text: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="64"><text x="8" y="44" font-family="Manrope" font-weight="800" font-size="36" fill="#fff">${text}</text></svg>`;

/** The review's probe: N blurred rects on a 1080x600 canvas (the largest the caps allow), which costs seconds inside resvg. Every rect stays on the canvas, so each one is really blurred. */
function blurred(n: number): string {
  const rects = Array.from({ length: n }, (_, i) => `<rect x="${20 + (i % 20) * 30}" y="40" width="400" height="400" fill="#f00" filter="url(#b)"/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="600"><defs><filter id="b" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="14"/></filter></defs>${rects}</svg>`;
}

/**
 * The worst caption the template can legitimately emit for «Без фона»: the largest canvas the caps allow (1080x600), two
 * lines of the largest text, and SP2's shadow filter (blur, offset, flood, composite, merge) over all of it.
 */
function worstShadowCaption(): string {
  const lines = ["Sunset beach vibes with", "the best crew ever!!"];
  const text = lines
    .map((l, i) => `<text x="540" y="${190 + i * 150}" text-anchor="middle" font-family="Manrope" font-weight="800" font-size="112" fill="#ffffff" xml:space="preserve">${l}</text>`)
    .join("");
  const filter =
    `<defs><filter id="s" x="-10%" y="-10%" width="120%" height="140%"><feGaussianBlur in="SourceAlpha" stdDeviation="6.72"/><feOffset dx="0" dy="5.6" result="b"/>` +
    `<feFlood flood-color="#000" flood-opacity="0.75"/><feComposite in2="b" operator="in"/><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="600" viewBox="0 0 1080 600">${filter}<g filter="url(#s)">${text}</g></svg>`;
}

function codeOf(error: unknown): string {
  return error instanceof RasterError ? error.code : `not a RasterError: ${String(error)}`;
}

describe("the real worker under Electron's Node", () => {
  test("draws the Cyrillic self-test string to the very bytes the in-process rasteriser draws", async () => {
    const { gate: g } = gate();
    const image = await g.render({ svg: selfTestSvg("manrope"), font: "manrope" });
    assert.equal(sha(image.png), SELF_TEST_HASHES.manrope);
    assert.equal(image.width, 800);
    assert.equal(image.height, 96);
  });

  test("measures with resvg's own getBBox", async () => {
    const { gate: g } = gate();
    const box = await g.measure({ svg: svgOf("Привет"), font: "manrope" });
    assert.ok(box !== null && box.width > 50);
  });

  test("rejects a control character with RENDER_FAILED and keeps the same worker", async () => {
    const { gate: g, spawned } = gate();
    await assert.rejects(g.render({ svg: svgOf("a\u0001b"), font: "manrope" }), (e) => codeOf(e) === "RENDER_FAILED");
    assert.equal((await g.render({ svg: svgOf("fine"), font: "manrope" })).width, 240);
    assert.equal(spawned(), 1);
  });

  test("rejects a frame-sized canvas with RASTER_TOO_LARGE, before resvg paints it", async () => {
    const { gate: g } = gate();
    await assert.rejects(g.render({ svg: '<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920"/>', font: "manrope" }), (e) => codeOf(e) === "RASTER_TOO_LARGE");
  });

  test("answers SVG_TOO_LARGE for 600 KB of ASCII and keeps the worker alive", async () => {
    const { gate: g, spawned } = gate();
    await g.render({ svg: svgOf("warm"), font: "manrope" });
    const big = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><!--${"x".repeat(600 * 1024)}--></svg>`;
    await assert.rejects(g.render({ svg: big, font: "manrope" }), (e) => codeOf(e) === "SVG_TOO_LARGE");
    assert.equal((await g.render({ svg: svgOf("after"), font: "manrope" })).width, 240);
    assert.equal(spawned(), 1);
  });

  test("the worker itself answers SVG_TOO_LARGE for an oversized request instead of dying", async () => {
    // The gate refuses first, so speak to the worker directly: what it does with what the gate would never send.
    const { Worker } = await import("node:worker_threads");
    const worker = new Worker(WORKER, { workerData: INIT });
    try {
      const answer = await new Promise<{ type: string; code?: string }>((resolve, reject) => {
        worker.once("error", reject);
        worker.once("exit", (code) => reject(new Error(`the worker exited (${code})`)));
        worker.on("message", (m: { type: string; code?: string }) => {
          if (m.type === "ready") worker.postMessage({ type: "render", id: 0, svg: "x".repeat(600 * 1024), font: "manrope" });
          else resolve(m);
        });
      });
      assert.equal(answer.type, "failed");
      assert.equal(answer.code, "SVG_TOO_LARGE");
    } finally {
      await worker.terminate();
    }
  });

  test("cuts a render that overruns the deadline at the deadline, not at the end of the render, and the next call works on a fresh worker", async () => {
    // Hardware-relative: the probe must take at least 3x the bound on THIS machine when nothing interrupts it, or a
    // gate that never interrupted would pass the assertion below. It must also finish under the worker's own tripwire
    // (TEXT_RENDER_DEADLINE_MS), which discards a slower call. So the probe is sized to this runner: the uninterrupted
    // render is measured, and the number of blurred rects is scaled until it lands in that window.
    const DEADLINE_MS = 200;
    const bound = DEADLINE_MS + 400;
    const { gate: uninterrupted } = gate({ renderTimeoutMs: 60_000 });
    await uninterrupted.render({ svg: svgOf("warm"), font: "manrope" });
    const TARGET_MS = 2300;
    let rects = 24;
    let probe = blurred(rects);
    let full = 0;
    for (let attempt = 0; attempt < 5; attempt++) {
      probe = blurred(rects);
      const fullStarted = performance.now();
      try {
        await uninterrupted.render({ svg: probe, font: "manrope" });
        full = performance.now() - fullStarted;
      } catch (error) {
        if (codeOf(error) !== "RENDER_TIMEOUT") throw error;
        full = Number.POSITIVE_INFINITY; // over the worker's own tripwire: too heavy
      }
      if (full >= 3 * bound && full < TEXT_RENDER_DEADLINE_MS * 0.9) break;
      rects = Number.isFinite(full) ? Math.ceil((rects * TARGET_MS) / full) : Math.max(1, Math.floor(rects / 2));
    }
    assert.ok(Buffer.byteLength(probe, "utf8") < 512 * 1024, `the probe (${rects} rects) is over the SVG byte cap`);
    assert.ok(full >= 3 * bound, `probe too light for this runner: ${rects} rects took ${Math.round(full)} ms uninterrupted, under 3 x ${bound} ms`);

    const { gate: g, spawned } = gate({ renderTimeoutMs: DEADLINE_MS });
    await g.render({ svg: svgOf("warm"), font: "manrope" });
    const started = performance.now();
    await assert.rejects(g.render({ svg: probe, font: "manrope" }), (e) => codeOf(e) === "RENDER_TIMEOUT");
    const cut = performance.now() - started;
    // Electron's Node interrupts wasm on terminate(): the call ends at the deadline plus the kill, not when the
    // render would have finished (Bun does not interrupt it: 712 ms locally, 2015 ms on CI).
    console.log(`uninterrupted probe (${rects} rects) ${Math.round(full)} ms; cut at a ${DEADLINE_MS} ms deadline after ${Math.round(cut)} ms (bound ${bound} ms) on ${process.platform}`);
    assert.ok(cut < bound, `the call took ${Math.round(cut)} ms, not under ${bound} ms (the render alone takes ${Math.round(full)} ms)`);
    assert.equal((await g.render({ svg: svgOf("after"), font: "manrope" })).width, 240);
    assert.equal(spawned(), 2);
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
    assert.ok(took > 100, `the render took only ${Math.round(took)} ms`);
    assert.ok(worstGap < Math.max(100, took / 3), `this thread stalled ${Math.round(worstGap)} ms during a ${Math.round(took)} ms render`);
  });

  test("the deadline is at least 5x a legitimate shadow caption's typical cost and 3x its second-slowest of 7 on this runner", async () => {
    // Two bounds over 7 renders after a warm-up. The MEDIAN is the caption's typical cost (5x). The tail is the
    // SECOND-slowest (3x, a looser factor), not the slowest: on a shared runner the single worst of a few is a
    // scheduling hiccup (the max of 5 read 836 ms on one macOS run and 410 ms on another), and this suite has no
    // retry, so one outlier must not fail it. Two slow renders in 7 are a slow runner, and a deadline that a plain
    // slow caption on it could trip would cut legitimate work, which the median alone would not show.
    const { gate: g } = gate({ renderTimeoutMs: 60_000 });
    const request = { svg: worstShadowCaption(), font: "manrope" } as const;
    await g.render(request); // warm
    const times: number[] = [];
    for (let i = 0; i < 7; i++) {
      const started = performance.now();
      await g.render(request);
      times.push(performance.now() - started);
    }
    times.sort((a, b) => a - b);
    const min = times[0] ?? Number.NaN;
    const median = times[3] ?? Number.NaN;
    const max = times[6] ?? Number.NaN;
    console.log(
      `legitimate shadow caption on ${process.platform}: min ${min.toFixed(0)} / median ${median.toFixed(0)} / max ${max.toFixed(0)} ms of 7; deadline ${TEXT_RENDER_DEADLINE_MS} ms (${(TEXT_RENDER_DEADLINE_MS / median).toFixed(1)}x the median)`,
    );
    assert.ok(median * 5 <= TEXT_RENDER_DEADLINE_MS, `a shadow caption's median is ${Math.round(median)} ms: the ${TEXT_RENDER_DEADLINE_MS} ms deadline is under 5x that`);
    const secondSlowest = times[5] ?? Number.NaN;
    assert.ok(secondSlowest * 3 <= TEXT_RENDER_DEADLINE_MS, `a shadow caption's second-slowest of 7 is ${Math.round(secondSlowest)} ms: the ${TEXT_RENDER_DEADLINE_MS} ms deadline is under 3x that`);
  });

  test("the loader starts it, and the self-test through the worker gives the pinned fingerprint", async () => {
    const infos: string[] = [];
    const loaded = await loadTextRasteriser({ spawnWorker: createTextWorkerSpawner(WORKER, INIT), log: { info: (m) => infos.push(m), error: () => {} } });
    gates.push(loaded.gate);
    assert.ok("fingerprint" in loaded, "the load failed");
    assert.equal(loaded.fingerprint, SELF_TEST_FINGERPRINT);
    console.log(infos.join("\n"));
  });
});
