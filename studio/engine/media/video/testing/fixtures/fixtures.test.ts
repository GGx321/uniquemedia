import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { useNativeGlobals } from "../../../../../testing/nativeGlobals";
import { openFileSource } from "../../fileSource";
import { probeVideo, type VideoInfo } from "../../videoProbe";
import { FIXTURES, type VideoFixtureName } from "./index";
useNativeGlobals();

// The fixtures are committed bytes, pinned by size and sha256, and each is what README.md says: the walker reads the facts the tests rely on.

async function infoOf(name: VideoFixtureName): Promise<VideoInfo> {
  const opened = await openFileSource(FIXTURES[name].file);
  try {
    const probe = await probeVideo(opened.source);
    if (!probe.ok) throw new Error(`${name} was refused: ${probe.reason}`);
    return probe.info;
  } finally {
    await opened.close();
  }
}

describe("the pins", () => {
  test.each(Object.keys(FIXTURES) as VideoFixtureName[])("%s is the pinned size and sha256", async (name) => {
    const bytes = await readFile(FIXTURES[name].file);
    expect({ bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") }).toEqual({ bytes: FIXTURES[name].bytes, sha256: FIXTURES[name].sha256 });
  });

  test("each is small enough to commit (200 KB at most)", async () => {
    for (const name of Object.keys(FIXTURES) as VideoFixtureName[]) expect((await stat(FIXTURES[name].file)).size).toBeLessThanOrEqual(200 * 1024);
  });
});

describe("what each fixture is", () => {
  test("hevc-hlg-chart.mp4: HEVC, BT.2020 HLG, 192 x 96, three frames, moov after mdat", async () => {
    const { video } = await infoOf("hevc-hlg-chart.mp4");
    expect([video.fourcc, video.dynamicRange, video.width, video.height, video.samples, video.rotation]).toEqual(["hvc1", "hlg", 192, 96, 3, 0]);
    expect(video.colour).toEqual({ tagged: true, primaries: 9, transfer: 18, matrix: 9, fullRange: false });
    const bytes = await readFile(FIXTURES["hevc-hlg-chart.mp4"].file);
    expect(bytes.indexOf("mdat")).toBeLessThan(bytes.indexOf("moov"));
  });

  test("h264-sdr-chart.mp4: H.264 BT.709 with an audio track", async () => {
    const info = await infoOf("h264-sdr-chart.mp4");
    expect([info.video.fourcc, info.video.dynamicRange, info.audioTracks, info.video.samples]).toEqual(["avc1", "sdr", 1, 5]);
  });

  test("h264-vfr.mp4: variable frame rate, 14 frames", async () => {
    const { video } = await infoOf("h264-vfr.mp4");
    expect([video.variableFrameRate, video.samples]).toEqual([true, 14]);
  });

  test("prores-hq-chart.mov: ProRes 422 HQ with QuickTime's nclc colour box", async () => {
    const { video, brand } = await infoOf("prores-hq-chart.mov");
    expect([brand, video.fourcc, video.codec]).toEqual(["qt  ", "apch", "prores"]);
    expect(video.colour.tagged).toBe(true);
  });

  test("hevc-hlg-rotated-vfr.mov: HEVC HLG, variable rate, a quarter turn", async () => {
    const { video } = await infoOf("hevc-hlg-rotated-vfr.mov");
    expect([video.fourcc, video.dynamicRange, video.variableFrameRate, video.rotation]).toEqual(["hvc1", "hlg", true, 90]);
  });

  test("mpeg4-then-h264-two-video-tracks.mp4: two video tracks the walker refuses, MPEG-4 first, moov after mdat", async () => {
    const opened = await openFileSource(FIXTURES["mpeg4-then-h264-two-video-tracks.mp4"].file);
    try {
      expect((await probeVideo(opened.source)).ok).toBe(false);
    } finally {
      await opened.close();
    }
    const bytes = await readFile(FIXTURES["mpeg4-then-h264-two-video-tracks.mp4"].file);
    expect(bytes.indexOf("mdat")).toBeLessThan(bytes.indexOf("moov"));
    const moov = bytes.indexOf("moov");
    expect(bytes.indexOf("mp4v", moov)).toBeGreaterThan(moov);
    expect(bytes.indexOf("mp4v", moov)).toBeLessThan(bytes.indexOf("avc1", moov));
  });

  test("h264-sps-4224x2176-claims-1080p.mp4: the headers say 1920 x 1080", async () => {
    const { video } = await infoOf("h264-sps-4224x2176-claims-1080p.mp4");
    expect([video.width, video.height]).toEqual([1920, 1080]);
  });

  test("hevc-hlg-flat-4k.mp4: 4096 x 2160 HEVC HLG", async () => {
    const { video } = await infoOf("hevc-hlg-flat-4k.mp4");
    expect([video.width, video.height, video.dynamicRange]).toEqual([4096, 2160, "hlg"]);
  });
});
