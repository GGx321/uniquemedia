import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { join } from "node:path";
import { CAPTION_FINGERPRINT, CAPTION_FINGERPRINT_LAYERS, CAPTION_LAYER_HASHES, fingerprintOf, hashOf } from "../caption/fingerprint";
import { deadlineHeadroomProblem, HEADROOM_SAMPLES, headroomStats } from "../deadlineHeadroom";
import { openEmojiFont } from "../emoji/emojiFont";
import { loadEmojiFont } from "../fonts";
import { RASTER_WASM, RasterError, TEXT_RENDER_DEADLINE_MS } from "../rasterTypes";
import { tierOf } from "../../../testing/tiers";
import { createTextWorkerSpawner } from "./spawn";
import { createTextGate, type TextGate } from "./textGate";

// The caption call through the REAL text worker (resvg, the fonts, the emoji reader, the layout and the template),
// under ELECTRON'S NODE like textGate.real.node-test.ts, on macOS and Windows in CI. The fingerprint asserted here is
// the same constant the in-process test (caption/fingerprint.test.ts) asserts under Bun.

const root = process.env.STUDIO_ROOT;
if (root === undefined || root === "") throw new Error("STUDIO_ROOT is not set: run this through studio/scripts/electronNodeTests.ts");
const WORKER = new URL("./textWorker.js", import.meta.url);
const INIT = { wasmPath: join(root, "node_modules", "@resvg", "resvg-wasm", RASTER_WASM.file), fontDir: join(root, "studio", "assets", "fonts") };

const gates: TextGate[] = [];
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

const base = { font: "manrope", style: "plaque", color: "#ffffff", scale: 1 } as const;

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (e: unknown) => e,
  );
}

