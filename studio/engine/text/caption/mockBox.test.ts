import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { TextLayer } from "../../../shared/engine";
import { MockTextPreviews } from "../../../renderer/engine/mockText";
import { useNativeGlobals } from "../../../testing/nativeGlobals";
import { openEmojiFont } from "../emoji/emojiFont";
import { loadPinnedEmojiFont } from "../emoji/emojiFont.testkit";
import { TEXT_FONT_KEYS } from "../fonts";
import { createTextRasteriser, RASTER_WASM } from "../rasteriser";
import { createCaptionRenderer } from "./renderer";
useNativeGlobals();

// The dev mock draws no caption: its box is the shared layout over a per-font average advance (renderer/engine/mockText.ts). This
// holds that estimate to the REAL renderer on typical captions, so the editor built on the mock places a text about where the
// engine will. It is a calibration, not parity: the numbers of the engine's box are still the engine's own.

const STUDIO = join(import.meta.dir, "..", "..", "..");
const WIDTH_TOLERANCE = 0.15;

const SAMPLES = [
  "sunday reset",
  "Monday motivation",
  "coffee and a good book",
  "city lights tonight",
  "new week, new goals",
  "hello",
  "golden hour in Lisbon",
  "sunday reset sunday reset sunday",
  "one two three four five six seven eight",
  "one\r\ntwo words",
];

let real: ReturnType<typeof createCaptionRenderer>;
beforeAll(async () => {
  const rasteriser = createTextRasteriser({ wasmPath: join(STUDIO, "..", "node_modules", "@resvg", "resvg-wasm", RASTER_WASM.file), fontDir: join(STUDIO, "assets", "fonts") });
  await rasteriser.init();
  real = createCaptionRenderer({ rasteriser, emoji: openEmojiFont(await loadPinnedEmojiFont()) });
});

async function mockBox(layer: TextLayer): Promise<{ width: number; height: number }> {
  let n = 0;
  const mock = new MockTextPreviews({ scheduler: { schedule: (_ms: number, task: () => void) => (task(), () => undefined) }, drawMs: 0, newId: () => `preview-${String(++n).padStart(4, "0")}` });
  const outcome = await mock.preview(layer);
  if (!outcome.ok) throw new Error(`the mock refused: ${outcome.error.code}`);
  return outcome.result;
}

describe("the mock's text box against the real renderer", () => {
  for (const font of TEXT_FONT_KEYS) {
    for (const scale of [1, 1.5]) {
      test(`${font} at scale ${scale}: a width and a height (so the line count) within ${WIDTH_TOLERANCE * 100} % on typical captions`, async () => {
        const off: string[] = [];
        for (const value of SAMPLES) {
          const layer: TextLayer = { kind: "text", layerId: "layer-00000001", startMs: 0, endMs: 3000, value, font, style: "plaque", color: "#ffffff", x: 0.5, y: 0.2, scale };
          const actual = await real.render({ value, font, style: "plaque", color: "#ffffff", scale });
          const mocked = await mockBox(layer);
          const ratio = mocked.width / actual.width;
          // A different line count would show as a different height (a line is about half of the box).
          const heightRatio = mocked.height / actual.height;
          if (Math.abs(ratio - 1) > WIDTH_TOLERANCE || Math.abs(heightRatio - 1) > WIDTH_TOLERANCE) off.push(`${JSON.stringify(value)}: ${mocked.width}x${mocked.height} against ${actual.width}x${actual.height}`);
        }
        expect(off).toEqual([]);
      });
    }
  }
});
