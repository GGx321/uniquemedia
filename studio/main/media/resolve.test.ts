import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { videoPaths } from "../../engine/videos/record";
import { fakeVideoBytes, sampleRecord, useWorld, type World } from "../../engine/videos/testing/kit";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import type { ByteSource } from "./diskSource";
import { resolveMedia, type MediaDeps } from "./resolve";
import type { MediaRoute } from "./route";
useNativeGlobals();

// Each route's file kinds and roots (invariant 28 after K14), and the `video` route's walk through the record.
// The ids here are the ones the URL parser has already vetted; what is checked is what a route makes of them.

const AVATAR_NAME_DIR = "Mia";
const REL = `${AVATAR_NAME_DIR}/2026-09-29_photo_001.mp4`;
const VIDEO_ID = "video-00000001";
const TRACK = "track-000001";
const PREVIEW = "preview-0001";
const MEDIA = "media-000001";

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 1)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(60, 2)]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([1, 2, 3, 4]), Buffer.from("WEBP"), Buffer.alloc(60, 3)]);
const GIF = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(60, 4)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypisom"), Buffer.alloc(200, 5)]);

/** Whether the temp volume folds case (macOS and Windows by default): decides which of the two case tests below can say something. */
const caseInsensitive = await (async () => {
  const probe = await mkdtemp(join(tmpdir(), "studio-case-"));
  try {
    await writeFile(join(probe, "a"), "x");
    return await Bun.file(join(probe, "A")).exists();
  } finally {
    await rm(probe, { recursive: true, force: true });
  }
})();

const world = useWorld();
let w: World;
let musicRoot = "";
let textRoot = "";
let outside = "";
let stickerIds: string[] = [];

beforeEach(async () => {
  w = world();
  musicRoot = join(w.dir, "music");
  textRoot = join(w.dir, "render-tmp", "text");
  outside = await mkdtemp(join(tmpdir(), "studio-resolve-out-"));
  stickerIds = [];
  await mkdir(join(musicRoot, "tracks"), { recursive: true });
  await mkdir(join(musicRoot, "covers"), { recursive: true });
  await mkdir(textRoot, { recursive: true });
  await mkdir(join(w.libraryRoot, "media"), { recursive: true });
  await mkdir(videoPaths(w.libraryRoot, w.avatar.id).videosDir, { recursive: true });
});
afterEach(() => rm(outside, { recursive: true, force: true }));

const memory = (bytes: Buffer): ByteSource => ({ size: bytes.length, read: async (o, l) => new Uint8Array(bytes.subarray(o, o + l)) });

function deps(overrides: Partial<MediaDeps> = {}): MediaDeps {
  return {
    libraryRoot: () => w.libraryRoot,
    exportRoot: () => w.exportRoot,
    musicRoot: () => musicRoot,
    textPreviewRoot: () => textRoot,
    sticker: async (id) => (stickerIds.includes(id) ? memory(PNG) : null),
    ...overrides,
  };
}

async function get(route: MediaRoute, overrides: Partial<MediaDeps> = {}): Promise<{ type: string; bytes: Buffer } | null> {
  const served = await resolveMedia(route, deps(overrides));
  if (served === null) return null;
  return { type: served.contentType, bytes: Buffer.from(await served.source.read(0, served.source.size)) };
}

const photo = (photoId: string): MediaRoute => ({ route: "photo", avatarId: w.avatar.id, photoId });
const video = (videoId = VIDEO_ID, avatarId = w.avatar.id): MediaRoute => ({ route: "video", avatarId, videoId });
const poster = (videoId = VIDEO_ID): MediaRoute => ({ route: "poster", avatarId: w.avatar.id, videoId });

const put = async (path: string, bytes: Buffer | string): Promise<void> => {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, bytes);
};
const photosDir = (): string => join(w.libraryRoot, "avatars", w.avatar.id, "photos");

async function tryLink(target: string, path: string, type?: "dir" | "file" | "junction"): Promise<boolean> {
  try {
    await symlink(target, path, type);
    return true;
  } catch (error) {
    if (process.platform === "win32" && error instanceof Error && Reflect.get(error, "code") === "EPERM") return false;
    throw error;
  }
}

