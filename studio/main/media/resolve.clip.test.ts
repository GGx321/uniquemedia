import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ClipRecord } from "../../engine/clips/schemas";
import { AVATARS_DIR, CLIPS_DIR } from "../../engine/library/layout";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { canSymlink, useMediaWorld, type MediaWorld } from "./testing";
import { gateKeyOf, resolveMedia, type MediaDeps } from "./resolve";
import { respond } from "./respond";
import type { MediaRoute } from "./route";
useNativeGlobals();

// The `clip` and `clipposter` routes (S5.V4b, I5.53, I5.54). A clip is served THROUGH ITS RECORD, as a video and an own upload are: `<library>/avatars/<avatarId>/clips/<clipId>.json` is read
// (bounded, no link followed) and judged by the engine's own strict schema, must be this clip's own and `ready`, and then only the file it names is opened. So the mp4 and the poster of a clip
// whose record is not there (a crash's orphan, a clip whose delete has begun: the engine removes the record first), of a failed clip, and of another avatar's clip are never served.

const CLIP = "clip-00000001";
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypisom"), Buffer.alloc(2000, 5)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, 1)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(60, 2)]);

const world = useMediaWorld();
let w: MediaWorld;
let outside = "";
beforeEach(async () => {
  w = world();
  outside = await mkdtemp(join(tmpdir(), "studio-clip-out-"));
});
afterEach(() => rm(outside, { recursive: true, force: true }));

const clipsDir = (avatarId = w.avatarId): string => join(w.libraryRoot, AVATARS_DIR, avatarId, CLIPS_DIR);
const clip = (clipId = CLIP, avatarId = w.avatarId): MediaRoute => ({ route: "clip", avatarId, clipId });
const poster = (clipId = CLIP, avatarId = w.avatarId): MediaRoute => ({ route: "clipposter", avatarId, clipId });

/** The record as the engine writes it, as plain data: a test bends it, so it is not parsed here (the first test proves the default is one). */
function readyRecord(clipId = CLIP, avatarId = w.avatarId, bytes = MP4.length, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: clipId,
    avatarId,
    sourcePhotoId: "photo-00000001",
    createdAt: "2026-10-13T10:00:00.000Z",
    seen: false,
    motion: { source: "code", label: "Моргает и улыбается", text: "she slowly blinks and gives a small smile" },
    request: { model: "kling", quality: "std", seconds: 5, fallback: "auto" },
    provider: { model: "kling-std", attempts: [{ attemptId: "attempt-1", outcome: "completed", costSource: "usage" }] },
    recovered: false,
    exports: [],
    outcome: {
      status: "ready",
      file: `${clipId}.mp4`,
      posterFile: `${clipId}.poster.jpg`,
      width: 720,
      height: 1280,
      durationMs: 5000,
      fps: 24,
      bytes,
      sha256: createHash("sha256").update(MP4).digest("hex"),
      face: { verdict: "skipped", frames: 0, why: "hidden" },
      ...over,
    },
  };
}

async function put(path: string, bytes: Buffer | string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, bytes);
}

/** A committed ready clip: the mp4, the poster and the record. */
async function commit(clipId = CLIP, avatarId = w.avatarId): Promise<void> {
  await put(join(clipsDir(avatarId), `${clipId}.mp4`), MP4);
  await put(join(clipsDir(avatarId), `${clipId}.poster.jpg`), JPEG);
  await put(join(clipsDir(avatarId), `${clipId}.json`), JSON.stringify(readyRecord(clipId, avatarId)));
}

function deps(over: Partial<MediaDeps> = {}): MediaDeps {
  return { libraryRoot: () => w.libraryRoot, exportRoot: () => w.exportRoot, musicRoot: () => join(w.dir, "music"), textPreviewRoot: () => join(w.dir, "text"), sticker: async () => null, ...over };
}

async function get(route: MediaRoute, over: Partial<MediaDeps> = {}): Promise<{ type: string; bytes: Buffer } | null> {
  const served = (await resolveMedia(route, deps(over))) ?? null;
  if (served === null) return null;
  return { type: served.contentType, bytes: Buffer.from(await served.source.read(0, served.source.size)) };
}

