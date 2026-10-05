import { MAX_SOURCE_OFFSET_MS, type MontageDraft } from "../../../shared/engine";
import { MIN_CLIP_MS, STEP_MS } from "../../../shared/montage";
import { roomMs } from "./clipOps";

// 3f.3b: «Обрезка», an own video clip's trim (EditorMine.dc.html, R16): which part of the stored video the clip plays, as pure functions over a draft.
// The editor sends each result through `DraftSession.edit` (a drag or a held key is one undo step). What every result keeps:
// - the contract's grid: `trimStartMs` and the clip's length are whole 100 ms steps (`multipleOf(TIME_STEP_MS)`: the engine refuses anything else),
//   so a wanted time is snapped to the nearest step first;
// - the clip at least 0.1 s (`MIN_CLIP_MS`), the montage at most 15 s (the clip grows only by the room), a start no further than `MAX_SOURCE_OFFSET_MS`;
// - the clip inside the stored video: it ends by `sourceEndMs`, the video's length down to the grid (`video-too-short` otherwise). An edit never makes a
//   clip that already runs past the end (a draft from elsewhere) worse; sliding it brings its start back to the video's start.
// The window SLIDES (the length kept); its LEFT edge moves the start with the end kept (as pulling a film's head does: earlier makes it longer), its RIGHT
// edge the end with the start kept. A clip that is not a video is a programming error (RangeError), as in clipOps.ts.

type VideoClip = Extract<MontageDraft["clips"][number], { kind: "video" }>;

/** Where a handle or the window may go, in ms of the stored video. */
export interface Range {
  readonly min: number;
  readonly max: number;
}

export interface TrimLimits {
  /** The window's start, its length kept. */
  readonly slide: Range;
  /** The left edge (the start), the end kept. */
  readonly start: Range;
  /** The right edge (the end), the start kept. */
  readonly end: Range;
}

/** The trim on the strip: the times, and the clip's part of the whole video as fractions of it (cut at the video's end). */
export interface TrimView {
  readonly startMs: number;
  readonly endMs: number;
  readonly sourceMs: number;
  readonly from: number;
  readonly width: number;
}

const snap = (ms: number): number => Math.round(ms / STEP_MS) * STEP_MS;
const clamp = (v: number, range: Range): number => Math.min(range.max, Math.max(range.min, v));

function videoAt(spec: MontageDraft, index: number): VideoClip {
  const clip = spec.clips[index];
  if (!Number.isSafeInteger(index) || clip === undefined) throw new RangeError(`clip index must be 0..${spec.clips.length - 1}, got ${index}`);
  if (clip.kind !== "video") throw new RangeError(`clip ${index} is not an own video and has no trim`);
  return clip;
}

function withClip(spec: MontageDraft, index: number, clip: VideoClip, trimStartMs: number, durationMs: number): MontageDraft {
  if (trimStartMs === clip.trimStartMs && durationMs === clip.durationMs) return spec;
  const next: VideoClip = { ...clip, trimStartMs, durationMs };
  return { ...spec, clips: spec.clips.map((c, i) => (i === index ? next : c)) };
}

/** How far into a stored video of `sourceMs` a clip may reach: its length down to the 100 ms grid (a start and a length on the grid end on it). */
export function sourceEndMs(sourceMs: number): number {
  return Math.floor(sourceMs / STEP_MS) * STEP_MS;
}

export function trimView(clip: VideoClip, sourceMs: number): TrimView {
  const startMs = clip.trimStartMs;
  const endMs = startMs + clip.durationMs;
  const from = Math.min(1, startMs / sourceMs);
  return { startMs, endMs, sourceMs, from, width: Math.max(0, Math.min(endMs, sourceMs) - startMs) / sourceMs };
}

/** Where the window and its two edges may go for clip `index` over a stored video of `sourceMs`. */
export function trimLimits(spec: MontageDraft, index: number, sourceMs: number): TrimLimits {
  const clip = videoAt(spec, index);
  const end = sourceEndMs(sourceMs);
  const start = clip.trimStartMs;
  const length = clip.durationMs;
  const longest = length + roomMs(spec);
  const startMin = Math.max(0, start + length - longest);
  return {
    slide: { min: 0, max: Math.max(0, Math.min(end - length, MAX_SOURCE_OFFSET_MS)) },
    start: { min: startMin, max: Math.max(startMin, Math.min(start + length - MIN_CLIP_MS, MAX_SOURCE_OFFSET_MS)) },
    end: { min: start + MIN_CLIP_MS, max: Math.max(start + MIN_CLIP_MS, Math.min(start + longest, end)) },
  };
}

/** The window moved to start at `wantedMs` in the video, its length kept; the same draft when it does not move. */
export function slideTrim(spec: MontageDraft, index: number, wantedMs: number, sourceMs: number): MontageDraft {
  const clip = videoAt(spec, index);
  return withClip(spec, index, clip, clamp(snap(wantedMs), trimLimits(spec, index, sourceMs).slide), clip.durationMs);
}

/** The left edge moved to `wantedMs`, the clip's end in the video kept; the same draft when it does not move. */
export function trimStartTo(spec: MontageDraft, index: number, wantedMs: number, sourceMs: number): MontageDraft {
  const clip = videoAt(spec, index);
  const end = clip.trimStartMs + clip.durationMs;
  const start = clamp(snap(wantedMs), trimLimits(spec, index, sourceMs).start);
  return withClip(spec, index, clip, start, end - start);
}

/** The right edge moved to `wantedMs`, the clip's start kept; the same draft when it does not move. */
export function trimEndTo(spec: MontageDraft, index: number, wantedMs: number, sourceMs: number): MontageDraft {
  const clip = videoAt(spec, index);
  const end = clamp(snap(wantedMs), trimLimits(spec, index, sourceMs).end);
  return withClip(spec, index, clip, clip.trimStartMs, end - clip.trimStartMs);
}

/** The longest `clip` may last from its trim: up to the video's end on the grid, never under `MIN_CLIP_MS` (what the timeline's handles are held to). */
export function durationLimitMs(clip: VideoClip, sourceMs: number): number {
  return Math.max(MIN_CLIP_MS, sourceEndMs(sourceMs) - clip.trimStartMs);
}

/** How much longer clip `index` may get with both edges: within the montage's room and the video. */
export function growMs(spec: MontageDraft, index: number, sourceMs: number): number {
  const clip = videoAt(spec, index);
  return Math.max(0, Math.min(roomMs(spec), sourceEndMs(sourceMs) - clip.durationMs));
}
