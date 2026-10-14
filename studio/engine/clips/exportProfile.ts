import type { ClipExportProfile } from "../../shared/engine";
import { COLOUR_TAG_ARGS, CONTAINER_ARGS } from "../render/profile";
import type { ClipColour } from "./validate";

// Stage 5, 5b.1, S5.V4c (plan s5b1 §5.13, I5.55, I5.58; owner Q-C, 2026-10-13): the ffmpeg argv of «Сохранить в папку». The library keeps the provider's file byte for byte; every
// export re-encodes FROM it into H.264 High 1080 x 1920 at the profile's rate, `+faststart`, BT.709 limited range, with no audio track, at CRF 18 under the 12 Mbit/s cap the
// owner chose for the uniquifier. What the file says about itself is the owner's line (I5.58): every tag of the source and every signature of the tools is stripped, the only
// thing written is the real `creation_time`, and nothing here (or anywhere) writes a device, a place, a camera or an «AI» claim.
//
// The two flags beyond `-map_metadata -1` were measured on the bundled ffmpeg-static 6.0 (S5.V4c spike, exportVerify.ffmpeg.test.ts): without `-empty_hdlr_name 1` the video handler
// is named «VideoHandler»; with `encoder=` (empty) in place of `encoder= ` (one space) the key is deleted and the sample entry's compressor name is «Lavc libx264» again.

/** `EXPORT_FPS` (shared/engine/clips.ts): how the providers' 24 fps become the file's rate. */
export type ExportFpsMode = "interpolate" | "duplicate" | "native24";

/** The record's name for the profile each mode makes (I5.55). */
export const EXPORT_PROFILE_OF: Readonly<Record<ExportFpsMode, ClipExportProfile>> = { interpolate: "1080p30-interp", duplicate: "1080p30-dup", native24: "1080p24" };

/** The frame rate each mode's file plays at. */
export const EXPORT_RATE_OF: Readonly<Record<ExportFpsMode, number>> = { interpolate: 30, duplicate: 30, native24: 24 };

export const EXPORT_WIDTH = 1080;
export const EXPORT_HEIGHT = 1920;

/** The VBV cap, bits per second: the uniquifier's output rate, which the owner chose (QE-1). */
export const EXPORT_MAX_BITRATE = 12_000_000;

/** One 1080 x 1920 frame is 3 MiB as 4:2:0; far above what a decode needs, far below what a hostile header could ask for (the face frames' bound). */
const MAX_ALLOC_BYTES = 512 * 1024 * 1024;

/**
 * The 24 -> 30 step, before the scale (at the source size: interpolating 720p is about a third of the work of 1080p).
 * - `interpolate`: motion-compensated (`mci`, overlapped blocks, bidirectional search): a plain `fps=30` repeats every fourth frame, which judders on slow motion (§5.13);
 * - `duplicate`: that plain `fps=30`, the default since canary C3 (the owner saw no difference in the blind A/B/C; it encodes about 3x faster);
 * - `native24`: the file stays at 24 fps (only the owner picks it).
 *
 * MEASURED (S5.V4c, 2026-10-14, the owner's M4 Max, ffmpeg-static 6.0, this argv, a 10 s 24 fps `testsrc2` source): from 720 x 1280, interpolate 27.0 s, duplicate 4.1 s,
 * native24 3.6 s; from 1080 x 1920, interpolate 58.2 s, duplicate 4.0 s, native24 3.5 s (about 8-11 MB each). `minterpolate` runs on one thread; x264 is capped at two. So the
 * export always shows its progress, and its bound is 10 minutes (`EXPORT_ENCODE_TIMEOUT_MS`).
 */
const FPS_STEP: Readonly<Record<ExportFpsMode, string>> = {
  interpolate: "minterpolate=fps=30:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1",
  duplicate: "fps=30",
  native24: "fps=24",
};

/** The walker's matrix codes (H.273) as swscale names them; a code outside the table is a defect here, never a guess written into a graph (frames.ts's rule). */
const SCALE_MATRICES: Readonly<Record<number, string>> = { 1: "bt709", 5: "bt601", 6: "smpte170m", 9: "bt2020" };

