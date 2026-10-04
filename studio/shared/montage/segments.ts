import { FRAME_W } from "./constants";
import { clipRanges } from "./timeline";
import type { Rect } from "./types";

// The preview's clip progress segments: one bar per clip along the top of the
// frame, like Instagram's story bars. PREVIEW-ONLY: the render never draws
// them (the plan: "Slide progress bars appear only in the preview").
//
// Layout (the designer's artboards, CF19 of the 3d.0 reconciliation, even-
// rounded at 1080): 36 px side margins and top inset, 10 px tall bars, 14 px
// gaps. The plan's model stays: the available width (frame minus margins
// minus gaps) is shared in proportion to each clip's frames with CUMULATIVE
// rounding down: bar i spans `floor(avail * start_i / total)` to
// `floor(avail * end_i / total)`, so the widths add up to the available width
// exactly and each is within 1 px of its true share.

export const SEGMENT_MARGIN = 36;
export const SEGMENT_TOP = 36;
export const SEGMENT_HEIGHT = 10;
export const SEGMENT_GAP = 14;

export interface ProgressSegment {
  readonly clipId: string;
  readonly rect: Rect;
  /** The clip's first frame on the timeline. */
  readonly startFrame: number;
  /** One past its last frame (half-open, as in `clipRanges`). */
  readonly endFrame: number;
}

/** One segment per clip, in timeline order. */
export function progressSegments(clips: readonly { readonly clipId: string; readonly durationMs: number }[]): ProgressSegment[] {
  const ranges = clipRanges(clips);
  const last = ranges[ranges.length - 1];
  if (last === undefined) return [];
  const total = last.endFrame;
  const avail = FRAME_W - 2 * SEGMENT_MARGIN - SEGMENT_GAP * (ranges.length - 1);
  return ranges.map((range, i) => {
    const from = Math.floor((avail * range.startFrame) / total);
    const to = Math.floor((avail * range.endFrame) / total);
    return {
      clipId: range.clipId,
      rect: { x: SEGMENT_MARGIN + from + SEGMENT_GAP * i, y: SEGMENT_TOP, w: to - from, h: SEGMENT_HEIGHT },
      startFrame: range.startFrame,
      endFrame: range.endFrame,
    };
  });
}

/** How many pixels of the bar are filled at timeline `frame`: 0 before the clip, the full width from its end frame on. */
export function segmentFillWidth(segment: ProgressSegment, frame: number): number {
  const done = Math.floor((segment.rect.w * (frame - segment.startFrame)) / (segment.endFrame - segment.startFrame));
  return Math.min(segment.rect.w, Math.max(0, done));
}
