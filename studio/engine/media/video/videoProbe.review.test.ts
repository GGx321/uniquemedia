import { describe, expect, test } from "bun:test";
import { useNativeGlobals } from "../../../testing/nativeGlobals";
import { bytesSource, probeVideo, type ProbeRefusal, type VideoInfo } from "./videoProbe";
import { box, buildMp4, trackBox, type ColrSpec, type Mp4Spec, type TrackSpec, type VideoEntrySpec } from "./testing/mp4VideoBuilder";
useNativeGlobals();

// 3f.3a review round 1: the walker must judge the track ffmpeg will decode (H1), count what ffmpeg counts (M1), refuse a repeated box
// (M3), and keep its tables out of arrays (L1). Each test breaks one property of an otherwise good file.

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
const entry = (over: Partial<VideoEntrySpec> = {}): VideoEntrySpec => ({ fourcc: "avc1", width: 1920, height: 1080, ...over });
const nclx = (primaries: number, transfer: number, matrix: number): ColrSpec => ({ type: "nclx", primaries, transfer, matrix });

describe("H1: a track is a video track by its sample entry, whatever its handler says", () => {
  test("a track whose handler says meta but whose sample entry is a video codec counts as a video track", async () => {
    expect(["several-video-tracks", "unsupported-codec"]).toContain(await refusalOf({ tracks: [video({ handler: "meta", sampleEntry: "video", entry: entry({ fourcc: "mp4v", width: 320, height: 240 }) }), video()] }));
  });

  test("so does one whose handler is a word nobody knows", async () => {
    expect(["several-video-tracks", "unsupported-codec"]).toContain(await refusalOf({ tracks: [video({ handler: "xxxx", sampleEntry: "video", entry: entry({ fourcc: "mp4v" }) }), video()] }));
  });

  test("a track with a sample entry the walker has never heard of counts too (ffmpeg may know it as video)", async () => {
    expect(["several-video-tracks", "unsupported-codec"]).toContain(await refusalOf({ tracks: [{ handler: "meta", sampleEntry: "video", entry: entry({ fourcc: "xyzw" }) }, video()] }));
  });

  test("the order does not matter", async () => {
    expect(await refusalOf({ tracks: [video(), video({ handler: "meta", sampleEntry: "video", entry: entry({ fourcc: "mp4v" }) })] })).toBe("several-video-tracks");
  });

  test("an unknown sample entry that is the ONLY video-like track is judged as the video track, and refused as a codec", async () => {
    expect(await refusalOf({ tracks: [{ handler: "meta", sampleEntry: "video", entry: entry({ fourcc: "xyzw" }) }] })).toBe("unsupported-codec");
  });

  test("a track with an audio handler and a video entry is the video track", async () => {
    const info = await infoOf({ tracks: [{ handler: "soun", sampleEntry: "video", entry: entry() }] });
    expect(info.video.codec).toBe("h264");
  });

  test.each(["mp4a", "tmcd", "mebx"])("a %s track (sound, timecode, timed metadata: what a phone writes) is not a video track", async (fourcc) => {
    const info = await infoOf({ tracks: [video(), { handler: "meta", sampleEntry: "video", entry: entry({ fourcc }) }] });
    expect(info.video.width).toBe(1920);
  });

  test("a top-level trak is refused: ffmpeg reads it as a stream, and the walker would never see it", async () => {
    expect(await refusalOf({ topExtra: [trackBox({ handler: "vide", entry: entry({ fourcc: "mp4v" }) })] })).toBe("stray-track");
  });

  test("a trak inside moov's udta is not a track (ffmpeg takes it for the udta's own box)", async () => {
    const info = await infoOf({ moovExtra: [box("udta", trackBox({ handler: "vide", entry: entry({ fourcc: "mp4v" }) }))] });
    expect(info.video.fourcc).toBe("avc1");
  });
});

