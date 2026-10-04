import type { Cell, Clip, Focus, MontageDraft } from "../../../shared/engine";
import { coverCrop, FRAME_H, FRAME_W, type Rect, resolveFocus, type Size } from "../../../shared/montage";

// 3d.4: dragging in the preview, as pure maths on the 1080x1920 frame (the preview turns its own pixels into frame pixels first).
// - A layer MOVES by its box: from where the box is drawn (a centre stored past an edge is drawn clamped there), by the pointer's
//   travel, never past the frame. The render clamps a box into the frame anyway (`textBox`, `stickerBox`); keeping the centre where
//   the box can still follow the pointer means dragging back has no dead zone.
// - A corner SCALES a layer about its centre (the contract anchors layers at their centre): by the pointer's distance from the
//   centre over the press's. The size or scale itself goes through `setStickerSize` / `setTextScale`, which keep the contract's range.
// - A selected cell's CROP is moved by its face point (Q3: no zoom slider in Stage 3): the photo follows the pointer, so the focus
//   moves the other way by the crop's photo pixels per frame pixel, within the range where the shared cover crop still moves.
// Centres and focuses keep four decimals: a tenth of a frame pixel.

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Travel {
  readonly dx: number;
  readonly dy: number;
}

const round4 = (v: number): number => Math.round(v * 10_000) / 10_000;
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** One axis of a box drawn at `offset` with `side`, moved by `travel`, its centre kept where the box stays inside `length`. */
function centreAlong(offset: number, side: number, travel: number, length: number): number {
  const half = Math.min(side, length) / 2;
  return round4(clamp(offset + side / 2 + travel, half, length - half) / length);
}

/** The centre (fractions of the frame) of a layer whose `box` is dragged by `travel` frame pixels. */
export function dragLayerCentre(box: Rect, travel: Travel): Point {
  return { x: centreAlong(box.x, box.w, travel.dx, FRAME_W), y: centreAlong(box.y, box.h, travel.dy, FRAME_H) };
}

/** How much a corner drag scales a layer about `centre`: the pointer's distance over the press's, each at least a pixel. */
export function resizeFactor(centre: Point, press: Point, pointer: Point): number {
  const from = Math.max(1, Math.hypot(press.x - centre.x, press.y - centre.y));
  const to = Math.max(1, Math.hypot(pointer.x - centre.x, pointer.y - centre.y));
  return to / from;
}

/**
 * One axis of the focus after the photo moved `travel` frame pixels: an axis the pointer did not move keeps its value (the motion
 * still anchors on it), one whose crop already spans the photo cannot move; otherwise from where the crop really is, the other way,
 * within the range where the crop still moves.
 */
function focusAlong(stored: number, travel: number, cropSide: number, cellSide: number, sourceSide: number): number {
  if (travel === 0 || cropSide >= sourceSide) return stored;
  const lo = cropSide / 2 / sourceSide;
  const hi = 1 - lo;
  const from = clamp(stored, lo, hi);
  return round4(clamp(from - (travel * cropSide) / cellSide / sourceSide, lo, hi));
}

/** A cell's face focus after its photo was dragged `travel` frame pixels in a `cell`-sized area, from `start` (null: the fallback). */
export function dragFocus(start: Focus | null, travel: Travel, cell: Size, source: Size): Focus {
  const from = resolveFocus(start);
  const crop = coverCrop(source, cell, from);
  return { x: focusAlong(from.x, travel.dx, crop.w, cell.w, source.w), y: focusAlong(from.y, travel.dy, crop.h, cell.h, source.h) };
}

/** Layer `index` centred at `centre` (fractions of the frame), all else kept; the same draft when it already is there. */
export function placeLayer(spec: MontageDraft, index: number, centre: Point): MontageDraft {
  const layer = spec.layers[index];
  if (layer === undefined) throw new RangeError(`layer index must be 0..${spec.layers.length - 1}, got ${index}`);
  if (layer.x === centre.x && layer.y === centre.y) return spec;
  return { ...spec, layers: spec.layers.map((l, i) => (i === index ? { ...l, x: centre.x, y: centre.y } : l)) };
}

/**
 * Own video clip `clipIndex` with its focus set to `focus` (3f.3b): what its crop centres on, as a photo cell's face point does (`videoClipCrop`); the
 * same draft when it already is. Only an own video clip has one of its own.
 */
export function setVideoFocus(spec: MontageDraft, clipIndex: number, focus: Focus): MontageDraft {
  const clip = spec.clips[clipIndex];
  if (clip === undefined) throw new RangeError(`clip index must be 0..${spec.clips.length - 1}, got ${clipIndex}`);
  if (clip.kind !== "video") throw new RangeError(`clip ${clipIndex} is not an own video: its focus is a cell's`);
  if (clip.focus !== null && clip.focus.x === focus.x && clip.focus.y === focus.y) return spec;
  const replaced: Clip = { ...clip, focus: { x: focus.x, y: focus.y } };
  return { ...spec, clips: spec.clips.map((c, i) => (i === clipIndex ? replaced : c)) };
}

/** Cell `cell` of clip `clipIndex` with its face focus set to `focus`; the same draft when it already is. Only a cell with a photo has one. */
export function setCellFocus(spec: MontageDraft, clipIndex: number, cell: number, focus: Focus): MontageDraft {
  const clip = spec.clips[clipIndex];
  if (clip === undefined) throw new RangeError(`clip index must be 0..${spec.clips.length - 1}, got ${clipIndex}`);
  if (clip.kind === "video") throw new RangeError(`clip ${clipIndex} is an own video: its framing comes with 3f`);
  const cells: readonly Cell[] = clip.kind === "photo" ? [clip.cell] : clip.cells;
  const target = cells[cell];
  if (target === undefined) throw new RangeError(`cell index must be 0..${cells.length - 1}, got ${cell}`);
  if (target.photo === null) throw new RangeError(`cell ${cell} of clip ${clipIndex} has no photo to frame`);
  if (target.focus !== null && target.focus.x === focus.x && target.focus.y === focus.y) return spec;
  const next: Cell = { ...target, focus: { x: focus.x, y: focus.y } };
  const replaced: Clip = clip.kind === "photo" ? { ...clip, cell: next } : { ...clip, cells: clip.cells.map((c, i) => (i === cell ? next : c)) };
  return { ...spec, clips: spec.clips.map((c, i) => (i === clipIndex ? replaced : c)) };
}
