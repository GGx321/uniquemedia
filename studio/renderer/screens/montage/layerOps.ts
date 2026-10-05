import { MAX_STICKER_LAYERS, MAX_TEXT_LAYERS, MIN_LAYER_MS, type Layer, type MontageDraft, type TextFont, type TextStyle } from "../../../shared/engine";
import { DEFAULT_STICKER, DEFAULT_TEXT_Y, MAX_TOTAL_MS, STEP_MS } from "../../../shared/montage";
import { stickerById } from "../../../shared/stickers/manifest";
import { nextLayerId, totalMs } from "./clipOps";

// 3d.3b: the text and sticker tracks' edits, as pure functions over a draft (the sibling of clipOps.ts). The editor
// sends each result through `DraftSession.edit`, so every one is an undo step and is saved like any other edit. What
// every result keeps (the tests pin it):
// - the contract's draft rules (`MontageDraft`): every layer time on the 100 ms grid within 0–15 s, every layer at
//   least 0.3 s long, unique ids, at most 10 texts and 10 stickers (20 layers in all, 3b.6);
// - the editor's own rule: an edit never pushes a layer's end further past the montage's end. A layer the owner
//   left past the end (by shortening the clips under it) may come back, never go further out; anything else that would
//   end past the end is REFUSED (`outside-montage`), and no layer is ever shortened or moved to make it fit. The `*Range`
//   and `clamp*` helpers say where a drag may go, keeping the layer's length as it is.
//
// A refusal the owner can meet (a cap, no room, too short) is a `LayerRefusal`; an index outside the draft is a
// programming error and throws a RangeError, like clipOps does.

export type LayerKind = Layer["kind"];
export type LayerEdge = "start" | "end";

/**
 * Why a layer edit was not made:
 * - `layer-cap`: 10 layers of that kind already (10 + 10 is the montage's 20);
 * - `no-room`: less than 0.3 s from the playhead to the montage's end;
 * - `too-short`: the layer, or a part of a split, would be under 0.3 s (zero length included);
 * - `outside-montage`: the layer would start before 0 or end (further) past the montage's end;
 * - `not-splittable`: the point is not strictly inside the layer;
 * - `top` / `bottom`: no layer on screen at the same time is above / below it.
 */
export type LayerRefusal = "layer-cap" | "no-room" | "too-short" | "outside-montage" | "not-splittable" | "top" | "bottom";

/** A layer edit's result: the new draft and the id of a layer it created (to select it), or why not. */
export type LayerEdit = { readonly ok: true; readonly spec: MontageDraft; readonly id?: string } | { readonly ok: false; readonly reason: LayerRefusal };

/** Where something may go, both ends included. */
export interface Range {
  readonly min: number;
  readonly max: number;
}

/** A new layer lasts this long when the montage has the time for it (AM7). */
export const ADD_LAYER_MS = 3_000;
/**
 * «Добавить текст»'s caption (AM7: the first preset, «Плашка · Manrope», with a neutral sample). Plain English, so it
 * passes the caption rules as it is; the owner types his own in the text's properties (3d.5).
 */
export const DEFAULT_TEXT_VALUE = "your text";

const refuse = (reason: LayerRefusal): LayerEdit => ({ ok: false, reason });
const done = (spec: MontageDraft, id?: string): LayerEdit => (id === undefined ? { ok: true, spec } : { ok: true, spec, id });

function layerAt(spec: MontageDraft, index: number): Layer {
  if (!Number.isSafeInteger(index) || index < 0 || index >= spec.layers.length) throw new RangeError(`layer index must be 0..${spec.layers.length - 1}, got ${index}`);
  const layer = spec.layers[index];
  if (layer === undefined) throw new RangeError(`no layer at ${index}`);
  return layer;
}

function assertTime(ms: number, what: string): void {
  if (!Number.isFinite(ms)) throw new RangeError(`${what} must be a finite number, got ${ms}`);
}

