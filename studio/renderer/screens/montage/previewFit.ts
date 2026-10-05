import type { Size } from "../../../shared/montage";

// The owner's feedback (2026-10-05): the preview fits the stage instead of staying the artboard's 306 × 544 island. The size is a pure function
// of the stage (the preview area's content box), the render's size, the screen's pixel ratio and the «Подсказки» gutter:
// - it keeps the montage's aspect EXACTLY: the frame is a whole number of the aspect's smallest steps (9 × 16 px for 1080 × 1920), so one
//   scale serves both axes and a layer stored in montage coordinates (drawn in percent of the frame) lands where the render puts it;
// - it never overflows the stage;
// - it never shows more physical pixels than the render has (the large-screen audit): render size / devicePixelRatio is the most it takes,
//   540 × 960 CSS px on a 2× screen, so a 720 px scene photo is never drawn more upscaled than the video will hold it;
// - it keeps clear of the hints on both sides (centred), unless that would leave it narrower than `PREVIEW_MIN_W`: then the gutter gives way,
//   and only as much as the minimum needs.

/** The artboard's preview width (Editor.dc.html): the overlays' pixel sizes were drawn for it (`previewScale`). */
export const PREVIEW_ARTBOARD_W = 306;
/** The narrowest the preview is made for the hints' sake (a stage narrower than this gets what fits). */
export const PREVIEW_MIN_W = 180;

export interface PreviewFitInput {
  /** The preview area's content box, in CSS px. */
  readonly stage: Size;
  /** The montage's render size, in pixels (1080 × 1920). */
  readonly render: Size;
  /** `window.devicePixelRatio`. */
  readonly dpr: number;
  /** What the frame keeps clear on EACH side of the stage, in CSS px (the «Подсказки» block's width beside it). */
  readonly gutter: number;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/** Whole steps under `value / step`, a hair of float error forgiven (1080 / (1.25 × 9) is 96, not 95.999…). */
const steps = (value: number, step: number): number => Math.max(0, Math.floor(value / step + 1e-9));

/** The preview's size in CSS px; null while the stage is not laid out (the stylesheet's default size stands). */
export function fitPreview({ stage, render, dpr, gutter }: PreviewFitInput): Size | null {
  if (!(stage.w > 0 && stage.h > 0 && Number.isFinite(stage.w) && Number.isFinite(stage.h))) return null;
  const rw = Math.round(render.w);
  const rh = Math.round(render.h);
  const unit = gcd(rw, rh);
  const aw = rw / unit;
  const ah = rh / unit;
  const ratio = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const side = Number.isFinite(gutter) && gutter > 0 ? gutter : 0;
  const cap = Math.min(steps(rw / ratio, aw), steps(rh / ratio, ah));
  const within = (width: number): number => Math.min(steps(width, aw), steps(stage.h, ah), cap);
  const clear = within(stage.w - 2 * side);
  const whole = within(stage.w);
  // The gutter gives way to the minimum, never past what the stage holds.
  const units = Math.max(clear, Math.min(whole, Math.ceil(PREVIEW_MIN_W / aw)));
  return { w: units * aw, h: units * ah };
}

/** The room a `stageHeight` px stage leaves above a centred frame `frameHeight` px tall (review r1 MEDIUM-2: where the notices' dock can stay). */
export function roomAboveFrame(stageHeight: number, frameHeight: number): number {
  return Math.max(0, (stageHeight - frameHeight) / 2);
}

/** How much the overlays' artboard pixel sizes (pills, the face ring, the handles) scale on a preview `width` px wide. */
export function previewScale(width: number): number {
  return width / PREVIEW_ARTBOARD_W;
}
