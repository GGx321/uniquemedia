import type { Probed, ProbedStream } from "../engine/render/ffmpeg.testkit";
import { AUDIO_OVER_MS, AUDIO_UNDER_MS, VIDEO_TOLERANCE_MS } from "../engine/verify";
import { ALLOWED_COMPATIBLE_BRANDS, ALLOWED_MAJOR_BRAND, COMPRESSOR_NAME, ENCODER_TAG } from "../engine/verify/allowlist";
import type { Mp4Facts } from "./mp4Facts";

// What the packaged E2E asks of every file the packaged app renders (plan 3a.9; invariants 14 and 20), as a pure function of what
// ffprobe and the box reader found. It is a SECOND opinion beside the engine's own verifier (which already refused anything
// else before the commit): ffprobe and the box walker are independent code, so a disagreement between them and the verifier shows.

export interface RenderedFileEvidence {
  /** `probeVideo`: stream facts, the decoded frame count, stream and format tags. */
  readonly probe: Probed;
  readonly facts: Mp4Facts;
}

export interface RenderedFileExpectation {
  /** `Σ durationMs × 3 / 100`. */
  readonly frames: number;
  readonly durationMs: number;
}

const CONTAINER_TAGS = ["major_brand", "minor_version", "compatible_brands", "encoder"];
const STREAM_TAGS = new Set(["language", "handler_name", "vendor_id", "encoder"]);
const ZERO_VENDOR = "[0][0][0][0]";
const LAVC_LIBX264 = "Lavc<version> libx264";

const ms = (seconds: string | undefined): number => Math.round(Number(seconds) * 1000);

function streamProblems(expected: RenderedFileExpectation, video: ProbedStream, audio: ProbedStream): string[] {
  const problems: string[] = [];
  if (video.codec_name !== "h264" || video.profile !== "High" || video.width !== 1080 || video.height !== 1920 || video.pix_fmt !== "yuv420p" || video.r_frame_rate !== "30/1" || video.avg_frame_rate !== "30/1") {
    problems.push("the video is not H.264 High 1080x1920 yuv420p at 30/1 fps");
  }
  if (video.color_range !== "tv" || video.color_space !== "bt709" || video.color_transfer !== "bt709" || video.color_primaries !== "bt709") {
    problems.push("the video is not tagged BT.709 limited range in every field");
  }
  if (audio.codec_name !== "aac" || audio.profile !== "LC" || audio.sample_rate !== "48000" || audio.channels !== 2) problems.push("the audio is not AAC-LC 48000 Hz stereo");

  // Invariant 20: the exact number of frames, the video's own length, and the audio at most one AAC frame under it.
  const frames = Number(video.nb_read_frames);
  if (frames !== expected.frames) problems.push(`the video holds ${frames} frames, expected ${expected.frames}`);
  const videoMs = ms(video.duration);
  if (Math.abs(videoMs - expected.durationMs) > VIDEO_TOLERANCE_MS) problems.push(`the video lasts ${videoMs} ms, expected ${expected.durationMs} ms (±${VIDEO_TOLERANCE_MS})`);
  const gap = videoMs - ms(audio.duration);
  if (gap < -AUDIO_OVER_MS) problems.push(`the audio is ${-gap} ms longer than the video (at most ${AUDIO_OVER_MS} allowed)`);
  if (gap > AUDIO_UNDER_MS) problems.push(`the audio is ${gap} ms shorter than the video (at most ${AUDIO_UNDER_MS} allowed)`);

  // Invariant 14 as ffprobe sees it.
  const streamKeys = [video, audio].flatMap((s) => Object.keys(s.tags ?? {}));
  const strayStreamKeys = [...new Set(streamKeys.filter((key) => !STREAM_TAGS.has(key)))];
  if (strayStreamKeys.length > 0) problems.push(`a stream carries tags outside the allowlist: ${strayStreamKeys.join(", ")}`);
  // macOS' ffprobe 6.0 prints the zero vendor and Windows' 4.4 prints none; the box itself is pinned by the engine's own tests.
  if ([video, audio].some((s) => s.tags?.vendor_id !== undefined && s.tags.vendor_id !== ZERO_VENDOR)) problems.push("a stream's vendor_id is not zero");
  if ([video, audio].some((s) => s.tags?.language !== undefined && s.tags.language !== "und")) problems.push("a stream's language is not und");
  if (video.tags?.handler_name !== "VideoHandler" || audio.tags?.handler_name !== "SoundHandler") problems.push("the streams' handler names are not VideoHandler and SoundHandler");
  if (audio.tags?.encoder !== undefined) problems.push("the audio stream carries an encoder tag");
  const videoEncoder = video.tags?.encoder;
  if (videoEncoder === undefined || !COMPRESSOR_NAME.test(videoEncoder)) problems.push(`the video stream's encoder tag is not ${LAVC_LIBX264}: ${videoEncoder ?? "missing"}`);
  return problems;
}

function containerProblems(probe: Probed): string[] {
  const problems: string[] = [];
  const tags = probe.format.tags ?? {};
  const stray = Object.keys(tags).filter((key) => !CONTAINER_TAGS.includes(key));
  if (stray.length > 0) problems.push(`the container carries tags outside the allowlist: ${stray.join(", ")}`);
  else if (CONTAINER_TAGS.some((key) => tags[key] === undefined)) problems.push("the container's tags are not exactly major_brand, minor_version, compatible_brands and encoder");
  if (tags.encoder !== undefined && !ENCODER_TAG.test(tags.encoder)) problems.push(`the container's encoder tag is not Lavf<version>: ${tags.encoder}`);
  return problems;
}

function factProblems(facts: Mp4Facts): string[] {
  const problems: string[] = [];
  for (const name of ["mvhd", "tkhd", "mdhd"] as const) {
    const times = facts.times[name];
    if (times.length === 0) problems.push(`the file has no ${name} time to check`);
    else if (times.some((t) => t.creation !== 0 || t.modification !== 0)) problems.push(`a creation or modification time is not zero: ${name}`);
  }
  if (facts.tool === null) problems.push("the file has no ©too string");
  else if (!ENCODER_TAG.test(facts.tool)) problems.push(`the ©too string is not Lavf<version>: ${facts.tool}`);
  if (facts.compressor === null) problems.push("the file has no compressor name");
  else if (!COMPRESSOR_NAME.test(facts.compressor)) problems.push(`the compressor name is not ${LAVC_LIBX264}: ${facts.compressor}`);
  if (facts.brands.major !== ALLOWED_MAJOR_BRAND) problems.push(`the ftyp major brand is ${facts.brands.major}, expected ${ALLOWED_MAJOR_BRAND}`);
  const strayBrands = facts.brands.compatible.filter((brand) => !ALLOWED_COMPATIBLE_BRANDS.has(brand));
  if (strayBrands.length > 0) problems.push(`the ftyp brands are outside the allowlist: ${strayBrands.join(", ")}`);
  return problems;
}

/** Everything wrong with a rendered file, in a fixed order; empty when it is what the engine writes. */
export function renderedFileProblems(expected: RenderedFileExpectation, evidence: RenderedFileEvidence): string[] {
  const { probe } = evidence;
  const video = probe.streams.find((s) => s.codec_type === "video");
  const audio = probe.streams.find((s) => s.codec_type === "audio");
  const streams =
    probe.streams.length !== 2 || video === undefined || audio === undefined
      ? [`the file has ${probe.streams.length} streams, expected a video and an audio stream`]
      : streamProblems(expected, video, audio);
  return [...streams, ...containerProblems(probe), ...factProblems(evidence.facts)];
}