/** The nearest 100 ms step. */
const snap = (ms: number): number => Math.round(ms / STEP_MS) * STEP_MS;
const clamp = (ms: number, range: Range): number => Math.min(range.max, Math.max(range.min, ms));
const withLayers = (spec: MontageDraft, layers: Layer[]): MontageDraft => ({ ...spec, layers });
const replaceLayer = (spec: MontageDraft, index: number, layer: Layer): MontageDraft => withLayers(spec, spec.layers.map((l, i) => (i === index ? layer : l)));

/** How many layers of `kind` the draft holds. */
export function layerCount(spec: MontageDraft, kind: LayerKind): number {
  return spec.layers.filter((l) => l.kind === kind).length;
}

/** The cap of a kind: 10 texts, 10 stickers. */
export const layerCap = (kind: LayerKind): number => (kind === "text" ? MAX_TEXT_LAYERS : MAX_STICKER_LAYERS);

// Ten texts and ten stickers are the montage's 20 layers (`MAX_LAYERS`, 3b.6): the two caps hold the total too.
const capReached = (spec: MontageDraft, kind: LayerKind): boolean => layerCount(spec, kind) >= layerCap(kind);

/** Where a layer added at a playhead of `atMs` starts: the 100 ms step the playhead is in (a playing clock is between steps). */
function addStart(atMs: number): number {
  assertTime(atMs, "the playhead");
  if (atMs < 0) throw new RangeError(`the playhead must not be negative, got ${atMs}`);
  return Math.floor(atMs / STEP_MS) * STEP_MS;
}

/** Where a new layer must end by: the montage's end, and never past 15 s (a draft from elsewhere may run longer). */
const addLimit = (spec: MontageDraft): number => Math.min(totalMs(spec), MAX_TOTAL_MS);

/** Why no layer of `kind` can be added at the playhead `atMs`, or null. The cap is told first. */
export function addLayerRefusal(spec: MontageDraft, kind: LayerKind, atMs: number): "layer-cap" | "no-room" | null {
  const start = addStart(atMs);
  if (capReached(spec, kind)) return "layer-cap";
  if (addLimit(spec) - start < MIN_LAYER_MS) return "no-room";
  return null;
}

/** A new layer from the playhead for `min(3.0 s, the rest of the montage)`, on top of the others. */
function addLayer(spec: MontageDraft, kind: LayerKind, atMs: number, make: (base: { layerId: string; startMs: number; endMs: number }) => Layer): LayerEdit {
  const why = addLayerRefusal(spec, kind, atMs);
  if (why !== null) return refuse(why);
  const startMs = addStart(atMs);
  const layerId = nextLayerId(spec);
  const layer = make({ layerId, startMs, endMs: startMs + Math.min(ADD_LAYER_MS, addLimit(spec) - startMs) });
  return done(withLayers(spec, [...spec.layers, layer]), layerId);
}

/**
 * «Добавить текст»: the first preset («Плашка · Manrope», white) with the neutral sample, where the mockup sets a text. A «Стили»
 * preset (3d.5, T2) adds its own font, style and sample instead; the colour is the styles' default, white.
 */
export function addTextLayer(spec: MontageDraft, atMs: number, preset?: { readonly font: TextFont; readonly style: TextStyle; readonly sample: string }): LayerEdit {
  const look = preset === undefined ? { value: DEFAULT_TEXT_VALUE, font: "manrope" as const, style: "plaque" as const } : { value: preset.sample, font: preset.font, style: preset.style };
  return addLayer(spec, "text", atMs, (base) => ({ ...base, kind: "text", ...look, color: "#ffffff", x: 0.5, y: DEFAULT_TEXT_Y, scale: 1 }));
}

/** A built-in sticker at the playhead, where and as large as the mockup sets one. */
export function addStickerLayer(spec: MontageDraft, atMs: number, stickerId: string): LayerEdit {
  if (stickerById(stickerId) === undefined) throw new RangeError(`no built-in sticker ${stickerId}`);
  return addLayer(spec, "sticker", atMs, (base) => ({ ...base, kind: "sticker", sticker: { source: "builtin", stickerId }, x: DEFAULT_STICKER.x, y: DEFAULT_STICKER.y, size: DEFAULT_STICKER.size }));
}