describe("captions through the real worker under Electron's Node", () => {
  test("the fifteen font by style layers draw to the pinned hashes and the pinned fingerprint", async () => {
    const { gate: g } = gate();
    const hashes: Record<string, string> = {};
    for (const layer of CAPTION_FINGERPRINT_LAYERS) hashes[layer.key] = hashOf((await g.caption(layer.request)).png);
    assert.deepEqual(hashes, { ...CAPTION_LAYER_HASHES });
    assert.equal(fingerprintOf(hashes), CAPTION_FINGERPRINT);
    console.log(`caption fingerprint on ${process.platform}: ${fingerprintOf(hashes)}`);
  });

  test("returns the resolved layout, and its box is the picture's", async () => {
    const { gate: g } = gate();
    const image = await g.caption({ ...base, value: "one\r\ntwo", scale: 1.5 });
    assert.deepEqual(image.layout.lines, ["one", "two"]);
    assert.equal(image.layout.fontSize, 84);
    assert.equal(image.layout.width, image.width);
    assert.equal(image.layout.height, image.height);
  });

  test("a caption that breaks a rule is CAPTION_INVALID with the rule, and the same worker goes on", async () => {
    const { gate: g, spawned } = gate();
    const error = await failure(g.caption({ ...base, value: "café" }));
    assert.ok(error instanceof RasterError);
    assert.equal(error.code, "CAPTION_INVALID");
    assert.equal(error.captionIssue, "charset");
    await g.caption({ ...base, value: "fine" });
    assert.equal(spawned(), 1);
  });

  test("each rule is named through the worker", async () => {
    const { gate: g } = gate();
    const expected: [string, string][] = [
      ["\u{1F1FA}", "emoji-missing"],
      ["❤︎", "emoji-text-style"],
      ["a".repeat(61), "too-long"],
      ["a\nb\nc", "too-many-lines"],
    ];
    for (const [value, issue] of expected) {
      const error = await failure(g.caption({ ...base, value }));
      assert.ok(error instanceof RasterError);
      assert.equal(error.captionIssue, issue);
    }
  });

  test("a caption of only spaces is RENDER_FAILED, not a picture", async () => {
    const { gate: g } = gate();
    const error = await failure(g.caption({ ...base, value: "   " }));
    assert.ok(error instanceof RasterError);
    assert.equal(error.code, "RENDER_FAILED");
  });

  test("a call cancelled while queued costs nothing: the running one finishes and no worker is killed", async () => {
    const { gate: g, spawned } = gate();
    const controller = new AbortController();
    let started = false;
    const first = g.caption({ ...base, value: "first caption \u{1F600}", style: "none" }, { onStart: () => (started = true) });
    const queued = failure(g.caption({ ...base, value: "stale" }, { signal: controller.signal }));
    controller.abort(new Error("stale"));
    assert.equal(((await queued) as Error).message, "stale");
    const done = await first;
    assert.ok(started);
    assert.deepEqual(done.layout.lines, ["first caption \u{1F600}"]);
    await g.caption({ ...base, value: "after" });
    assert.equal(spawned(), 1);
  });

  test("a running call that overruns the deadline is RENDER_TIMEOUT, and the worker is terminated", async () => {
    const { gate: g, spawned } = gate({ renderTimeoutMs: 1 });
    const error = await failure(g.caption({ ...base, value: "slow \u{1F600}", style: "none", scale: 2 }));
    assert.ok(error instanceof RasterError);
    assert.equal(error.code, "RENDER_TIMEOUT");
    assert.equal(spawned(), 1);
  });

  test("[perf] the configured deadline leaves headroom over the worst legitimate \u00ABБез фона\u00BB caption on this runner, for text and for emoji", async () => {
    // Every run draws the two worst captions and checks they ARE the worst case (below); only the perf run takes the timing
    // samples and judges them against the deadline (CI-4: that judgement is a measurement of the runner, and does not block).
    // The worst the real template can emit, at its largest size (a caption that SHRINKS is not the worst: `fontSize >= 108` is asserted):
    // two lines of the widest text at scale 2 with the shadow filter over the whole box, and the same with two lines of the 7 largest
    // emoji bitmaps (the most to decode, embed and blur).
    const font = openEmojiFont(await loadEmojiFont(INIT.fontDir));
    const sizes: { sequence: string; bytes: number }[] = [];
    for (let cp = 0x1f300; cp <= 0x1faff; cp++) {
      const sequence = String.fromCodePoint(cp);
      const bitmap = font.bitmap(sequence);
      if (bitmap !== null) sizes.push({ sequence, bytes: bitmap.png.byteLength });
    }
    const largest = sizes
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 7)
      .map((entry) => entry.sequence)
      .join("");
    assert.equal([...largest].length, 7);
    const cases = [
      { name: "text", request: { ...base, style: "none", value: `${"W".repeat(13)}\n${"W".repeat(13)}`, font: "ptmono", scale: 2 } as const },
      { name: "emoji", request: { ...base, style: "none", value: `${largest}\n${largest}`, font: "manrope", scale: 2 } as const },
    ];
    for (const { name, request } of cases) {
      const { gate: g } = gate({ renderTimeoutMs: 60_000 });
      const first = await g.caption(request); // warm
      assert.ok(first.layout.fontSize >= 108, `${name}: the caption shrank to ${first.layout.fontSize} px, so it is not the worst case`);
      assert.equal(first.layout.lines.length, 2);
      if (tierOf() !== "perf") continue;
      const times: number[] = [];
      for (let i = 0; i < HEADROOM_SAMPLES; i++) {
        const started = performance.now();
        await g.caption(request);
        times.push(performance.now() - started);
      }
      const { lowerQuartile, median, secondSlowest } = headroomStats(times);
      console.log(
        `worst template shadow caption (${name}, ${first.width}x${first.height} at ${first.layout.fontSize} px) on ${process.platform}: lower quartile ${lowerQuartile.toFixed(0)} / median ${median.toFixed(0)} / second-slowest ${secondSlowest.toFixed(0)} ms of ${HEADROOM_SAMPLES}; deadline ${TEXT_RENDER_DEADLINE_MS} ms`,
      );
      assert.equal(deadlineHeadroomProblem(times, TEXT_RENDER_DEADLINE_MS), undefined, name);
    }
  });
});
