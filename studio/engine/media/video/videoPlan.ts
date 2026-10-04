import { isAbsolute } from "node:path";
import { MEDIA_BYTE_CAPS, type MediaUnsupportedReason } from "../../../shared/engine";
import { longerThan, type ProbeRefusal, type VideoCodec, type VideoColour, type VideoInfo, type VideoProbe } from "./videoProbe";

// From what the walker read (`videoProbe.ts`) to what is refused and what ffmpeg is asked to do (Stage 3 plan, 3f.3a). Pure: it starts nothing
// and reads no file. The importer (`videoImporter.ts`) runs the arguments built here.
//
// THE MEZZANINE: H.264 at CRF 16, 4:2:0, a constant 30 fps, BT.709 limited range, fitted inside 1080 x 1920 and never upscaled, with the
// rotation applied and no audio and no metadata. 3f.3b reads it frame by frame and the preview plays it, so it must be uniform whatever
// the owner's phone wrote.
//
// THE COLOUR. Every frame is TAGGED from what the walker read (`setparams`) before anything converts it: `zscale` fails on untagged input
// (SP3), and ffmpeg's own reading of a clip's tags is a second opinion nobody asked for. Then:
// - HDR (PQ or HLG, Dolby Vision 8.x by its base layer): `zscale` to RGB as 16-bit integers (the signal is clipped to the RGB cube), to linear
//   light (`npl=100`), to BT.709 primaries, `tonemap=hable` with `desat=0` (a hue-preserving curve), the light clipped as 16-bit integers, then
//   the BT.709 gamma, matrix and range. Measured on the HLG chart fixture against a model of this chain (its formulas the standards', its three
//   constants fitted to ffmpeg's output): every patch within 1 code value (invariant 36 allows 2; see `videoImporter.ffmpeg.test.ts`);
// - SDR that is already BT.709 limited range: tagged and put in 4:2:0, nothing else;
// - SDR in other primaries (BT.601, Display P3, BT.2020): the same two clips, signal then light, around the primaries conversion;
// - any other SDR (BT.709 primaries with full range, an sRGB transfer or another matrix): converted to BT.709 limited by one `zscale`.
//
// NO TRANSFER FUNCTION SEES A FLOAT THAT CAN BE NEGATIVE. zimg's approximate gamma is not defined there and is CPU-dependent (one CI runner's
// CPU made a patch 47 codes off). YUV outside the RGB cube and colour outside BT.709's gamut are the two ways to a negative, and each is clipped
// through a 16-bit integer frame first. `videoImporter.colour.ffmpeg.test.ts` pins the colours, the ordering, and the cost in the shadows.
//
// THE ORDER. 30 fps first (a frame that will not survive is not tone-mapped), then the scale in the STORED orientation (the quarter turn
// is then done on the small picture), then the turn, then the colour. The rotation is applied here from the walker's reading
// (`-noautorotate` on the input), so that no ffmpeg version decides which way up a clip is.

export const VIDEO_LIMITS = {
  /** A clip is at most three minutes long. */
  maxSeconds: 180,
  /** "4K": 4096 on the long side and 2160 on the short one, whichever way it is turned. */
  maxLongSide: 4096,
  maxShortSide: 2160,
  /** Each side at least this many pixels (3a.3: `coverCrop` cannot make a 1 px side even). */
  minSide: 2,
  /** The mezzanine is fitted inside this box. */
  fitWidth: 1080,
  fitHeight: 1920,
  fps: 30,
} as const;

/** Frames of slack either way in `expectedFrames`: the rounding of the first and the last. */
const FRAME_SLACK = 2;

/** One allocation may take at most 256 MiB: above a 4K 12-bit 4:4:4 plane (about 35 MiB) and far below a container bomb. */
const MAX_ALLOC_BYTES = 256 * 1024 * 1024;
/** ffmpeg's wall-clock limit is this floor plus ten times the clip's length: a 3 minute 4K HDR clip is a quarter of an hour at its slowest. */
const TIMEOUT_FLOOR_MS = 60_000;
const TIMEOUT_PER_CLIP_MS = 10;

export interface VideoPlan {
  readonly info: VideoInfo;
  /** The mezzanine's size, as it is SHOWN (after the turn): inside 1080 x 1920, even, at least 2. */
  readonly outWidth: number;
  readonly outHeight: number;
  readonly hdrToSdr: boolean;
  readonly colour: VideoColour;
  readonly timeoutMs: number;
}

