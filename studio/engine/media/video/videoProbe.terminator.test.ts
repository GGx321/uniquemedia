import { describe, expect, test } from "bun:test";
import { useNativeGlobals } from "../../../testing/nativeGlobals";
import { bytesSource, probeVideo, type ProbeRefusal, type VideoInfo } from "./videoProbe";
import { box, buildMp4, concat, type Mp4Spec, type TrackSpec, type VideoEntrySpec } from "./testing/mp4VideoBuilder";
useNativeGlobals();

// 3f.3a follow-up, review round 5 (H-2). QuickTime writers end a list of boxes with a 32-bit zero (an old terminator, not a box). Apple's writer
// puts it at the end of the video sample entry: 168 of 222 macOS system videos, and all 40 HEVC MOVs looked at, were refused as `bad-box` (shown
// to the owner as "not a video file") for those four bytes. ffmpeg's `mov_read_default` leaves anything under a box header at the end of a list
// alone. The walker does the same for a remainder of ZERO bytes, and still refuses a remainder that is not zero.

async function infoOf(spec: Mp4Spec): Promise<VideoInfo> {
  const result = await probeVideo(bytesSource(buildMp4(spec)));
  if (!result.ok) throw new Error(`expected the file to be read, it was refused: ${result.reason}`);
  return result.info;
}

async function refusalOf(spec: Mp4Spec): Promise<ProbeRefusal> {
  const result = await probeVideo(bytesSource(buildMp4(spec)));
  if (result.ok) throw new Error("expected the file to be refused");
  return result.reason;
}

const entry = (fourcc: string, extra: Uint8Array[]): VideoEntrySpec => ({ fourcc, width: 1920, height: 1080, extra });
const video = (over: Partial<TrackSpec> = {}): TrackSpec => ({ handler: "vide", ...over });
const zeros = (count: number): Uint8Array => new Uint8Array(count);

describe("a zero terminator at the end of a list", () => {
  test.each(["hvc1", "hev1", "avc1", "apch"])("at the end of a %s sample entry (what Apple's writer does) is the end of the list", async (fourcc) => {
    const info = await infoOf({ tracks: [video({ entry: entry(fourcc, [zeros(4)]) })] });
    expect(info.video.fourcc).toBe(fourcc);
  });

  test("after a colr box in the entry: the box is still read", async () => {
    const colr = box("colr", concat(new Uint8Array([0x6e, 0x63, 0x6c, 0x78]), new Uint8Array([0, 9, 0, 18, 0, 9, 0])));
    const info = await infoOf({ tracks: [video({ entry: entry("hvc1", [colr, zeros(4)]) })] });
    expect(info.video.dynamicRange).toBe("hlg");
  });

  test.each([1, 2, 3, 4, 5, 6, 7])("of %i zero bytes is taken (ffmpeg leaves anything shorter than a header alone)", async (count) => {
    expect((await infoOf({ tracks: [video({ entry: entry("avc1", [zeros(count)]) })] })).video.width).toBe(1920);
  });

  test("at the end of a trak, and of a moov", async () => {
    expect((await infoOf({ tracks: [video({ trakExtra: [zeros(4)] })] })).video.width).toBe(1920);
    expect((await infoOf({ tracks: [video()], moovExtra: [zeros(4)] })).video.width).toBe(1920);
  });

  test("at the end of a udta", async () => {
    expect((await infoOf({ tracks: [video({ trakExtra: [box("udta", concat(box("name", zeros(6)), zeros(4)))] })] })).video.width).toBe(1920);
  });

  test.each([
    [[0, 0, 0, 1]],
    [[0, 0, 1, 0]],
    [[0x68, 0x64, 0x6c, 0x72]],
    [[0, 0, 0, 0, 0, 0, 0, 5]],
    [[1, 0, 0]],
  ])("a remainder that is NOT all zero (%j) is still refused", async (tail) => {
    expect(await refusalOf({ tracks: [video({ entry: entry("avc1", [Uint8Array.from(tail)]) })] })).toBe("bad-box");
  });

  test("eight zero bytes are a box header of size 0 inside a list, and are still refused", async () => {
    expect(await refusalOf({ tracks: [video({ entry: entry("avc1", [zeros(8)]) })] })).toBe("bad-box");
  });

  test("a remainder that is zero but sits BEFORE another box is not a terminator: the list is read as it is", async () => {
    expect(await refusalOf({ tracks: [video({ entry: entry("avc1", [zeros(4), box("pasp", new Uint8Array(8))]) })] })).toBe("bad-box");
  });

  test("the terminator does not hide anything: a handler before it in a trak is still found", async () => {
    const hdlr = box("hdlr", concat(zeros(4), zeros(4), new Uint8Array([0x76, 0x69, 0x64, 0x65]), zeros(13)));
    expect(await refusalOf({ tracks: [video({ trakExtra: [hdlr, zeros(4)] })] })).toBe("hidden-handler");
  });
});
