import type { Clip, Focus, Layer, MontageDraft } from "../../../shared/engine";
import {
  cellAlphaPermille,
  cellMotionGeometry,
  cellReveal,
  clipAtFrame,
  clipCellRects,
  clipMotionPlan,
  clipRanges,
  layerRange,
  layerVisibleAt,
  motionWindow,
  type MotionPlan,
  msToFrameFloor,
  type Rect,
  type Size,
  stickerBox,
  textBox,
  totalFrames,
  videoClipCrop,
} from "../../../shared/montage";
import { stickerById } from "../../../shared/stickers/manifest";

// 3d.4: what the live preview draws at a frame, as plain data. Every number comes from the SHARED geometry the engine renders with
// (studio/shared/montage), so the preview cannot drift from the render: the clip under the playhead (`clipAtFrame`), its cells
// (`clipCellRects`), the part of each photo the render's cover crop and `zp4` motion show on that frame (`cellMotionGeometry` +
// `motionWindow`, the window on the upscaled canvas mapped back to the photo's own pixels), a collage cell's stagger fade
// (`cellReveal` / `cellAlphaPermille`, the render's `fade`), the layers on screen in z-order (`layerVisibleAt`), their boxes
// (`textBox` on the engine's picture, `stickerBox`), and a sticker's frame on the loop period stored with it (the render's `loop`
// cache, 3b.6). Nothing here is the window's own maths.

/**
 * What a cell holds: a scene photo (with its stored focus), an own video clip's video (3f.3b: the whole frame, cropped by the clip's focus), an own photo
 * (a neutral surface), or nothing yet.
 */
export type CellContent =
  | { readonly kind: "scene"; readonly photoId: string; readonly focus: Focus | null }
  | { readonly kind: "video"; readonly mediaId: string; readonly focus: Focus | null }
  | { readonly kind: "own" }
  | { readonly kind: "empty" };

export interface CellView {
  readonly index: number;
  /** Where the cell sits on the 1080x1920 frame. */
  readonly rect: Rect;
  readonly content: CellContent;
  /** The photo's stored size once its picture has loaded, an own video's from its record; null before that and for anything else. */
  readonly source: Size | null;
  /** The part of the photo or video the cell shows on this frame, in its own pixels (fractional for a moving photo); null without a size. */
  readonly window: Rect | null;
  /** The cell's opacity, 0 to 1000: below 1000 only while a staggered collage cell fades in. */
  readonly alphaPermille: number;
}

export interface ClipView {
  readonly index: number;
  readonly clipId: string;
  readonly kind: Clip["kind"];
  /** The clip's frames, and which of them is on screen (0-based). */
  readonly frames: number;
  readonly localFrame: number;
  readonly cells: readonly CellView[];
}

/** The frame on screen at playhead `ms`: the montage's last frame at or past its end; null for a draft with no clip. */
export function previewFrameAt(spec: MontageDraft, ms: number): number | null {
  const total = totalFrames(spec.clips);
  if (total === 0) return null;
  return Math.min(total - 1, msToFrameFloor(Math.max(0, ms)));
}

/**
 * The part of a `source`-sized photo a `cell`-sized area shows on clip frame `localFrame` of `frames`, in the photo's pixels: the
 * shared cover crop around `focus`, then the motion's window on the upscaled canvas (exactly what the render's zoompan cuts),
 * mapped back to the photo through the canvas's scale. A static clip shows its whole crop.
 */
export function cellSourceWindow(cell: Size, source: Size, focus: Focus | null, plan: MotionPlan, localFrame: number, frames: number): Rect {
  const g = cellMotionGeometry(cell, source, focus);
  const w = motionWindow(plan, g.canvas, g.anchor, localFrame, frames);
  // Multiplied before dividing: a window of the whole canvas maps back to exactly the crop.
  return {
    x: g.crop.x + (w.x * g.crop.w) / g.canvas.w,
    y: g.crop.y + (w.y * g.crop.h) / g.canvas.h,
    w: (w.w * g.crop.w) / g.canvas.w,
    h: (w.h * g.crop.h) / g.canvas.h,
  };
}

function cellsOfClip(clip: Clip): readonly { photo: CellContent }[] {
  if (clip.kind === "video") return [{ photo: { kind: "video", mediaId: clip.mediaId, focus: clip.focus } }];
  const cells = clip.kind === "photo" ? [clip.cell] : clip.cells;
  return cells.map((cell) => ({
    photo: cell.photo === null ? { kind: "empty" } : cell.photo.source === "scene" ? { kind: "scene", photoId: cell.photo.photoId, focus: cell.focus } : { kind: "own" },
  }));
}

const noVideoSize = (): Size | null => null;

/**
 * The clip on screen at timeline `frame`, its cells and what each shows; null when no clip holds the frame. `sizeOf` gives a scene
 * photo's stored size once its picture has loaded (null until then); `videoSizeOf` an own video's stored size from its record (3f.3b),
 * whose part the clip shows is the render's `videoClipCrop` (static: a video clip has no motion).
 */