export type VideoJudgement = { readonly ok: true; readonly plan: VideoPlan } | { readonly ok: false; readonly reason: MediaUnsupportedReason };

/** The even size a picture of `width` x `height` (as shown) is fitted to: inside the box, never bigger than it is, never under 2. */
function fit(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, VIDEO_LIMITS.fitWidth / width, VIDEO_LIMITS.fitHeight / height);
  const even = (value: number): number => Math.max(VIDEO_LIMITS.minSide, scale === 1 ? Math.floor(value / 2) * 2 : Math.round(value / 2) * 2);
  return { width: Math.min(VIDEO_LIMITS.fitWidth, even(width * scale)), height: Math.min(VIDEO_LIMITS.fitHeight, even(height * scale)) };
}

/** A file that is not a clip at all or is damaged is a `format`; a codec is a `codec`; a clip put together in a way the importer will not take is a `structure`. */
function reasonOf(refusal: ProbeRefusal): MediaUnsupportedReason {
  switch (refusal) {
    case "unsupported-codec":
      return "codec";
    case "bad-box":
    case "no-ftyp":
    case "no-moov":
    case "moov-too-large":
    case "bad-header":
    case "no-video-track":
      return "format";
    default:
      return "structure";
  }
}

/** The decoder ffmpeg is allowed to use for each codec the walker names; the argument of `-codec_whitelist` and of the input's `-c:v`. */
const DECODERS: Readonly<Record<VideoCodec, string>> = { h264: "h264", hevc: "hevc", prores: "prores" };

/**
 * How many 30 fps frames a faithful normalisation of this clip has, as a range. ffmpeg honours the edit list (measured on 6.0): a trim that
 * keeps the samples from the keyframe before the cut and cuts into them with an edit gives the EDIT's length, not the samples'; an empty edit
 * before the segment gives nothing (the picture starts later, it is not longer); B-frames make x264 write an edit that starts a little way in and
 * is as long as the samples, and the count is the samples'. It stops at whichever of the edit and the samples runs out first.
 * - the most it can be: the samples' length with no edit, the edit's with one (the samples' length by `stts` can be shorter than what is shown, a held last frame whose time lives in `ctts`; ffmpeg stops at the edit, and a forged long edit is refused as too long first);
 * - the least: the shorter of the edit and what is left of the samples after the edit's start;
 * and two frames of slack either way for the first and the last frame's rounding. A forged length (a `stts` that is short, an edit that is
 * long) lands outside this and fails the import.
 */
export function expectedFrames(info: VideoInfo): { min: number; max: number } {
  const { video } = info;
  const samples = video.durationTicks / video.timescale;
  const edit = video.edit === null ? samples : video.edit.durationTicks / info.mvhd.timescale;
  const start = video.edit === null ? 0 : video.edit.mediaTime / video.timescale;
  // With an edit the upper bound is the edit's: the samples' length (`stts`) can be shorter than what is shown (a VFR clip's last frame held by `ctts`).
  const most = video.edit === null ? samples : edit;
  const least = Math.min(edit, Math.max(0, samples - start));
  return { min: Math.max(0, Math.floor(least * VIDEO_LIMITS.fps) - FRAME_SLACK), max: Math.ceil(most * VIDEO_LIMITS.fps) + FRAME_SLACK };
}

/**
 * What to do with a file the walker read, or why not. `bytes` is the size of the staged copy. The order is the size of the file, then what
 * the boxes said, then the picture's smallest side, its largest, and its length.
 */
export function judgeVideo(probe: VideoProbe, bytes: number): VideoJudgement {
  if (bytes > MEDIA_BYTE_CAPS.video) return { ok: false, reason: "too-large" };
  if (!probe.ok) return { ok: false, reason: reasonOf(probe.reason) };
  const { info } = probe;
  const { width, height } = info.video;
  if (Math.min(width, height) < VIDEO_LIMITS.minSide) return { ok: false, reason: "too-small" };
  if (Math.max(width, height) > VIDEO_LIMITS.maxLongSide || Math.min(width, height) > VIDEO_LIMITS.maxShortSide) return { ok: false, reason: "dimensions" };
  if (longerThan(info, VIDEO_LIMITS.maxSeconds)) return { ok: false, reason: "too-long" };
  const turned = info.video.rotation === 90 || info.video.rotation === 270;
  const shown = fit(turned ? height : width, turned ? width : height);
  return {
    ok: true,
    plan: {
      info,
      outWidth: shown.width,
      outHeight: shown.height,
      hdrToSdr: info.video.dynamicRange !== "sdr",
      colour: info.video.colour,
      timeoutMs: TIMEOUT_FLOOR_MS + info.durationMs * TIMEOUT_PER_CLIP_MS,
    },
  };
}

