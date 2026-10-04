import { describe, expect, test } from "bun:test";
import { MAX_LISTED_BY_ID, MAX_LISTED_MEDIA, MediaCancelImportPayload, MediaDeletePayload, MediaDeleteResult, MediaListPayload, MediaListResult, MediaSummary } from "./media";

// 3f.1b: own-media records, the listing and the import job's commands (K28, K29).

const photoSummary = {
  mediaId: "media-00000001",
  kind: "photo",
  name: "summer.jpg",
  bytes: 120_000,
  createdAt: "2026-10-04T10:00:00.000Z",
  width: 3024,
  height: 4032,
  durationMs: null,
  sourceFps: null,
  hdrToSdr: false,
  loopFrames: null,
  delayFrames: null,
};
const videoSummary = { ...photoSummary, mediaId: "media-00000002", kind: "video", name: "walk.mov", width: 1080, height: 1920, durationMs: 6400, sourceFps: 60, hdrToSdr: true };
const audioSummary = { ...photoSummary, mediaId: "media-00000003", kind: "audio", name: "track.m4a", width: null, height: null, durationMs: 95_000 };
const stickerSummary = { ...photoSummary, mediaId: "media-00000004", kind: "sticker", name: "wave.gif", width: 320, height: 320, loopFrames: 6, delayFrames: [2, 2, 2] };

describe("MediaSummary (K28)", () => {
  test("a photo, a video, a track and a sticker each fit", () => {
    for (const summary of [photoSummary, videoSummary, audioSummary, stickerSummary]) {
      expect(MediaSummary.safeParse(summary).success).toBe(true);
    }
  });

  test("carries no path, whatever it is called", () => {
    for (const extra of [{ path: "/lib/media/x.jpg" }, { file: "x.jpg" }, { sha256: "ab" }]) {
      expect(MediaSummary.safeParse({ ...photoSummary, ...extra }).success).toBe(false);
    }
  });

  test("its name is a display name: no control or bidi characters, at most 120, not empty", () => {
    expect(MediaSummary.safeParse({ ...photoSummary, name: "a‮gpj.exe" }).success).toBe(false);
    expect(MediaSummary.safeParse({ ...photoSummary, name: "a".repeat(121) }).success).toBe(false);
    expect(MediaSummary.safeParse({ ...photoSummary, name: "" }).success).toBe(false);
  });

  test("its id is an Id and its time is an ISO date-time", () => {
    expect(MediaSummary.safeParse({ ...photoSummary, mediaId: "../x" }).success).toBe(false);
    expect(MediaSummary.safeParse({ ...photoSummary, createdAt: "yesterday" }).success).toBe(false);
  });

  test("a file has bytes: zero, a fraction and a negative size are refused", () => {
    for (const bytes of [0, 1.5, -1]) expect(MediaSummary.safeParse({ ...photoSummary, bytes }).success).toBe(false);
  });

  test("a photo, a video and a sticker have a size in pixels; a track has none", () => {
    expect(MediaSummary.safeParse({ ...photoSummary, width: null }).success).toBe(false);
    expect(MediaSummary.safeParse({ ...videoSummary, height: null }).success).toBe(false);
    expect(MediaSummary.safeParse({ ...stickerSummary, width: null }).success).toBe(false);
    expect(MediaSummary.safeParse({ ...audioSummary, width: 10, height: 10 }).success).toBe(false);
  });

  test("a side is a positive whole number of pixels", () => {
    for (const width of [0, -3, 1.5]) expect(MediaSummary.safeParse({ ...photoSummary, width }).success).toBe(false);
  });

  test("a video and a track have a length; a photo has none", () => {
    expect(MediaSummary.safeParse({ ...videoSummary, durationMs: null }).success).toBe(false);
    expect(MediaSummary.safeParse({ ...audioSummary, durationMs: null }).success).toBe(false);
    expect(MediaSummary.safeParse({ ...photoSummary, durationMs: 1000 }).success).toBe(false);
  });

  test("only a video has a source frame rate, and only a video is tone-mapped", () => {
    expect(MediaSummary.safeParse({ ...videoSummary, sourceFps: null }).success).toBe(false);
    expect(MediaSummary.safeParse({ ...photoSummary, sourceFps: 30 }).success).toBe(false);
    expect(MediaSummary.safeParse({ ...photoSummary, hdrToSdr: true }).success).toBe(false);
    expect(MediaSummary.safeParse({ ...audioSummary, hdrToSdr: true }).success).toBe(false);
    expect(MediaSummary.safeParse({ ...videoSummary, sourceFps: 0 }).success).toBe(false);
  });

  test("a sticker has its loop in 30 fps frames, at most 300, and its delays add up to it", () => {
    const loop = (loopFrames: number | null, delayFrames: number[] | null): unknown => ({ ...stickerSummary, loopFrames, delayFrames });
    expect(MediaSummary.safeParse(loop(300, [150, 150])).success).toBe(true);
    expect(MediaSummary.safeParse(loop(301, [150, 151])).success).toBe(false);
    expect(MediaSummary.safeParse(loop(0, [])).success).toBe(false);
    expect(MediaSummary.safeParse(loop(5, [2, 2])).success).toBe(false);
    expect(MediaSummary.safeParse(loop(4, [2, 0, 2])).success).toBe(false);
    expect(MediaSummary.safeParse(loop(null, null)).success).toBe(false);
    expect(MediaSummary.safeParse(loop(4, null)).success).toBe(false);
  });

  test("a loop belongs to a sticker only", () => {
    expect(MediaSummary.safeParse({ ...photoSummary, loopFrames: 4, delayFrames: [2, 2] }).success).toBe(false);
    expect(MediaSummary.safeParse({ ...videoSummary, loopFrames: 4, delayFrames: [2, 2] }).success).toBe(false);
  });
});

