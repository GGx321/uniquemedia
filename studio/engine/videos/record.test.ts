import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { MontageSpec } from "../../shared/engine";
import { partNameOf, scenePhotoIds, videoPaths, VideoRecordSchema } from "./record";
import { sceneSpec } from "../library/testing/videoRecords";
import { fakeVideoBytes, sha256Of, specOf } from "./testing/kit";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// The record's layout (Stage 3 plan, "Outputs and export"): `file { rootId,
// relPath, bytes, sha256 }`, the resolved spec, and the ids the reader and the
// recovery rely on.

const good = () => ({
  schemaVersion: 1,
  id: "video-00000001",
  avatarId: "avatar-00000001",
  jobId: "job-00000001",
  createdAt: "2026-09-29T10:00:00.000Z",
  kind: "photo",
  durationMs: 1000,
  frames: 30,
  montageId: null,
  music: null,
  file: { rootId: "root-00000001", relPath: "Mia/2026-09-29_photo_001.mp4", bytes: 10, sha256: sha256Of(fakeVideoBytes(10)) },
  spec: specOf("avatar-00000001", ["photo-00000001"]),
});

describe("VideoRecordSchema", () => {
  test("accepts a complete record, with or without the file's mtime", () => {
    expect(VideoRecordSchema.safeParse(good()).success).toBe(true);
    expect(VideoRecordSchema.safeParse({ ...good(), file: { ...good().file, mtimeMs: 1_780_000_000_123 } }).success).toBe(true);
  });

  test.each([
    ["a relative path that is not <SafeName>/<date>_<kind>_<NNN>.mp4", { file: { ...good().file, relPath: "../evil.mp4" } }],
    ["an absolute path", { file: { ...good().file, relPath: "/Users/alex/Studio/export/Mia/2026-09-29_photo_001.mp4" } }],
    ["a sha256 that is not 64 lowercase hex characters", { file: { ...good().file, sha256: "ABC" } }],
    ["an empty file", { file: { ...good().file, bytes: 0 } }],
    ["a root id that is not an id", { file: { ...good().file, rootId: "Root/1" } }],
    ["a missing job id", { jobId: undefined }],
    ["a zero frame count", { frames: 0 }],
    ["a spec with an unknown clip kind", { spec: { ...good().spec, clips: [{ kind: "gif" }] } }],
    ["a newer schema version", { schemaVersion: 2 }],
  ])("refuses %s", (_name, patch) => {
    expect(VideoRecordSchema.safeParse({ ...good(), ...patch }).success).toBe(false);
  });

  test("keeps a field a later build added, so an older reader does not drop it", () => {
    const parsed = VideoRecordSchema.parse({ ...good(), poster: "x.webp" });
    expect(Reflect.get(parsed, "poster")).toBe("x.webp");
  });
});

describe("scenePhotoIds", () => {
  test("lists each scene photo once, in order, over photo and collage clips", () => {
    const spec = MontageSpec.parse(sceneSpec("avatar-00000001", ["photo-00000001", "photo-00000002", "photo-00000003"], { collage: true }));
    expect(scenePhotoIds(spec.clips)).toEqual(["photo-00000001", "photo-00000002", "photo-00000003"]);
  });

  test("never counts an own upload: it is not a scene photo", () => {
    const spec = MontageSpec.parse(sceneSpec("avatar-00000001", ["photo-00000001"], { ownMediaId: "media-00000001" }));
    expect(scenePhotoIds(spec.clips)).toEqual(["photo-00000001"]);
  });
});

describe("videoPaths", () => {
  test("puts records under videos/ and intents under videos/.pending/, named by id", () => {
    const paths = videoPaths("/lib", "avatar-00000001");
    expect(paths.record("video-00000001")).toBe(join("/lib", "avatars", "avatar-00000001", "videos", "video-00000001.json"));
    expect(paths.intent("video-00000001")).toBe(join("/lib", "avatars", "avatar-00000001", "videos", ".pending", "video-00000001.json"));
  });

  test("refuses an id that could walk out of the folder", () => {
    expect(() => videoPaths("/lib", "../x")).toThrow(TypeError);
    expect(() => videoPaths("/lib", "avatar-00000001").record("../../x")).toThrow(TypeError);
  });
});

describe("partNameOf", () => {
  test("is the runner's own temp name", () => {
    expect(partNameOf("job-00000001")).toBe(".studio-part-job-00000001.mp4");
  });
});
