import { MAX_STICKER_LAYERS, MAX_TEXT_LAYERS, MIN_LAYER_MS, type Clip, type Layer, type MontageDraft } from "../../../shared/engine";
import { MIN_CLIP_MS, STEP_MS } from "../../../shared/montage";
import { addRefusal, cellsOf, clipStartMs, duplicateClip, duplicateLayer, type Edit, type Refusal, removeClip, removeLayer, splitClipAt, splitLayerAt } from "./clipOps";

// 3d.3a: the timeline's one selected item (a clip and one of its cells, a text or sticker layer, or the music), and
// what the toolbar's «Разрезать по плейхеду», «Дублировать выбранное» and «Удалить выбранное» can do with it. The
// selection is renderer state, never saved; it names the item by id, so it survives a reorder and an undo, and an
// item that is gone (undone, deleted in another window) selects nothing.

export type Selection =
  | { readonly kind: "clip"; readonly clipId: string; readonly cell: number }
  | { readonly kind: "layer"; readonly layerId: string }
  | { readonly kind: "music" };

/** The selection found in the draft: where the item is now, and the cell a clip's «Ячейки» picker shows. */
export type Resolved =
  | { readonly kind: "clip"; readonly index: number; readonly clip: Clip; readonly cell: number }
  | { readonly kind: "layer"; readonly index: number; readonly layer: Layer }
  | { readonly kind: "music" };

/**
 * Why a toolbar action is off:
 * - `nothing-selected`;
 * - `photo-split`: a photo or collage clip is never split (CF4: its photo would repeat);
 * - `playhead-outside`: the playhead is not strictly inside the selected item;
 * - `too-short`: a part would be under its minimum (0.5 s for a clip, 0.3 s for a layer);
 * - `clip-cap` / `no-room` / `layer-cap`: no place for a copy (`Refusal`'s meaning);
 * - `music`: the one track is neither split nor copied.
 */
export type ActionBlock = "nothing-selected" | "photo-split" | "playhead-outside" | "too-short" | "clip-cap" | "no-room" | "layer-cap" | "music";

export type ActionState = { readonly enabled: true } | { readonly enabled: false; readonly why: ActionBlock };

export interface Actions {
  readonly split: ActionState;
  readonly duplicate: ActionState;
  readonly remove: ActionState;
}

/** An action's result: the new draft and what is selected after it. */
export interface Applied {
  readonly spec: MontageDraft;
  readonly selection: Selection | null;
}

export function resolveSelection(spec: MontageDraft, selection: Selection | null): Resolved | null {
  if (selection === null) return null;
  switch (selection.kind) {
    case "clip": {
      const index = spec.clips.findIndex((c) => c.clipId === selection.clipId);
      const clip = spec.clips[index];
      if (clip === undefined) return null;
      const last = Math.max(0, cellsOf(clip).length - 1);
      return { kind: "clip", index, clip, cell: Math.min(Math.max(0, selection.cell), last) };
    }
    case "layer": {
      const index = spec.layers.findIndex((l) => l.layerId === selection.layerId);
      const layer = spec.layers[index];
      return layer === undefined ? null : { kind: "layer", index, layer };
    }
    case "music":
      return spec.music === null ? null : { kind: "music" };
  }
}

/** Clip `index` (and its cell `cell`) as a selection. */
export function selectClip(spec: MontageDraft, index: number, cell = 0): Selection {
  const clip = spec.clips[index];
  if (!Number.isSafeInteger(index) || clip === undefined) throw new RangeError(`clip index must be 0..${spec.clips.length - 1}, got ${index}`);
  return { kind: "clip", clipId: clip.clipId, cell };
}

const ON: ActionState = { enabled: true };
const off = (why: ActionBlock): ActionState => ({ enabled: false, why });

/** Can `[startMs, endMs)` be cut at `atMs` with `minMs` on both sides? */
function splitState(startMs: number, endMs: number, atMs: number, minMs: number): ActionState {
  const at = Math.round(atMs / STEP_MS) * STEP_MS;
  if (at <= startMs || at >= endMs) return off("playhead-outside");
  if (at - startMs < minMs || endMs - at < minMs) return off("too-short");
  return ON;
}

const refusalBlock = (why: Refusal | null): ActionState => (why === null ? ON : why === "clip-cap" || why === "no-room" || why === "layer-cap" ? off(why) : off("too-short"));

/** What the toolbar can do with the selection, the playhead at `playheadMs`. */
export function selectionActions(spec: MontageDraft, selection: Selection | null, playheadMs: number): Actions {
  const item = resolveSelection(spec, selection);
  if (item === null) return { split: off("nothing-selected"), duplicate: off("nothing-selected"), remove: off("nothing-selected") };
  if (item.kind === "music") return { split: off("music"), duplicate: off("music"), remove: ON };
  if (item.kind === "layer") {
    const { layer } = item;
    const full = spec.layers.filter((l) => l.kind === layer.kind).length >= (layer.kind === "text" ? MAX_TEXT_LAYERS : MAX_STICKER_LAYERS);
    const split = splitState(layer.startMs, layer.endMs, playheadMs, MIN_LAYER_MS);
    return { split: split.enabled && full ? off("layer-cap") : split, duplicate: full ? off("layer-cap") : ON, remove: ON };
  }
  const { clip, index } = item;
  const start = clipStartMs(spec, index);
  const split = clip.kind === "video" ? splitState(start, start + clip.durationMs, playheadMs, MIN_CLIP_MS) : off("photo-split");
  const cap = addRefusal(spec);
  return { split: split.enabled && cap === "clip-cap" ? off("clip-cap") : split, duplicate: refusalBlock(cap), remove: ON };
}

/** «Удалить выбранное» (and Delete): the item goes, nothing stays selected; null when there is nothing to delete. */
export function removeSelected(spec: MontageDraft, selection: Selection | null): Applied | null {
  const item = resolveSelection(spec, selection);
  if (item === null) return null;
  if (item.kind === "music") return { spec: { ...spec, music: null }, selection: null };
  if (item.kind === "layer") return { spec: removeLayer(spec, item.index), selection: null };
  return { spec: removeClip(spec, item.index), selection: null };
}

function selectCreated(edit: Edit, kind: "clip" | "layer"): Applied | Refusal {
  if (!edit.ok) return edit.reason;
  const selection: Selection | null = edit.id === undefined ? null : kind === "clip" ? { kind: "clip", clipId: edit.id, cell: 0 } : { kind: "layer", layerId: edit.id };
  return { spec: edit.spec, selection };
}

/** «Дублировать выбранное»: the copy is selected. */
export function duplicateSelected(spec: MontageDraft, selection: Selection | null): Applied | Refusal {
  const item = resolveSelection(spec, selection);
  if (item === null || item.kind === "music") return "not-splittable";
  return item.kind === "layer" ? selectCreated(duplicateLayer(spec, item.index), "layer") : selectCreated(duplicateClip(spec, item.index), "clip");
}

/** «Разрезать по плейхеду»: the second part is selected. */
export function splitSelected(spec: MontageDraft, selection: Selection | null, playheadMs: number): Applied | Refusal {
  const item = resolveSelection(spec, selection);
  if (item === null || item.kind === "music") return "not-splittable";
  return item.kind === "layer" ? selectCreated(splitLayerAt(spec, item.index, playheadMs), "layer") : selectCreated(splitClipAt(spec, item.index, playheadMs), "clip");
}