export interface ClipExportArgvInput {
  /** The library's mp4 (`<clipId>.mp4`), read only. */
  readonly input: string;
  /** The temp in the avatar's export folder (`.studio-part-<jobId>.mp4`), which the job created empty a moment before. */
  readonly output: string;
  readonly mode: ExportFpsMode;
  /** The clip's own colour, as the walker read it from its boxes. */
  readonly colour: ClipColour;
  /** The real export time: the file's `creation_time`, and the record line's `at`. */
  readonly exportedAt: Date;
}

/** What the file may say about itself (I5.58): nothing from any input, no muxer or encoder signature, empty handler names, a blank compressor name, no SEI, and the real time. */
function metadataArgs(exportedAt: Date): string[] {
  return [
    "-map_metadata", "-1",
    "-map_metadata:s:v:0", "-1",
    "-map_chapters", "-1",
    "-fflags", "+bitexact",
    "-flags:v", "+bitexact",
    "-empty_hdlr_name", "1",
    "-metadata:s:v:0", "encoder= ",
    "-bsf:v", "filter_units=remove_types=6",
    "-metadata", `creation_time=${exportedAt.toISOString()}`,
  ];
}

/** The scale from the clip's own matrix and range to BT.709 limited range at 1080 x 1920. */
function scaleOf(colour: ClipColour): string {
  const matrix = SCALE_MATRICES[colour.matrix];
  if (matrix === undefined) throw new Error(`no scaler name for colour matrix ${colour.matrix}`);
  return `scale=${EXPORT_WIDTH}:${EXPORT_HEIGHT}:flags=lanczos:in_color_matrix=${matrix}:in_range=${colour.fullRange ? "pc" : "tv"}:out_color_matrix=bt709:out_range=tv`;
}

/** The whole argv after the ffmpeg binary, the output path last (`runFfmpegArgv` adds the thread caps and the progress pipe). */
export function clipExportArgv(input: ClipExportArgvInput): string[] {
  const rate = String(EXPORT_RATE_OF[input.mode]);
  return [
    // The hardened head (the clip's frames and poster read the library's file the same way, frames.ts): no stdin, one decoder thread, a cap on one allocation, the file protocol only
    // (nothing in the file can make ffmpeg open a URL, a pipe or another file), and the mov demuxer forced.
    "-hide_banner",
    "-loglevel", "error",
    "-nostdin",
    "-threads", "1",
    "-max_alloc", String(MAX_ALLOC_BYTES),
    "-protocol_whitelist", "file",
    "-f", "mov",
    "-i", input.input,
    // The first video stream and nothing else: Grok's stray sound (and any other track) never reaches the export.
    "-map", "0:V:0",
    "-an", "-sn", "-dn",
    // The source's disposition is not carried: a DASH role on the provider's track (`comment`, `dub`, ...) would make the muxer write a `udta/kind` box the verifier refuses.
    "-disposition:v:0", "default",
    "-vf", `${FPS_STEP[input.mode]},${scaleOf(input.colour)},format=yuv420p`,
    "-c:v", "libx264", "-profile:v", "high", "-preset", "medium", "-crf", "18",
    "-maxrate", "12M", "-bufsize", "24M", "-g", "60", "-threads", "2",
    "-pix_fmt", "yuv420p",
    ...COLOUR_TAG_ARGS,
    "-r", rate, "-fps_mode", "cfr",
    ...metadataArgs(input.exportedAt),
    ...CONTAINER_ARGS,
    // The job created the temp empty and exclusively a moment ago (never following a link): ffmpeg only truncates that file.
    "-y",
    "-f", "mp4",
    input.output,
  ];
}

/** The bytes an export of `durationMs` may take: its length at the 12 Mbit/s cap, and a quarter more (§5.13). */
export function expectedExportBytes(durationMs: number): number {
  return Math.ceil(((durationMs / 1000) * EXPORT_MAX_BITRATE * 1.25) / 8);
}

/** The frames an export of `durationMs` holds at the mode's rate: what the progress counts to. At least one. */
export function expectedExportFrames(durationMs: number, mode: ExportFpsMode): number {
  return Math.max(1, Math.round((durationMs / 1000) * EXPORT_RATE_OF[mode]));
}
