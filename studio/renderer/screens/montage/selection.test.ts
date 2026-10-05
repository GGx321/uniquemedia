import { describe, expect, test } from "bun:test";
import { MontageDraft } from "../../../shared/engine";
import { duplicateSelected, lowerSelected, raiseSelected, removeSelected, resolveSelection, selectClip, selectionActions, splitSelected, type Applied } from "./selection";
import { collageClip, draftSpec, photoClip, photoClips, stickerLayer, textLayer, videoClip } from "./testkit";

// 3d.3a: one item selected at a time (a clip and one of its cells, a text or sticker layer, or the music). The
// selection names the item by id, so it survives a reorder and an undo; an item that is gone selects nothing.

const MUSIC = { source: "trending", trackId: "track-espresso-01", startMs: 42_000 } as const;
/** Only a text or a sticker has a place in the z-order. */
const NOT_LAYER = { enabled: false, why: "not-a-layer" } as const;

function applied(result: Applied | string | null): Applied {
  if (result === null || typeof result === "string") throw new Error(`not applied: ${String(result)}`);
  expect(MontageDraft.safeParse(result.spec).success).toBe(true);
  return result;
}

describe("resolving the selection against the draft", () => {
  const spec = draftSpec([photoClip(0, "photo-mia-0001"), collageClip(1, ["photo-mia-0002", null, null])], { layers: [textLayer(0, 0, 1_000)], music: MUSIC });

  test("a clip by its id, wherever it is now, with its cell", () => {
    expect(resolveSelection(spec, { kind: "clip", clipId: "clip-002", cell: 2 })).toMatchObject({ kind: "clip", index: 1, cell: 2 });
    const moved = { ...spec, clips: [...spec.clips].reverse() };
    expect(resolveSelection(moved, { kind: "clip", clipId: "clip-002", cell: 2 })).toMatchObject({ kind: "clip", index: 0 });
  });

  test("a cell past the clip's cells falls back to the last one (a layout switched to fewer cells)", () => {
    expect(resolveSelection(spec, { kind: "clip", clipId: "clip-002", cell: 3 })).toMatchObject({ cell: 2 });
    expect(resolveSelection(spec, { kind: "clip", clipId: "clip-001", cell: 1 })).toMatchObject({ cell: 0 });
    expect(resolveSelection(draftSpec([videoClip(0)]), { kind: "clip", clipId: "clip-001", cell: 2 })).toMatchObject({ cell: 0 });
  });

  test("a gone item (an undo, a delete elsewhere), no music, or nothing: null", () => {
    expect(resolveSelection(spec, null)).toBeNull();
    expect(resolveSelection(spec, { kind: "clip", clipId: "clip-009", cell: 0 })).toBeNull();
    expect(resolveSelection(spec, { kind: "layer", layerId: "layer-009" })).toBeNull();
    expect(resolveSelection(draftSpec(1), { kind: "music" })).toBeNull();
    expect(resolveSelection(spec, { kind: "layer", layerId: "layer-001" })).toMatchObject({ kind: "layer", index: 0 });
    expect(resolveSelection(spec, { kind: "music" })).toEqual({ kind: "music" });
  });

  test("selecting a clip by its place names it by id", () => {
    expect(selectClip(spec, 1)).toEqual({ kind: "clip", clipId: "clip-002", cell: 0 });
    expect(selectClip(spec, 1, 2)).toEqual({ kind: "clip", clipId: "clip-002", cell: 2 });
    expect(() => selectClip(spec, 2)).toThrow(RangeError);
  });
});

