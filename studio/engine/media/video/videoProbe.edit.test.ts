import { describe, expect, test } from "bun:test";
import { useNativeGlobals } from "../../../testing/nativeGlobals";
import { bytesSource, probeVideo, type ProbeRefusal, type VideoInfo } from "./videoProbe";
import { buildMp4, type Mp4Spec, type TrackSpec } from "./testing/mp4VideoBuilder";
useNativeGlobals();

// 3f.3a review round 2 (H-1, M-1): ffmpeg honours a track's edit list, so the length of a clip is the EDIT's when there is one (a clip trimmed
// without re-encoding keeps the samples from the keyframe before the cut, and an edit list cuts into them); and a sound track is a sound track
// whatever its codec is called.

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

const video = (over: Partial<TrackSpec> = {}): TrackSpec => ({ handler: "vide", ...over });
/** 4.9 s of samples at 30 fps (timescale 30000), with the movie clock at 1000. */
const media = { mdhdTimescale: 30000, stts: [[147, 1000]] } as const satisfies Partial<TrackSpec>;

describe("the edit list", () => {
  test("a clip with none is as long as its samples, and says it has no edit", async () => {
    const info = await infoOf({ tracks: [video(media)] });
    expect(info.video.edit).toBeNull();
    expect(info.video.presentation).toEqual({ ticks: 147_000, timescale: 30000 });
    expect(info.durationMs).toBe(4900);
  });

  test("one media segment is the clip's length, and where in the media it starts", async () => {
    const info = await infoOf({ tracks: [video({ ...media, edits: [{ duration: 3000, mediaTime: 29184 }] })] });
    expect(info.video.edit).toEqual({ mediaTime: 29184, durationTicks: 3000 });
    expect(info.video.presentation).toEqual({ ticks: 3000, timescale: 1000 });
    expect(info.durationMs).toBe(3000);
  });

  test("an empty edit before the segment (a clip that starts later) is allowed and is not part of the clip's length", async () => {
    const info = await infoOf({ tracks: [video({ ...media, edits: [{ duration: 2000, mediaTime: -1 }, { duration: 3000, mediaTime: 0 }] })] });
    expect(info.video.edit).toEqual({ mediaTime: 0, durationTicks: 3000 });
    expect(info.durationMs).toBe(3000);
  });

  test("a version 1 edit list (64-bit) is read, an empty edit's -1 included", async () => {
    const info = await infoOf({ tracks: [video({ ...media, editsV1: true, edits: [{ duration: 1000, mediaTime: -1 }, { duration: 3000, mediaTime: 512 }] })] });
    expect(info.video.edit).toEqual({ mediaTime: 512, durationTicks: 3000 });
  });

  test("a list with no entries is no edit", async () => {
    const info = await infoOf({ tracks: [video({ ...media, edits: [{ duration: 1, mediaTime: 0 }], editsDeclaredCount: 0 })] });
    expect(info.video.edit).toBeNull();
  });

  test.each([
    ["two media segments", [{ duration: 1000, mediaTime: 0 }, { duration: 1000, mediaTime: 60000 }]],
    ["an empty edit after the segment", [{ duration: 3000, mediaTime: 0 }, { duration: 1000, mediaTime: -1 }]],
    ["only an empty edit", [{ duration: 3000, mediaTime: -1 }]],
    ["two empty edits and a segment", [{ duration: 1000, mediaTime: -1 }, { duration: 1000, mediaTime: -1 }, { duration: 3000, mediaTime: 0 }]],
    ["a slowed segment (media rate 1/2)", [{ duration: 3000, mediaTime: 0, rate: [0, 32768] as const }]],
    ["a fast segment (media rate 2)", [{ duration: 3000, mediaTime: 0, rate: [2, 0] as const }]],
    ["a still segment (media rate 0)", [{ duration: 3000, mediaTime: 0, rate: [0, 0] as const }]],
    ["a segment of no length", [{ duration: 0, mediaTime: 0 }]],
  ])("%s is a structure the importer does not take", async (_name, edits) => {
    expect(await refusalOf({ tracks: [video({ ...media, edits })] })).toBe("unsupported-edit");
  });

  test("a list that declares more entries than it holds is refused", async () => {
    expect(await refusalOf({ tracks: [video({ ...media, edits: [{ duration: 3000, mediaTime: 0 }], editsDeclaredCount: 9000 })] })).toBe("bad-box");
  });

  test("two edts boxes, or two elst boxes, are refused", async () => {
    expect(await refusalOf({ tracks: [video({ ...media, edits: [{ duration: 3000, mediaTime: 0 }], duplicateEdit: "edts" })] })).toBe("duplicate-box");
    expect(await refusalOf({ tracks: [video({ ...media, edits: [{ duration: 3000, mediaTime: 0 }], duplicateEdit: "elst" })] })).toBe("duplicate-box");
  });

  test("the movie's own length no longer decides: only the video track's (edited) one does", async () => {
    const info = await infoOf({ mvhdDuration: 600_000, tracks: [video({ ...media, edits: [{ duration: 3000, mediaTime: 0 }] })] });
    expect(info.durationMs).toBe(3000);
  });
});

describe("a sound track is a sound track", () => {
  test.each(["apac", "ima4", "ac-4", "mhm1", "xxxx"])("a soun track with the codec %s is not a video track, and the clip is taken", async (fourcc) => {
    const info = await infoOf({ tracks: [video(), { handler: "soun", sampleEntry: "video", entry: { fourcc, width: 0, height: 0 } }] });
    expect(info.video.width).toBe(1920);
    expect(info.audioTracks).toBe(1);
  });

  test("a soun track with a VIDEO codec in its entry is still a sound track (ffmpeg decides by the handler for sound, and no decoder is opened for it)", async () => {
    const info = await infoOf({ tracks: [video(), { handler: "soun", sampleEntry: "video", entry: { fourcc: "avc1", width: 64, height: 64 } }] });
    expect(info.video.width).toBe(1920);
  });

  test("a clip whose only track is a sound track has no video", async () => {
    expect(await refusalOf({ tracks: [{ handler: "soun", sampleEntry: "video", entry: { fourcc: "avc1", width: 64, height: 64 } }] })).toBe("no-video-track");
  });

  test("but a track with two handlers is refused, so a sound handler cannot hide a second one", async () => {
    expect(await refusalOf({ tracks: [video(), { handler: "soun", duplicate: "hdlr" }] })).toBe("duplicate-box");
  });

  test.each(["djmd", "dbgi", "CTMD", "rtp ", "mp4s"])("a %s track (side data a camera writes) is not a video track", async (fourcc) => {
    const info = await infoOf({ tracks: [video(), { handler: "meta", sampleEntry: "video", entry: { fourcc, width: 0, height: 0 } }] });
    expect(info.video.width).toBe(1920);
  });

  test("an unknown entry under a meta handler is still a video candidate (the A1 bypass stays shut)", async () => {
    const result = await probeVideo(bytesSource(buildMp4({ tracks: [video(), { handler: "meta", sampleEntry: "video", entry: { fourcc: "mp4v", width: 320, height: 240 } }] })));
    expect(result.ok).toBe(false);
  });
});
