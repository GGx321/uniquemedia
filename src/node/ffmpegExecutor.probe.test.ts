import { test, expect } from "bun:test";
import { videoInfoFromProbe } from "./ffmpegExecutor";
import { parseFfprobeJson } from "./ffprobeJson";

/** ffprobe writes every number as a string and omits whatever it could not
 *  determine, so a payload is built here the way ffprobe actually emits one. */
const full = JSON.stringify({
  streams: [
    { codec_type: "video", codec_name: "h264", width: "1920", height: "1080", duration: "4.020000" },
    { codec_type: "audio", codec_name: "aac", duration: "4.010000" },
  ],
  format: { duration: "4.008000" },
});

const info = (stdout: string) => videoInfoFromProbe(parseFfprobeJson(stdout), "clip.mp4");

test("reads the dimensions, duration and audio flag off an ffprobe payload", () => {
  expect(info(full)).toEqual({
    kind: "video",
    durationSec: 4.008,
    width: 1920,
    height: 1080,
    hasAudio: true,
  });
});

test("reports no audio for a payload carrying only a video stream", () => {
  const silent = JSON.stringify({
    streams: [{ codec_type: "video", codec_name: "h264", width: "640", height: "480" }],
    format: { duration: "2.000000" },
  });
  expect(info(silent).hasAudio).toBe(false);
});

test("a stated duration of N/A is no duration at all, not a NaN", () => {
  // ffprobe writes "N/A" for a stream it could not measure. Number("N/A") is
  // NaN, and a NaN duration reaches the frame sampler as a NaN timestamp.
  const na = JSON.stringify({
    streams: [{ codec_type: "video", codec_name: "h264", width: "640", height: "480" }],
    format: { duration: "N/A" },
  });
  expect(info(na).durationSec).toBe(0);
});

test("names the file when the payload carries no streams at all", () => {
  // `json.streams.find(...)` on an empty object threw `undefined is not an
  // object` — a stack trace that names neither the file nor the problem.
  const err = (() => {
    try {
      info("{}");
      return null;
    } catch (e: unknown) {
      return e;
    }
  })();
  expect(err).toBeInstanceOf(Error);
  expect(err instanceof Error ? err.message : "").toContain("clip.mp4");
});

test("names the file when the payload is not JSON at all", () => {
  // A failed probe can write nothing, or a half-flushed buffer.
  const err = (() => {
    try {
      info('{"streams": [{"codec_type"');
      return null;
    } catch (e: unknown) {
      return e;
    }
  })();
  expect(err).toBeInstanceOf(Error);
  expect(err instanceof Error ? err.message : "").toContain("clip.mp4");
});

test("names the file when the video stream states no dimensions", () => {
  // Silently yielding 0x0 sent `crop=0:0` into the filter graph and failed far
  // from here, in an ffmpeg error nobody could trace back to the probe.
  const noDims = JSON.stringify({
    streams: [{ codec_type: "video", codec_name: "h264", duration: "4.0" }],
    format: { duration: "4.0" },
  });
  const err = (() => {
    try {
      info(noDims);
      return null;
    } catch (e: unknown) {
      return e;
    }
  })();
  expect(err).toBeInstanceOf(Error);
  expect(err instanceof Error ? err.message : "").toContain("clip.mp4");
});

test("takes the duration from the format block, not the longest stream", () => {
  // Deliberate: the frame sampler places its PDQ probes at fractions of this
  // number, so widening it to the longest stream would move every sample point
  // and shift the verification metric of footage that has not changed.
  const longerAudio = JSON.stringify({
    streams: [
      { codec_type: "video", codec_name: "h264", width: "640", height: "480", duration: "4.0" },
      { codec_type: "audio", codec_name: "aac", duration: "9.5" },
    ],
    format: { duration: "4.008000" },
  });
  expect(info(longerAudio).durationSec).toBe(4.008);
});
