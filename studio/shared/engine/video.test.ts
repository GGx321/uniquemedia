import { describe, expect, test } from "bun:test";
import { FileState, MAX_LISTED_VIDEOS, RelativePath, RenderResult, VideoKindToken, VideoSummary } from "./video";

const video = {
  videoId: "video-00000001",
  avatarId: "avatar-0001",
  kind: "collage3",
  durationMs: 8_000,
  bytes: 3_100_000,
  createdAt: "2026-09-29T12:00:00.000Z",
  relPath: "Mia/2026-09-29_collage3_001.mp4",
  fileState: "present",
};

const renderResult = {
  kind: "render",
  videoId: "video-00000001",
  avatarId: "avatar-0001",
  bytes: 3_100_000,
  durationMs: 8_000,
  videoKind: "collage3",
  relPath: "Mia/2026-09-29_collage3_001.mp4",
};

describe("VideoSummary", () => {
  test("accepts a record with its file's state", () => {
    expect(VideoSummary.safeParse(video).success).toBe(true);
  });

  test.each(["present", "missing", "changed", "elsewhere"])("accepts the file state %s", (fileState) => {
    expect(VideoSummary.safeParse({ ...video, fileState }).success).toBe(true);
  });

  test("the file states are exactly present, missing, changed and elsewhere", () => {
    const actual: string[] = [...FileState.options].sort();
    expect(actual).toEqual(["changed", "elsewhere", "missing", "present"]);
  });

  test("rejects an unknown file state", () => {
    expect(VideoSummary.safeParse({ ...video, fileState: "deleted" }).success).toBe(false);
  });

  test("rejects a record without its file state: it is derived on read, never omitted", () => {
    const { fileState: _f, ...rest } = video;
    expect(VideoSummary.safeParse(rest).success).toBe(false);
  });

  test("rejects an extra field, such as an absolute path", () => {
    expect(VideoSummary.safeParse({ ...video, path: "/Users/alex/Studio/export/Mia/a.mp4" }).success).toBe(false);
  });

  test.each(["videoId", "avatarId", "kind", "durationMs", "bytes", "createdAt", "relPath"])("rejects a record without %s", (field) => {
    const { [field]: _dropped, ...rest } = video;
    expect(VideoSummary.safeParse(rest).success).toBe(false);
  });

  test.each([0, -1, 1.5])("rejects a duration of %p ms", (durationMs) => {
    expect(VideoSummary.safeParse({ ...video, durationMs }).success).toBe(false);
  });

  test.each([0, -1, 1.5])("rejects %p bytes", (bytes) => {
    expect(VideoSummary.safeParse({ ...video, bytes }).success).toBe(false);
  });

  test("rejects a createdAt that is not an ISO time", () => {
    expect(VideoSummary.safeParse({ ...video, createdAt: "yesterday" }).success).toBe(false);
  });

  test("rejects a videoId that breaks the id pattern", () => {
    expect(VideoSummary.safeParse({ ...video, videoId: "../video" }).success).toBe(false);
  });

  test("the list bound is 500 records", () => {
    expect(MAX_LISTED_VIDEOS).toBe(500);
  });
});

describe("VideoKindToken", () => {
  test.each(["photo", "collage3", "mix", "slides"])("accepts %s", (kind) => {
    expect(VideoKindToken.safeParse(kind).success).toBe(true);
  });

  test.each(["", "Photo", "3photo", "photo-2", "фото", "a".repeat(17), "collage 3"])("rejects %p: an ASCII token that goes into a file name", (kind) => {
    expect(VideoKindToken.safeParse(kind).success).toBe(false);
  });
});

describe("RelativePath", () => {
  test.each(["Mia/2026-09-29_photo_001.mp4", "avatar-0001/2026-09-29_mix_012.mp4", "a.mp4"])("accepts %s", (path) => {
    expect(RelativePath.safeParse(path).success).toBe(true);
  });

  test.each([
    ["an empty path", ""],
    ["a leading slash", "/etc/passwd"],
    ["a parent segment", "../outside.mp4"],
    ["a parent segment in the middle", "Mia/../../outside.mp4"],
    ["a current-directory segment", "Mia/./a.mp4"],
    ["an empty segment", "Mia//a.mp4"],
    ["a trailing slash", "Mia/"],
    ["a backslash", "Mia\\a.mp4"],
    ["a Windows drive", "C:/Users/a.mp4"],
    ["a Windows drive without a slash", "C:a.mp4"],
    ["a NUL byte", "Mia/a\u0000.mp4"],
    ["a UNC path", "//server/share/a.mp4"],
    ["a path over 512 chars", `${"a".repeat(513)}.mp4`],
  ])("rejects %s", (_label, path) => {
    expect(RelativePath.safeParse(path).success).toBe(false);
  });
});

describe("RenderResult", () => {
  test("accepts a finished render: the video, its size and length, its kind and place", () => {
    expect(RenderResult.safeParse(renderResult).success).toBe(true);
  });

  test("its discriminator is render, and the video's own kind token is videoKind", () => {
    expect(RenderResult.safeParse({ ...renderResult, kind: "collage3" }).success).toBe(false);
    const { videoKind: _k, ...rest } = renderResult;
    expect(RenderResult.safeParse(rest).success).toBe(false);
  });

  test("rejects a relPath that leaves the export folder", () => {
    expect(RenderResult.safeParse({ ...renderResult, relPath: "../a.mp4" }).success).toBe(false);
  });

  test("rejects an extra field", () => {
    expect(RenderResult.safeParse({ ...renderResult, path: "/x.mp4" }).success).toBe(false);
  });

  test.each([0, -5, 2.5])("rejects a size of %p bytes", (bytes) => {
    expect(RenderResult.safeParse({ ...renderResult, bytes }).success).toBe(false);
  });
});