// ---------- the filter graph ----------

const PRIMARIES: Readonly<Record<number, string>> = { 1: "bt709", 5: "bt470bg", 6: "smpte170m", 9: "bt2020", 11: "smpte431", 12: "smpte432" };
const TRANSFERS: Readonly<Record<number, string>> = { 1: "bt709", 6: "smpte170m", 13: "iec61966-2-1", 14: "bt2020-10", 15: "bt2020-12", 16: "smpte2084", 18: "arib-std-b67" };
const MATRICES: Readonly<Record<number, string>> = { 1: "bt709", 5: "bt470bg", 6: "smpte170m", 9: "bt2020nc" };

const ROTATIONS: Readonly<Record<90 | 180 | 270, string>> = { 90: "transpose=1", 180: "hflip,vflip", 270: "transpose=2" };

function nameOf(table: Readonly<Record<number, string>>, code: number): string {
  const name = table[code];
  // The walker only lets through codes of these tables; a code outside them is a bug here, never a reason to write a guess into a graph.
  if (name === undefined) throw new Error(`no ffmpeg name for colour code ${code}`);
  return name;
}

/** The `-vf` chain of a plan. Built from a fixed vocabulary and numbers: nothing of the file's own text is in it. */
export function videoFilterGraph(plan: VideoPlan): string {
  const { video } = plan.info;
  const turned = video.rotation === 90 || video.rotation === 270;
  const storedWidth = turned ? plan.outHeight : plan.outWidth;
  const storedHeight = turned ? plan.outWidth : plan.outHeight;
  const chain: string[] = [`fps=${VIDEO_LIMITS.fps}`];
  if (storedWidth !== video.width || storedHeight !== video.height) chain.push(`scale=${storedWidth}:${storedHeight}:flags=bicubic+accurate_rnd+full_chroma_int`);
  if (video.rotation !== 0) chain.push(ROTATIONS[video.rotation]);
  // A scale keeps the display aspect by bending the pixel aspect (4096 x 2160 to 1080 x 570 leaves 1.0007:1), and the muxer then writes a
  // non-square pixel and a fractional width. The walker refuses both, and so does every editor: the mezzanine's pixels are square.
  chain.push("setsar=1");
  const { colour } = plan;
  chain.push(
    `setparams=colorspace=${nameOf(MATRICES, colour.matrix)}:color_primaries=${nameOf(PRIMARIES, colour.primaries)}:color_trc=${nameOf(TRANSFERS, colour.transfer)}:range=${colour.fullRange ? "pc" : "tv"}`,
  );
  if (plan.hdrToSdr) {
    // A transfer function never sees a float that can be negative; it sees 16-bit integers, which saturate and are the same on every CPU. zimg's
    // approximate gamma (SIMD tables) is not defined on a negative float, and on one CI runner's CPU it made garbage of one (a patch 47 codes off)
    // where the others clipped at zero. Two places make a negative:
    // - YUV outside the RGB cube is a negative R'G'B'. `zscale` (no option) only converts the matrix to RGB with the transfer untouched, into
    //   16-bit integers, so the signal is clipped to the cube BEFORE the inverse HLG curve;
    // - a colour outside BT.709's gamut is a negative linear channel after the primaries conversion: `format=gbrp16le` after the tone map clips
    //   the light to 0..1 BEFORE the BT.709 gamma. (The clip costs up to 2 codes at 10-bit Y 66 to 70: a 16-bit step of linear light is about 2.5
    //   codes of gamma at the bottom. `videoImporter.colour.ffmpeg.test.ts` pins the bound.)
    chain.push(
      "zscale",
      "format=gbrp16le",
      "zscale=t=linear:npl=100",
      "format=gbrpf32le",
      "zscale=p=bt709",
      "tonemap=tonemap=hable:desat=0",
      "zscale=t=linear:p=bt709:m=bt709:r=pc",
      "format=gbrp16le",
      "zscale=t=bt709:m=bt709:r=tv",
    );
  } else if (colour.primaries !== 1 || colour.transfer === 13) {
    // SDR in other primaries (BT.601, Display P3, BT.2020), or in the sRGB curve (its inverse and the BT.709 gamma differ, so linear light is
    // reached and left, and a negative can come of either): the same two places, the same two splits. The signal is clipped to the cube, then
    // taken to linear light in BT.709's primaries and clipped to 0..1 (what is outside BT.709's gamut), then the BT.709 gamma.
    chain.push("zscale", "format=gbrp16le", "zscale=t=linear:p=bt709:m=bt709:r=pc", "format=gbrp16le", "zscale=t=bt709:m=bt709:r=tv");
  } else if (colour.transfer !== 1 || colour.matrix !== 1 || colour.fullRange) {
    // BT.709 primaries: no primaries conversion, so no negative light of that kind.
    chain.push("zscale=p=bt709:t=bt709:m=bt709:r=tv");
  }
  chain.push("format=yuv420p");
  return chain.join(",");
}

