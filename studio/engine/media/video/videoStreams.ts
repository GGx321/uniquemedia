import { isAbsolute } from "node:path";
import type { FfmpegSpawner } from "../../../node/runFfmpeg";
import { hasUnreadableStreamLine } from "../../music/decodeCheck";
import { capture, isAttachedPicture, probeArgv, streamLinesOf } from "../audioProbe";
import type { VideoCodec } from "./videoProbe";

// ffmpeg as the AUTHORITY for how many video streams a file has (Stage 3 plan, 3f.6 review, H1 as a class). The box walker (`videoProbe.ts`) is the first gate and judges the
// clip the importer will encode, but ffmpeg's mov demuxer finds a track wherever its parse table lets it (a `trak` with no `mdia`, a track's `minf` in `sinf` or `meta`, an
// `hdlr` in `wave`...), and `-map 0:V:0` takes the FIRST video stream it made, which may be a track the walker never saw. Mirroring the table closes the forms known today;
// this closes the class, whatever a parser hides and wherever: before the encode the bundled ffmpeg (the binary that then decodes the file) is asked, in a child process, with
// the demuxer forced and only the video decoders allowed (as 3f.4 does for audio, `selectionHasNoExtraStreams`):
//
//   1. `-map 0:V:1` must FAIL with `Stream map '0:V:1' matches no streams.`: ffmpeg's own selection, no text parsed, says there is at most one video stream (an attached picture is
//      not one: `V` leaves it out). Anything else (it went on, it failed for another reason) is not proof, and counts as several.
//   2. The dump's stream list (the strict grammar of `decodeCheck.parseStreamLine`, CRLF-safe, numbered 0..n-1 in order) must hold exactly one such stream, and its stream line must
//      be the codec and the size the walker judged: so the one stream is the walker's, not another's.

/** The decoders the importer takes: nothing else is opened while the file is looked at. */
const VIDEO_DECODERS = "h264,hevc,prores";

/** What the walker judged: the stream ffmpeg shows must be this one. */
export interface JudgedVideo {
  readonly codec: VideoCodec;
  readonly width: number;
  readonly height: number;
}

export interface VideoStreamsOptions {
  /** Absolute path of the staged file. */
  readonly path: string;
  readonly expected: JudgedVideo;
  readonly signal: AbortSignal;
  readonly timeoutMs?: number | undefined;
  /** Starts ffmpeg; Node's `spawn` by default (a test injects a scripted one). */
  readonly spawner?: FfmpegSpawner | undefined;
}

/** `ok`: one video stream, the judged one. `several`: ffmpeg has more than one (or cannot be shown to have only one). `mismatch`: its one stream is not the judged clip, or its dump is no plain list. */
export type VideoStreamsVerdict = "ok" | "several" | "mismatch";

const CODEC_OF_REST = /^\s*([a-z0-9_]+)/;
/** The picture's size in a video stream line: `, 1920x1080` after the pixel format (a hex number such as `0x31637661` follows a slash, never a comma). */
const SIZE_OF_REST = /,\s*(\d{1,5})x(\d{1,5})(?=[\s,[]|$)/;

const NO_STREAM = "Stream map '0:V:1' matches no streams.";

/** Asks ffmpeg how many video streams the file has and whether the one is the judged clip. Rejects with a `ProbeError` (the probe could not run) and on a cancel. */
export async function checkVideoStreams(options: VideoStreamsOptions): Promise<VideoStreamsVerdict> {
  if (!isAbsolute(options.path)) throw new TypeError("checkVideoStreams: the path must be absolute");
  const probe = { path: options.path, demuxer: "mov", whitelist: VIDEO_DECODERS } as const;
  const asked = { signal: options.signal, timeoutMs: options.timeoutMs, spawner: options.spawner };

  const { stderr: dump } = await capture(probeArgv(probe), asked);
  if (hasUnreadableStreamLine(dump)) return "mismatch";
  const streams = streamLinesOf(dump);
  if (!streams.every((stream, position) => stream.index === position)) return "mismatch";
  const videos = streams.filter((stream) => stream.kind === "Video" && !isAttachedPicture(stream));
  if (videos.length > 1) return "several";

  const selector = await capture([...probeArgv(probe), "-v", "error", "-map", "0:V:1", "-t", "0.05", "-f", "null", "-"], asked);
  if (selector.code === 0 || selector.code === null || !selector.stderr.includes(NO_STREAM)) return "several";

  const only = videos[0];
  if (only === undefined) return "mismatch";
  const codec = CODEC_OF_REST.exec(only.rest)?.[1];
  const size = SIZE_OF_REST.exec(only.rest);
  if (codec !== options.expected.codec || size?.[1] === undefined || size[2] === undefined) return "mismatch";
  return Number(size[1]) === options.expected.width && Number(size[2]) === options.expected.height ? "ok" : "mismatch";
}
