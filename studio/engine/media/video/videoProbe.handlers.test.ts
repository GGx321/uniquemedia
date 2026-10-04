import { describe, expect, test } from "bun:test";
import { useNativeGlobals } from "../../../testing/nativeGlobals";
import { bytesSource, probeVideo, type ProbeRefusal, type VideoInfo } from "./videoProbe";
import { box, buildMp4, concat, hdlrBox, u32, type Mp4Spec, type TrackSpec } from "./testing/mp4VideoBuilder";
useNativeGlobals();

// 3f.3a review round 3 (M-1): ffmpeg parses EVERY `hdlr` inside a `trak` and the last one wins, so "a sound handler is sound" only holds if no other
// `hdlr` of the track says a media type. Round 2 refused a second `hdlr` inside `mdia` only.

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
/** A track labelled sound whose sample entry is a picture (what an attacker writes). */
const sound = (over: Partial<TrackSpec> = {}): TrackSpec => ({ handler: "soun", sampleEntry: "video", ...over });
const MEDIA_TYPES = ["vide", "soun", "subp", "clcp", "text", "sbtl", "meta"];

describe("a second handler hidden in minf", () => {
  test.each(MEDIA_TYPES)("a %s handler in minf of a sound track is refused", async (subtype) => {
    expect(await refusalOf({ tracks: [video(), sound({ minfExtra: [hdlrBox(subtype)] })] })).toBe("hidden-handler");
  });

  test("and in the video track too", async () => {
    expect(await refusalOf({ tracks: [video({ minfExtra: [hdlrBox("soun")] })] })).toBe("hidden-handler");
  });

  test.each(["alis", "url ", "rsrc"])("a data handler (%s) in minf is what every ordinary MOV has, and is taken", async (subtype) => {
    const info = await infoOf({ tracks: [video({ minfExtra: [hdlrBox(subtype)] }), { handler: "soun", minfExtra: [hdlrBox(subtype)] }] });
    expect(info.video.width).toBe(1920);
    expect(info.audioTracks).toBe(1);
  });

  test("two handlers in minf are refused whatever they say (the last one would win)", async () => {
    expect(await refusalOf({ tracks: [video({ minfExtra: [hdlrBox("alis"), hdlrBox("alis")] })] })).toBe("duplicate-box");
  });
});

describe("a handler hidden in the track's meta or udta", () => {
  /** A `meta` box (a full box: version and flags first) holding an `hdlr` of this subtype. */
  const metaWith = (subtype: string): Uint8Array => box("meta", new Uint8Array([0, 0, 0, 0, ...hdlrBox(subtype)]));

  test.each(MEDIA_TYPES)("trak/meta with a %s handler is refused", async (subtype) => {
    expect(await refusalOf({ tracks: [video(), sound({ trakExtra: [metaWith(subtype)] })] })).toBe("hidden-handler");
  });

  test.each(MEDIA_TYPES)("trak/udta/meta with a %s handler is refused", async (subtype) => {
    expect(await refusalOf({ tracks: [video(), sound({ trakExtra: [box("udta", metaWith(subtype))] })] })).toBe("hidden-handler");
  });

  test("a meta box with no version and flags in front of its children (a QuickTime one) is read the same", async () => {
    expect(await refusalOf({ tracks: [video(), sound({ trakExtra: [box("meta", hdlrBox("vide"))] })] })).toBe("hidden-handler");
  });

  test("the metadata handler of an iTunes-style tag (mdir) is not a media type, and is taken (a metadata handler is not a media handler)", async () => {
    const info = await infoOf({ tracks: [video({ trakExtra: [metaWith("mdir")] }), { handler: "soun", trakExtra: [box("udta", metaWith("mdir"))] }] });
    expect(info.video.width).toBe(1920);
  });

  test("a meta box nobody can read is not a reason to refuse a clip", async () => {
    const info = await infoOf({ tracks: [video({ trakExtra: [box("meta", new Uint8Array([1, 2, 3]))] })] });
    expect(info.video.width).toBe(1920);
  });

});
