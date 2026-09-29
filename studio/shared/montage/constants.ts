// Shared montage geometry constants (plan: "Fixed decisions", rows Output
// format, Geometry, Motion). Everything here is an integer.

/** The output frame rate: constant, 30 fps. */
export const FPS = 30;
/** Milliseconds per timeline step; `FRAMES_PER_STEP` frames each, so time-to-frame maths is exact. */
export const STEP_MS = 100;
export const FRAMES_PER_STEP = 3;

/** The Reels frame. */
export const FRAME_W = 1080;
export const FRAME_H = 1920;
/** The black gutter between collage cells, in pixels (the mockup's 3 px at 306 px, rounded to an even 12). */
export const GUTTER = 12;

/** The face-less focus: horizontally centred, a little above the middle where a face usually sits. */
export const FOCUS_FALLBACK = { x: 0.5, y: 0.38 } as const;

/** `zp4`: the cover-cropped photo is upscaled 4x before `zoompan` (SP1). */
export const CANVAS_SCALE = 4;
/** The motion canvas never grows past this, so a large own photo is scaled to it instead of 4x its own size (SP1). */
export const CANVAS_MAX_W = 2880;
export const CANVAS_MAX_H = 5120;

/** Ken Burns runs between these zooms (in per-mille: 1000 = 1.00x). */
export const KENBURNS_MIN_PERMILLE = 1000;
export const KENBURNS_MAX_PERMILLE = 1100;
/** A pan runs at this fixed zoom. */
export const PAN_ZOOM_PERMILLE = 1150;

/** A collage stagger step is at most this long. */
export const STAGGER_MAX_STEP_MS = 300;

// Mirrors of the contract's limits (studio/shared/engine/montage.ts). They are
// copied, not imported, because importing a VALUE from the contract would pull
// zod into every bundle that uses this module; `constants.test.ts` pins that
// each equals the contract's.
export const MIN_TOTAL_MS = 4_000;
export const MAX_TOTAL_MS = 15_000;
export const MIN_CLIP_MS = 500;
export const MAX_CLIPS = 20;
