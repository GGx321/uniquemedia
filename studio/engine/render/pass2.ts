import { FPS, FRAME_H, FRAME_W, msToFrames } from "../../shared/montage";
import { assertAbsolutePath, assertSafeFilterGraph, quoteExpression } from "./filterString";
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
// audio input slot for music (3c) is the index after the overlays; only the
// silent source exists in 3a and it needs no input.

const HEAD_ARGS: readonly string[] = ["-hide_banner", "-nostdin", "-y"];
/** 48 kHz: 48 samples per millisecond. */
const AUDIO_SAMPLES_PER_MS = 48;

function bad(message: string): never {
  throw new RenderGraphError("BAD_OVERLAY", message);
}

function assertWhole(value: number, what: string): void {
  if (!Number.isSafeInteger(value)) bad(`${what} must be a whole number, got ${value}`);
}

function validateOverlay(o: OverlayInput, index: number, total: number): void {
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
}

/**
 * The input flags of an overlay. Every overlay is longer than the timeline
 * (`-t total+1`, looped), so that `eof_action=endall` ends the output when the
 * MAIN input ends, on the exact frame (SP1, SP3).
 */
function overlayInputArgs(o: OverlayInput, longSeconds: number): string[] {
  const loop = o.animated ? ["-stream_loop", "-1"] : ["-loop", "1", "-framerate", String(FPS)];
  return [...loop, "-t", String(longSeconds), "-i", o.path];
}

/**
 * The chain that turns overlay input `inputIndex` into the RGBA-converted
 * stream `[s<k>]`: shifted to its start frame (an animated one is resampled to
 * 30 fps first, so its loop starts on the layer's first frame), optionally
 * resized, then converted to BT.709 limited range explicitly.
 */
function overlayPrepare(o: OverlayInput, inputIndex: number, k: number): string {
  const resample = o.animated ? `fps=${FPS},` : "";
  const resize = o.resize ? `scale=${o.box.w}:${o.box.h}:flags=lanczos,` : "";
  return `[${inputIndex}:v]${resample}settb=1/${FPS},setpts=N+${o.startFrame},format=rgba,${resize}${OVERLAY_COLOUR_CHAIN}[s${k}]`;
}

/** The audio chain, built to exactly `samples` samples. Only silence exists in 3a; music (3c) adds a variant and its input. */
function audioChain(source: AudioSource, samples: number): string {
  // `source.kind` is "silent" for now; the switch is here so 3c adds a case, not a rewrite.
  switch (source.kind) {
    case "silent":
      return `anullsrc=r=48000:cl=stereo,apad,atrim=end_sample=${samples}[a]`;
  }
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
    totalFrames += msToFrames(clip.durationMs);
    totalMs += clip.durationMs;
  }
  const audioSamples = totalMs * AUDIO_SAMPLES_PER_MS;
  input.overlays.forEach((o, i) => validateOverlay(o, i, totalFrames));

  // Every overlay input outlasts the timeline by one second; a decimal of whole tenths is exact.
  const longSeconds = totalMs / 1000 + 1;

  const filters: string[] = [];
  const last = input.overlays.length - 1;
  filters.push(`[0:v]${FRAME_TAGS}[${last < 0 ? "v" : "b0"}]`);
  input.overlays.forEach((o, k) => {
    const out = k === last ? "v" : `b${k + 1}`;
    filters.push(overlayPrepare(o, k + 1, k));
    const enable = quoteExpression(`between(n,${o.startFrame},${o.endFrame - 1})`);
    filters.push(`[b${k}][s${k}]overlay=x=${o.box.x}:y=${o.box.y}:eof_action=endall:format=yuv420:enable=${enable}[${out}]`);
  });
  filters.push(audioChain(input.audio, audioSamples));
  const graph = filters.join(";");
  assertSafeFilterGraph(graph);

  const listFileContents = input.clips.map((_, i) => `file '${clipFileName(i)}'\n`).join("");
  const argv = [
    ...HEAD_ARGS,
    ...FILTER_THREAD_ARGS,
    "-f", "concat", "-protocol_whitelist", "file", "-i", CONCAT_LIST_NAME,
    ...input.overlays.flatMap((o) => overlayInputArgs(o, longSeconds)),
    "-filter_complex", graph,
    "-map", "[v]", "-map", "[a]",
    ...FINAL_VIDEO_ARGS,
    ...FINAL_AUDIO_ARGS,
    ...CONTAINER_ARGS,
    ...METADATA_ARGS,
    input.output,
  ];
  return { argv, cwd: input.clipDir, listFileName: CONCAT_LIST_NAME, listFileContents, output: input.output, totalFrames, audioSamples };
}
