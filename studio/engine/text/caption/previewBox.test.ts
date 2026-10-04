import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { TextLayer } from "../../../shared/engine";
import { FRAME_H, FRAME_W, type Rect, reelsSafeZones, zonesHit } from "../../../shared/montage";
import { MockTextPreviews } from "../../../renderer/engine/mockText";
import { dragLayerCentre, placeLayer } from "../../../renderer/screens/montage/previewDrag";
import { textLayerBox } from "../../../renderer/screens/montage/previewFrame";
import { tempDirFor } from "../../../testing/tempDir";
import { useNativeGlobals } from "../../../testing/nativeGlobals";
import { resolveLayers } from "../../videos/layers";
import { openEmojiFont } from "../emoji/emojiFont";
import { loadPinnedEmojiFont } from "../emoji/emojiFont.testkit";
import { type PreviewGate, TextPreviewService } from "../preview";
import { createTextRasteriser, RASTER_WASM } from "../rasteriser";
import { createCaptionRenderer } from "./renderer";
useNativeGlobals();

// 3d.4 (the 3d.1b line in the plan's 3d.4 row): the preview places a caption by the REAL engine's numbers, never the mock's estimate.
// This runs the real caption renderer (resvg-wasm, the five fonts, the emoji font), answers `montages.textPreview` through the
// engine's own service, and checks, for a set of captions (wrap points and pathological letters included) at the centre and at
// every edge, that the box the preview draws (`textLayerBox` on the preview's answer) is exactly the box the render overlays
// (`resolveLayers`, the render's own layer planning); that dragging a caption far past an edge leaves it where the render clamps
// it; and that the Reels zones it reaches are the same for both.

const STUDIO = join(import.meta.dir, "..", "..", "..");
const dir = tempDirFor({ beforeEach, afterEach }, "studio-preview-box-");

let gate: PreviewGate;
beforeAll(async () => {
  const rasteriser = createTextRasteriser({ wasmPath: join(STUDIO, "..", "node_modules", "@resvg", "resvg-wasm", RASTER_WASM.file), fontDir: join(STUDIO, "assets", "fonts") });
  await rasteriser.init();
  const real = createCaptionRenderer({ rasteriser, emoji: openEmojiFont(await loadPinnedEmojiFont()) });
  gate = { caption: async (request) => ({ ...(await real.render(request)), workerMs: 0 }) };
});

const base = (over: Partial<TextLayer>): TextLayer => ({
  kind: "text",
  layerId: "layer-00000001",
  startMs: 0,
  endMs: 3_000,
  value: "sunday reset",
  font: "manrope",
  style: "plaque",
  color: "#ffffff",
  x: 0.5,
  y: 0.2,
  scale: 1,
  ...over,
});

/** Captions the mock's estimate gets wrong or nearly wrong (3d.1b residuals), and ordinary ones, across the fonts and styles. */
const CAPTIONS: Partial<TextLayer>[] = [
  { value: "sunday reset" },
  { value: "good morning sunshine", scale: 1.5 },
  { value: "new drop out now", scale: 2 },
  { value: "iiiiiiiiiiiiiiiiiiii", font: "playfair" },
  { value: "WWWWWWWWWWWW", font: "oswald", scale: 1.3 },
  { value: "ALL CAPS HEADLINE TODAY", font: "oswald", style: "outline" },
  { value: "coffee first ☕", font: "caveat", style: "outline", color: "#111111" },
  { value: "one\ntwo words", font: "playfair", style: "none" },
  { value: "a long caption that has to wrap onto two lines", font: "ptmono", scale: 2, color: "#ffd166" },
];

/** The centre and every edge: the last ones put the box against (and clamp it at) the frame's sides. */
const PLACES: { x: number; y: number }[] = [
  { x: 0.5, y: 0.2 },
  { x: 0, y: 0 },
  { x: 1, y: 1 },
  { x: 0.02, y: 0.98 },
  { x: 0.97, y: 0.03 },
];

let ids = 0;
function service(): TextPreviewService {
  return new TextPreviewService({ gate, dir: () => join(dir(), "text"), newId: () => `preview-${String(++ids).padStart(4, "0")}`, log: () => undefined });
}

/** The box the render overlays the caption at: the engine's own layer planning, with the engine's own drawing. */
async function renderBox(layer: TextLayer): Promise<Rect> {
  const resolved = await resolveLayers([layer], join(dir(), "job"), { gate, stickers: { read: () => Promise.reject(new Error("no sticker in this test")) } }, new AbortController().signal);
  const overlay = resolved.overlays[0];
  if (overlay === undefined) throw new Error("the render planned no overlay");
  return overlay.box;
}

