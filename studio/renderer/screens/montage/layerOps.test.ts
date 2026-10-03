import { describe, expect, test } from "bun:test";
import { MAX_LAYERS, MAX_STICKER_LAYERS, MAX_TEXT_LAYERS, MontageDraft, type Layer } from "../../../shared/engine";
import { DEFAULT_STICKER, DEFAULT_TEXT_Y, MAX_TOTAL_MS } from "../../../shared/montage";
import {
  ADD_LAYER_MS,
  addLayerRefusal,
  addStickerLayer,
  addTextLayer,
  clampEdge,
  clampStart,
  DEFAULT_TEXT_VALUE,
  duplicateLayer,
  edgeRange,
  type LayerEdit,
  layerRows,
  lowerLayer,
  moveLayer,
  raiseLayer,
  removeLayer,
  splitLayerAt,
  startRange,
  trimLayer,
} from "./layerOps";
import { draftSpec, stickerLayer, textLayer } from "./testkit";

// 3d.3b: the text and sticker tracks' edits, pure over a draft. Every result must still be a draft the contract takes
// (`MontageDraft`), keep every layer on the 100 ms grid and at least 0.3 s long, and never push a layer's end further
// past the montage's end: an edit that would is refused, and no layer is ever shortened or moved behind the owner's back
// to make it fit.

/** The edited draft, after checking it is one the contract takes. */
function ok(edit: LayerEdit): MontageDraft {
  if (!edit.ok) throw new Error(`refused: ${edit.reason}`);
  expect(MontageDraft.safeParse(edit.spec).success).toBe(true);
  return edit.spec;
}

const ranges = (spec: MontageDraft): [string, number, number][] => spec.layers.map((l) => [l.layerId, l.startMs, l.endMs]);
const order = (spec: MontageDraft): string[] => spec.layers.map((l) => l.layerId);
/** Four 2 s clips: an 8.0 s montage. */
const EIGHT = draftSpec(4);
const texts = (n: number): Layer[] => Array.from({ length: n }, (_, i) => textLayer(i, 0, 1_000));
const stickers = (n: number, from = 0): Layer[] => Array.from({ length: n }, (_, i) => stickerLayer(from + i, 0, 1_000));

