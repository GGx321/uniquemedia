import { describe, expect, test } from "bun:test";
import type { Clip } from "../engine/montage";
import { ownVideoClips, ownVideoIssues, videoClipCrop, videoClipWindow } from "./ownVideos";

// An own video clip (3f.3b): where the spec names one, which of them the library cannot give, and the part of the stored video it plays. Pure and shared:
// the engine (`videos.render`'s admission, `montages.get`, the pass-1 builder) and the renderer's mock and preview use THESE, so a draft's issues, a
// render's refusal and the picture cannot be worded or drawn differently.

const video = (n: number, mediaId: string, trimStartMs: number, durationMs: number): Clip => ({ clipId: `clip-${n}`, durationMs, transitionIn: "cut", kind: "video", mediaId, trimStartMs, focus: null });
const photo: Clip = { clipId: "clip-900", durationMs: 2000, transitionIn: "cut", kind: "photo", cell: { photo: { source: "scene", photoId: "photo-1" }, focus: null }, motion: "static" };

describe("ownVideoClips", () => {
  test("lists the video clips in clip order with their path, trim and length", () => {
    expect(ownVideoClips({ clips: [video(1, "media-1", 0, 2_000), photo, video(2, "media-2", 300, 1_000)] })).toEqual([
      { mediaId: "media-1", path: ["clips", 0], trimStartMs: 0, durationMs: 2_000 },
      { mediaId: "media-2", path: ["clips", 2], trimStartMs: 300, durationMs: 1_000 },
    ]);
  });

  test("lists the same media twice when two clips use it", () => {
    expect(ownVideoClips({ clips: [video(1, "media-1", 0, 2_000), video(2, "media-1", 2_000, 2_000)] }).map((c) => c.mediaId)).toEqual(["media-1", "media-1"]);
  });

  test("lists nothing for photos and no clips", () => {
    expect(ownVideoClips({ clips: [photo] })).toEqual([]);
    expect(ownVideoClips({ clips: [] })).toEqual([]);
  });
});

describe("ownVideoIssues", () => {
  const stored = (durationMs: number) => (mediaId: string) => (mediaId === "media-1" ? { durationMs } : null);

  test("is nothing when the clip fits inside the stored video", () => {
    expect(ownVideoIssues({ clips: [video(1, "media-1", 1_000, 2_000)] }, stored(5_000))).toEqual([]);
  });

  test("is media-unavailable at the clip when the library does not hold the media as a video", () => {
    expect(ownVideoIssues({ clips: [video(1, "media-404", 0, 2_000)] }, stored(5_000))).toEqual([{ code: "media-unavailable", path: ["clips", 0] }]);
  });

  test("is media-unavailable, never video-too-short, for a media that is not there at all, whatever its length would have been", () => {
    expect(ownVideoIssues({ clips: [video(1, "media-404", 90_000, 2_000)] }, stored(1_000))).toEqual([{ code: "media-unavailable", path: ["clips", 0] }]);
  });

  test("a clip that ends exactly at the stored video's end passes", () => {
    expect(ownVideoIssues({ clips: [video(1, "media-1", 3_000, 2_000)] }, stored(5_000))).toEqual([]);
  });

  test("a clip that asks one step past the end is video-too-short", () => {
    expect(ownVideoIssues({ clips: [video(1, "media-1", 3_100, 2_000)] }, stored(5_000))).toEqual([{ code: "video-too-short", path: ["clips", 0] }]);
  });

  test("a trim start at the very end leaves nothing to play: video-too-short", () => {
    expect(ownVideoIssues({ clips: [video(1, "media-1", 5_000, 500)] }, stored(5_000))).toEqual([{ code: "video-too-short", path: ["clips", 0] }]);
  });

  test("a stored video of 89 frames (2967 ms) cannot give a 3 s clip, and one of 90 frames (3000 ms) can", () => {
    expect(ownVideoIssues({ clips: [video(1, "media-1", 0, 3_000)] }, stored(2_967))).toEqual([{ code: "video-too-short", path: ["clips", 0] }]);
    expect(ownVideoIssues({ clips: [video(1, "media-1", 0, 3_000)] }, stored(3_000))).toEqual([]);
  });

  test("a stored video of 91 frames (3033 ms) gives 3 s, and one of 92 frames (3067 ms) does not give 3.1 s", () => {
    expect(ownVideoIssues({ clips: [video(1, "media-1", 0, 3_000)] }, stored(3_033))).toEqual([]);
    expect(ownVideoIssues({ clips: [video(1, "media-1", 0, 3_100)] }, stored(3_067))).toEqual([{ code: "video-too-short", path: ["clips", 0] }]);
  });

  test("is one issue per clip, in clip order, each judged on its own trim", () => {
    const clips = [video(1, "media-1", 0, 2_000), photo, video(2, "media-1", 4_000, 2_000), video(3, "media-404", 0, 1_000)];
    expect(ownVideoIssues({ clips }, stored(5_000))).toEqual([
      { code: "video-too-short", path: ["clips", 2] },
      { code: "media-unavailable", path: ["clips", 3] },
    ]);
  });

  test("never judges a photo clip", () => {
    expect(ownVideoIssues({ clips: [photo] }, () => null)).toEqual([]);
  });
});