describe("clip/<avatarId>/<clipId>", () => {
  test("the test record is one the engine's own schema accepts", () => {
    expect(ClipRecord.safeParse(readyRecord()).success).toBe(true);
  });

  test("serves the stored mp4 as video/mp4, byte for byte", async () => {
    await commit();
    expect(await get(clip())).toEqual({ type: "video/mp4", bytes: MP4 });
  });

  test("is served from the library whether or not an export folder is set", async () => {
    await commit();
    expect(await get(clip(), { exportRoot: () => undefined })).toEqual({ type: "video/mp4", bytes: MP4 });
  });

  test("answers a range request with a 206 and the bytes asked for", async () => {
    await commit();
    const served = await resolveMedia(clip(), deps());
    if (!served) throw new Error("expected the clip to be served");
    const answer = respond(served.source, { contentType: served.contentType, range: "bytes=8-107" });
    expect(answer.status).toBe(206);
    expect(answer.headers.get("Content-Range")).toBe(`bytes 8-107/${MP4.length}`);
    expect(answer.headers.get("Accept-Ranges")).toBe("bytes");
    expect(Buffer.from(await answer.arrayBuffer())).toEqual(MP4.subarray(8, 108));
  });

  test("is not served when only the file is there: no record, no clip", async () => {
    await put(join(clipsDir(), `${CLIP}.mp4`), MP4);
    expect(await get(clip())).toBeNull();
  });

  test("is not served from a record of a failed clip", async () => {
    await put(join(clipsDir(), `${CLIP}.mp4`), MP4);
    const failed = { ...readyRecord(), outcome: { status: "failed", reason: "invalid-file" } };
    await put(join(clipsDir(), `${CLIP}.json`), JSON.stringify(failed));
    expect(await get(clip())).toBeNull();
  });

  test("is not served when the record is not JSON, or not a record of this build", async () => {
    await put(join(clipsDir(), `${CLIP}.mp4`), MP4);
    await put(join(clipsDir(), `${CLIP}.json`), "{ not json");
    expect(await get(clip())).toBeNull();
    await put(join(clipsDir(), `${CLIP}.json`), JSON.stringify({ ...readyRecord(), schemaVersion: 2 }));
    expect(await get(clip())).toBeNull();
    await put(join(clipsDir(), `${CLIP}.json`), JSON.stringify({ ...readyRecord(), extraField: true }));
    expect(await get(clip())).toBeNull();
  });

  test("is not served from another clip's record", async () => {
    await put(join(clipsDir(), `${CLIP}.mp4`), MP4);
    await put(join(clipsDir(), `${CLIP}.json`), JSON.stringify(readyRecord("clip-00000002")));
    expect(await get(clip())).toBeNull();
  });

  test("is not served from another avatar's record", async () => {
    await put(join(clipsDir(), `${CLIP}.mp4`), MP4);
    await put(join(clipsDir(), `${CLIP}.json`), JSON.stringify(readyRecord(CLIP, "avatar-9999")));
    expect(await get(clip())).toBeNull();
  });

  test("is not served from a record that names another file", async () => {
    await put(join(clipsDir(), "other-clip.mp4"), MP4);
    await put(join(clipsDir(), `${CLIP}.json`), JSON.stringify(readyRecord(CLIP, w.avatarId, MP4.length, { file: "other-clip.mp4" })));
    expect(await get(clip())).toBeNull();
  });

  test("is not served from a record that names a path out of the clips folder", async () => {
    await put(join(w.libraryRoot, AVATARS_DIR, w.avatarId, "secret.mp4"), MP4);
    await put(join(clipsDir(), `${CLIP}.json`), JSON.stringify(readyRecord(CLIP, w.avatarId, MP4.length, { file: "../secret.mp4" })));
    expect(await get(clip())).toBeNull();
  });

  test("is not served when the file is not the size the record was written for", async () => {
    await put(join(clipsDir(), `${CLIP}.mp4`), Buffer.concat([MP4, Buffer.from("x")]));
    await put(join(clipsDir(), `${CLIP}.json`), JSON.stringify(readyRecord()));
    expect(await get(clip())).toBeNull();
  });

  test("is not served when the file is shorter than the record says (a cut-off copy)", async () => {
    await put(join(clipsDir(), `${CLIP}.mp4`), MP4);
    await put(join(clipsDir(), `${CLIP}.json`), JSON.stringify(readyRecord(CLIP, w.avatarId, MP4.length + 1)));
    expect(await get(clip())).toBeNull();
  });

  test("is not served when the file does not start like an MP4", async () => {
    await put(join(clipsDir(), `${CLIP}.mp4`), Buffer.alloc(MP4.length, 7));
    await put(join(clipsDir(), `${CLIP}.json`), JSON.stringify(readyRecord()));
    expect(await get(clip())).toBeNull();
  });

  test("is not served for an unknown clip, an unknown avatar or a library root that is not there", async () => {
    await commit();
    expect(await get(clip("clip-99999999"))).toBeNull();
    expect(await get(clip(CLIP, "avatar-9999"))).toBeNull();
    expect(await get(clip(), { libraryRoot: () => join(w.dir, "nowhere") })).toBeNull();
  });

  test("does not read another route's folders: a photo, a video or an own upload of the same id is not a clip", async () => {
    await put(join(w.libraryRoot, AVATARS_DIR, w.avatarId, "photos", `${CLIP}.mp4`), MP4);
    await put(join(w.libraryRoot, AVATARS_DIR, w.avatarId, "videos", `${CLIP}.mp4`), MP4);
    await put(join(w.libraryRoot, "media", `${CLIP}.mp4`), MP4);
    expect(await get(clip())).toBeNull();
  });

  test.skipIf(!canSymlink)("a symlink in place of the mp4, or of the record, is not served", async () => {
    await put(join(outside, "secret.mp4"), MP4);
    await mkdir(clipsDir(), { recursive: true });
    await symlink(join(outside, "secret.mp4"), join(clipsDir(), `${CLIP}.mp4`), "file");
    await put(join(clipsDir(), `${CLIP}.json`), JSON.stringify(readyRecord()));
    expect(await get(clip())).toBeNull();
    await rm(join(clipsDir(), `${CLIP}.mp4`));
    await rm(join(clipsDir(), `${CLIP}.json`));
    await put(join(clipsDir(), `${CLIP}.mp4`), MP4);
    await put(join(outside, "record.json"), JSON.stringify(readyRecord()));
    await symlink(join(outside, "record.json"), join(clipsDir(), `${CLIP}.json`), "file");
    expect(await get(clip())).toBeNull();
  });

  test.skipIf(!canSymlink)("a clips folder replaced by a link out of the library is not followed", async () => {
    await put(join(outside, `${CLIP}.mp4`), MP4);
    await put(join(outside, `${CLIP}.json`), JSON.stringify(readyRecord(CLIP, "avatar-linked")));
    await mkdir(join(w.libraryRoot, AVATARS_DIR, "avatar-linked"), { recursive: true });
    await symlink(outside, join(w.libraryRoot, AVATARS_DIR, "avatar-linked", CLIPS_DIR), "junction");
    expect(await get(clip(CLIP, "avatar-linked"))).toBeNull();
  });
});

