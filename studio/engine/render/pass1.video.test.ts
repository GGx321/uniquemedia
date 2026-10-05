import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Clip, Focus } from "../../shared/engine/montage";
import { FRAME_H, FRAME_W, videoClipCrop } from "../../shared/montage";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { assertSafeFilterGraph } from "./filterString";
import { buildPass1, VIDEO_INPUT_ARGS } from "./pass1";
import { COLOUR_TAG_ARGS, FILTER_THREAD_ARGS, FRAME_TAGS, INTERMEDIATE_VIDEO_ARGS, PHOTO_COLOUR_CHAIN } from "./profile";
import type { PhotoResolver, VideoResolver, VideoSource } from "./types";
useNativeGlobals();

// Pass 1 for an own video clip (3f.3b): the stored mezzanine's private copy in the job folder, the frames `[startFrame, startFrame + frames)` of it, the
// cover-crop with focus onto the whole frame, no motion, and an EXACT frame count. The clip's audio is never used (the mezzanine has none, and nothing maps it).

const CLIP_DIR = "/work/render-tmp/job-1";
const COPY = join(CLIP_DIR, "own-media-0000001.mp4");
const none: PhotoResolver = () => undefined;

const video = (durationMs: number, trimStartMs = 0, focus: Focus | null = { x: 0.3, y: 0.6 }, clipId = "v"): Clip => ({ clipId, durationMs, transitionIn: "cut", kind: "video", mediaId: "media-0000001", trimStartMs, focus });
const source = (width = 1080, height = 1920, path = COPY): VideoSource => ({ path, width, height });

function build(clips: Clip[], resolveVideo: VideoResolver = () => source()) {
  return buildPass1({ seed: 7, clips, resolvePhoto: none, resolveVideo, clipDir: CLIP_DIR });
}

const graphOf = (argv: readonly string[]): string => {
  const i = argv.indexOf("-filter_complex");
  const graph = argv[i + 1];
  if (i < 0 || graph === undefined) throw new Error("no -filter_complex in argv");
  return graph;
};
const only = <T>(items: readonly T[]): T => {
  const item = items[0];
  if (item === undefined || items.length !== 1) throw new Error("expected exactly one item");
  return item;
};