describe("photo/<avatarId>/<photoId>", () => {
  test("serves the library photo with its image type", async () => {
    await put(join(photosDir(), "photo-0000a001.png"), PNG);
    expect(await get(photo("photo-0000a001"))).toEqual({ type: "image/png", bytes: PNG });
  });

  test("tries jpg, then png, then webp, and serves each as what it is", async () => {
    await put(join(photosDir(), "photo-0000b001.jpg"), JPEG);
    await put(join(photosDir(), "photo-0000b002.webp"), WEBP);
    expect((await get(photo("photo-0000b001")))?.type).toBe("image/jpeg");
    expect((await get(photo("photo-0000b002")))?.type).toBe("image/webp");
  });

  test("a photo whose bytes are not the image its extension claims is not served", async () => {
    await put(join(photosDir(), "photo-0000c001.png"), JPEG);
    await put(join(photosDir(), "photo-0000c002.jpg"), "<html>not a picture</html>");
    expect(await get(photo("photo-0000c001"))).toBeNull();
    expect(await get(photo("photo-0000c002"))).toBeNull();
  });

  test("an unknown photo, an unknown avatar and a library root that is not there", async () => {
    expect(await get(photo("photo-99999999"))).toBeNull();
    expect(await get({ route: "photo", avatarId: "avatar-9999", photoId: "photo-0000a001" })).toBeNull();
    expect(await get(photo("photo-0000a001"), { libraryRoot: () => join(w.dir, "nope") })).toBeNull();
  });

  test("a symlink out of the library, and one to another photo inside it, are not served", async () => {
    await put(join(outside, "secret.png"), PNG);
    await put(join(photosDir(), "photo-0000d000.png"), PNG);
    if (!(await tryLink(join(outside, "secret.png"), join(photosDir(), "photo-0000d001.png"), "file"))) return;
    await tryLink(join(photosDir(), "photo-0000d000.png"), join(photosDir(), "photo-0000d002.png"), "file");
    expect(await get(photo("photo-0000d001"))).toBeNull();
    expect(await get(photo("photo-0000d002"))).toBeNull();
  });

  test("the photos folder replaced by a link out of the library is not followed", async () => {
    await put(join(outside, "photo-0000e001.png"), PNG);
    await mkdir(join(w.libraryRoot, "avatars", "avatar-linked"), { recursive: true });
    if (!(await tryLink(outside, join(w.libraryRoot, "avatars", "avatar-linked", "photos"), "junction"))) return;
    expect(await get({ route: "photo", avatarId: "avatar-linked", photoId: "photo-0000e001" })).toBeNull();
  });
});

describe("poster/<avatarId>/<videoId>", () => {
  const posterPath = (ext: string, id = VIDEO_ID): string => join(videoPaths(w.libraryRoot, w.avatar.id).videosDir, `${id}.poster.${ext}`);

  test("serves the poster kept next to the record", async () => {
    await put(posterPath("webp"), WEBP);
    expect(await get(poster())).toEqual({ type: "image/webp", bytes: WEBP });
  });

  test("serves jpg and png posters as what they are", async () => {
    await put(posterPath("jpg", "video-00000002"), JPEG);
    await put(posterPath("png", "video-00000003"), PNG);
    expect((await get(poster("video-00000002")))?.type).toBe("image/jpeg");
    expect((await get(poster("video-00000003")))?.type).toBe("image/png");
  });

  test("needs no video file and no export root: the tile shows it for a missing file too", async () => {
    await put(posterPath("webp"), WEBP);
    expect(await get(poster(), { exportRoot: () => undefined })).toEqual({ type: "image/webp", bytes: WEBP });
  });

  test("the record itself is not a poster: only <videoId>.poster.<image ext> is looked at", async () => {
    await put(join(videoPaths(w.libraryRoot, w.avatar.id).videosDir, `${VIDEO_ID}.json`), PNG);
    expect(await get(poster())).toBeNull();
  });

  test("a poster that is not the image its extension claims, or is a link, is not served", async () => {
    await put(posterPath("png"), "<svg onload=alert(1)/>");
    expect(await get(poster())).toBeNull();
    await rm(posterPath("png"));
    await put(join(outside, "secret.png"), PNG);
    if (!(await tryLink(join(outside, "secret.png"), posterPath("png"), "file"))) return;
    expect(await get(poster())).toBeNull();
  });

  test("a poster over its 8 MiB limit is not served", async () => {
    await put(posterPath("png"), Buffer.concat([PNG, Buffer.alloc(8 * 1024 * 1024)]));
    expect(await get(poster())).toBeNull();
  });
});

