import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { exiftool } from "exiftool-vendored";
import type { Clip } from "../../shared/engine/montage";
import { totalFrames } from "../../shared/montage";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { frameTimesMs, probeJson, probeVideo, type Probed, type ProbedStream } from "./ffmpeg.testkit";
import { containsAscii, readTimes, typesAt, walkBoxes, type Box } from "./mp4Boxes.testkit";
import { buildPass1 } from "./pass1";
import { buildPass2 } from "./pass2";
import { makeWorkDir, readBytes, removeDir, runPass1, runPass2 } from "./render.testkit";
useNativeGlobals();

// REAL ffmpeg, both passes: a 6 s mixed timeline is rendered end to end, from
// photos that carry EXIF and XMP, and the finished MP4 is checked for exact
// length (invariant 20), format, colour tags, and the metadata allowlist
// (invariant 14). SLOW: about 10 s.

const SOURCE = join(import.meta.dir, "../face/fixtures/images/render-best-home-1.jpg");
const SENTINELS = ["SENTINEL-ARTIST", "SENTINEL-COPYRIGHT", "SENTINEL-XMP"];

const scene = (id: string) => ({ photo: { source: "scene" as const, photoId: id }, focus: { x: 0.5, y: 0.38 } });
const CLIPS: Clip[] = [
  { clipId: "a", durationMs: 2000, transitionIn: "cut", kind: "photo", cell: scene("a"), motion: "kenburns" },
  { clipId: "b", durationMs: 2000, transitionIn: "cut", kind: "collage", layout: "collage3", cells: [scene("a"), scene("b"), scene("c")], motion: "kenburns", stagger: true },
  { clipId: "c", durationMs: 1500, transitionIn: "cut", kind: "photo", cell: scene("b"), motion: "pan" },
  { clipId: "d", durationMs: 500, transitionIn: "cut", kind: "collage", layout: "collage2", cells: [scene("a"), scene("c")], motion: "static", stagger: true },
];
const EXPECTED_FRAMES = 180; // 6 s at 30 fps

let dir: string;
let output: string;
let probe: Probed;
let bytes: Uint8Array;
let boxes: Box[];
let times: number[];
let container: Probed;
let sourceBytes: Uint8Array;

beforeAll(async () => {
  dir = makeWorkDir("pass2");
  const photo = join(dir, "laden.jpg");
  copyFileSync(SOURCE, photo);
  await exiftool.write(photo, { Artist: SENTINELS[0], Copyright: SENTINELS[1], "XMP-dc:Creator": SENTINELS[2] }, { writeArgs: ["-overwrite_original"] });

  sourceBytes = readBytes(photo);
  await runPass1(buildPass1({ seed: 3, clips: CLIPS, resolvePhoto: () => ({ path: photo, width: 720, height: 1280 }), clipDir: dir }));
  output = join(dir, "final.mp4");
  await runPass2(buildPass2({ clips: CLIPS, clipDir: dir, output, overlays: [], audio: { kind: "silent" } }));

  probe = await probeVideo(output);
  container = await probeJson(output, ["-show_entries", "format_tags:stream_tags"]);
  bytes = readBytes(output);
  boxes = walkBoxes(bytes);
  times = await frameTimesMs(output);
}, 180_000);

afterAll(() => removeDir(dir));

const video = (): ProbedStream => {
  const v = probe.streams.find((s) => s.codec_type === "video");
  if (!v) throw new Error("no video stream");
  return v;
};
const audio = (): ProbedStream => {
  const a = probe.streams.find((s) => s.codec_type === "audio");
  if (!a) throw new Error("no audio stream");
  return a;
};

describe("pass 2 on real ffmpeg: exact length (invariant 20)", () => {
  test("holds exactly the sum of the clips' frames", () => {
    expect(totalFrames(CLIPS)).toBe(EXPECTED_FRAMES);
    expect(Number(video().nb_read_frames)).toBe(EXPECTED_FRAMES);
  });

  test("reports the video stream as exactly 6 seconds", () => {
    expect(Number(video().duration)).toBeCloseTo(6, 3);
  });

  test("is constant frame rate: every frame is 33.333 ms after the last", () => {
    expect(times.length).toBe(EXPECTED_FRAMES);
    const deltas = times.slice(1).map((t, i) => t - (times[i] ?? 0));
    expect(Math.min(...deltas)).toBeGreaterThan(33.3);
    expect(Math.max(...deltas)).toBeLessThan(33.4);
  });

  test("starts on time zero", () => {
    expect(times[0]).toBeCloseTo(0, 3);
  });

  test("builds the audio to within one AAC frame under the video's length", () => {
    const gap = Number(video().duration) - Number(audio().duration);
    expect(gap).toBeGreaterThanOrEqual(-0.0005);
    expect(gap).toBeLessThanOrEqual(0.0213);
  });

  test("reports the container as the same 6 seconds", () => {
    expect(Number(probe.format.duration)).toBeCloseTo(6, 3);
  });
});