describe("clipposter/<avatarId>/<clipId>", () => {
  test("serves the stored poster as image/jpeg, byte for byte", async () => {
    await commit();
    expect(await get(poster())).toEqual({ type: "image/jpeg", bytes: JPEG });
  });

  test("is not served when only the poster is there: no record, no clip", async () => {
    await put(join(clipsDir(), `${CLIP}.poster.jpg`), JPEG);
    expect(await get(poster())).toBeNull();
  });

  test("is not served from a record of a failed clip", async () => {
    await put(join(clipsDir(), `${CLIP}.poster.jpg`), JPEG);
    await put(join(clipsDir(), `${CLIP}.json`), JSON.stringify({ ...readyRecord(), outcome: { status: "failed", reason: "lost" } }));
    expect(await get(poster())).toBeNull();
  });

  test("is not served from another clip's or another avatar's record", async () => {
    await put(join(clipsDir(), `${CLIP}.poster.jpg`), JPEG);
    await put(join(clipsDir(), `${CLIP}.json`), JSON.stringify(readyRecord("clip-00000002")));
    expect(await get(poster())).toBeNull();
    await put(join(clipsDir(), `${CLIP}.json`), JSON.stringify(readyRecord(CLIP, "avatar-9999")));
    expect(await get(poster())).toBeNull();
  });

  test("is not served when the bytes are not a JPEG", async () => {
    await put(join(clipsDir(), `${CLIP}.mp4`), MP4);
    await put(join(clipsDir(), `${CLIP}.poster.jpg`), PNG);
    await put(join(clipsDir(), `${CLIP}.json`), JSON.stringify(readyRecord()));
    expect(await get(poster())).toBeNull();
  });

  test("is not served when the record names another poster", async () => {
    await put(join(clipsDir(), "other.poster.jpg"), JPEG);
    await put(join(clipsDir(), `${CLIP}.json`), JSON.stringify(readyRecord(CLIP, w.avatarId, MP4.length, { posterFile: "other.poster.jpg" })));
    expect(await get(poster())).toBeNull();
  });

  test("is not served when the poster is bigger than a small picture may be", async () => {
    await put(join(clipsDir(), `${CLIP}.mp4`), MP4);
    await put(join(clipsDir(), `${CLIP}.poster.jpg`), Buffer.concat([JPEG, Buffer.alloc(8 * 1024 * 1024, 1)]));
    await put(join(clipsDir(), `${CLIP}.json`), JSON.stringify(readyRecord()));
    expect(await get(poster())).toBeNull();
  });

  test("is not served when the poster is missing", async () => {
    await put(join(clipsDir(), `${CLIP}.mp4`), MP4);
    await put(join(clipsDir(), `${CLIP}.json`), JSON.stringify(readyRecord()));
    expect(await get(poster())).toBeNull();
  });

  test.skipIf(!canSymlink)("a symlink in place of the poster is not served", async () => {
    await put(join(outside, "secret.jpg"), JPEG);
    await mkdir(clipsDir(), { recursive: true });
    await symlink(join(outside, "secret.jpg"), join(clipsDir(), `${CLIP}.poster.jpg`), "file");
    await put(join(clipsDir(), `${CLIP}.json`), JSON.stringify(readyRecord()));
    expect(await get(poster())).toBeNull();
  });

  test("answers a range request with a 206", async () => {
    await commit();
    const served = await resolveMedia(poster(), deps());
    if (!served) throw new Error("expected the poster to be served");
    expect(respond(served.source, { contentType: served.contentType, range: "bytes=0-9" }).status).toBe(206);
  });
});

describe("the clip routes' disk gate", () => {
  test("is the library's, because both read the library", () => {
    expect(gateKeyOf(clip())).toBe("library");
    expect(gateKeyOf(poster())).toBe("library");
  });
});