describe("adding a layer at the playhead (AM7: min(3.0 s, the rest of the montage), refused under 0.3 s)", () => {
  test("a text starts at the playhead for 3.0 s with the first preset and a neutral sample, on top of the others", () => {
    const spec = draftSpec(4, { layers: [stickerLayer(0, 0, 1_000)] });
    const edit = addTextLayer(spec, 1_000);
    const next = ok(edit);
    expect(edit.ok && edit.id).toBe("layer-002");
    expect(next.layers.at(-1)).toEqual({
      layerId: "layer-002",
      startMs: 1_000,
      endMs: 1_000 + ADD_LAYER_MS,
      kind: "text",
      value: DEFAULT_TEXT_VALUE,
      font: "manrope",
      style: "plaque",
      color: "#ffffff",
      x: 0.5,
      y: DEFAULT_TEXT_Y,
      scale: 1,
    });
    expect(order(next)).toEqual(["layer-001", "layer-002"]);
  });

  test("a built-in sticker lands where the mockup puts one, for as long as a text", () => {
    const next = ok(addStickerLayer(EIGHT, 2_000, "heart-pulse"));
    expect(next.layers).toEqual([
      { layerId: "layer-001", startMs: 2_000, endMs: 5_000, kind: "sticker", sticker: { source: "builtin", stickerId: "heart-pulse" }, x: DEFAULT_STICKER.x, y: DEFAULT_STICKER.y, size: DEFAULT_STICKER.size },
    ]);
  });

  test("near the end the layer takes what is left, down to exactly 0.3 s; less than that is no room", () => {
    expect(ranges(ok(addTextLayer(EIGHT, 6_500)))).toEqual([["layer-001", 6_500, 8_000]]);
    expect(ranges(ok(addTextLayer(EIGHT, 7_700)))).toEqual([["layer-001", 7_700, 8_000]]);
    expect(addTextLayer(EIGHT, 7_800)).toEqual({ ok: false, reason: "no-room" });
    expect(addTextLayer(EIGHT, 8_000)).toEqual({ ok: false, reason: "no-room" });
    expect(addStickerLayer(EIGHT, 7_800, "heart-pulse")).toEqual({ ok: false, reason: "no-room" });
    // An empty montage has no time for a layer at all.
    expect(addTextLayer(draftSpec([]), 0)).toEqual({ ok: false, reason: "no-room" });
  });

  test("a playhead between two 100 ms steps (while playing) starts the layer on the step it is in", () => {
    expect(ranges(ok(addTextLayer(EIGHT, 1_299.5)))).toEqual([["layer-001", 1_200, 4_200]]);
  });

  test("ten of a kind is that kind's cap; the other kind is still free", () => {
    const tenTexts = draftSpec(4, { layers: texts(MAX_TEXT_LAYERS) });
    expect(addTextLayer(tenTexts, 0)).toEqual({ ok: false, reason: "layer-cap" });
    expect(addLayerRefusal(tenTexts, "text", 0)).toBe("layer-cap");
    expect(addLayerRefusal(tenTexts, "sticker", 0)).toBeNull();
    ok(addStickerLayer(tenTexts, 0, "star-spin"));
    const tenStickers = draftSpec(4, { layers: stickers(MAX_STICKER_LAYERS) });
    expect(addStickerLayer(tenStickers, 0, "star-spin")).toEqual({ ok: false, reason: "layer-cap" });
    ok(addTextLayer(tenStickers, 0));
  });

  test("ten and ten are the 20 layers a montage holds (3b.6): nothing more of either kind", () => {
    const full = draftSpec(4, { layers: [...texts(MAX_TEXT_LAYERS), ...stickers(MAX_STICKER_LAYERS, MAX_TEXT_LAYERS)] });
    expect(full.layers).toHaveLength(MAX_LAYERS);
    expect(addLayerRefusal(full, "text", 0)).toBe("layer-cap");
    expect(addLayerRefusal(full, "sticker", 0)).toBe("layer-cap");
    expect(duplicateLayer(full, 0)).toEqual({ ok: false, reason: "layer-cap" });
    expect(splitLayerAt(full, MAX_LAYERS - 1, 500)).toEqual({ ok: false, reason: "layer-cap" });
  });

  test("the cap is told before the room: a full kind says so even with the playhead at the end", () => {
    expect(addLayerRefusal(draftSpec(4, { layers: texts(MAX_TEXT_LAYERS) }), "text", 8_000)).toBe("layer-cap");
    expect(addLayerRefusal(EIGHT, "text", 8_000)).toBe("no-room");
    expect(addLayerRefusal(EIGHT, "text", 7_700)).toBeNull();
  });

  test("a draft longer than 15 s (from elsewhere) still gets no layer past 15 s: the contract's end is the limit", () => {
    // Eight 2.5 s clips: 20 s.
    const long = draftSpec(draftSpec(8).clips.map((c) => ({ ...c, durationMs: 2_500 })));
    expect(ranges(ok(addTextLayer(long, 14_000)))).toEqual([["layer-001", 14_000, 15_000]]);
    expect(addLayerRefusal(long, "text", 14_700)).toBeNull();
    expect(addLayerRefusal(long, "text", 14_800)).toBe("no-room");
    expect(addTextLayer(long, 15_000)).toEqual({ ok: false, reason: "no-room" });
    expect(addStickerLayer(long, 16_000, "heart-pulse")).toEqual({ ok: false, reason: "no-room" });
  });

  test("a sticker the built-in set does not have, or a playhead that is not a time, is a programming error", () => {
    expect(() => addStickerLayer(EIGHT, 0, "sticker-nowhere")).toThrow(RangeError);
    expect(() => addTextLayer(EIGHT, Number.NaN)).toThrow(RangeError);
    expect(() => addTextLayer(EIGHT, -100)).toThrow(RangeError);
  });
});