describe("video/<avatarId>/<videoId>", () => {
  const writeRecord = async (patch: Record<string, unknown> = {}, file?: Record<string, unknown>): Promise<string> => {
    const record = sampleRecord(w, { videoId: VIDEO_ID, relPath: REL, bytes: fakeVideoBytes(MP4.length) });
    const path = videoPaths(w.libraryRoot, w.avatar.id).record(VIDEO_ID);
    await writeFile(path, JSON.stringify({ ...record, ...patch, file: { ...record.file, ...file } }));
    return path;
  };
  const filePath = (): string => join(w.exportRoot, AVATAR_NAME_DIR, "2026-09-29_photo_001.mp4");
  const putVideo = async (bytes: Buffer = MP4): Promise<void> => put(filePath(), bytes);

  test("a `present` record: its file, from the export root, as video/mp4", async () => {
    await writeRecord();
    await putVideo();
    expect(await get(video())).toEqual({ type: "video/mp4", bytes: MP4 });
  });

  test("a `changed` record (other bytes than it recorded) still plays: 'playable, still used'", async () => {
    await writeRecord({}, { bytes: 999_999, sha256: "d".repeat(64) });
    await putVideo();
    expect((await get(video()))?.type).toBe("video/mp4");
  });

  test("a `missing` record (no file) is not served", async () => {
    await writeRecord();
    expect(await get(video())).toBeNull();
  });

  test("an `elsewhere` record: another root id than the export folder's marker", async () => {
    await writeRecord({}, { rootId: "root-other-000" });
    await putVideo();
    expect(await get(video())).toBeNull();
  });

  test("an `elsewhere` record: an export folder with no marker (an empty folder at the same path)", async () => {
    await writeRecord();
    await putVideo();
    await rm(join(w.exportRoot, ".studio-export.json"));
    expect(await get(video())).toBeNull();
  });

  test("an `elsewhere` record: a marker that is not valid", async () => {
    await writeRecord();
    await putVideo();
    await writeFile(join(w.exportRoot, ".studio-export.json"), "{not json");
    expect(await get(video())).toBeNull();
  });

  test("no export folder configured", async () => {
    await writeRecord();
    await putVideo();
    expect(await get(video(), { exportRoot: () => undefined })).toBeNull();
  });

  test("an export folder that is not there", async () => {
    await writeRecord();
    expect(await get(video(), { exportRoot: () => join(w.dir, "gone") })).toBeNull();
  });

  test("no record, an unreadable record, and a record of a newer schema", async () => {
    await putVideo();
    expect(await get(video())).toBeNull();
    const path = await writeRecord();
    await writeFile(path, "{not json");
    expect(await get(video())).toBeNull();
    await writeRecord({ schemaVersion: 2 });
    expect(await get(video())).toBeNull();
  });

  test("a record filed under another video id or another avatar than its own", async () => {
    await putVideo();
    await writeRecord({ id: "video-00000009" });
    expect(await get(video())).toBeNull();
    await writeRecord({ avatarId: "avatar-9999" });
    expect(await get(video())).toBeNull();
  });

  test("a record filed under the wrong avatar's folder is not reachable through another avatar's URL", async () => {
    await writeRecord();
    await putVideo();
    expect(await get(video(VIDEO_ID, "avatar-9999"))).toBeNull();
  });

  const hostileRelPaths = [
    "../outside/file.mp4",
    "Mia/../../outside.mp4",
    "Mia/..%2f..%2foutside.mp4",
    "/etc/passwd",
    "C:/Windows/win.ini",
    "C:\\Windows\\win.ini",
    "Mia\\2026-09-29_photo_001.mp4",
    "Mia/2026-09-29_photo_001.mp4/",
    "Mia//2026-09-29_photo_001.mp4",
    "Mia/sub/2026-09-29_photo_001.mp4",
    "./Mia/2026-09-29_photo_001.mp4",
    "Mia/2026-09-29_photo_001.mp4\0.png",
    "NUL/2026-09-29_photo_001.mp4",
    "Mia/2026-09-29_photo_001.txt",
    "",
  ];
  for (const relPath of hostileRelPaths) {
    test(`a record whose relPath is ${JSON.stringify(relPath)} is refused`, async () => {
      await putVideo();
      await mkdir(join(w.exportRoot, "..", "outside"), { recursive: true });
      await writeRecord({}, { relPath });
      expect(await get(video())).toBeNull();
    });
  }

  test("a symlink in place of the video file, to a file outside the export folder", async () => {
    await writeRecord();
    await put(join(outside, "secret.mp4"), MP4);
    await mkdir(join(w.exportRoot, AVATAR_NAME_DIR), { recursive: true });
    if (!(await tryLink(join(outside, "secret.mp4"), filePath(), "file"))) return;
    expect(await get(video())).toBeNull();
  });

  test("a link in place of the video's folder, to a folder outside the export folder", async () => {
    await writeRecord();
    await put(join(outside, "2026-09-29_photo_001.mp4"), MP4);
    if (!(await tryLink(outside, join(w.exportRoot, AVATAR_NAME_DIR), "junction"))) return;
    expect(await get(video())).toBeNull();
  });

  test("a folder where the video file should be", async () => {
    await writeRecord();
    await mkdir(filePath(), { recursive: true });
    expect(await get(video())).toBeNull();
  });

  test("a video file that does not start like an MP4 is not served", async () => {
    await writeRecord();
    await putVideo(Buffer.from("<html>not a video</html>"));
    expect(await get(video())).toBeNull();
  });

  test("a record that is a link out of the library is not read", async () => {
    await putVideo();
    const path = await writeRecord();
    await put(join(outside, "record.json"), await Bun.file(path).text());
    await rm(path);
    if (!(await tryLink(join(outside, "record.json"), path, "file"))) return;
    expect(await get(video())).toBeNull();
  });

  test("a huge record is not read", async () => {
    await putVideo();
    const path = await writeRecord();
    await writeFile(path, `{"pad":"${"x".repeat(2 * 1024 * 1024)}"}`);
    expect(await get(video())).toBeNull();
  });

  test("a file replaced between the record check and the read is an error on read, not other bytes", async () => {
    await writeRecord();
    await putVideo();
    const served = await resolveMedia(video(), deps());
    await put(`${filePath()}.swap`, Buffer.concat([MP4, Buffer.from("extra")]));
    await rename(`${filePath()}.swap`, filePath());
    await expect(served?.source.read(0, 10)).rejects.toThrow();
  });

  test.skipIf(!caseInsensitive)("on a case-insensitive volume a folder that differs from the record only in case is the same folder, still inside the root", async () => {
    await writeRecord({}, { relPath: `${AVATAR_NAME_DIR.toLowerCase()}/2026-09-29_photo_001.mp4` });
    await putVideo();
    expect((await get(video()))?.type).toBe("video/mp4");
  });

  test.skipIf(caseInsensitive)("on a case-sensitive volume a folder that differs only in case is another folder, and is not found", async () => {
    await writeRecord({}, { relPath: `${AVATAR_NAME_DIR.toLowerCase()}/2026-09-29_photo_001.mp4` });
    await putVideo();
    expect(await get(video())).toBeNull();
  });
});

