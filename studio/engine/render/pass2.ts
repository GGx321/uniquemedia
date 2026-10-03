import { FRAME_H, FRAME_W } from "../../shared/montage";
import { clipFrames } from "./durations";
import { assertAbsolutePath, assertSafeFilterGraph } from "./filterString";
import { FPS } from "../../shared/montage";
import { musicInputArgs, musicRenderFilters } from "./musicChain";
import { clipFileName, CONCAT_LIST_NAME } from "./names";
import {
  CONTAINER_ARGS,
  FILTER_THREAD_ARGS,
  FINAL_AUDIO_ARGS,
  FINAL_VIDEO_ARGS,
  FRAME_TAGS,
  METADATA_ARGS,
  OVERLAY_COLOUR_CHAIN,
} from "./profile";
import { RenderGraphError, type AudioSource, type OverlayInput, type Pass2Input, type Pass2Job } from "./types";

// Pass 2: one compositing pass over the pass-1 intermediates. The concat
// DEMUXER (not the filter) feeds one decoder from a list of the job's own
// fixed, relative file names, with ffmpeg's `cwd` set to the job's folder;
// the text and sticker overlays, the audio and the final encode follow, and
// the result goes to a temp file on the export volume.
//
// Length is built into the graph, never cut by an output flag (invariant 20):
// the video is exactly the frames the intermediates hold, and the audio is
// `apad,atrim=end_sample=N` with N = Σ durationMs × 48. There is no
// `-frames:v`, no output `-t` and no `-shortest`.
//
// Inputs, by index: 0 is the concat list, 1..k the overlays in z-order. The
// music track (3c.5), when there is one, is the index after the overlays; the
// silent source needs no input. Music is mapped explicitly (`-map <i>:a:0`)
// and filtered by a simple `-af` chain of its own (`musicChain.ts`); the
// silent source is a source inside the complex graph.

const HEAD_ARGS: readonly string[] = ["-hide_banner", "-nostdin", "-y"];
/**
 * The most frames of an animated overlay's loop the graph caches: the plan's 10 s cap at 30 fps. The cache
 * holds only the frames the file really has.
 */
export const ANIMATED_LOOP_MAX_FRAMES = 300;
/** 48 kHz: 48 samples per millisecond. */
const AUDIO_SAMPLES_PER_MS = 48;

function bad(message: string): never {
  throw new RenderGraphError("BAD_OVERLAY", message);
}

function assertWhole(value: number, what: string): void {
  if (!Number.isSafeInteger(value)) bad(`${what} must be a whole number, got ${value}`);
}

export function validateOverlay(o: OverlayInput, index: number, total: number): void {
  const at = `overlay ${index}`;
  assertAbsolutePath(o.path, `the path of ${at}`);
  assertWhole(o.startFrame, `${at} start frame`);
  assertWhole(o.endFrame, `${at} end frame`);
  if (o.startFrame < 0 || o.endFrame <= o.startFrame || o.endFrame > total) {
    bad(`${at} must satisfy 0 <= start < end <= ${total}, got [${o.startFrame}, ${o.endFrame})`);
  }
  for (const [name, v] of [["x", o.box.x], ["y", o.box.y], ["w", o.box.w], ["h", o.box.h]] as const) assertWhole(v, `${at} box ${name}`);
  // Offsets are even because the video is 4:2:0; a text PNG's own size may be odd.
  if (o.box.x < 0 || o.box.y < 0 || o.box.x % 2 !== 0 || o.box.y % 2 !== 0) bad(`${at} box offset must be even and not negative, got ${o.box.x},${o.box.y}`);
  if (o.box.w < 1 || o.box.h < 1) bad(`${at} box must have a positive size, got ${o.box.w}x${o.box.h}`);
  if (o.box.x + o.box.w > FRAME_W || o.box.y + o.box.h > FRAME_H) bad(`${at} box leaves the ${FRAME_W}x${FRAME_H} frame`);
  // The layer pass's file is the whole frame over the whole timeline, or it is not what the layer pass wrote.
  if (o.format === "layers" && (o.box.x !== 0 || o.box.y !== 0 || o.box.w !== FRAME_W || o.box.h !== FRAME_H || o.startFrame !== 0 || o.endFrame !== total || o.resize)) {
    bad(`${at} (the layer pass's file) must be the whole ${FRAME_W}x${FRAME_H} frame over frames [0, ${total}), unscaled`);
  }
}

