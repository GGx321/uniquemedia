import { describe, expect, test } from "bun:test";
import { MontageDraft } from "../../../shared/engine";
import { duplicateSelected, removeSelected, resolveSelection, selectClip, selectionActions, splitSelected, type Applied } from "./selection";
import { collageClip, draftSpec, photoClip, photoClips, stickerLayer, textLayer, videoClip } from "./testkit";

// 3d.3a: one item selected at a time (a clip and one of its cells, a text or sticker layer, or the music). The
// selection names the item by id, so it survives a reorder and an undo; an item that is gone selects nothing.

const MUSIC = { source: "trending", trackId: "track-espresso-01", startMs: 42_000 } as const;

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
    });
  });

  test("a photo or collage clip is never split (CF4); it is copied and deleted", () => {
    for (const id of ["clip-001", "clip-003"]) {
      expect(selectionActions(spec, clip(id), 500)).toEqual({ split: { enabled: false, why: "photo-split" }, duplicate: { enabled: true }, remove: { enabled: true } });
    }
  });

  test("a video clip splits with the playhead inside it and 0.5 s on both sides", () => {
    expect(selectionActions(spec, clip("clip-002"), 2_000).split).toEqual({ enabled: true });
    expect(selectionActions(spec, clip("clip-002"), 1_500).split).toEqual({ enabled: true });
    expect(selectionActions(spec, clip("clip-002"), 1_400).split).toEqual({ enabled: false, why: "too-short" });
    expect(selectionActions(spec, clip("clip-002"), 1_000).split).toEqual({ enabled: false, why: "playhead-outside" });
    expect(selectionActions(spec, clip("clip-002"), 3_000).split).toEqual({ enabled: false, why: "playhead-outside" });
  });

  test("a copy needs a free clip and 0.5 s of room", () => {
    const full = draftSpec(photoClips(20, 500));
    expect(selectionActions(full, clip("clip-001"), 0).duplicate).toEqual({ enabled: false, why: "clip-cap" });
    const long = draftSpec([photoClip(0, "photo-mia-0001", 14_600)]);
    expect(selectionActions(long, clip("clip-001"), 0).duplicate).toEqual({ enabled: false, why: "no-room" });
  });

  test("a layer splits inside its range with 0.3 s on both sides; ten of a kind stop a copy", () => {
    const layer = { kind: "layer", layerId: "layer-001" } as const;
    expect(selectionActions(spec, layer, 900)).toEqual({ split: { enabled: true }, duplicate: { enabled: true }, remove: { enabled: true } });
    expect(selectionActions(spec, layer, 400).split).toEqual({ enabled: false, why: "too-short" });
    expect(selectionActions(spec, layer, 1_500).split).toEqual({ enabled: false, why: "playhead-outside" });
    const ten = draftSpec(1, { layers: Array.from({ length: 10 }, (_, i) => textLayer(i, 0, 1_000)) });
    expect(selectionActions(ten, layer, 500).duplicate).toEqual({ enabled: false, why: "layer-cap" });
  });

  test("the music is deleted, never split or copied", () => {
    expect(selectionActions(spec, { kind: "music" }, 500)).toEqual({ split: { enabled: false, why: "music" }, duplicate: { enabled: false, why: "music" }, remove: { enabled: true } });
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