describe("track/<trackId> and cover/<trackId>", () => {
  test("a cached track is served from userData/music/tracks as audio/mp4", async () => {
    await put(join(musicRoot, "tracks", `${TRACK}.m4a`), MP4);
    expect(await get({ route: "track", trackId: TRACK })).toEqual({ type: "audio/mp4", bytes: MP4 });
  });

  test("a track file that does not start like an MP4 audio file is not served", async () => {
    await put(join(musicRoot, "tracks", `${TRACK}.m4a`), JPEG);
    expect(await get({ route: "track", trackId: TRACK })).toBeNull();
  });

  test("the track route reads only tracks/: a file of the same id in covers/ is not a track", async () => {
    await put(join(musicRoot, "covers", `${TRACK}.m4a`), MP4);
    expect(await get({ route: "track", trackId: TRACK })).toBeNull();
  });

  test("a cover is served from userData/music/covers in its own image type", async () => {
    await put(join(musicRoot, "covers", `${TRACK}.jpg`), JPEG);
    expect(await get({ route: "cover", trackId: TRACK })).toEqual({ type: "image/jpeg", bytes: JPEG });
  });

  test("the cover route reads only covers/: a track's audio is not a cover", async () => {
    await put(join(musicRoot, "tracks", `${TRACK}.jpg`), JPEG);
    expect(await get({ route: "cover", trackId: TRACK })).toBeNull();
  });

  test("a cover over its 8 MiB limit is not served", async () => {
    await put(join(musicRoot, "covers", `${TRACK}.jpg`), Buffer.concat([JPEG, Buffer.alloc(8 * 1024 * 1024)]));
    expect(await get({ route: "cover", trackId: TRACK })).toBeNull();
  });

  test("an unknown track, and a music folder that is not there", async () => {
    expect(await get({ route: "track", trackId: "track-999999" })).toBeNull();
    expect(await get({ route: "cover", trackId: "track-999999" }, { musicRoot: () => join(w.dir, "nope") })).toBeNull();
  });

  test("a symlink in place of a track", async () => {
    await put(join(outside, "secret.m4a"), MP4);
    if (!(await tryLink(join(outside, "secret.m4a"), join(musicRoot, "tracks", `${TRACK}.m4a`), "file"))) return;
    expect(await get({ route: "track", trackId: TRACK })).toBeNull();
  });
});