/**
 * The input flags of an overlay (invariant 15): only the file protocol, and
 * the demuxer named outright: the still-image one with no pattern matching for
 * a PNG, `apng` or `gif` for an animation. Nothing else: a still is one frame
 * that the graph converts once and repeats; an animation is read once and its
 * frames are looped in the graph (`overlayPrepare`). `-stream_loop -1` and
 * `-ignore_loop` were measured, and both fail on APNG and GIF: the demuxer's
 * duration is one frame short, so each loop restarts a frame early and eats a
 * frame of the animation, and a file with a finite loop count ends the overlay
 * (and with `endall`, the whole output).
 */
export function overlayInputArgs(o: OverlayInput): string[] {
  const demuxer = o.format === "png" ? ["-f", "image2", "-pattern_type", "none"] : o.format === "layers" ? ["-f", "matroska"] : ["-f", o.format];
  return ["-protocol_whitelist", "file", ...demuxer, "-i", o.path];
}

/**
 * The chain that turns overlay input `inputIndex` into the stream `[s<k>]`,
 * shifted to its start frame and converted to BT.709 limited range with alpha
 * (explicitly, never left to the auto scaler), optionally resized to its box.
 *
 * A still is converted once and its one frame repeated forever. An animated
 * one is resampled to 30 fps, converted once, and looped forever from a cache
 * of its own frames (the small yuva420p ones, at most
 * `ANIMATED_LOOP_MAX_FRAMES`). Either is then cut to the layer's length and
 * numbered from the layer's first frame, so the loop starts there and every
 * loop is the file's frames in order.
 */
function overlayPrepare(o: OverlayInput, inputIndex: number, k: number, totalFrames: number): string {
  const resize = o.resize ? `scale=${o.box.w}:${o.box.h}:flags=lanczos,` : "";
  const cut = spansTimeline(o, totalFrames) ? "" : `trim=end_frame=${o.endFrame - o.startFrame},`;
  const shift = `settb=1/${FPS},setpts=N+${o.startFrame}`;
  // The layer pass's file is already BT.709 yuva420p, the whole frame and exactly the timeline long: only re-time it onto the 30 fps grid
  // (the container's millisecond time base would otherwise jitter the frame sync against the main input).
  if (o.format === "layers") return `[${inputIndex}:v]settb=1/${FPS},setpts=N[s${k}]`;
  if (o.format !== "png") {
    return `[${inputIndex}:v]fps=${FPS},format=rgba,${resize}${OVERLAY_COLOUR_CHAIN},loop=loop=-1:size=${ANIMATED_LOOP_MAX_FRAMES},${cut}${shift}[s${k}]`;
  }
  // A still is converted ONCE, and the converted frame is repeated.
  return `[${inputIndex}:v]format=rgba,${resize}${OVERLAY_COLOUR_CHAIN},loop=loop=-1:size=1,${cut}${shift}[s${k}]`;
}

/** A layer that covers every frame of the montage. */
export const spansTimeline = (o: OverlayInput, totalFrames: number): boolean => o.startFrame === 0 && o.endFrame === totalFrames;

/**
 * What `overlay` does when its overlay input ends (or, for one that spans the
 * timeline, never does).
 *
 * - A layer that SPANS the timeline is not cut: its input is longer than the
 *   timeline, and `endall` ends the output with the main input, on the exact
 *   frame (SP1: 450 frames for 15 s).
 * - A WINDOWED layer is cut to its own frames (`trim`) and the output goes on
 *   with the main input when it ends: `pass`. The layer's window is the
 *   overlay stream's own extent, so nothing depends on `overlay`'s `enable`
 *   timeline, which was measured to drop the last frame (with `n`, the last
 *   frame of the stream; with `t`, the last frame of the window).
 *
 * `endall` on a windowed layer would end the whole output at its end, so it is
 * only for the spanning case.
 */