const zones = (box: Rect): string[] => zonesHit(box, reelsSafeZones()).map((z) => z.id);

describe("the preview's caption box against the real engine", () => {
  test("for every caption and place, the preview draws exactly the box the render overlays, inside the frame", async () => {
    const previews = service();
    const off: string[] = [];
    for (const caption of CAPTIONS) {
      for (const place of PLACES) {
        const layer = base({ ...caption, ...place });
        const answer = await previews.preview(layer);
        const drawn = textLayerBox(layer, answer);
        const rendered = await renderBox(layer);
        const inside = drawn.x >= 0 && drawn.y >= 0 && drawn.x + drawn.w <= FRAME_W && drawn.y + drawn.h <= FRAME_H;
        if (JSON.stringify(drawn) !== JSON.stringify(rendered) || !inside) off.push(`${JSON.stringify(caption)} at ${JSON.stringify(place)}: preview ${JSON.stringify(drawn)}, render ${JSON.stringify(rendered)}`);
        if (JSON.stringify(zones(drawn)) !== JSON.stringify(zones(rendered))) off.push(`${JSON.stringify(caption)} at ${JSON.stringify(place)}: zones ${zones(drawn)} against ${zones(rendered)}`);
      }
    }
    expect(off).toEqual([]);
  });

  test("a caption dragged far past each edge stops where the render clamps it, and the preview draws it there", async () => {
    const previews = service();
    const off: string[] = [];
    for (const caption of CAPTIONS) {
      const layer = base(caption);
      const answer = await previews.preview(layer);
      const drawn = textLayerBox(layer, answer);
      for (const travel of [
        { dx: -5_000, dy: -5_000 },
        { dx: 5_000, dy: 5_000 },
        { dx: -5_000, dy: 5_000 },
      ]) {
        const centre = dragLayerCentre(drawn, travel);
        const moved = placeLayer({ schemaVersion: 1, avatarId: "avatar-00000001", clips: [], layers: [layer], music: null, seed: 1 }, 0, centre).layers[0];
        if (moved?.kind !== "text") throw new Error("the layer is gone");
        const rendered = await renderBox(moved);
        const shown = textLayerBox(moved, answer);
        // Against the edge the drag went to: the render's even-rounded offset of a box flush with that side.
        const wantX = travel.dx < 0 ? 0 : FRAME_W - rendered.w - ((FRAME_W - rendered.w) % 2);
        const wantY = travel.dy < 0 ? 0 : FRAME_H - rendered.h - ((FRAME_H - rendered.h) % 2);
        if (JSON.stringify(shown) !== JSON.stringify(rendered) || rendered.x !== wantX || rendered.y !== wantY) {
          off.push(`${JSON.stringify(caption)} dragged ${JSON.stringify(travel)}: preview ${JSON.stringify(shown)}, render ${JSON.stringify(rendered)}`);
        }
      }
    }
    expect(off).toEqual([]);
  });

  test("the box is the engine's size, not the mock's estimate: a caption near the wrap point is two lines on the engine", async () => {
    const answer = await service().preview(base({ value: "good morning sunshine", scale: 1.5 }));
    const one = await service().preview(base({ value: "good", scale: 1.5 }));
    // Two lines are well over one line's height (the plaque's padding counts once).
    expect(answer.height).toBeGreaterThan(one.height * 1.6);
  });

  test("control: the dev mock's estimated box would put some of these captions elsewhere (why this is checked on the engine)", async () => {
    const previews = service();
    let n = 0;
    const mock = new MockTextPreviews({ scheduler: { schedule: (_ms: number, task: () => void) => (task(), () => undefined) }, drawMs: 0, newId: () => `preview-${String(++n).padStart(4, "0")}` });
    const differ: string[] = [];
    for (const caption of CAPTIONS) {
      const layer = base(caption);
      const estimate = await mock.preview(layer);
      if (!estimate.ok) throw new Error(`the mock refused ${JSON.stringify(caption)}`);
      if (JSON.stringify(textLayerBox(layer, estimate.result)) !== JSON.stringify(textLayerBox(layer, await previews.preview(layer)))) differ.push(layer.value);
    }
    expect(differ.length).toBeGreaterThan(0);
  });
});
