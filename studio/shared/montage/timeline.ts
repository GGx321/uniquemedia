import { FPS, FRAMES_PER_STEP, STEP_MS } from "./constants";

// Time <-> frames at 30 fps. Every montage time is a multiple of 100 ms (the
// contract enforces it), and 100 ms is exactly 3 frames, so the conversion is
// exact integer maths: `frames = ms * 3 / 100`. A time that is not a multiple
// of 100 is a programming error here and throws; nothing is ever rounded.
//
// Conventions (pinned by tests):
// - Frames are numbered from 0. Frame `f` is on screen from `f / 30` s.
// - A range is HALF-OPEN: `[startFrame, endFrame)`. A clip or layer shows on
//   frame `startFrame` and does not show on frame `endFrame`, which belongs to
//   the next clip (or is past the end of the montage).
// - The montage's last frame is `totalFrames - 1`.

export interface ClipRange {
  readonly clipId: string;
  /** The first frame of the clip. */
  readonly startFrame: number;
  /** How many frames the clip lasts. */
  readonly frames: number;
  /** One past the clip's last frame; the next clip's `startFrame`. */
  readonly endFrame: number;
}

export interface LayerRange {
  readonly startFrame: number;
  /** Exclusive. */
  readonly endFrame: number;
  readonly frames: number;
}

/** A whole, finite, non-negative number. */
function assertWhole(value: number, what: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${what} must be a whole non-negative number, got ${value}`);
}

/** Milliseconds to frames: exact, for multiples of 100 ms only. */
export function msToFrames(ms: number): number {
  assertWhole(ms, "ms");
  if (ms % STEP_MS !== 0) throw new RangeError(`ms must be a multiple of ${STEP_MS}, got ${ms}`);
  return (ms / STEP_MS) * FRAMES_PER_STEP;
}

/**
 * The time a frame starts at, in whole milliseconds, ROUNDED DOWN
 * (`floor(frame * 1000 / 30)`). Exact on step boundaries (a multiple of 3
 * frames); in between it is the floor of 33.33 ms multiples.
 */
export function framesToMs(frames: number): number {
  assertWhole(frames, "frames");
  return Math.floor((frames * 1000) / FPS);
}

/** The clips laid back to back from frame 0. */
export function clipRanges(clips: readonly { readonly clipId: string; readonly durationMs: number }[]): ClipRange[] {
  const ranges: ClipRange[] = [];
  let cursor = 0;
  for (const clip of clips) {
    const frames = msToFrames(clip.durationMs);
    ranges.push({ clipId: clip.clipId, startFrame: cursor, frames, endFrame: cursor + frames });
    cursor += frames;
  }
  return ranges;
}

/** The montage's length in frames: the sum of its clips' frames. */
export function totalFrames(clips: readonly { readonly durationMs: number }[]): number {
  let total = 0;
  for (const clip of clips) total += msToFrames(clip.durationMs);
  return total;
}

/** A text or sticker layer's frame range, half-open: `[startMs, endMs)` becomes `[startFrame, endFrame)`. */
export function layerRange(layer: { readonly startMs: number; readonly endMs: number }): LayerRange {
  const startFrame = msToFrames(layer.startMs);
  const endFrame = msToFrames(layer.endMs);
  return { startFrame, endFrame, frames: endFrame - startFrame };
}

/** Whether the layer is on screen on `frame`: true from its first frame, false from its end frame on. */
export function layerVisibleAt(layer: { readonly startMs: number; readonly endMs: number }, frame: number): boolean {
  const { startFrame, endFrame } = layerRange(layer);
  return frame >= startFrame && frame < endFrame;
}