/** An own sticker from «Мои» (3f.6, M12) at the playhead: where and as large as a built-in one, by the same caps and room. */
export function addOwnStickerLayer(spec: MontageDraft, atMs: number, mediaId: string): LayerEdit {
  return addLayer(spec, "sticker", atMs, (base) => ({ ...base, kind: "sticker", sticker: { source: "own", mediaId }, x: DEFAULT_STICKER.x, y: DEFAULT_STICKER.y, size: DEFAULT_STICKER.size }));
}

export function removeLayer(spec: MontageDraft, index: number): MontageDraft {
  layerAt(spec, index);
  return withLayers(spec, spec.layers.filter((_, i) => i !== index));
}

/**
 * The furthest a layer's end may go: the montage's end, or its own end when that is already past it (it may only come
 * back), and never past 15 s (a draft from elsewhere may run longer than the editor's own 15 s).
 */
function endLimit(spec: MontageDraft, layer: Layer): number {
  return Math.min(MAX_TOTAL_MS, Math.max(totalMs(spec), layer.endMs));
}

/** Where layer `index` may start when it is moved: from 0 to the last start that keeps its whole length in the montage. */
export function startRange(spec: MontageDraft, index: number): Range {
  const layer = layerAt(spec, index);
  return { min: 0, max: Math.max(0, endLimit(spec, layer) - (layer.endMs - layer.startMs)) };
}

/** A drag's start for layer `index`: the nearest 100 ms, inside `startRange`. */
export function clampStart(spec: MontageDraft, index: number, wantedMs: number): number {
  assertTime(wantedMs, "a start");
  return clamp(snap(wantedMs), startRange(spec, index));
}

/** Layer `index` moved to start at `startMs` (the nearest 100 ms), its length kept; the same draft when it stays. */
export function moveLayer(spec: MontageDraft, index: number, startMs: number): LayerEdit {
  const layer = layerAt(spec, index);
  assertTime(startMs, "a start");
  const start = snap(startMs);
  if (start === layer.startMs) return done(spec);
  const end = start + (layer.endMs - layer.startMs);
  if (start < 0 || end > endLimit(spec, layer)) return refuse("outside-montage");
  return done(replaceLayer(spec, index, { ...layer, startMs: start, endMs: end }));
}

/** Where an edge of layer `index` may go: the start from 0 to 0.3 s before the end, the end from 0.3 s after the start to its limit. */
export function edgeRange(spec: MontageDraft, index: number, edge: LayerEdge): Range {
  const layer = layerAt(spec, index);
  return edge === "start" ? { min: 0, max: layer.endMs - MIN_LAYER_MS } : { min: layer.startMs + MIN_LAYER_MS, max: endLimit(spec, layer) };
}

/** A drag's edge for layer `index`: the nearest 100 ms, inside `edgeRange`. */
export function clampEdge(spec: MontageDraft, index: number, edge: LayerEdge, wantedMs: number): number {
  assertTime(wantedMs, "an edge");
  return clamp(snap(wantedMs), edgeRange(spec, index, edge));
}

/** One edge of layer `index` moved to `ms` (the nearest 100 ms), the other kept; the same draft when it stays. */
export function trimLayer(spec: MontageDraft, index: number, edge: LayerEdge, ms: number): LayerEdit {
  const layer = layerAt(spec, index);
  assertTime(ms, "an edge");
  const at = snap(ms);
  const startMs = edge === "start" ? at : layer.startMs;
  const endMs = edge === "end" ? at : layer.endMs;
  if (startMs === layer.startMs && endMs === layer.endMs) return done(spec);
  if (endMs - startMs < MIN_LAYER_MS) return refuse("too-short");
  if (startMs < 0 || endMs > endLimit(spec, layer)) return refuse("outside-montage");
  return done(replaceLayer(spec, index, { ...layer, startMs, endMs }));
}

