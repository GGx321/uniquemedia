import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { openEmojiFont } from "./emoji/emojiFont";
import { loadPinnedEmojiFont } from "./emoji/emojiFont.testkit";
import { CAPTION_FINGERPRINT_LAYERS } from "./caption/fingerprint";
import { createCaptionRenderer, type CaptionRenderer } from "./caption/renderer";
import { loadTextRasteriser } from "./load";
import { createTextRasteriser, RASTER_WASM, type TextRasteriser } from "./rasteriser";
import { SELF_TEST_FINGERPRINT } from "./selfTest";
import type { TextGate } from "./worker/textGate";
useNativeGlobals();

// The default self-test of the loader is the text one and THEN the caption one. A gate backed by the real rasteriser in this
// process lets the caption check be the only thing that can fail: the text self-test passes on the real bytes.

const FONT_DIR = join(import.meta.dir, "..", "..", "assets", "fonts");
const WASM_PATH = join(import.meta.dir, "..", "..", "..", "node_modules", "@resvg", "resvg-wasm", RASTER_WASM.file);

let rasteriser: TextRasteriser;
let renderer: CaptionRenderer;
beforeAll(async () => {
  rasteriser = createTextRasteriser({ wasmPath: WASM_PATH, fontDir: FONT_DIR });
  await rasteriser.init();
  renderer = createCaptionRenderer({ rasteriser, emoji: openEmojiFont(await loadPinnedEmojiFont()) });
});

/** A gate that draws in this process: the real text bytes, and captions through `caption`. */
function gateWith(caption: TextGate["caption"]): TextGate {
  return {
    start: async () => undefined,
    render: async (request) => ({ ...(await rasteriser.render(request)), workerMs: 1 }),
    measure: async (request) => rasteriser.measure(request),
    caption,
    dispose: async () => undefined,
    isBroken: () => false,
  };
}

const quiet = { info: () => {}, error: () => {} };
const real: TextGate["caption"] = async (request) => ({ ...(await renderer.render(request)), workerMs: 1 });

describe("the loader's default self-test", () => {
  test("passes, with the text fingerprint, when the gate draws the pinned caption", async () => {
    const result = await loadTextRasteriser({ gate: gateWith(real), log: quiet });
    expect("fingerprint" in result && result.fingerprint).toBe(SELF_TEST_FINGERPRINT);
  });

  test("runs the caption check: a gate that answers a caption with a foreign picture fails the load", async () => {
    const other = CAPTION_FINGERPRINT_LAYERS.find((layer) => layer.key === "manrope/outline");
    const foreign: TextGate["caption"] = async () => ({ ...(await renderer.render(other?.request ?? { value: "x", font: "manrope", style: "plaque", color: "#ffffff", scale: 1 })), workerMs: 1 });
    const errors: string[] = [];
    const result = await loadTextRasteriser({ gate: gateWith(foreign), log: { info: () => {}, error: (m) => errors.push(m) } });
    expect("error" in result && result.error).toMatch(/caption self-test: manrope\/plaque/);
    expect(errors.join("\n")).toMatch(/could not be loaded/);
  });

  test("a gate that cannot draw a caption at all fails the load, with the gate's own reason", async () => {
    const result = await loadTextRasteriser({ gate: gateWith(() => Promise.reject(new Error("no emoji reader"))), log: quiet });
    expect("error" in result && result.error).toMatch(/no emoji reader/);
  });
});