export function clipViewAt(spec: MontageDraft, frame: number, sizeOf: (photoId: string) => Size | null, videoSizeOf: (mediaId: string) => Size | null = noVideoSize): ClipView | null {
  const at = clipAtFrame(clipRanges(spec.clips), frame);
  if (at === null) return null;
  const clip = spec.clips[at.index];
  if (clip === undefined) return null;
  const { frames } = at.range;
  const rects = clipCellRects(clip);
  const plan = clipMotionPlan(spec.seed, clip);
  const contents = cellsOfClip(clip);
  const cells = rects.map((rect, index): CellView => {
    const content = contents[index]?.photo ?? { kind: "empty" };
    const source = content.kind === "scene" ? sizeOf(content.photoId) : content.kind === "video" ? videoSizeOf(content.mediaId) : null;
    const window =
      source === null ? null : content.kind === "scene" ? cellSourceWindow({ w: rect.w, h: rect.h }, source, content.focus, plan, at.localFrame, frames) : content.kind === "video" ? videoClipCrop(source, content.focus) : null;
    const alphaPermille = clip.kind === "collage" && clip.stagger ? cellAlphaPermille(cellReveal(index, rects.length, clip.durationMs, true), at.localFrame) : 1000;
    return { index, rect, content, source, window, alphaPermille };
  });
  return { index: at.index, clipId: clip.clipId, kind: clip.kind, frames, localFrame: at.localFrame, cells };
}

/** The layers on screen at timeline `frame`, in z-order: the spec's order, a later layer on top. */
export function visibleLayers(spec: MontageDraft, frame: number): { index: number; layer: Layer }[] {
  return spec.layers.flatMap((layer, index) => (layerVisibleAt(layer, frame) ? [{ index, layer }] : []));
}

/** A text layer's box on the frame: the engine's `textBox`, centred where the layer says, on the size of the picture the engine drew. */
export function textLayerBox(layer: { readonly x: number; readonly y: number }, picture: { readonly width: number; readonly height: number }): Rect {
  return textBox(layer, { w: picture.width, h: picture.height });
}

/**
 * A sticker layer's box on the frame (the engine's `stickerBox`): a built-in sticker on the set's picture; an OWN one (3f.5) on ITS canvas (`own`,
 * from its record, which need not be square). Null for a built-in id the set lacks, and for an own sticker whose record is not known (yet).
 */
export function stickerLayerBox(layer: Extract<Layer, { kind: "sticker" }>, own?: { readonly width: number; readonly height: number }): Rect | null {
  if (layer.sticker.source === "own") return own === undefined ? null : stickerBox(layer, { w: own.width, h: own.height });
  const entry = stickerById(layer.sticker.stickerId);
  if (entry === undefined) return null;
  return stickerBox(layer, { w: entry.size, h: entry.size });
}

function assertFrames(value: number, what: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${what} must be a whole number of 30 fps frames, at least 1, got ${value}`);
}

/**
 * Which of a sticker's own frames is on screen at timeline `frame` for a layer starting at `startFrame`: the 30 fps tick since the
 * start, wrapped on `loopFrames` (the quantised period STORED with the sticker, never a decoder's frame durations: Chrome reports
 * 1/30 s as 33 000 µs), then found among the frames by `delayFrames`, each frame's length in 30 fps frames (one each when absent,
 * as for the whole built-in set). Like the render's loop cache: a loop shorter than the frames cuts them, frames that add up to
 * less than the loop repeat what they have.
 */
export function stickerFrameIndex(frame: number, startFrame: number, loopFrames: number, delayFrames?: readonly number[]): number {
  assertFrames(loopFrames, "a sticker's loop");
  if (delayFrames !== undefined) {
    if (delayFrames.length === 0) throw new RangeError("a sticker has at least one frame");
    for (const delay of delayFrames) assertFrames(delay, "a frame's delay");
  }
  const sum = delayFrames === undefined ? loopFrames : delayFrames.reduce((a, b) => a + b, 0);
  const period = Math.min(loopFrames, sum);
  const tick = Math.max(0, frame - startFrame) % period;
  if (delayFrames === undefined) return tick;
  let end = 0;
  for (const [index, delay] of delayFrames.entries()) {
    end += delay;
    if (tick < end) return index;
  }
  return delayFrames.length - 1;
}

/**
 * The frame of a layer's sticker on screen at timeline `frame`: from the LAYER's first frame, on the loop stored with the sticker
 * and through its own `delayFrames` where it has them (an own sticker, 3f.5: the manifest's built-in set has none, one frame per
 * tick).
 */
export function stickerFrameOf(sticker: { readonly loopFrames: number; readonly delayFrames?: readonly number[] }, layer: { readonly startMs: number; readonly endMs: number }, frame: number): number {
  return stickerFrameIndex(frame, layerRange(layer).startFrame, sticker.loopFrames, sticker.delayFrames);
}