describe("moving a layer (the 100 ms grid, its length kept, never further past the montage's end)", () => {
  const spec = draftSpec(4, { layers: [textLayer(0, 300, 4_400), stickerLayer(1, 1_000, 2_000)] });

  test("the layer keeps its length and its place in the z-order", () => {
    expect(ranges(ok(moveLayer(spec, 0, 2_000)))).toEqual([
      ["layer-001", 2_000, 6_100],
      ["layer-002", 1_000, 2_000],
    ]);
  });

  test("a start between steps lands on the nearest one", () => {
    expect(ranges(ok(moveLayer(spec, 1, 2_049)))[1]).toEqual(["layer-002", 2_000, 3_000]);
    expect(ranges(ok(moveLayer(spec, 1, 2_050)))[1]).toEqual(["layer-002", 2_100, 3_100]);
  });

  test("it may end exactly at the montage's end, never after it, and never start before 0", () => {
    expect(ranges(ok(moveLayer(spec, 0, 3_900)))[0]).toEqual(["layer-001", 3_900, 8_000]);
    expect(moveLayer(spec, 0, 4_000)).toEqual({ ok: false, reason: "outside-montage" });
    expect(moveLayer(spec, 0, -100)).toEqual({ ok: false, reason: "outside-montage" });
  });

  test("the same start is the same draft", () => {
    const same = moveLayer(spec, 0, 300);
    expect(same.ok && same.spec === spec).toBe(true);
  });

  test("a layer already past the end (its clips were shortened) may come back, never go further out", () => {
    const out = draftSpec(4, { layers: [textLayer(0, 6_000, 9_000)] });
    expect(ranges(ok(moveLayer(out, 0, 5_000)))).toEqual([["layer-001", 5_000, 8_000]]);
    expect(ranges(ok(moveLayer(out, 0, 5_500)))).toEqual([["layer-001", 5_500, 8_500]]);
    expect(moveLayer(out, 0, 6_500)).toEqual({ ok: false, reason: "outside-montage" });
  });

  test("where a drag may put it: from 0 to the last start that still ends in the montage", () => {
    expect(startRange(spec, 0)).toEqual({ min: 0, max: 3_900 });
    expect(startRange(spec, 1)).toEqual({ min: 0, max: 7_000 });
    // Past the end: only back, so its own start is the furthest.
    expect(startRange(draftSpec(4, { layers: [textLayer(0, 6_000, 9_000)] }), 0)).toEqual({ min: 0, max: 6_000 });
    // Longer than the montage itself: it can only move towards 0.
    expect(startRange(draftSpec(1, { layers: [textLayer(0, 500, 4_500)] }), 0)).toEqual({ min: 0, max: 500 });
  });

  test("a drag's start is snapped to 100 ms and held inside that range", () => {
    expect(clampStart(spec, 0, 1_234)).toBe(1_200);
    expect(clampStart(spec, 0, 9_999)).toBe(3_900);
    expect(clampStart(spec, 0, -500)).toBe(0);
    expect(() => clampStart(spec, 0, Number.NaN)).toThrow(RangeError);
  });

  test("an index outside the draft is a programming error", () => {
    expect(() => moveLayer(spec, 2, 0)).toThrow(RangeError);
    expect(() => startRange(spec, -1)).toThrow(RangeError);
  });
});