describe("videoClipWindow", () => {
  test("a trim of 0 and 2 s is frames 0 to 60", () => {
    expect(videoClipWindow({ trimStartMs: 0, durationMs: 2_000 })).toEqual({ startFrame: 0, frames: 60 });
  });

  test("a trim of 1.1 s and 0.5 s is 15 frames from frame 33", () => {
    expect(videoClipWindow({ trimStartMs: 1_100, durationMs: 500 })).toEqual({ startFrame: 33, frames: 15 });
  });

  test("a clip of the montage's longest length is 450 frames", () => {
    expect(videoClipWindow({ trimStartMs: 0, durationMs: 15_000 })).toEqual({ startFrame: 0, frames: 450 });
  });

  test("a time off the 100 ms grid is a programming error, never rounded", () => {
    expect(() => videoClipWindow({ trimStartMs: 50, durationMs: 1_000 })).toThrow(RangeError);
    expect(() => videoClipWindow({ trimStartMs: 0, durationMs: 1_050 })).toThrow(RangeError);
  });
});

describe("videoClipCrop: the cover-crop of a stored video onto the whole frame", () => {
  test("a portrait video of exactly the frame's size is not cropped", () => {
    expect(videoClipCrop({ w: 1080, h: 1920 }, null)).toEqual({ x: 0, y: 0, w: 1080, h: 1920 });
  });

  test("a landscape 1080 x 570 video keeps its whole height and a 9:16 slice of its width, centred on the focus", () => {
    expect(videoClipCrop({ w: 1080, h: 570 }, { x: 0.5, y: 0.5 })).toEqual({ x: 380, y: 0, w: 320, h: 570 });
  });

  test("with the focus at the left edge the slice starts at the left edge", () => {
    expect(videoClipCrop({ w: 1080, h: 570 }, { x: 0, y: 0.5 }).x).toBe(0);
  });

  test("with the focus at the right edge the slice ends at the right edge", () => {
    const crop = videoClipCrop({ w: 1080, h: 570 }, { x: 1, y: 0.5 });
    expect(crop.x + crop.w).toBe(1080);
  });

  test("a clip with no focus uses the face-less fallback, as a photo does", () => {
    expect(videoClipCrop({ w: 1080, h: 570 }, null)).toEqual(videoClipCrop({ w: 1080, h: 570 }, { x: 0.5, y: 0.38 }));
  });

  test("a tall narrow video keeps its width and a slice of its height at the focus", () => {
    expect(videoClipCrop({ w: 540, h: 1920 }, { x: 0.5, y: 0 })).toEqual({ x: 0, y: 0, w: 540, h: 960 });
  });
});
