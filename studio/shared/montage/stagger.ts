import { FRAMES_PER_STEP, STAGGER_MAX_STEP_MS, STEP_MS } from "./constants";
import { msToFrames } from "./timeline";

// Collage stagger («Ячейки по очереди»): cell k fades in starting at
// k x step, over one step. Cells are 0-based, so the first cell starts on the
// clip's first frame and the last one (n - 1) is complete at n x step.
//
// step = min(300 ms, durationMs / (n + 1)), rounded DOWN to a whole frame.
// Because n x step <= n / (n + 1) of the clip, every cell is fully in
// strictly before the clip ends, and with the smallest clip (500 ms = 15
// frames) and the largest collage (4 cells) the step is still 3 frames.
// Working in frames keeps it exact: floor(durationFrames / (n + 1)) equals the
// floor of the millisecond rule converted to frames.

/** When a cell fades in: `frames` long from `startFrame` (a clip-relative frame). 0 frames = visible from the start. */
export interface CellReveal {
  readonly startFrame: number;
  readonly frames: number;
}

function assertCellCount(cellCount: number): void {
  if (!Number.isSafeInteger(cellCount) || cellCount < 1) throw new RangeError(`cellCount must be a whole number of at least 1, got ${cellCount}`);
}

/** The stagger step in frames for a clip of `durationMs` with `cellCount` cells: at least 1 for any valid clip. */
export function staggerStepFrames(durationMs: number, cellCount: number): number {
  assertCellCount(cellCount);
  const capFrames = (STAGGER_MAX_STEP_MS / STEP_MS) * FRAMES_PER_STEP;
  return Math.min(capFrames, Math.floor(msToFrames(durationMs) / (cellCount + 1)));
}

/** The reveal of cell `cellIndex` (0-based) in a collage clip. With `stagger` off, every cell is visible from frame 0. */
export function cellReveal(cellIndex: number, cellCount: number, durationMs: number, stagger: boolean): CellReveal {
  assertCellCount(cellCount);
  if (!Number.isSafeInteger(cellIndex) || cellIndex < 0 || cellIndex >= cellCount) throw new RangeError(`cellIndex must be 0..${cellCount - 1}, got ${cellIndex}`);
  if (!stagger) return { startFrame: 0, frames: 0 };
  const step = staggerStepFrames(durationMs, cellCount);
  return { startFrame: cellIndex * step, frames: step };
}

/**
 * A cell's opacity on a clip-relative frame, in per-mille (0 to 1000), rising
 * linearly from 0 on `startFrame` to 1000 on `startFrame + frames` (rounded
 * down). A reveal of 0 frames is 1000 throughout.
 */
export function cellAlphaPermille(reveal: CellReveal, frame: number): number {
  if (reveal.frames === 0) return 1000;
  const progress = Math.floor((1000 * (frame - reveal.startFrame)) / reveal.frames);
  return Math.min(1000, Math.max(0, progress));
}