describe("sticker/<stickerId>", () => {
  test("a built-in sticker is served as image/apng", async () => {
    stickerIds = ["heart-pulse"];
    expect(await get({ route: "sticker", stickerId: "heart-pulse" })).toEqual({ type: "image/apng", bytes: PNG });
  });

  test("an id that is not a built-in sticker", async () => {
    expect(await get({ route: "sticker", stickerId: "heart-pulse" })).toBeNull();
  });
});

describe("text/<previewId>", () => {
  test("an engine text preview is served from render-tmp/text as image/png", async () => {
    await put(join(textRoot, `${PREVIEW}.png`), PNG);
    expect(await get({ route: "text", previewId: PREVIEW })).toEqual({ type: "image/png", bytes: PNG });
  });

  test("a preview that is not a PNG is not served", async () => {
    await put(join(textRoot, `${PREVIEW}.png`), JPEG);
    expect(await get({ route: "text", previewId: PREVIEW })).toBeNull();
  });

  test("a preview that has expired (the file is gone) and a text folder that is not there", async () => {
    expect(await get({ route: "text", previewId: PREVIEW })).toBeNull();
    expect(await get({ route: "text", previewId: PREVIEW }, { textPreviewRoot: () => join(w.dir, "nope") })).toBeNull();
  });

  test("a render job's own files in render-tmp, one folder up, are not reachable", async () => {
    await put(join(w.dir, "render-tmp", `${PREVIEW}.png`), PNG);
    expect(await get({ route: "text", previewId: PREVIEW })).toBeNull();
  });

  test("a preview over its 8 MiB limit is not served", async () => {
    await put(join(textRoot, `${PREVIEW}.png`), Buffer.concat([PNG, Buffer.alloc(8 * 1024 * 1024)]));
    expect(await get({ route: "text", previewId: PREVIEW })).toBeNull();
  });
});

describe("media/<mediaId>", () => {
  const mediaFile = (ext: string, id = MEDIA): string => join(w.libraryRoot, "media", `${id}.${ext}`);

  test("an own upload is served from <library>/media in the type of its extension", async () => {
    const cases: [string, Buffer, string][] = [
      ["jpg", JPEG, "image/jpeg"],
      ["png", PNG, "image/png"],
      ["webp", WEBP, "image/webp"],
      ["gif", GIF, "image/gif"],
      ["apng", PNG, "image/apng"],
      ["mp4", MP4, "video/mp4"],
      ["m4a", MP4, "audio/mp4"],
    ];
    for (const [i, [ext, bytes, type]] of cases.entries()) {
      const id = `media-0000${i}0`;
      await put(mediaFile(ext, id), bytes);
      expect(await get({ route: "media", mediaId: id })).toEqual({ type, bytes });
    }
  });

  test("the sidecar next to an upload is never served, and neither is any other extension", async () => {
    await put(mediaFile("json"), '{"kind":"photo"}');
    await put(mediaFile("svg"), "<svg/>");
    await put(mediaFile("html"), "<html/>");
    await put(mediaFile("exe"), "MZ");
    await put(mediaFile("txt"), "hello");
    expect(await get({ route: "media", mediaId: MEDIA })).toBeNull();
  });

  test("a file that is not what its extension claims is not served", async () => {
    await put(mediaFile("mp4"), PNG);
    expect(await get({ route: "media", mediaId: MEDIA })).toBeNull();
  });

  test("a symlink in place of an upload is not served", async () => {
    await put(join(outside, "secret.png"), PNG);
    if (!(await tryLink(join(outside, "secret.png"), mediaFile("png"), "file"))) return;
    expect(await get({ route: "media", mediaId: MEDIA })).toBeNull();
  });

  test("the media route reads only <library>/media: a photo of the same id is not an upload", async () => {
    await put(join(photosDir(), `${MEDIA}.png`), PNG);
    expect(await get({ route: "media", mediaId: MEDIA })).toBeNull();
  });
});