describe("what the toolbar can do with the selection", () => {
  const spec = draftSpec([photoClip(0, "photo-mia-0001", 1_000), videoClip(1, 2_000), collageClip(2, ["photo-mia-0002", "photo-mia-0003"], 2_000)], {
    layers: [textLayer(0, 300, 1_500)],
    music: MUSIC,
  });
  const clip = (clipId: string) => ({ kind: "clip", clipId, cell: 0 }) as const;

  test("nothing selected: nothing to split, copy or delete", () => {
    expect(selectionActions(spec, null, 0)).toEqual({
      split: { enabled: false, why: "nothing-selected" },
      duplicate: { enabled: false, why: "nothing-selected" },
      remove: { enabled: false, why: "nothing-selected" },
      raise: { enabled: false, why: "nothing-selected" },
      lower: { enabled: false, why: "nothing-selected" },
    });
  });

  test("a photo or collage clip is never split (CF4); it is copied and deleted", () => {
    for (const id of ["clip-001", "clip-003"]) {
      expect(selectionActions(spec, clip(id), 500)).toEqual({ split: { enabled: false, why: "photo-split" }, duplicate: { enabled: true }, remove: { enabled: true }, raise: NOT_LAYER, lower: NOT_LAYER });
    }
  });

  test("a video clip splits with the playhead inside it and a step (0.1 s) on both sides", () => {
    expect(selectionActions(spec, clip("clip-002"), 2_000).split).toEqual({ enabled: true });
    expect(selectionActions(spec, clip("clip-002"), 1_500).split).toEqual({ enabled: true });
    expect(selectionActions(spec, clip("clip-002"), 1_100).split).toEqual({ enabled: true });
    expect(selectionActions(spec, clip("clip-002"), 2_900).split).toEqual({ enabled: true });
    // Less than a step from an edge snaps onto the edge: that is outside the clip, not too short.
    expect(selectionActions(spec, clip("clip-002"), 1_040).split).toEqual({ enabled: false, why: "playhead-outside" });
    expect(selectionActions(spec, clip("clip-002"), 1_000).split).toEqual({ enabled: false, why: "playhead-outside" });
    expect(selectionActions(spec, clip("clip-002"), 3_000).split).toEqual({ enabled: false, why: "playhead-outside" });
  });

  test("a copy needs a free clip and room: a 100 ms step is enough, none at 15 s", () => {
    const full = draftSpec(photoClips(20, 500));
    expect(selectionActions(full, clip("clip-001"), 0).duplicate).toEqual({ enabled: false, why: "clip-cap" });
    const last = draftSpec([photoClip(0, "photo-mia-0001", 14_900)]);
    expect(selectionActions(last, clip("clip-001"), 0).duplicate).toEqual({ enabled: true });
    const long = draftSpec([photoClip(0, "photo-mia-0001", 15_000)]);
    expect(selectionActions(long, clip("clip-001"), 0).duplicate).toEqual({ enabled: false, why: "no-room" });
  });

  test("a layer splits inside its range with 0.3 s on both sides; ten of a kind stop a copy", () => {
    const layer = { kind: "layer", layerId: "layer-001" } as const;
    expect(selectionActions(spec, layer, 900)).toEqual({ split: { enabled: true }, duplicate: { enabled: true }, remove: { enabled: true }, raise: { enabled: false, why: "top" }, lower: { enabled: false, why: "bottom" } });
    expect(selectionActions(spec, layer, 400).split).toEqual({ enabled: false, why: "too-short" });
    expect(selectionActions(spec, layer, 1_500).split).toEqual({ enabled: false, why: "playhead-outside" });
    const ten = draftSpec(1, { layers: Array.from({ length: 10 }, (_, i) => textLayer(i, 0, 1_000)) });
    expect(selectionActions(ten, layer, 500).duplicate).toEqual({ enabled: false, why: "layer-cap" });
  });

  test("the music is deleted, never split or copied", () => {
    expect(selectionActions(spec, { kind: "music" }, 500)).toEqual({ split: { enabled: false, why: "music" }, duplicate: { enabled: false, why: "music" }, remove: { enabled: true }, raise: NOT_LAYER, lower: NOT_LAYER });
  });
});

