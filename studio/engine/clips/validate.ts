import { open } from "node:fs/promises";
import { handleSource } from "../media/video/fileSource";
import { probeVideo } from "../media/video/videoProbe";

// Stage 5, 5b.1, S5.V4b (plan s5b1 §5.10, I5.54): the one gate between a paid download and the library. A clip is accepted when it is ONE H.264 video stream, 9:16, at least 720 wide,
// and within half a second of the length asked. Whatever size it really is gets stored and badged: a pro request that came back 720p, or a Grok fallback, is accepted as it is.
// Audio is allowed and the file is never touched (Grok's stray track stays, I5.54). Every fact comes from the file's own boxes, read by the app's bounded walker
// (`probeVideo`); ffmpeg's text is never read for a fact.

/** The narrowest clip accepted: Kling std and Grok deliver 720 x 1280. */
export const MIN_CLIP_WIDTH = 720;
/** How far the file's length may be from the length asked. */
export const DURATION_TOLERANCE_MS = 500;
/** Pixels of slack on 9:16: `|16 w - 9 h| <= 16` is one pixel in either dimension. */
const ASPECT_SLACK = 16;

/** Why a file is not a clip. Every one of these is a paid `invalid-file` for the job; the reason is for the log and the tests. */
export type ClipInvalidReason = "not-mp4" | "unreadable" | "several-video-streams" | "not-h264" | "not-vertical" | "too-narrow" | "wrong-duration" | "bad-rate";

/** The most `ClipRecord.fps` holds: a faster file could not be recorded, and a paid clip must never be left without its record. */
export const MAX_CLIP_FPS = 240;

/** What the rule needs to know about a file. */
export interface ClipFacts {
  /** The video stream's codec, as the walker names it. */
  readonly codec: string;
  /** The picture as it is shown (a quarter turn already applied). */
  readonly width: number;
  readonly height: number;
  readonly durationMs: number;
  /** Samples per second on average. */
  readonly fps: number;
}

export type ClipJudgement = { readonly ok: true } | { readonly ok: false; readonly reason: ClipInvalidReason };

/** The rule of I5.54 over facts. Pure. */
export function judgeClipFacts(facts: ClipFacts, requestedSeconds: number): ClipJudgement {
  if (facts.codec !== "h264") return { ok: false, reason: "not-h264" };
  if (Math.abs(16 * facts.width - 9 * facts.height) > ASPECT_SLACK) return { ok: false, reason: "not-vertical" };
  if (facts.width < MIN_CLIP_WIDTH) return { ok: false, reason: "too-narrow" };
  if (Math.abs(facts.durationMs - requestedSeconds * 1000) > DURATION_TOLERANCE_MS) return { ok: false, reason: "wrong-duration" };
  if (!(facts.fps > 0 && facts.fps <= MAX_CLIP_FPS)) return { ok: false, reason: "bad-rate" };
  return { ok: true };
}

/**
 * What the clip's own boxes say about its colour, as the walker resolved it (untagged HD is BT.709): the H.273 matrix code, whether the range is full, and the dynamic range. The poster
 * and the face-check frames are converted from this, never from an assumption (frames.ts).
 */
export interface ClipColour {
  readonly matrix: number;
  readonly fullRange: boolean;
  readonly dynamicRange: "sdr" | "pq" | "hlg";
}

export interface ValidClip {
  readonly colour: ClipColour;
  /** The real size: the clip is badged by it («1080p» only when it is 1080 x 1920). */
  readonly width: number;
  readonly height: number;
  readonly durationMs: number;
  /** Samples per second on average. */
  readonly fps: number;
  /** A sound track is in the file (Grok's). It stays. */
  readonly hasAudio: boolean;
  readonly bytes: number;
}

export type ClipValidation = { readonly ok: true; readonly clip: ValidClip } | { readonly ok: false; readonly reason: ClipInvalidReason; readonly detail: string };

const invalid = (reason: ClipInvalidReason, detail: string): ClipValidation => ({ ok: false, reason, detail });

/** `ftyp` at byte 4: the first thing every MP4 says. */
function startsLikeMp4(header: Uint8Array): boolean {
  return header.length >= 8 && header[4] === 0x66 && header[5] === 0x74 && header[6] === 0x79 && header[7] === 0x70;
}

/**
 * Reads `path` (read-only; the file is never changed) and judges it. Never throws for a file problem: a missing, empty, cut-off or foreign file is a refusal. A failing disk read is
 * the only thing that rejects, because that is not a verdict on the file.
 */
export async function validateClipFile(path: string, requestedSeconds: number): Promise<ClipValidation> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    return invalid("unreadable", `the file cannot be opened (${error instanceof Error && "code" in error ? String(error.code) : "error"})`);
  }
  try {
    const { size } = await handle.stat();
    const source = handleSource(handle, size);
    if (!startsLikeMp4(await source.read(0, Math.min(8, size)))) return invalid("not-mp4", "the file does not start with an MP4 `ftyp` box");
    const probe = await probeVideo(source);
    if (!probe.ok) {
      return probe.reason === "several-video-tracks" ? invalid("several-video-streams", "the file holds more than one video stream") : invalid("unreadable", `the file's boxes were refused: ${probe.reason}`);
    }
    const { video } = probe.info;
    const turned = video.rotation === 90 || video.rotation === 270;
    const facts: ClipFacts = {
      codec: video.codec,
      width: turned ? video.height : video.width,
      height: turned ? video.width : video.height,
      durationMs: probe.info.durationMs,
      fps: video.sourceFps,
    };
    const judged = judgeClipFacts(facts, requestedSeconds);
    if (!judged.ok) return invalid(judged.reason, `${facts.codec} ${facts.width} x ${facts.height}, ${facts.durationMs} ms for ${requestedSeconds} s asked`);
    return {
      ok: true,
      clip: {
        colour: { matrix: video.colour.matrix, fullRange: video.colour.fullRange, dynamicRange: video.dynamicRange },
        width: facts.width,
        height: facts.height,
        durationMs: facts.durationMs,
        fps: video.sourceFps,
        hasAudio: probe.info.audioTracks > 0,
        bytes: size,
      },
    };
  } finally {
    await handle.close();
  }
}
