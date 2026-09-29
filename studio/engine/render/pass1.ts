import { join } from "node:path";
import type { Cell, Clip } from "../../shared/engine/montage";
import {
  cellMotionGeometry,
  cellReveal,
  clipCellRects,
  clipMotionPlan,
  FPS,
  FRAME_H,
  FRAME_W,
  msToFrames,
  type MotionPlan,
  type Rect,
} from "../../shared/montage";
import { assertAbsolutePath, assertSafeFilterGraph } from "./filterString";
import { clipFileName } from "./names";
import { FILTER_THREAD_ARGS, FRAME_TAGS, INTERMEDIATE_VIDEO_ARGS, PHOTO_COLOUR_CHAIN } from "./profile";
import { RenderGraphError, type Pass1Input, type Pass1Job, type PhotoResolver, type PhotoSource } from "./types";
import { zoompanFilter } from "./zoompan";

// Pass 1: each visual clip is rendered on its own to a near-lossless
// intermediate (`clip-NN.mkv`), so memory is bounded per clip. Every number
// comes from the shared geometry module (`studio/shared/montage`), the same
// one the preview uses; this file only writes it in ffmpeg's language.
//
// Rules from SP1 and SP3, each pinned by a test:
// - `-r 30 -fps_mode cfr` on the encode (the profile);
// - a still is repeated with `loop=loop=N-1:size=1,settb=1/30,setpts=N`, never
//   `setpts=N/(30*TB)` on the image demuxer's 1/25 time base;
// - the frames are tagged with `setparams` right after the swscale conversion;
// - collage cells are overlaid WITHOUT `eof_action=endall`: the black
//   `color` base sets the clip's length;
// - `crop` takes `exact=1` (the crop is even by construction).
//
// Photos are `-i` inputs addressed by index. No path and no text is ever
// written into the filter graph (invariant 16); the graph is checked against a
// strict charset before it is returned.

const HEAD_ARGS: readonly string[] = ["-hide_banner", "-nostdin", "-y"];

function refKey(ref: NonNullable<Cell["photo"]>): string {
  return ref.source === "scene" ? `scene:${ref.photoId}` : `own:${ref.mediaId}`;
}

function resolveCell(cell: Cell, resolvePhoto: PhotoResolver): PhotoSource {
  if (cell.photo === null) throw new RenderGraphError("CELL_EMPTY", "a cell has no photo");
  const source = resolvePhoto(cell.photo);
  if (source === undefined) throw new RenderGraphError("PHOTO_UNRESOLVED", `the photo ${refKey(cell.photo)} was not resolved`);
  assertAbsolutePath(source.path, "the photo path");
  return source;
}

/**
 * One cell's chain, from input `inputIndex` to `outLabel`: colour conversion,
 * the cover-crop, then either the `zp4` motion (upscale to the canvas, then
 * `zoompan`) or, for a static clip, one scale to the cell and the still repeated.
 */
function cellChain(inputIndex: number, outLabel: string, source: PhotoSource, cell: Cell, rect: Rect, plan: MotionPlan, frames: number): string {
  const g = cellMotionGeometry({ w: rect.w, h: rect.h }, { w: source.width, h: source.height }, cell.focus);
  const head = `[${inputIndex}:v]${PHOTO_COLOUR_CHAIN},crop=${g.crop.w}:${g.crop.h}:${g.crop.x}:${g.crop.y}:exact=1`;
  if (plan.kind === "static") {
    return `${head},scale=${rect.w}:${rect.h}:flags=lanczos,loop=loop=${frames - 1}:size=1,settb=1/${FPS},setpts=N[${outLabel}]`;
  }
  return `${head},scale=${g.canvas.w}:${g.canvas.h}:flags=lanczos,${zoompanFilter(plan, g.canvas, g.anchor, frames, { w: rect.w, h: rect.h })}[${outLabel}]`;
}

function buildClipGraph(clip: Clip & { kind: "photo" | "collage" }, seed: number, sources: readonly PhotoSource[]): string {
  const frames = msToFrames(clip.durationMs);
  const plan = clipMotionPlan(seed, clip);
  const rects = clipCellRects(clip);
  const cells = clip.kind === "photo" ? [clip.cell] : clip.cells;
  const filters: string[] = [];

  if (clip.kind === "photo") {
    const [cell] = cells;
    const [source] = sources;
    const [rect] = rects;
    if (cell === undefined || source === undefined || rect === undefined) throw new RenderGraphError("CELL_EMPTY", "a photo clip has no cell");
    filters.push(cellChain(0, "c0", source, cell, rect, plan, frames));
    filters.push("[c0]setsar=1[v]");
    return filters.join(";");
  }

  cells.forEach((cell, k) => {
    const source = sources[k];
    const rect = rects[k];
    if (source === undefined || rect === undefined) throw new RenderGraphError("CELL_EMPTY", `collage cell ${k} has no photo`);
    if (clip.stagger) {
      const reveal = cellReveal(k, cells.length, clip.durationMs, true);
      filters.push(cellChain(k, `raw${k}`, source, cell, rect, plan, frames));
      filters.push(`[raw${k}]format=yuva420p,fade=t=in:s=${reveal.startFrame}:n=${reveal.frames}:alpha=1[c${k}]`);
    } else {
      filters.push(cellChain(k, `c${k}`, source, cell, rect, plan, frames));
    }
  });

  // The black base sets the length (exactly `durationMs`, a multiple of 100 ms, so the decimal is exact).
  filters.push(`color=c=black:s=${FRAME_W}x${FRAME_H}:r=${FPS}:d=${clip.durationMs / 1000},format=yuv420p,${FRAME_TAGS}[bg]`);
  let previous = "bg";
  rects.forEach((r, k) => {
    filters.push(`[${previous}][c${k}]overlay=x=${r.x}:y=${r.y}:format=yuv420[o${k}]`);
    previous = `o${k}`;
  });
  filters.push(`[${previous}]setsar=1[v]`);
  return filters.join(";");
}

/**
 * The ffmpeg call of every visual clip in the spec. `clipDir` is the job's temp
 * folder (`userData/render-tmp/<jobId>`), which the runner creates; the
 * intermediates are `clip-00.mkv`, `clip-01.mkv`, and so on.
 */
export function buildPass1(input: Pass1Input): Pass1Job[] {
  if (input.clips.length === 0) throw new RenderGraphError("NO_CLIPS", "there are no clips to render");
  assertAbsolutePath(input.clipDir, "the job folder");

  return input.clips.map((clip, index) => {
    if (clip.kind === "video") {
      throw new RenderGraphError("VIDEO_CLIP_UNSUPPORTED", "an own video clip is not supported yet (slice 3f)");
    }
    const cells = clip.kind === "photo" ? [clip.cell] : clip.cells;
    const sources = cells.map((cell) => resolveCell(cell, input.resolvePhoto));
    const graph = buildClipGraph(clip, input.seed, sources);
    assertSafeFilterGraph(graph);

    const fileName = clipFileName(index);
    const output = join(input.clipDir, fileName);
    const argv = [
      ...HEAD_ARGS,
      ...FILTER_THREAD_ARGS,
      ...sources.flatMap((s) => ["-i", s.path]),
      "-filter_complex", graph,
      "-map", "[v]",
      ...INTERMEDIATE_VIDEO_ARGS,
      output,
    ];
    return { index, clipId: clip.clipId, frames: msToFrames(clip.durationMs), fileName, output, argv };
  });
}
