import { describe, expect, test } from "bun:test";
import { FileState, isSafeName, isWindowsDeviceName, MAX_LISTED_VIDEOS, RelativePath, RenderResult, VideoKindToken, VideoSummary } from "./video";

const video = {
  videoId: "video-00000001",
  avatarId: "avatar-0001",
  kind: "collage3",
  durationMs: 8_000,
  bytes: 3_100_000,
  createdAt: "2026-09-29T12:00:00.000Z",
  relPath: "Mia/2026-09-29_collage3_001.mp4",
  fileState: "present",
  montageId: "montage-00000001",
  photoCount: 3,
  music: { title: "Espresso", artist: "Sabrina Carpenter", trackId: "4199287736976977" },
  hasPoster: true,
  title: "утро дома",
  firstClip: {
    clipId: "clip-001",
    durationMs: 4_000,
    transitionIn: "cut",
    kind: "collage",
    layout: "collage3",
    cells: [
      { photo: { source: "scene", photoId: "photo-0002" }, focus: { x: 0.5, y: 0.35 } },
      { photo: { source: "scene", photoId: "photo-0003" }, focus: null },
      { photo: { source: "own", mediaId: "media-0001" }, focus: null },
    ],
    motion: "kenburns",
    stagger: true,
  },
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

  test.each(["present", "missing", "changed", "elsewhere", "unchecked"])("accepts the file state %s", (fileState) => {
    expect(VideoSummary.safeParse({ ...video, fileState }).success).toBe(true);
  });

  test("the file states are exactly present, missing, changed, elsewhere and unchecked (3e.2, K15: a look that failed is not «another folder»)", () => {
    const actual: string[] = [...FileState.options].sort();
    expect(actual).toEqual(["changed", "elsewhere", "missing", "present", "unchecked"]);
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

  test("a video from a headless spec has no montage and may have no music", () => {
    expect(VideoSummary.safeParse({ ...video, montageId: null, music: null }).success).toBe(true);
  });

  test("the tile's extras are required: montageId, photoCount, music and hasPoster", () => {
    for (const field of ["montageId", "photoCount", "music", "hasPoster"]) {
      const rest = Object.fromEntries(Object.entries(video).filter(([key]) => key !== field));
      expect(VideoSummary.safeParse(rest).success).toBe(false);
    }
  });

  test("a poster flag survives a missing file: it is about the record, not the MP4", () => {
    expect(VideoSummary.safeParse({ ...video, fileState: "missing", hasPoster: true }).success).toBe(true);
  });

  test("a track with no artist is accepted: an own track's tags are dropped (3f.4), so the artist may be null", () => {
    expect(VideoSummary.safeParse({ ...video, music: { title: "My track", artist: null, trackId: null } }).success).toBe(true);
  });

  test("a null title is still refused: the tile always has something to call the track", () => {
    expect(VideoSummary.safeParse({ ...video, music: { title: null, artist: "a", trackId: null } }).success).toBe(false);
  });

  test("an artist that is present is still 1 to 120 characters", () => {
    expect(VideoSummary.safeParse({ ...video, music: { title: "t", artist: "", trackId: null } }).success).toBe(false);
    expect(VideoSummary.safeParse({ ...video, music: { title: "t", artist: "a".repeat(121), trackId: null } }).success).toBe(false);
  });

  test("the music title and artist are bounded strings", () => {
    expect(VideoSummary.safeParse({ ...video, music: { title: "t".repeat(120), artist: "a".repeat(120), trackId: null } }).success).toBe(true);
    expect(VideoSummary.safeParse({ ...video, music: { title: "t".repeat(121), artist: "a", trackId: null } }).success).toBe(false);
    expect(VideoSummary.safeParse({ ...video, music: { title: "t", artist: "a".repeat(121), trackId: null } }).success).toBe(false);
    expect(VideoSummary.safeParse({ ...video, music: { title: "", artist: "a", trackId: null } }).success).toBe(false);
  });

  test("the music carries nothing else, so no track URL can ride along", () => {
    expect(VideoSummary.safeParse({ ...video, music: { title: "t", artist: "a", trackId: null, url: "https://x" } }).success).toBe(false);
  });

  test("the music names its trending track by id, for the tile's cover and «E» (K13); an own track has none", () => {
    expect(VideoSummary.safeParse({ ...video, music: { title: "t", artist: "a", trackId: "4199287736976977" } }).success).toBe(true);
    expect(VideoSummary.safeParse({ ...video, music: { title: "My track", artist: null, trackId: null } }).success).toBe(true);
  });

  test("the music's track id is required (null when there is none) and is an id, never a path or a URL", () => {
    expect(VideoSummary.safeParse({ ...video, music: { title: "t", artist: "a" } }).success).toBe(false);
    expect(VideoSummary.safeParse({ ...video, music: { title: "t", artist: "a", trackId: "../tracks/x" } }).success).toBe(false);
    expect(VideoSummary.safeParse({ ...video, music: { title: "t", artist: "a", trackId: "https://cdn/x.m4a" } }).success).toBe(false);
  });

  test("the title is the draft's name at render time, kept by the record (K12); a video with none reads null", () => {
    expect(VideoSummary.safeParse({ ...video, title: "кафе и город · 2" }).success).toBe(true);
    expect(VideoSummary.safeParse({ ...video, title: null }).success).toBe(true);
  });

  test("the title is a montage name: 1 to 80 characters, no control character, and always present", () => {
    expect(VideoSummary.safeParse({ ...video, title: "" }).success).toBe(false);
    expect(VideoSummary.safeParse({ ...video, title: "a".repeat(81) }).success).toBe(false);
    expect(VideoSummary.safeParse({ ...video, title: "утро\nдома" }).success).toBe(false);
    const { title: _t, ...rest } = video;
    expect(VideoSummary.safeParse(rest).success).toBe(false);
  });

  test("the first clip as rendered is the tile's still until a poster frame exists: a photo, a collage or an own video clip", () => {
    const photoClip = { clipId: "clip-001", durationMs: 8_000, transitionIn: "cut", kind: "photo", cell: { photo: { source: "scene", photoId: "photo-0002" }, focus: { x: 0.5, y: 0.4 } }, motion: "pan" };
    const ownVideo = { clipId: "clip-001", durationMs: 2_000, transitionIn: "cut", kind: "video", mediaId: "media-0001", trimStartMs: 0, focus: null };
    expect(VideoSummary.safeParse({ ...video, firstClip: photoClip }).success).toBe(true);
    expect(VideoSummary.safeParse({ ...video, firstClip: ownVideo }).success).toBe(true);
    expect(VideoSummary.safeParse({ ...video, firstClip: null }).success).toBe(true);
  });

  test("the first clip is a clip of the contract, or null: never a free shape and never left out", () => {
    expect(VideoSummary.safeParse({ ...video, firstClip: { kind: "photo", photoId: "photo-0002" } }).success).toBe(false);
    expect(VideoSummary.safeParse({ ...video, firstClip: { ...video.firstClip, path: "/Users/a/photo.jpg" } }).success).toBe(false);
    const { firstClip: _c, ...rest } = video;
    expect(VideoSummary.safeParse(rest).success).toBe(false);
  });

  test("photoCount is a count", () => {
    expect(VideoSummary.safeParse({ ...video, photoCount: 0 }).success).toBe(true);
    expect(VideoSummary.safeParse({ ...video, photoCount: -1 }).success).toBe(false);
    expect(VideoSummary.safeParse({ ...video, photoCount: 1.5 }).success).toBe(false);
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
  test.each([
    "Mia/2026-09-29_photo_001.mp4",
    "avatar-0001/2026-09-29_mix_012.mp4",
    "a_b-C/2026-01-01_collage3_1234.mp4",
    "com10/2026-09-29_photo_001.mp4",
  ])("accepts %s", (path) => {
    expect(RelativePath.safeParse(path).success).toBe(true);
  });

  test.each([
    ["a single segment", "a.mp4"],
    ["an empty path", ""],
    ["an NTFS alternate data stream", "Mia/2026-09-29_photo_001.mp4:ads"],
    ["a Windows device name as the folder", "CON/2026-09-29_photo_001.mp4"],
    ["a lowercase device name", "nul/2026-09-29_photo_001.mp4"],
    ["COM1", "COM1/2026-09-29_photo_001.mp4"],
    ["LPT9", "lpt9/2026-09-29_photo_001.mp4"],
    ["PRN", "Prn/2026-09-29_photo_001.mp4"],
    ["AUX", "aux/2026-09-29_photo_001.mp4"],
    ["a device name as the file", "Mia/NUL.mp4"],
    ["a trailing dot on the folder", "Mia./2026-09-29_photo_001.mp4"],
    ["a trailing space on the folder", "Mia /2026-09-29_photo_001.mp4"],
    ["a parent segment", "../2026-09-29_photo_001.mp4"],
    ["a parent segment with a space", "a/.. /b"],
    ["dots only", "..."],
    ["a parent segment in the middle", "Mia/../2026-09-29_photo_001.mp4"],
    ["a trailing newline", "Mia/2026-09-29_photo_001.mp4\n"],
    ["a NUL byte", "Mia/2026-09-29_photo_001.mp4\u0000"],
    ["a control character", "Mi\u0007a/2026-09-29_photo_001.mp4"],
    ["a full-width dot", "Mia/2026-09-29_photo_001\uFF0Emp4"],
    ["a home shortcut", "~/2026-09-29_photo_001.mp4"],
    ["a leading slash", "/Mia/2026-09-29_photo_001.mp4"],
    ["a UNC path", "//server/share/2026-09-29_photo_001.mp4"],
    ["a backslash", "Mia\\2026-09-29_photo_001.mp4"],
    ["a Windows drive", "C:/Users/2026-09-29_photo_001.mp4"],
    ["a third segment", "Mia/x/2026-09-29_photo_001.mp4"],
    ["an uppercase kind", "Mia/2026-09-29_Photo_001.mp4"],
    ["a kind that starts with a digit", "Mia/2026-09-29_3photo_001.mp4"],
    ["a two-digit counter", "Mia/2026-09-29_photo_01.mp4"],
    ["a seven-digit counter", "Mia/2026-09-29_photo_1234567.mp4"],
    ["an impossible month", "Mia/2026-13-29_photo_001.mp4"],
    ["an impossible day", "Mia/2026-09-32_photo_001.mp4"],
    ["another extension", "Mia/2026-09-29_photo_001.mov"],
    ["an uppercase extension", "Mia/2026-09-29_photo_001.MP4"],
    ["a folder over 64 chars", `${"a".repeat(65)}/2026-09-29_photo_001.mp4`],
    ["a non-ASCII folder", "Мия/2026-09-29_photo_001.mp4"],
  ])("rejects %s", (_label, path) => {
    expect(RelativePath.safeParse(path).success).toBe(false);
  });
});

describe("SafeName, the folder part of a RelativePath", () => {
  test.each(["Mia", "a_b-C", "avatar-0001", "com10", "A".repeat(64)])("accepts %s", (name) => {
    expect(isSafeName(name)).toBe(true);
  });

  test.each(["", "A".repeat(65), "Мия", "a b", "a.b", "Mia.", "..", "CON", "nul", "Com1", "LPT9", "a/b", "a\\b", "a\n"])("rejects %p", (name) => {
    expect(isSafeName(name)).toBe(false);
  });

  test.each(["CON", "prn", "Aux", "NUL", "com0", "COM9", "lpt1"])("%s is a Windows device name", (name) => {
    expect(isWindowsDeviceName(name)).toBe(true);
  });

  test.each(["com10", "console", "Mia", "lpt", "nully"])("%s is not a Windows device name", (name) => {
    expect(isWindowsDeviceName(name)).toBe(false);
  });

  test("agrees with RelativePath on every folder, so a SafeName always parses", () => {
    for (const name of ["Mia", "CON", "com10", "a.b", "", "A".repeat(65), "x-y_z"]) {
      expect(RelativePath.safeParse(`${name}/2026-09-29_photo_001.mp4`).success).toBe(isSafeName(name));
    }
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