describe("buildPass1: an own video clip", () => {
  test("reads the private copy it was given, as the one input, and nothing else", () => {
    const { argv } = only(build([video(2_000)]));
    expect(argv.filter((a) => a === "-i")).toHaveLength(1);
    expect(argv[argv.indexOf("-i") + 1]).toBe(COPY);
  });

  test("is held to the file protocol, the MP4 demuxer and the one decoder the mezzanine needs, all before -i", () => {
    const { argv } = only(build([video(2_000)]));
    const before = argv.slice(0, argv.indexOf("-i"));
    for (const flag of [["-protocol_whitelist", "file"], ["-f", "mov"], ["-codec_whitelist", "h264"], ["-c:v", "h264"], ["-noautorotate"]]) {
      const at = before.indexOf(flag[0] ?? "");
      expect(at).toBeGreaterThanOrEqual(0);
      expect(before.slice(at, at + flag.length)).toEqual(flag);
    }
    expect(VIDEO_INPUT_ARGS).toContain("h264");
  });

  test("is held to an allocation cap and a pixel cap before -i, as a second line of defence behind the sha check (L-4)", () => {
    const { argv } = only(build([video(2_000)]));
    const before = argv.slice(0, argv.indexOf("-i"));
    expect(Number(before[before.indexOf("-max_alloc") + 1])).toBe(256 * 1024 * 1024);
    expect(Number(before[before.indexOf("-max_pixels") + 1])).toBe((FRAME_W + 64) * (FRAME_H + 64));
    // ... and a mezzanine of exactly the frame's size fits under it (the real-ffmpeg test of the portrait mezzanine runs it).
    expect(Number(before[before.indexOf("-max_pixels") + 1])).toBeGreaterThanOrEqual(FRAME_W * FRAME_H);
  });

  test("maps exactly one stream, the filter graph's picture: the clip's audio is never used", () => {
    const { argv } = only(build([video(2_000)]));
    expect(argv.filter((a) => a === "-map")).toHaveLength(1);
    expect(argv[argv.indexOf("-map") + 1]).toBe("[v]");
    expect(argv).not.toContain("-c:a");
    expect(argv.join(" ")).not.toContain("0:a");
  });

  test("encodes with the pass-1 intermediate profile and the thread caps, into clip-NN.mkv", () => {
    const job = only(build([video(2_000)]));
    expect(job.argv.slice(0, 3)).toEqual(["-hide_banner", "-nostdin", "-y"]);
    expect(job.argv.join(" ")).toContain(FILTER_THREAD_ARGS.join(" "));
    expect(job.argv.join(" ")).toContain(INTERMEDIATE_VIDEO_ARGS.join(" "));
    expect(job.argv.join(" ")).toContain(COLOUR_TAG_ARGS.join(" "));
    expect(job.fileName).toBe("clip-00.mkv");
    expect(job.output).toBe(join(CLIP_DIR, "clip-00.mkv"));
    expect(job.argv.at(-1)).toBe(job.output);
  });

  test("is numbered by its place among the clips, whatever its neighbours are", () => {
    const photo: Clip = { clipId: "p", durationMs: 2_000, transitionIn: "cut", kind: "photo", cell: { photo: { source: "scene", photoId: "photo-p" }, focus: null }, motion: "static" };
    const jobs = buildPass1({ seed: 7, clips: [photo, video(2_000, 0, null, "v1")], resolvePhoto: () => ({ path: "/work/p.jpg", width: 720, height: 1280 }), resolveVideo: () => source(), clipDir: CLIP_DIR });
    expect(jobs.map((j) => j.fileName)).toEqual(["clip-00.mkv", "clip-01.mkv"]);
    expect(jobs[1]?.clipId).toBe("v1");
  });

  test("holds exactly the frames of its length: 3 per 100 ms", () => {
    expect(only(build([video(2_000)])).frames).toBe(60);
  });

  test.each([
    [100, 3],
    [500, 15],
    [15_000, 450],
  ])("a clip of %d ms, the montage's own limit, holds %d frames and the graph stops at the same number", (ms, frames) => {
    const job = only(build([video(ms)]));
    expect(job.frames).toBe(frames);
    expect(graphOf(job.argv)).toContain(`trim=end_frame=${frames}`);
  });

  test("refuses a clip below the 100 ms minimum or off the 100 ms grid as BAD_DURATION", () => {
    expect(() => build([video(90)])).toThrow(expect.objectContaining({ code: "BAD_DURATION" }));
    expect(() => build([video(0)])).toThrow(expect.objectContaining({ code: "BAD_DURATION" }));
    expect(() => build([video(2_050)])).toThrow(expect.objectContaining({ code: "BAD_DURATION" }));
  });

  test("a trim of 0 starts at the file's first frame: no seek at all", () => {
    expect(only(build([video(2_000, 0)])).argv).not.toContain("-ss");
  });

  test("a trim seeks the INPUT, half a frame before the wanted frame, so the first frame out is exactly that one", () => {
    // Frame 33 (a trim of 1.1 s) is on screen from 1_100_000 us; half a frame earlier is 1_083_333 us, between frame 32 and frame 33.
    const { argv } = only(build([video(500, 1_100)]));
    const at = argv.indexOf("-ss");
    expect(argv.slice(at, at + 2)).toEqual(["-ss", "1083333us"]);
    expect(at).toBeLessThan(argv.indexOf("-i"));
  });

  test("the seek is half a frame before the first frame whatever the trim is", () => {
    for (const trimMs of [100, 300, 1_000, 5_700, 179_500]) {
      // A 100 ms clip (3 frames) seeks the same way: the clip's own length does not move the seek.
      const { argv } = only(build([video(100, trimMs)]));
      const startFrame = (trimMs * 3) / 100;
      const given = Number(argv[argv.indexOf("-ss") + 1]?.replace("us", ""));
      // Strictly between frame (startFrame - 1) and frame startFrame, in microseconds.
      expect(given).toBeLessThan((startFrame * 1_000_000) / 30);
      expect(given).toBeGreaterThan(((startFrame - 1) * 1_000_000) / 30);
    }
  });

  test("the graph counts frames, not time: it stops after the clip's frames and restarts the clock at 0", () => {
    const graph = graphOf(only(build([video(2_000, 1_100)])).argv);
    expect(graph.startsWith("[0:v:0]trim=end_frame=60,settb=1/30,setpts=N,")).toBe(true);
  });

  test("crops the cover-crop of the stored size with the clip's focus, then scales to the frame, with no motion", () => {
    const crop = videoClipCrop({ w: 1080, h: 570 }, { x: 0.3, y: 0.6 });
    const graph = graphOf(only(build([video(2_000)], () => source(1080, 570))).argv);
    expect(graph).toContain(`crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}:exact=1`);
    expect(graph).toContain(`scale=${FRAME_W}:${FRAME_H}:flags=lanczos`);
    expect(graph).not.toContain("zoompan");
    expect(graph).not.toContain("loop=");
    expect(graph.endsWith("[v]")).toBe(true);
  });

  test("a clip with no focus is cropped with the face-less fallback, as a photo is", () => {
    const crop = videoClipCrop({ w: 1080, h: 570 }, null);
    const graph = graphOf(only(build([video(2_000, 0, null)], () => source(1080, 570))).argv);
    expect(graph).toContain(`crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}:exact=1`);
  });

  test("the frames are tagged BT.709 limited after the scaler, and the picture is square-pixel", () => {
    const graph = graphOf(only(build([video(2_000)])).argv);
    expect(graph).toContain(`setsar=1,${FRAME_TAGS}[v]`);
  });

  test("does not run the photo's colour conversion: a mezzanine is already BT.709 limited, and the JPEG chain would convert it as a BT.601 full-range picture", () => {
    expect(graphOf(only(build([video(2_000)])).argv)).not.toContain(PHOTO_COLOUR_CHAIN);
  });

  test("keeps the path, the clip id and the job folder out of the graph, and the graph inside the strict charset", () => {
    const nasty = join(CLIP_DIR, "own-media-we ird;'[x]:y,z=1.mp4");
    const graph = graphOf(only(build([video(2_000, 700, { x: 0.5, y: 0.5 }, "clip-we ird")], () => source(1080, 570, nasty))).argv);
    assertSafeFilterGraph(graph);
    expect(graph).not.toContain(nasty);
    expect(graph).not.toContain("clip-we ird");
    expect(graph).not.toContain(CLIP_DIR);
  });

  test("is pure: the same input gives the same argv", () => {
    expect(build([video(2_000, 700)])).toEqual(build([video(2_000, 700)]));
  });
});

describe("buildPass1: an own video clip that cannot be built", () => {
  test("is refused when the resolver does not know the media, naming no path", () => {
    expect(() => build([video(2_000)], () => undefined)).toThrow(expect.objectContaining({ code: "VIDEO_UNRESOLVED" }));
  });

  test("is refused when no video resolver was given", () => {
    expect(() => buildPass1({ seed: 7, clips: [video(2_000)], resolvePhoto: none, clipDir: CLIP_DIR })).toThrow(expect.objectContaining({ code: "VIDEO_UNRESOLVED" }));
  });

  test("is refused for a relative path", () => {
    expect(() => build([video(2_000)], () => source(1080, 1920, "own-media-0000001.mp4"))).toThrow(expect.objectContaining({ code: "PATH_NOT_ABSOLUTE" }));
  });

  test.each([
    [0, 1920],
    [1080, 0],
    [1080.5, 1920],
    [-2, 1920],
  ])("is refused for a stored size of %d x %d: not whole positive pixels", (w, h) => {
    expect(() => build([video(2_000)], () => source(w, h))).toThrow(expect.objectContaining({ code: "BAD_VIDEO_SIZE" }));
  });
});
