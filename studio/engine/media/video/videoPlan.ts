import { isAbsolute } from "node:path";
import { MEDIA_BYTE_CAPS, type MediaUnsupportedReason } from "../../../shared/engine";
import { longerThan, type VideoColour, type VideoInfo, type VideoProbe } from "./videoProbe";

// From what the walker read (`videoProbe.ts`) to what is refused and what ffmpeg is asked to do (Stage 3 plan, 3f.3a). Pure: it starts nothing
// and reads no file. The importer (`videoImporter.ts`) runs the arguments built here.
//
// THE MEZZANINE: H.264 at CRF 16, 4:2:0, a constant 30 fps, BT.709 limited range, fitted inside 1080 x 1920 and never upscaled, with the
// rotation applied and no audio and no metadata. 3f.3b reads it frame by frame and the preview plays it, so it must be uniform whatever
// the owner's phone wrote.
//
// THE COLOUR. Every frame is TAGGED from what the walker read (`setparams`) before anything converts it: `zscale` fails on untagged input
// (SP3), and ffmpeg's own reading of a clip's tags is a second opinion nobody asked for. Then:
// - HDR (PQ or HLG, Dolby Vision 8.x by its base layer): `zscale` to linear light (`npl=100`), to BT.709 primaries, `tonemap=hable` with
//   `desat=0` (a hue-preserving curve), then BT.709 matrix and range. Measured on the HLG chart fixture against an independent model of
//   this chain: every patch within 1 code value (invariant 36 allows 2; see `videoImporter.ffmpeg.test.ts`);
// - SDR that is already BT.709 limited range: tagged and put in 4:2:0, nothing else;
// - any other SDR (BT.601, Display P3, full range, sRGB): converted to BT.709 limited by `zscale`.
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

/**
 * What to do with a file the walker read, or why not. `bytes` is the size of the staged copy. The order is the size of the file, then what
 * the boxes said, then the picture's smallest side, its largest, and its length.
 */
export function judgeVideo(probe: VideoProbe, bytes: number): VideoJudgement {
  if (bytes > MEDIA_BYTE_CAPS.video) return { ok: false, reason: "too-large" };
  if (!probe.ok) return { ok: false, reason: probe.reason === "unsupported-codec" ? "codec" : "format" };
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
    chain.push("zscale=t=linear:npl=100", "format=gbrpf32le", "zscale=p=bt709", "tonemap=tonemap=hable:desat=0", "zscale=t=bt709:m=bt709:r=tv");
  } else if (colour.primaries !== 1 || colour.transfer !== 1 || colour.matrix !== 1 || colour.fullRange) {
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