describe("media.list", () => {
  test("takes no filter, or one kind, and nothing else", () => {
    expect(MediaListPayload.safeParse({}).success).toBe(true);
    expect(MediaListPayload.safeParse({ kind: "video" }).success).toBe(true);
    expect(MediaListPayload.safeParse({ kind: "any" }).success).toBe(false);
    expect(MediaListPayload.safeParse({ kind: "video", path: "/x" }).success).toBe(false);
    // 3f.5 round 1: a draft's own stickers by id, however old they are (the plain listing is cut at MAX_LISTED_MEDIA).
    expect(MediaListPayload.safeParse({ kind: "sticker", mediaIds: ["media-00000001", "media-00000002"] }).success).toBe(true);
    expect(MediaListPayload.safeParse({ mediaIds: [] }).success).toBe(true);
    expect(MediaListPayload.safeParse({ mediaIds: ["../x"] }).success).toBe(false);
    expect(MediaListPayload.safeParse({ mediaIds: "media-00000001" }).success).toBe(false);
    expect(MediaListPayload.safeParse({ mediaIds: Array.from({ length: MAX_LISTED_BY_ID + 1 }, (_, i) => `media-${String(i).padStart(8, "0")}`) }).success).toBe(false);
    expect(MediaListPayload.safeParse({ mediaIds: Array.from({ length: MAX_LISTED_BY_ID }, (_, i) => `media-${String(i).padStart(8, "0")}`) }).success).toBe(true);
  });

  test("answers at most MAX_LISTED_MEDIA records and how many there are in all", () => {
    expect(MAX_LISTED_MEDIA).toBe(500);
    expect(MediaListResult.safeParse({ media: [photoSummary], total: 1 }).success).toBe(true);
    const many = Array.from({ length: MAX_LISTED_MEDIA + 1 }, (_, i) => ({ ...photoSummary, mediaId: `media-${String(i).padStart(8, "0")}` }));
    expect(MediaListResult.safeParse({ media: many, total: many.length }).success).toBe(false);
    expect(MediaListResult.safeParse({ media: many.slice(0, MAX_LISTED_MEDIA), total: 900 }).success).toBe(true);
  });

  test("the total is never below what is listed", () => {
    expect(MediaListResult.safeParse({ media: [photoSummary, videoSummary], total: 1 }).success).toBe(false);
  });
});

describe("media.delete and media.cancelImport", () => {
  test("delete names a media id and nothing else, and answers the id", () => {
    expect(MediaDeletePayload.safeParse({ mediaId: "media-00000001" }).success).toBe(true);
    expect(MediaDeletePayload.safeParse({ mediaId: "media-00000001", path: "/x" }).success).toBe(false);
    expect(MediaDeletePayload.safeParse({ mediaId: "../../etc/passwd" }).success).toBe(false);
    expect(MediaDeleteResult.safeParse({ mediaId: "media-00000001" }).success).toBe(true);
  });

  test("cancelImport names a job id and nothing else", () => {
    expect(MediaCancelImportPayload.safeParse({ jobId: "job-00000001" }).success).toBe(true);
    expect(MediaCancelImportPayload.safeParse({ jobId: "job-00000001", mediaId: "media-00000001" }).success).toBe(false);
    expect(MediaCancelImportPayload.safeParse({ jobId: "" }).success).toBe(false);
  });
});
