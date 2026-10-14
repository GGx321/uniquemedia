import { describe, expect, test } from "bun:test";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { useWorld, type World } from "../videos/testing/kit";
import { sceneSpec, writeVideoRecord } from "./testing/videoRecords";
useNativeGlobals();

// 5b.2, S5.WA2 (Q-F = 1, `ClipSummary.use.inVideo`): how a finished video uses a clip's frame, from the used index. `clip`: a finished video's clipFrames name THIS clip. `photo`: the frame is used
// through the photo itself or a sibling clip of it. Nothing otherwise.

const world = useWorld();
const photoOf = (w: World, i: number): string => w.photos[i]?.id ?? "";
const frame = (n: number, photoId: string) => ({ mediaId: `media-copy-000${n}`, clipId: `clip-000000${n}`, photoId });

describe("Library.videoUseOfClip", () => {
  test("is clip when a finished video's clipFrames name this clip", async () => {
    const w = world();
    await writeVideoRecord(w.libraryRoot, "video-0000001", sceneSpec(w.avatar.id, [photoOf(w, 0)]), { clipFrames: [frame(1, photoOf(w, 1))] });
    await w.library.reloadVideoRecords(w.avatar.id);

    expect(w.library.videoUseOfClip(w.avatar.id, "clip-0000001", photoOf(w, 1))).toBe("clip");
  });

  test("is photo when the frame is used through a sibling clip of the same photo", async () => {
    const w = world();
    await writeVideoRecord(w.libraryRoot, "video-0000001", sceneSpec(w.avatar.id, [photoOf(w, 0)]), { clipFrames: [frame(1, photoOf(w, 1))] });
    await w.library.reloadVideoRecords(w.avatar.id);

    expect(w.library.videoUseOfClip(w.avatar.id, "clip-0000002", photoOf(w, 1))).toBe("photo");
  });

  test("is photo when the frame is used through the photo itself", async () => {
    const w = world();
    await writeVideoRecord(w.libraryRoot, "video-0000001", sceneSpec(w.avatar.id, [photoOf(w, 0)]));
    await w.library.reloadVideoRecords(w.avatar.id);

    expect(w.library.videoUseOfClip(w.avatar.id, "clip-0000001", photoOf(w, 0))).toBe("photo");
  });

  test("is nothing for a clip whose frame no finished video uses", async () => {
    const w = world();
    await writeVideoRecord(w.libraryRoot, "video-0000001", sceneSpec(w.avatar.id, [photoOf(w, 0)]), { clipFrames: [frame(1, photoOf(w, 1))] });
    await w.library.reloadVideoRecords(w.avatar.id);

    expect(w.library.videoUseOfClip(w.avatar.id, "clip-0000003", photoOf(w, 2))).toBeUndefined();
  });

  test("is clip, not photo, when one video holds the clip and another holds the photo", async () => {
    const w = world();
    await writeVideoRecord(w.libraryRoot, "video-0000001", sceneSpec(w.avatar.id, [photoOf(w, 1)]));
    await writeVideoRecord(w.libraryRoot, "video-0000002", sceneSpec(w.avatar.id, [photoOf(w, 0)]), { clipFrames: [frame(1, photoOf(w, 1))] });
    await w.library.reloadVideoRecords(w.avatar.id);

    expect(w.library.videoUseOfClip(w.avatar.id, "clip-0000001", photoOf(w, 1))).toBe("clip");
  });

  test("is nothing for an avatar the library does not have, and for an avatar with no video", async () => {
    const w = world();
    expect(w.library.videoUseOfClip(w.avatar.id, "clip-0000001", photoOf(w, 1))).toBeUndefined();
    expect(w.library.videoUseOfClip("avatar-nobody-0001", "clip-0000001", photoOf(w, 1))).toBeUndefined();
  });

  test("a video that was deleted uses nothing any more", async () => {
    const w = world();
    await writeVideoRecord(w.libraryRoot, "video-0000001", sceneSpec(w.avatar.id, [photoOf(w, 0)]), { clipFrames: [frame(1, photoOf(w, 1))] });
    await w.library.reloadVideoRecords(w.avatar.id);
    w.library.removeVideoRecordFromIndex(w.avatar.id, "video-0000001");

    expect(w.library.videoUseOfClip(w.avatar.id, "clip-0000001", photoOf(w, 1))).toBeUndefined();
  });
});
