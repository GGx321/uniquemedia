import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runFfmpegArgv } from "../../node/runFfmpeg";
import { tempDirFor } from "../../testing/tempDir";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { requestFor, stage } from "./video/testing/importKit";
import { FIXTURES } from "./video/testing/fixtures/index";
import { withFirstTrackAtTopLevel, withFirstTrackHandler } from "./video/testing/mp4Patch";
import { judgeVideo, videoArgs } from "./video/videoPlan";
import { bytesSource, probeVideo } from "./video/videoProbe";
import { createVideoImporter } from "./videoImporter";
useNativeGlobals();
setDefaultTimeout(60_000);

// 3f.3a review round 1, on real ffmpeg: the walker must judge the stream ffmpeg decodes (H1), and what the headers claim must be what the
// bitstream is (M1, L5). Every file here is a real clip with something wrong with its layout.

const tmp = tempDirFor({ beforeEach, afterEach }, "studio-video-review-");

const bytesOf = async (name: keyof typeof FIXTURES): Promise<Uint8Array> => new Uint8Array(await readFile(FIXTURES[name].file));

async function importBytes(bytes: Uint8Array) {
  const started: string[] = [];
  const rig = requestFor(tmp(), await stage(tmp(), bytes));
  const outcome = await createVideoImporter({
    run: async (options) => {
      started.push("ffmpeg");
      await runFfmpegArgv(options);
    },
  })(rig.request);
  return { outcome, started, rig };
}

describe("H1: the clip the walker judged is the clip ffmpeg decodes", () => {
  test("the two-track fixture is refused before ffmpeg is started", async () => {
    const { outcome, started } = await importBytes(await bytesOf("mpeg4-then-h264-two-video-tracks.mp4"));
    expect(outcome.ok).toBe(false);
    expect(started).toEqual([]);
  });

  test("A1: the first track's handler says meta: the walker still sees two video tracks (it reads the sample entries), and refuses", async () => {
    const hidden = withFirstTrackHandler(await bytesOf("mpeg4-then-h264-two-video-tracks.mp4"), "meta");
    expect((await probeVideo(bytesSource(hidden))).ok).toBe(false);
    const { outcome, started } = await importBytes(hidden);
    expect(outcome.ok).toBe(false);
    expect(started).toEqual([]);
  });

  test("C: the first track moved out of moov is refused as a structure, and ffmpeg is not started", async () => {
    const { outcome, started } = await importBytes(withFirstTrackAtTopLevel(await bytesOf("mpeg4-then-h264-two-video-tracks.mp4")));
    expect(outcome).toEqual({ ok: false, reason: "structure" });
    expect(started).toEqual([]);
  });

  test("the decoder pin alone stops it: handed the hidden MPEG-4 track, ffmpeg run with the importer's own arguments refuses to decode it", async () => {
    // The plan of a clean H.264 clip, and the A1 file as the input: whatever the walker would have said, ffmpeg itself is held to h264.
    const probe = await probeVideo(bytesSource(await bytesOf("h264-sdr-chart.mp4")));
    const judged = judgeVideo(probe, FIXTURES["h264-sdr-chart.mp4"].bytes);
    if (!judged.ok) throw new Error("the control clip is refused");
    const input = join(tmp(), "hidden.media");
    const output = join(tmp(), "out.media");
    await writeFile(input, withFirstTrackHandler(await bytesOf("mpeg4-then-h264-two-video-tracks.mp4"), "meta"));
    await expect(runFfmpegArgv({ argv: videoArgs(input, judged.plan, output), output, timeoutMs: 30_000 })).rejects.toThrow();
  });

  test("the pin does not stop a clip that has a sound track: the AAC track of the SDR fixture is probed under the whitelist and the import goes through", async () => {
    const { outcome } = await importBytes(await bytesOf("h264-sdr-chart.mp4"));
    expect(outcome.ok).toBe(true);
  });
});

describe("M1: the headers' sample count is what the bitstream holds", () => {
  test("a stts forged down to two samples over a stsz of five is refused, and ffmpeg is not started", async () => {
    const forged = await bytesOf("h264-sdr-chart.mp4");
    // stts: version and flags, entry count, then the first run's sample count.
    const at = Buffer.from(forged).indexOf("stts") + 4 + 4 + 4;
    new DataView(forged.buffer, forged.byteOffset).setUint32(at, 2);
    const { outcome, started } = await importBytes(forged);
    expect(outcome).toEqual({ ok: false, reason: "structure" });
    expect(started).toEqual([]);
  });
});

describe("L5: the pixel cap holds when the headers lie about the size", () => {
  test("a 4224 x 2176 bitstream under a 1920 x 1080 sample entry is stopped by ffmpeg's -max_pixels: a failed import with nothing left", async () => {
    const lie = await bytesOf("h264-sps-4224x2176-claims-1080p.mp4");
    const probe = await probeVideo(bytesSource(lie));
    expect(probe.ok && [probe.info.video.width, probe.info.video.height]).toEqual([1920, 1080]);
    const { outcome, started, rig } = await importBytes(lie);
    expect(started).toEqual(["ffmpeg"]);
    expect(outcome).toEqual({ ok: false, reason: "failed" });
    expect(rig.released).toHaveLength(1);
  });
});