export const overlayEofAction = (o: OverlayInput, totalFrames: number): string => (o.format !== "layers" && spansTimeline(o, totalFrames) ? "endall" : "pass");

/** The silent audio, built inside the complex graph to exactly `samples` samples (music has its own chain, `musicChain.ts`). */
function silentAudio(samples: number): string {
  return `anullsrc=r=48000:cl=stereo,apad,atrim=end_sample=${samples}[a]`;
}

/** The music track's input group, after the overlays'; nothing for silence. */
const audioInputArgs = (audio: AudioSource): string[] => (audio.kind === "music" ? musicInputArgs(audio.path) : []);

/** The maps and the audio filter: `[v]` plus the graph's own silence, or `[v]` plus the track's first audio stream, named, with its chain. */
function audioMapArgs(audio: AudioSource, audioInput: number, samples: number): string[] {
  if (audio.kind === "silent") return ["-map", "[v]", "-map", "[a]"];
  // `-map_metadata -1` (METADATA_ARGS) clears only the GLOBAL kind: a mapped stream carries its own tags and handler name along
  // unless a stream mapping of its own turns that off. A track's handler name is not the engine's, and its tags are the owner's
  // to keep out (invariant 14), so the output's audio stream starts with none.
  return ["-map", "[v]", "-map", `${audioInput}:a:0`, "-map_metadata:s:a:0", "-1", "-af", musicRenderFilters(audio.startMs, audio.gainDb, samples)];
}

/**
 * The final compositing call. `clipDir` is the job's temp folder holding the
 * pass-1 intermediates; the runner writes `listFileContents` to
 * `clipDir/listFileName` before spawning ffmpeg with `cwd = clipDir`.
 */
export function buildPass2(input: Pass2Input): Pass2Job {
  if (input.clips.length === 0) throw new RenderGraphError("NO_CLIPS", "there are no clips to composite");
  assertAbsolutePath(input.clipDir, "the job folder");
  assertAbsolutePath(input.output, "the output path");

  let totalFrames = 0;
  let totalMs = 0;
  for (const clip of input.clips) {
    totalFrames += clipFrames(clip.durationMs);
    totalMs += clip.durationMs;
  }
  const audioSamples = totalMs * AUDIO_SAMPLES_PER_MS;
  input.overlays.forEach((o, i) => validateOverlay(o, i, totalFrames));

  const filters: string[] = [];
  const last = input.overlays.length - 1;
  filters.push(`[0:v]${FRAME_TAGS}[${last < 0 ? "v" : "b0"}]`);
  input.overlays.forEach((o, k) => {
    const out = k === last ? "v" : `b${k + 1}`;
    filters.push(overlayPrepare(o, k + 1, k, totalFrames));
    filters.push(`[b${k}][s${k}]overlay=x=${o.box.x}:y=${o.box.y}:eof_action=${overlayEofAction(o, totalFrames)}:format=yuv420[${out}]`);
  });
  if (input.audio.kind === "silent") filters.push(silentAudio(audioSamples));
  const graph = filters.join(";");
  assertSafeFilterGraph(graph);

  const listFileContents = input.clips.map((_, i) => `file '${clipFileName(i)}'\n`).join("");
  const argv = [
    ...HEAD_ARGS,
    ...FILTER_THREAD_ARGS,
    "-f", "concat", "-protocol_whitelist", "file", "-i", CONCAT_LIST_NAME,
    ...input.overlays.flatMap((o) => overlayInputArgs(o)),
    ...audioInputArgs(input.audio),
    "-filter_complex", graph,
    ...audioMapArgs(input.audio, input.overlays.length + 1, audioSamples),
    ...FINAL_VIDEO_ARGS,
    ...FINAL_AUDIO_ARGS,
    ...CONTAINER_ARGS,
    ...METADATA_ARGS,
    input.output,
  ];
  return { argv, cwd: input.clipDir, listFileName: CONCAT_LIST_NAME, listFileContents, output: input.output, totalFrames, audioSamples };
}