describe("trimming a layer by an edge (the 100 ms grid, at least 0.3 s, inside the montage)", () => {
  const spec = draftSpec(4, { layers: [textLayer(0, 300, 4_400)] });

  test("the start edge moves the start alone", () => {
    expect(ranges(ok(trimLayer(spec, 0, "start", 1_000)))).toEqual([["layer-001", 1_000, 4_400]]);
    expect(ranges(ok(trimLayer(spec, 0, "start", 0)))).toEqual([["layer-001", 0, 4_400]]);
    expect(ranges(ok(trimLayer(spec, 0, "start", 4_100)))).toEqual([["layer-001", 4_100, 4_400]]);
  });

  test("under 0.3 s, zero length, or an edge past the other one is too short", () => {
    expect(trimLayer(spec, 0, "start", 4_200)).toEqual({ ok: false, reason: "too-short" });
    expect(trimLayer(spec, 0, "start", 4_400)).toEqual({ ok: false, reason: "too-short" });
    expect(trimLayer(spec, 0, "start", 4_500)).toEqual({ ok: false, reason: "too-short" });
    expect(trimLayer(spec, 0, "end", 500)).toEqual({ ok: false, reason: "too-short" });
    expect(trimLayer(spec, 0, "end", 300)).toEqual({ ok: false, reason: "too-short" });
  });

  test("the end edge stops at the montage's end; a start before 0 is outside too", () => {
    expect(ranges(ok(trimLayer(spec, 0, "end", 8_000)))).toEqual([["layer-001", 300, 8_000]]);
    expect(trimLayer(spec, 0, "end", 8_100)).toEqual({ ok: false, reason: "outside-montage" });
    expect(trimLayer(spec, 0, "start", -100)).toEqual({ ok: false, reason: "outside-montage" });
  });

  test("an end already past the montage may only come back", () => {
    const out = draftSpec(4, { layers: [textLayer(0, 6_000, 9_000)] });
    expect(ranges(ok(trimLayer(out, 0, "end", 8_500)))).toEqual([["layer-001", 6_000, 8_500]]);
    expect(trimLayer(out, 0, "end", 9_100)).toEqual({ ok: false, reason: "outside-montage" });
    const same = trimLayer(out, 0, "end", 9_000);
    expect(same.ok && same.spec === out).toBe(true);
  });

  test("an edge's range: the start from 0 to 0.3 s before the end; the end from 0.3 s after the start to the montage's end", () => {
    expect(edgeRange(spec, 0, "start")).toEqual({ min: 0, max: 4_100 });
    expect(edgeRange(spec, 0, "end")).toEqual({ min: 600, max: 8_000 });
    expect(edgeRange(draftSpec(4, { layers: [textLayer(0, 6_000, 9_000)] }), 0, "end")).toEqual({ min: 6_300, max: 9_000 });
    // A montage longer than 15 s (a draft from elsewhere) still holds no layer past 15 s.
    const long = draftSpec([...draftSpec(8).clips.map((c) => ({ ...c, durationMs: 2_500 }))], { layers: [textLayer(0, 14_000, 15_000)] });
    expect(edgeRange(long, 0, "end")).toEqual({ min: 14_300, max: MAX_TOTAL_MS });
  });

  test("a drag's edge is snapped to 100 ms and held inside its range", () => {
    expect(clampEdge(spec, 0, "end", 5_049)).toBe(5_000);
    expect(clampEdge(spec, 0, "end", 12_000)).toBe(8_000);
    expect(clampEdge(spec, 0, "end", 0)).toBe(600);
    expect(clampEdge(spec, 0, "start", 4_390)).toBe(4_100);
  });
});

describe("z-order: later is on top; a step passes the next layer that is on screen at the same time", () => {
  // A 0–2 s, B 5–6 s (alone), C 1–3 s, D 1.5–2.5 s.
  const spec = draftSpec(4, { layers: [textLayer(0, 0, 2_000), stickerLayer(1, 5_000, 6_000), textLayer(2, 1_000, 3_000), stickerLayer(3, 1_500, 2_500)] });

  test("raising A puts it right above C, then above D, then it is on top", () => {
    const once = ok(raiseLayer(spec, 0));
    expect(order(once)).toEqual(["layer-002", "layer-003", "layer-001", "layer-004"]);
    const twice = ok(raiseLayer(once, 2));
    expect(order(twice)).toEqual(["layer-002", "layer-003", "layer-004", "layer-001"]);
    expect(raiseLayer(twice, 3)).toEqual({ ok: false, reason: "top" });
  });

  test("lowering D puts it right below C, then below A, then it is at the bottom", () => {
    const once = ok(lowerLayer(spec, 3));
    expect(order(once)).toEqual(["layer-001", "layer-002", "layer-004", "layer-003"]);
    const twice = ok(lowerLayer(once, 2));
    expect(order(twice)).toEqual(["layer-004", "layer-001", "layer-002", "layer-003"]);
    expect(lowerLayer(twice, 0)).toEqual({ ok: false, reason: "bottom" });
  });

  test("a layer alone on screen is both on top and at the bottom; touching ranges do not share the screen", () => {
    expect(raiseLayer(spec, 1)).toEqual({ ok: false, reason: "top" });
    expect(lowerLayer(spec, 1)).toEqual({ ok: false, reason: "bottom" });
    const touching = draftSpec(4, { layers: [textLayer(0, 0, 1_000), textLayer(1, 1_000, 2_000)] });
    expect(raiseLayer(touching, 0)).toEqual({ ok: false, reason: "top" });
    expect(lowerLayer(touching, 1)).toEqual({ ok: false, reason: "bottom" });
  });

  test("the extremes of the array: the last layer is never raised, the first never lowered", () => {
    expect(raiseLayer(spec, 3)).toEqual({ ok: false, reason: "top" });
    expect(lowerLayer(spec, 0)).toEqual({ ok: false, reason: "bottom" });
    expect(() => raiseLayer(spec, 4)).toThrow(RangeError);
  });

  test("text and stickers share one z-order, and nothing but the order changes", () => {
    const once = ok(raiseLayer(spec, 2));
    expect(order(once)).toEqual(["layer-001", "layer-002", "layer-004", "layer-003"]);
    expect([...once.layers].sort((a, b) => a.layerId.localeCompare(b.layerId))).toEqual([...spec.layers].sort((a, b) => a.layerId.localeCompare(b.layerId)));
  });
});

