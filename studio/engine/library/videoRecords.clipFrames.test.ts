import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { tempDirFor } from "../../testing/tempDir";
import { sceneSpec, videoRecordJson, writeVideoRecord } from "./testing/videoRecords";
import { readVideoRecordFile, readVideoRecords } from "./videoRecords";
useNativeGlobals();

// 5b.2, S5.WA2 (I5.60, Q-F = 1): the used index is built from the records on disk (an engine start, a reload, a repair). A record's frames are its scene photos and the photos of its `clipFrames`: a video
// that holds a clip's copy uses the clip's photo, with the copy, the clip or the avatar long gone. A record that cannot be read in full is a problem, never a record that frees a photo.

const tmp = tempDirFor({ beforeEach, afterEach }, "studio-video-records-frames-");
const AVATAR = "avatar-mia-0001";
const avatarDir = (): string => join(tmp(), "avatars", AVATAR);
const frame = (photoId: string, n = 1) => ({ mediaId: `media-copy-000${n}`, clipId: `clip-000000${n}`, photoId });

describe("the used index of a record with clip frames", () => {
  test("names the scene photos and then the clips' photos, each once, and the clips", async () => {
    await writeVideoRecord(tmp(), "video-0000001", sceneSpec(AVATAR, ["photo-0000001", "photo-0000002"]), { clipFrames: [frame("photo-0000003"), frame("photo-0000002", 2)] });

    const read = await readVideoRecords(avatarDir(), AVATAR);

    expect(read.problems).toEqual([]);
    expect(read.records).toHaveLength(1);
    expect(read.records[0]?.photoIds).toEqual(["photo-0000001", "photo-0000002", "photo-0000003"]);
    expect(read.records[0]?.clipIds).toEqual(["clip-0000001", "clip-0000002"]);
  });

  test("a record with no scene photo at all (clips only) still uses their photos", async () => {
    const spec = sceneSpec(AVATAR, ["photo-0000001"]);
    const clipsOnly = { ...spec, clips: [{ clipId: "clip-00000001", kind: "video", mediaId: "media-copy-0001", trimStartMs: 0, focus: null, durationMs: 4_000, transitionIn: "cut" }] };
    const path = join(tmp(), "avatars", AVATAR, "videos");
    await writeVideoRecord(tmp(), "video-0000009", spec); // makes the folder
    await writeFile(join(path, "video-0000009.json"), JSON.stringify(videoRecordJson("video-0000009", clipsOnly as never, { clipFrames: [frame("photo-0000004")] })));

    const read = await readVideoRecords(avatarDir(), AVATAR);

    expect(read.problems).toEqual([]);
    expect(read.records[0]?.photoIds).toEqual(["photo-0000004"]);
  });

  test("an old record without clipFrames reads as it always did, with no clip ids", async () => {
    await writeVideoRecord(tmp(), "video-0000001", sceneSpec(AVATAR, ["photo-0000001"]));
    const read = await readVideoRecords(avatarDir(), AVATAR);
    expect(read.records).toEqual([{ videoId: "video-0000001", photoIds: ["photo-0000001"], montageId: null, file: { rootId: "root-00000001", relPath: "mia/2026-09-29_photo_001.mp4" } }]);
  });

  test("clipFrames that are not a list of frames make the record a problem, so its photos stay closed", async () => {
    await writeVideoRecord(tmp(), "video-0000001", sceneSpec(AVATAR, ["photo-0000001"]), { clipFrames: "photo-0000003" });
    await writeVideoRecord(tmp(), "video-0000002", sceneSpec(AVATAR, ["photo-0000002"]), { clipFrames: [{ mediaId: "media-copy-0001" }] });

    const read = await readVideoRecords(avatarDir(), AVATAR);

    expect(read.records).toEqual([]);
    expect(read.problems.map((p) => p.reason)).toEqual(["unreadable", "unreadable"]);
  });

  test("a single file read says the same", async () => {
    await writeVideoRecord(tmp(), "video-0000001", sceneSpec(AVATAR, ["photo-0000001"]), { clipFrames: [frame("photo-0000003")] });
    const one = await readVideoRecordFile(avatarDir(), AVATAR, "video-0000001.json");
    expect(one).toMatchObject({ kind: "record", record: { photoIds: ["photo-0000001", "photo-0000003"], clipIds: ["clip-0000001"] } });
  });
});