/** Whether two layers are on screen at the same time (half-open ranges: a layer ending as another starts shares none). */
const together = (a: Layer, b: Layer): boolean => a.startMs < b.endMs && b.startMs < a.endMs;

/** Layer `from` taken out and put back before the layer now at `at` (of the list without it). */
function reorder(spec: MontageDraft, from: number, at: number): MontageDraft {
  const layer = layerAt(spec, from);
  const rest = spec.layers.filter((_, i) => i !== from);
  return withLayers(spec, [...rest.slice(0, at), layer, ...rest.slice(at)]);
}

/**
 * «Слой выше»: layer `index` goes right above the next layer on screen at the same time (later in the array is on top).
 * Layers that never share the screen with it are passed over, since swapping with them would change nothing anyone sees.
 */
export function raiseLayer(spec: MontageDraft, index: number): LayerEdit {
  const layer = layerAt(spec, index);
  const above = spec.layers.findIndex((other, i) => i > index && together(layer, other));
  if (above < 0) return refuse("top");
  // Without the layer, the one above sits at `above - 1`; ours goes right after it.
  return done(reorder(spec, index, above));
}

/** «Слой ниже»: layer `index` goes right below the nearest layer under it that is on screen at the same time. */
export function lowerLayer(spec: MontageDraft, index: number): LayerEdit {
  const layer = layerAt(spec, index);
  let below = -1;
  for (let i = index - 1; i >= 0; i--) {
    const other = spec.layers[i];
    if (other !== undefined && together(layer, other)) {
      below = i;
      break;
    }
  }
  if (below < 0) return refuse("bottom");
  return done(reorder(spec, index, below));
}

/** Splits a layer at `atMs` (snapped to 100 ms); the second part is a new layer right above the first. */
export function splitLayerAt(spec: MontageDraft, index: number, atMs: number): LayerEdit {
  const layer = layerAt(spec, index);
  assertTime(atMs, "a split point");
  const at = snap(atMs);
  if (at <= layer.startMs || at >= layer.endMs) return refuse("not-splittable");
  if (at - layer.startMs < MIN_LAYER_MS || layer.endMs - at < MIN_LAYER_MS) return refuse("too-short");
  if (capReached(spec, layer.kind)) return refuse("layer-cap");
  const layerId = nextLayerId(spec);
  const first: Layer = { ...layer, endMs: at };
  const second: Layer = { ...layer, layerId, startMs: at };
  return done(withLayers(spec, [...spec.layers.slice(0, index), first, second, ...spec.layers.slice(index + 1)]), layerId);
}

/** A copy of a layer over the same range, right above it. */
export function duplicateLayer(spec: MontageDraft, index: number): LayerEdit {
  const layer = layerAt(spec, index);
  if (capReached(spec, layer.kind)) return refuse("layer-cap");
  const layerId = nextLayerId(spec);
  return done(withLayers(spec, [...spec.layers.slice(0, index + 1), { ...layer, layerId }, ...spec.layers.slice(index + 1)]), layerId);
}

/**
 * The timeline's rows for a kind's blocks (display packing only, AM11: the z-order is the array's): each layer, in
 * array order, takes the first row where it covers no block already placed. `rows[i]` is layer i's row.
 */
export function layerRows(layers: readonly Pick<Layer, "startMs" | "endMs">[]): { rows: number[]; count: number } {
  const placed: Pick<Layer, "startMs" | "endMs">[][] = [];
  const rows = layers.map((layer) => {
    let row = placed.findIndex((blocks) => blocks.every((b) => layer.endMs <= b.startMs || b.endMs <= layer.startMs));
    if (row < 0) {
      row = placed.length;
      placed.push([]);
    }
    placed[row]?.push(layer);
    return row;
  });
  return { rows, count: placed.length };
}