describe("M3: a repeated box is refused (ffmpeg takes the last one, the walker the first)", () => {
  test.each(["hdlr", "stts", "stsd", "stsz"] as const)("two %s boxes in the video track", async (type) => {
    expect(await refusalOf({ tracks: [video({ duplicate: type })] })).toBe("duplicate-box");
  });

  test("a stsz AND a stz2 in the video track", async () => {
    expect(await refusalOf({ tracks: [video({ alsoStz2: true })] })).toBe("duplicate-box");
  });

  test("two mvhd boxes", async () => {
    expect(await refusalOf({ moovExtra: [box("mvhd", new Uint8Array(100))] })).toBe("duplicate-box");
  });

  test("two tkhd boxes in the video track", async () => {
    expect(await refusalOf({ tracks: [video({ duplicate: "tkhd" })] })).toBe("duplicate-box");
  });
});

describe("M1: the sample count of stsz (what ffmpeg counts) is the sum of stts (what the walker measures)", () => {
  test("a stsz that holds more samples than stts is refused", async () => {
    expect(await refusalOf({ tracks: [video({ stts: [[30, 1000]], stszCount: 300 })] })).toBe("sample-count-mismatch");
  });

  test("a stsz that holds fewer is refused", async () => {
    expect(await refusalOf({ tracks: [video({ stts: [[30, 1000]], stszCount: 29 })] })).toBe("sample-count-mismatch");
  });

  test("the compact stz2 is read the same way", async () => {
    expect((await infoOf({ tracks: [video({ stts: [[30, 1000]], stz2: true })] })).video.samples).toBe(30);
    expect(await refusalOf({ tracks: [video({ stts: [[30, 1000]], stz2: true, stszCount: 300 })] })).toBe("sample-count-mismatch");
  });

  test("a video track with no sample sizes is refused", async () => {
    expect(await refusalOf({ tracks: [video({ noStsz: true })] })).toBe("bad-header");
  });

  test("equal counts are taken", async () => {
    expect((await infoOf({ tracks: [video({ stts: [[30, 1000]], stszCount: 30 })] })).video.samples).toBe(30);
  });
});

describe("L1: stts is summed in the loop, with no array and no spread", () => {
  test("700,000 runs of alternating lengths are read (Math.min(...array) throws in Bun past ~640,000 and in V8 past ~125,000)", async () => {
    const runs: [number, number][] = Array.from({ length: 700_000 }, (_, i) => [1, i % 2 === 0 ? 20 : 60]);
    const info = await infoOf({ tracks: [video({ mdhdTimescale: 600, stts: runs })] });
    expect(info.video.samples).toBe(700_000);
    expect(info.video.variableFrameRate).toBe(true);
  });
});

describe("L6: the budget for boxes visited and the cap on children each hold alone", () => {
  test("more boxes visited than the budget, with no parent over the cap, is refused", async () => {
    // Nine tracks of 500 children each: no parent holds 512, together they are over 4000.
    const fillers = Array.from({ length: 500 }, () => box("free", new Uint8Array(0)));
    const tracks: TrackSpec[] = [video(), ...Array.from({ length: 8 }, () => ({ handler: "meta", trakExtra: fillers }))];
    expect(await refusalOf({ tracks })).toBe("too-many-boxes");
  });

  test("a parent over the cap of children, with the total far under the budget, is refused", async () => {
    expect(await refusalOf({ moovExtra: Array.from({ length: 520 }, () => box("free", new Uint8Array(0))) })).toBe("too-many-boxes");
  });

  test("a parent at the cap's edge is taken", async () => {
    // mvhd and one trak are two of moov's children, so 509 more make 511.
    const info = await infoOf({ moovExtra: Array.from({ length: 509 }, () => box("free", new Uint8Array(0))) });
    expect(info.video.width).toBe(1920);
  });
});

describe("L6: Dolby Vision whose base is HLG is still refused when it is not profile 8", () => {
  test.each([5, 7, 4, 9])("profile %i with compatibility id 4 and no enhancement layer", async (profile) => {
    expect(await refusalOf({ tracks: [video({ entry: entry({ fourcc: "hvc1", colr: nclx(9, 18, 9), dolby: { profile, compatibilityId: 4 } }) })] })).toBe("unsupported-codec");
  });
});
