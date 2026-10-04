import type { Layer, MontageDraft } from "../../../shared/engine";
import { FRAME_H, FRAME_W, reelsSafeZones, type Rect, stickerBox, zonesHit } from "../../../shared/montage";
import { stickerById } from "../../../shared/stickers/manifest";

// 3d.5: a sticker layer's properties (EditorGif.dc.html; the reconciliation's R35–R41, G4) as pure edits over a draft, the sibling
// of layerOps.ts and textOps.ts. Each result goes through `DraftSession.edit`: one undo step, saved like any other edit.
// - The size is the contract's fraction of the frame width, 0.05–0.6 (CF12: the artboard's slider stopped at 50 %).
// - «Заменить стикер» swaps the built-in sticker and keeps everything else: time, place, size, the layer's id and z-order.
// - The Reels zones (AM10) are the shared `reelsSafeZones`: a sticker reaching one is only WARNED about (the render draws it as
//   placed), and «Сдвинуть внутрь» moves it by the shortest way that clears every zone, its size kept.

export type StickerLayer = Extract<Layer, { kind: "sticker" }>;

/** The zones a sticker can reach: the bottom band (the caption and the sound) and the right strip (likes, comments). */
export type ZoneId = "bottom" | "right";

/** The contract's bounds of `StickerLayer.size` (a test binds them to the schema). */
export const MIN_STICKER_SIZE = 0.05;
export const MAX_STICKER_SIZE = 0.6;

/** A moved box keeps this many pixels from a zone's edge, so no rounding of its centre on the way back puts it in again. */
const ROUNDING_MARGIN_PX = 2;

function stickerAt(spec: MontageDraft, index: number): StickerLayer {
  if (!Number.isSafeInteger(index) || index < 0 || index >= spec.layers.length) throw new RangeError(`layer index must be 0..${spec.layers.length - 1}, got ${index}`);
  const layer = spec.layers[index];
  if (layer?.kind !== "sticker") throw new RangeError(`layer ${index} is not a sticker`);
  return layer;
}

const withSticker = (spec: MontageDraft, index: number, layer: StickerLayer): MontageDraft => ({ ...spec, layers: spec.layers.map((l, i) => (i === index ? layer : l)) });

/** The size kept to a hundredth (a whole percent) and within 0.05–0.6; the same draft when it stays. */
export function setStickerSize(spec: MontageDraft, index: number, size: number): MontageDraft {
  const layer = stickerAt(spec, index);
  if (!Number.isFinite(size)) throw new RangeError(`a size must be a finite number, got ${size}`);
  const next = Math.min(MAX_STICKER_SIZE, Math.max(MIN_STICKER_SIZE, Math.round(size * 100) / 100));
  return next === layer.size ? spec : withSticker(spec, index, { ...layer, size: next });
}

/** «18 %»: the size as the panel shows it. */
export function stickerPercent(size: number): number {
  return Math.round(size * 100);
}

/** Layer `index` shows built-in sticker `stickerId` instead, in the same time and place; the same draft when it already does. */
export function replaceSticker(spec: MontageDraft, index: number, stickerId: string): MontageDraft {
  const layer = stickerAt(spec, index);
  if (stickerById(stickerId) === undefined) throw new RangeError(`no built-in sticker ${stickerId}`);
  if (layer.sticker.source === "builtin" && layer.sticker.stickerId === stickerId) return spec;
  return withSticker(spec, index, { ...layer, sticker: { source: "builtin", stickerId } });
}

/** How many layers show each built-in sticker (the «GIF» tab's badges). */
export function stickerUses(spec: MontageDraft): ReadonlyMap<string, number> {
  const uses = new Map<string, number>();
  for (const layer of spec.layers) {
    if (layer.kind === "sticker" && layer.sticker.source === "builtin") uses.set(layer.sticker.stickerId, (uses.get(layer.sticker.stickerId) ?? 0) + 1);
  }
  return uses;
}

/** The zones a box overlaps (touching an edge is no hit), as their ids. */
function boxZones(box: Rect): ZoneId[] {
  return zonesHit(box, reelsSafeZones()).flatMap((zone) => (zone.id === "top" ? [] : [zone.id]));
}

/** Which Reels zones the sticker reaches, bottom first. */
export function stickerZones(layer: StickerLayer): ZoneId[] {
  return boxZones(stickerBox(layer)).sort();
}

/** Which Reels zones a layer drawn in `box` reaches, bottom first (3d.4: a caption's box is the engine's picture's). */
export function layerBoxZones(box: Rect): ZoneId[] {
  return boxZones(box).sort();
}

/**
 * The centre (fractions of the frame) that takes a layer drawn in `box` out of every Reels zone by the shortest way, its size kept:
 * up out of the bottom band, and out of the right strip either to its left or above it, whichever is nearer. An axis the move did
 * not need keeps `centre`'s value exactly. Null when the box reaches no zone, or no clear place is near.
 */
export function zoneEscape(box: Rect, centre: { readonly x: number; readonly y: number }): { x: number; y: number } | null {
  if (boxZones(box).length === 0) return null;
  const zones = reelsSafeZones();
  const bottom = zones.find((z) => z.id === "bottom")?.rect;
  const right = zones.find((z) => z.id === "right")?.rect;
  if (bottom === undefined || right === undefined) return null;
  // Where the box's top-left may go: kept above the bottom band, then out of the right strip to its left or above it.
  const aboveBottom = Math.min(box.y, bottom.y - box.h - ROUNDING_MARGIN_PX);
  const candidates: { x: number; y: number }[] = [
    { x: box.x, y: aboveBottom },
    { x: Math.min(box.x, right.x - box.w - ROUNDING_MARGIN_PX), y: aboveBottom },
    { x: box.x, y: Math.min(aboveBottom, right.y - box.h - ROUNDING_MARGIN_PX) },
  ];
  const clear = candidates.filter((at) => at.x >= 0 && at.y >= 0 && boxZones({ ...box, ...at }).length === 0);
  const distance = (at: { x: number; y: number }): number => Math.hypot(at.x - box.x, at.y - box.y);
  const best = clear.sort((a, b) => distance(a) - distance(b))[0];
  if (best === undefined) return null;
  // The contract keeps the centre as a fraction of the frame; an axis the move did not touch keeps its value exactly.
  return { x: best.x === box.x ? centre.x : (best.x + box.w / 2) / FRAME_W, y: best.y === box.y ? centre.y : (best.y + box.h / 2) / FRAME_H };
}

/**
 * Layer `index` moved out of every Reels zone by the shortest way, its size kept (`zoneEscape`). The same draft when it reaches no
 * zone.
 */
export function moveInside(spec: MontageDraft, index: number): MontageDraft {
  const layer = stickerAt(spec, index);
  const to = zoneEscape(stickerBox(layer), layer);
  return to === null ? spec : withSticker(spec, index, { ...layer, x: to.x, y: to.y });
}