describe("acting on the selection", () => {
  const spec = draftSpec([photoClip(0, "photo-mia-0001", 1_000), videoClip(1, 2_000)], { layers: [stickerLayer(0, 0, 900)], music: MUSIC });

  test("delete removes the item and selects nothing", () => {
    expect(applied(removeSelected(spec, { kind: "clip", clipId: "clip-001", cell: 0 }))).toEqual({ spec: { ...spec, clips: spec.clips.slice(1) }, selection: null });
    expect(applied(removeSelected(spec, { kind: "layer", layerId: "layer-001" })).spec.layers).toEqual([]);
    expect(applied(removeSelected(spec, { kind: "music" })).spec.music).toBeNull();
    expect(removeSelected(spec, null)).toBeNull();
    expect(removeSelected(spec, { kind: "clip", clipId: "clip-009", cell: 0 })).toBeNull();
  });

  test("a copy is selected; a refused copy says why", () => {
    const copy = applied(duplicateSelected(spec, { kind: "clip", clipId: "clip-001", cell: 0 }));
    expect(copy.selection).toEqual({ kind: "clip", clipId: "clip-003", cell: 0 });
    expect(duplicateSelected(draftSpec(photoClips(20, 500)), { kind: "clip", clipId: "clip-001", cell: 0 })).toBe("clip-cap");
    const layerCopy = applied(duplicateSelected(spec, { kind: "layer", layerId: "layer-001" }));
    expect(layerCopy.selection).toEqual({ kind: "layer", layerId: "layer-002" });
  });

  test("after a split the second part is selected", () => {
    const split = applied(splitSelected(spec, { kind: "clip", clipId: "clip-002", cell: 0 }, 1_600));
    expect(split.spec.clips.map((c) => c.durationMs)).toEqual([1_000, 600, 1_400]);
    expect(split.selection).toEqual({ kind: "clip", clipId: "clip-003", cell: 0 });
    expect(splitSelected(spec, { kind: "clip", clipId: "clip-001", cell: 0 }, 500)).toBe("not-splittable");
    expect(applied(splitSelected(spec, { kind: "layer", layerId: "layer-001" }, 400)).selection).toEqual({ kind: "layer", layerId: "layer-002" });
  });
});

describe("the selected layer's place in the z-order («Слой выше» / «Слой ниже», 3d.3b)", () => {
  // A text 0–2 s under a sticker 1–3 s, and a text 5–6 s that shares the screen with neither.
  const spec = draftSpec(4, { layers: [textLayer(0, 0, 2_000), stickerLayer(1, 1_000, 3_000), textLayer(2, 5_000, 6_000)], music: MUSIC });
  const layer = (layerId: string) => ({ kind: "layer", layerId }) as const;

  test("a layer under another can go up, not down; the one above it the other way; one alone neither way", () => {
    expect(selectionActions(spec, layer("layer-001"), 0)).toMatchObject({ raise: { enabled: true }, lower: { enabled: false, why: "bottom" } });
    expect(selectionActions(spec, layer("layer-002"), 0)).toMatchObject({ raise: { enabled: false, why: "top" }, lower: { enabled: true } });
    expect(selectionActions(spec, layer("layer-003"), 0)).toMatchObject({ raise: { enabled: false, why: "top" }, lower: { enabled: false, why: "bottom" } });
  });

  test("a clip and the music have no z-order", () => {
    expect(selectionActions(spec, { kind: "clip", clipId: "clip-001", cell: 0 }, 0)).toMatchObject({ raise: NOT_LAYER, lower: NOT_LAYER });
    expect(selectionActions(spec, { kind: "music" }, 0)).toMatchObject({ raise: NOT_LAYER, lower: NOT_LAYER });
  });

  test("raising and lowering keep the layer selected; a refusal says why", () => {
    const up = applied(raiseSelected(spec, layer("layer-001")));
    expect(up.spec.layers.map((l) => l.layerId)).toEqual(["layer-002", "layer-001", "layer-003"]);
    expect(up.selection).toEqual(layer("layer-001"));
    const down = applied(lowerSelected(up.spec, layer("layer-001")));
    expect(down.spec.layers.map((l) => l.layerId)).toEqual(["layer-001", "layer-002", "layer-003"]);
    expect(down.selection).toEqual(layer("layer-001"));
    expect(raiseSelected(spec, layer("layer-003"))).toBe("top");
    expect(lowerSelected(spec, layer("layer-001"))).toBe("bottom");
    expect(raiseSelected(spec, { kind: "music" })).toBe("not-a-layer");
    expect(lowerSelected(spec, null)).toBe("not-a-layer");
  });
});