describe("pass 2 on real ffmpeg: format", () => {
  test("is H.264 High, 1080x1920, yuv420p at 30 fps", () => {
    const v = video();
    expect({ codec: v.codec_name, profile: v.profile, w: v.width, h: v.height, pix: v.pix_fmt, rate: v.r_frame_rate, avg: v.avg_frame_rate }).toEqual({
      codec: "h264",
      profile: "High",
      w: 1080,
      h: 1920,
      pix: "yuv420p",
      rate: "30/1",
      avg: "30/1",
    });
  });

  test("is tagged BT.709 limited range in every field", () => {
    const v = video();
    expect({ range: v.color_range, space: v.color_space, trc: v.color_transfer, primaries: v.color_primaries }).toEqual({ range: "tv", space: "bt709", trc: "bt709", primaries: "bt709" });
  });

  test("carries AAC-LC audio at 48 kHz stereo", () => {
    const a = audio();
    expect({ codec: a.codec_name, profile: a.profile, rate: a.sample_rate, channels: a.channels }).toEqual({ codec: "aac", profile: "LC", rate: "48000", channels: 2 });
  });

  test("has two streams and nothing else", () => {
    expect(probe.streams.length).toBe(2);
  });

  test("puts the index before the media data (+faststart)", () => {
    const moov = boxes.find((b) => b.path === "moov");
    const mdat = boxes.find((b) => b.path === "mdat");
    expect(moov?.start).toBeLessThan(mdat?.start ?? 0);
  });
});

describe("pass 2 on real ffmpeg: the metadata allowlist (invariant 14)", () => {
  const ALLOWED_CONTAINER = ["major_brand", "minor_version", "compatible_brands", "encoder"];

  test("the container carries only the brand tags and the Lavf encoder", () => {
    const tags = container.format.tags ?? {};
    expect(Object.keys(tags).sort()).toEqual([...ALLOWED_CONTAINER].sort());
    expect(tags.encoder).toMatch(/^Lavf/);
  });

  test("each stream carries only a handler name, an undefined language and a zero vendor id", () => {
    const [v, a] = container.streams;
    expect(v?.tags?.handler_name).toBe("VideoHandler");
    expect(a?.tags?.handler_name).toBe("SoundHandler");
    for (const s of container.streams) {
      expect(s.tags?.language).toBe("und");
      expect(s.tags?.vendor_id).toBe("[0][0][0][0]");
    }
  });

  test("the video stream's encoder tag is the x264 signature and the audio stream has none", () => {
    const [v, a] = container.streams;
    expect(v?.tags?.encoder).toMatch(/^Lavc\d+\.\d+\.\d+ libx264$/);
    expect(a?.tags?.encoder).toBeUndefined();
    const allKeys = container.streams.flatMap((s) => Object.keys(s.tags ?? {}));
    expect(new Set(allKeys)).toEqual(new Set(["language", "handler_name", "vendor_id", "encoder"]));
  });

  test("the file's top level is ftyp, moov, free, mdat and nothing else", () => {
    expect(typesAt(boxes, "")).toEqual(["ftyp", "moov", "free", "mdat"]);
  });

  test("the only user-data box is the Lavf encoder tag", () => {
    expect(typesAt(boxes, "moov/udta")).toEqual(["meta"]);
    expect(typesAt(boxes, "moov/udta/meta/ilst")).toEqual(["©too"]);
    const too = boxes.find((b) => b.path === "moov/udta/meta/ilst/©too");
    expect(too && containsAscii(bytes.subarray(too.start, too.end), "Lavf")).toBe(true);
  });

  test.each(["uuid", "XMP_", "jumb", "c2pa", "chpl", "Exif"])("has no %s box", (type) => {
    expect(boxes.some((b) => b.type === type)).toBe(false);
  });

  test.each(SENTINELS)("the source photo really carries %s, so its absence below means something", (sentinel) => {
    expect(containsAscii(sourceBytes, sentinel)).toBe(true);
  });

  test.each(SENTINELS)("does not carry %s from the source photo's EXIF or XMP", (sentinel) => {
    expect(containsAscii(bytes, sentinel)).toBe(false);
  });

  test("records no wall-clock time: the movie, track and media creation and modification times are all zero", () => {
    for (const path of ["moov/mvhd", "moov/trak/tkhd", "moov/trak/mdia/mdhd"]) {
      expect(readTimes(bytes, boxes, path)).toEqual({ creation: 0, modification: 0 });
    }
  });
});