/**
 * The whole ffmpeg argument list for a plan, the output path LAST (`runFfmpegArgv`'s shape). Hardened like the music chain
 * (`render/musicChain.ts`): the file protocol only, the demuxer forced, an allocation cap and a pixel cap, no stdin; one video stream mapped
 * and nothing else; no metadata; the output cut at three minutes whatever the headers claimed.
 */
export function videoArgs(input: string, plan: VideoPlan, output: string): string[] {
  if (!isAbsolute(input) || !isAbsolute(output)) throw new TypeError("videoArgs: the paths must be absolute");
  return [
    "-nostdin",
    "-hide_banner",
    "-v",
    "error",
    "-y",
    "-max_alloc",
    String(MAX_ALLOC_BYTES),
    // Options of the input, before its `-i`: only the file protocol (a data reference cannot make ffmpeg open a URL or a pipe), the MP4
    // demuxer forced (neither the extension nor the content can pick another), no automatic turn (the walker's reading is the one that counts),
    // and no decoded picture bigger than 4K.
    "-protocol_whitelist",
    "file",
    "-noautorotate",
    // `-noautorotate` leaves the input's display matrix on the stream, and the muxer would write it into the output again: a clip turned
    // here and still marked as turned would be turned twice by every player. The output's own matrix is the identity.
    "-display_rotation",
    "0",
    "-max_pixels",
    String(VIDEO_LIMITS.maxLongSide * VIDEO_LIMITS.maxShortSide),
    // The walker's verdict is what ffmpeg is held to: it may open one decoder, the codec read in the one video track. ffmpeg decides a track's
    // kind by its sample entry and opens a decoder for EVERY track while it probes the streams (even with `-an`), so without this a track the
    // walker did not judge could be decoded, or the one it judged be decoded as something else.
    "-codec_whitelist",
    DECODERS[plan.info.video.codec],
    "-c:v",
    DECODERS[plan.info.video.codec],
    "-f",
    "mov",
    "-i",
    input,
    // `V`, not `v`: a video stream that is not an attached picture. A file's cover art (`covr`) is a video stream to ffmpeg and can come
    // before the real one.
    "-map",
    "0:V:0",
    "-map_metadata",
    "-1",
    // `-map_metadata -1` is the FILE's metadata only; a stream's own (a handler name a phone wrote) is copied unless it is told not to.
    "-map_metadata:s:v:0",
    "-1",
    "-map_chapters",
    "-1",
    "-an",
    "-sn",
    "-dn",
    "-vf",
    videoFilterGraph(plan),
    "-fps_mode",
    "cfr",
    "-t",
    String(VIDEO_LIMITS.maxSeconds),
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "16",
    "-profile:v",
    "high",
    "-pix_fmt",
    "yuv420p",
    "-g",
    String(VIDEO_LIMITS.fps),
    "-colorspace",
    "bt709",
    "-color_primaries",
    "bt709",
    "-color_trc",
    "bt709",
    "-color_range",
    "tv",
    // No encoder name in the file, and the index first so a player starts at once.
    "-fflags",
    "+bitexact",
    "-flags:v",
    "+bitexact",
    "-movflags",
    "+faststart",
    "-f",
    "mp4",
    output,
  ];
}
