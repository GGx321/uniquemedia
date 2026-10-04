import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { runFfmpegArgv } from "../../node/runFfmpeg";
import { tempDirFor } from "../../testing/tempDir";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { requestFor, stage } from "./video/testing/importKit";
import { FIXTURES, type VideoFixtureName } from "./video/testing/fixtures/index";
import { withEditList, withHiddenVideoHandler } from "./video/testing/mp4Patch";
import { openFileSource } from "./video/fileSource";
import { bytesSource, probeVideo, type VideoInfo } from "./video/videoProbe";
import { createVideoImporter } from "./videoImporter";
useNativeGlobals();
setDefaultTimeout(60_000);

// 3f.3a review round 2 (H-1, M-1), on real ffmpeg. A clip trimmed WITHOUT re-encoding keeps the samples from the keyframe before the cut and an
// edit list cuts into them; x264 and x265 write an edit list for B-frames. ffmpeg honours the edit, so the mezzanine's frame count is the
// EDIT's, and the post-check that ties the decode to the judged clip must know that (it did not, and refused every such clip).
//
// What ffmpeg 6.0 does (measured with these fixtures): `-c copy -ss 0.5 / 1.0 / 1.9 -t 3` of a 10 s clip with a keyframe every 2 s: the samples
// run 3.5 / 4.0 / 4.9 s and the edit is 3.000 s from 0.5 / 1.0 / 1.9 s in; at 30 fps ffmpeg makes 90 frames of each. With B-frames, `ctts` and
// an edit of the clip's own length from 1024 of 15360 in: ffmpeg makes exactly the samples' count (60). An empty edit before the segment adds no
// frames. An edit longer than the samples is cut at the samples; one shorter cuts the samples at the edit.

const tmp = tempDirFor({ beforeEach, afterEach }, "studio-video-edit-");

const bytesOf = async (name: VideoFixtureName): Promise<Uint8Array> => new Uint8Array(await readFile(FIXTURES[name].file));

async function infoOf(path: string): Promise<VideoInfo> {
  const opened = await openFileSource(path);
  try {
    const probe = await probeVideo(opened.source);
    if (!probe.ok) throw new Error(`not a clip the walker reads: ${probe.reason}`);
    return probe.info;
  } finally {
    await opened.close();
  }
}

async function importBytes(bytes: Uint8Array) {
  const started: string[] = [];
  const rig = requestFor(tmp(), await stage(tmp(), bytes));
  const outcome = await createVideoImporter({
    run: async (options) => {
      started.push("ffmpeg");
      await runFfmpegArgv(options);
    },
  })(rig.request);
  return { outcome, started };
}

describe("H-1: a clip trimmed without re-encoding is a clip of the edit's length", () => {
  test.each(["0.5", "1.0", "1.9"] as const)("-c copy at %s s for 3 s: the samples are longer than the picture, and it is imported at the picture's length", async (offset) => {
    const name = `h264-copy-trim-ss${offset}.mp4` as const;
    const source = await bytesOf(name);
    const probe = await probeVideo(bytesSource(source));
    if (!probe.ok) throw new Error(`the fixture is refused: ${probe.reason}`);
    // The old expectation (the samples' length at 30 fps) was 105, 120 and 147 frames; the picture is 90.
    expect(Math.round((probe.info.video.durationTicks / probe.info.video.timescale) * 30)).toBeGreaterThan(100);
    expect(probe.info.video.edit).not.toBeNull();
    expect(probe.info.durationMs).toBe(3000);
    const { outcome } = await importBytes(source);
    if (!outcome.ok || outcome.output === undefined) throw new Error(`the import was refused: ${JSON.stringify(outcome)}`);
    const made = await infoOf(outcome.output.file.path);
    expect(Math.abs(made.video.samples - 90)).toBeLessThanOrEqual(2);
    expect(Math.abs((outcome.facts.durationMs ?? 0) - 3000)).toBeLessThanOrEqual(70);
  });

  test.each(["h264-bframes.mp4", "hevc-bframes.mp4"] as const)("%s (ctts and an edit that makes up for the delay) is imported at its own length", async (name) => {
    const source = await bytesOf(name);
    const probe = await probeVideo(bytesSource(source));
    if (!probe.ok) throw new Error(`the fixture is refused: ${probe.reason}`);
    expect(probe.info.video.edit?.mediaTime).toBeGreaterThan(0);
    const { outcome } = await importBytes(source);
    if (!outcome.ok || outcome.output === undefined) throw new Error(`the import was refused: ${JSON.stringify(outcome)}`);
    expect(Math.abs((await infoOf(outcome.output.file.path)).video.samples - 60)).toBeLessThanOrEqual(2);
  });

  test("an empty edit before the segment (a clip that starts later) adds no frames", async () => {
    const source = withEditList(await bytesOf("h264-bframes.mp4"), [{ duration: 2000, mediaTime: -1 }, { duration: 2000, mediaTime: 1024 }]);
    const { outcome } = await importBytes(source);
    if (!outcome.ok || outcome.output === undefined) throw new Error(`the import was refused: ${JSON.stringify(outcome)}`);
    expect(Math.abs((await infoOf(outcome.output.file.path)).video.samples - 60)).toBeLessThanOrEqual(2);
  });

  test("a multi-segment edit list is refused as a structure, and ffmpeg is not started", async () => {
    const source = withEditList(await bytesOf("h264-bframes.mp4"), [{ duration: 1000, mediaTime: 0 }, { duration: 1000, mediaTime: 30720 }]);
    const { outcome, started } = await importBytes(source);
    expect(outcome).toEqual({ ok: false, reason: "structure" });
    expect(started).toEqual([]);
  });

  test("a segment at another speed is refused as a structure", async () => {
    const source = withEditList(await bytesOf("h264-bframes.mp4"), [{ duration: 2000, mediaTime: 0, rate: [2, 0] }]);
    expect((await importBytes(source)).outcome).toEqual({ ok: false, reason: "structure" });
  });
});