describe("split, copy and delete (CF4: a layer may be split and copied)", () => {
  const spec = draftSpec(3, { layers: [textLayer(0, 300, 4_400), stickerLayer(1, 1_000, 2_000)] });

  test("removing a layer keeps the others in z-order", () => {
    expect(removeLayer(spec, 0).layers.map((l) => l.layerId)).toEqual(["layer-002"]);
    expect(() => removeLayer(spec, 2)).toThrow(RangeError);
  });

  test("a split keeps 0.3 s on both sides; the second part is a new layer right above the first", () => {
    const split = ok(splitLayerAt(spec, 0, 600));
    expect(split.layers.map((l) => [l.layerId, l.startMs, l.endMs])).toEqual([
      ["layer-001", 300, 600],
      ["layer-003", 600, 4_400],
      ["layer-002", 1_000, 2_000],
    ]);
    expect(splitLayerAt(spec, 0, 500)).toEqual({ ok: false, reason: "too-short" });
    expect(splitLayerAt(spec, 0, 4_200)).toEqual({ ok: false, reason: "too-short" });
    expect(splitLayerAt(spec, 0, 300)).toEqual({ ok: false, reason: "not-splittable" });
    expect(() => splitLayerAt(spec, 0, Number.NaN)).toThrow(RangeError);
  });

  test("a copy is a new layer over the same range, right above; ten of a kind is the cap", () => {
    const copy = ok(duplicateLayer(spec, 1));
    expect(copy.layers.map((l) => l.layerId)).toEqual(["layer-001", "layer-002", "layer-003"]);
    expect(copy.layers[2]).toMatchObject({ kind: "sticker", startMs: 1_000, endMs: 2_000 });
    const tenTexts = draftSpec(3, { layers: texts(MAX_TEXT_LAYERS) });
    expect(duplicateLayer(tenTexts, 0)).toEqual({ ok: false, reason: "layer-cap" });
    expect(splitLayerAt(tenTexts, 0, 500)).toEqual({ ok: false, reason: "layer-cap" });
  });
});

describe("rows: a kind's blocks packed so that none covers another (packing only, AM11)", () => {
  test("no layers, no rows; layers apart share the first row", () => {
    expect(layerRows([])).toEqual({ rows: [], count: 0 });
    expect(layerRows([textLayer(0, 0, 1_000), textLayer(1, 2_000, 3_000), textLayer(2, 1_000, 2_000)])).toEqual({ rows: [0, 0, 0], count: 1 });
  });

  test("an overlap goes to the next free row, in z-order", () => {
    expect(layerRows([textLayer(0, 0, 2_000), textLayer(1, 1_000, 3_000), textLayer(2, 2_000, 4_000), textLayer(3, 500, 3_500)])).toEqual({ rows: [0, 1, 0, 2], count: 3 });
  });
});