describe("a forged edit list cannot buy a clip past its limits or make ffmpeg work without bound", () => {
  test("an edit of 3 hours over 2 s of samples is too long, and ffmpeg is not started", async () => {
    const forged = withEditList(await bytesOf("h264-bframes.mp4"), [{ duration: 10_800_000, mediaTime: 1024 }]);
    const { outcome, started } = await importBytes(forged);
    expect(outcome).toEqual({ ok: false, reason: "too-long" });
    expect(started).toEqual([]);
  });

  test("an edit of 100 s over 4.9 s of samples (inside the limit) is played to the end of the samples by ffmpeg, and lands in the range", async () => {
    const forged = withEditList(await bytesOf("h264-copy-trim-ss1.9.mp4"), [{ duration: 100_000, mediaTime: 29184 }]);
    const { outcome } = await importBytes(forged);
    if (!outcome.ok || outcome.output === undefined) throw new Error(`the import was refused: ${JSON.stringify(outcome)}`);
    // ffmpeg plays all 147 samples when the edit outlasts them (measured), inside the range (88 to 149) the forged length allows and never past
    // the samples' own length: a forged edit cannot make it more than the samples hold.
    const frames = (await infoOf(outcome.output.file.path)).video.samples;
    expect(frames).toBeGreaterThanOrEqual(88);
    expect(frames).toBeLessThanOrEqual(149);
  });

  test("an edit of 1 s over 4.9 s of samples is cut at the edit: a clip of 30 frames, and its timeout is the edit's, not the samples'", async () => {
    const forged = withEditList(await bytesOf("h264-copy-trim-ss1.9.mp4"), [{ duration: 1000, mediaTime: 29184 }]);
    const probe = await probeVideo(bytesSource(forged));
    if (!probe.ok) throw new Error(`refused: ${probe.reason}`);
    expect(probe.info.durationMs).toBe(1000);
    const { outcome } = await importBytes(forged);
    if (!outcome.ok || outcome.output === undefined) throw new Error(`the import was refused: ${JSON.stringify(outcome)}`);
    expect(Math.abs((await infoOf(outcome.output.file.path)).video.samples - 30)).toBeLessThanOrEqual(2);
  });
});

describe("round 3: the handlers of a track are all judged, and the held last frame is a clip", () => {
  test("B: a sound-labelled track with a video handler hidden in minf is refused as a structure, and ffmpeg is not started", async () => {
    const { outcome, started } = await importBytes(withHiddenVideoHandler(await bytesOf("mpeg4-then-h264-two-video-tracks.mp4"), "minf"));
    expect(outcome).toEqual({ ok: false, reason: "structure" });
    expect(started).toEqual([]);
  });

  test("C: the same with the handler in a meta box at the end of the trak", async () => {
    const { outcome, started } = await importBytes(withHiddenVideoHandler(await bytesOf("mpeg4-then-h264-two-video-tracks.mp4"), "meta"));
    expect(outcome).toEqual({ ok: false, reason: "structure" });
    expect(started).toEqual([]);
  });

  test("an ordinary QuickTime file, whose minf has the data handler `dhlr` in minf (alis or url), is still imported", async () => {
    // ffmpeg's MOV muxer writes the data handler every ordinary QuickTime file has (`minf/hdlr`, component type dhlr): the ProRes fixture carries one.
    const source = await bytesOf("prores-hq-chart.mov");
    expect(Buffer.from(source).toString("latin1")).toContain("dhlr");
    const { outcome } = await importBytes(source);
    expect(outcome.ok).toBe(true);
  });

  test("a VFR clip whose last frame is held for two seconds by ctts is imported at its shown length", async () => {
    const source = await bytesOf("h264-vfr-held-last-frame-bframes.mp4");
    const probe = await probeVideo(bytesSource(source));
    if (!probe.ok) throw new Error(`refused: ${probe.reason}`);
    // The samples say about a second; the edit shows three (the hold). The old upper bound was the shorter of the two.
    expect(probe.info.video.durationTicks / probe.info.video.timescale).toBeLessThan(1.5);
    const { outcome } = await importBytes(source);
    if (!outcome.ok || outcome.output === undefined) throw new Error(`the import was refused: ${JSON.stringify(outcome)}`);
    expect((await infoOf(outcome.output.file.path)).video.samples).toBeGreaterThan(80);
  });
});

describe("M-1: an ordinary clip with a sound track the walker has no name for", () => {
  test("a soun track whose codec is spelled apac (iPhone 16 spatial audio) is imported: no decoder is opened for it", async () => {
    const source = Buffer.from(await bytesOf("h264-sdr-chart.mp4"));
    const sound = source.indexOf("soun");
    const entry = source.indexOf("mp4a", sound);
    expect(entry).toBeGreaterThan(sound);
    source.write("apac", entry, "latin1");
    const { outcome, started } = await importBytes(new Uint8Array(source));
    expect(outcome.ok).toBe(true);
    expect(started).toEqual(["ffmpeg"]);
  });
});
