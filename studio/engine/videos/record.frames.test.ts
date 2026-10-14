import { describe, expect, test } from "bun:test";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { clipFramesOf, framePhotoIds, recordFramePhotoIds, scenePhotoIds, VideoRecordSchema, type FrameOrigin } from "./record";
import { sampleRecord, useWorld } from "./testing/kit";
useNativeGlobals();

// 5b.2, S5.WA2 (I5.60, Q-F = 1): a photo and every clip made from it are ONE frame. `framePhotoIds` is the one definition of «used» beside `scenePhotoIds`; a record and an intent keep the snapshot
// `clipFrames`, so a deleted clip, a deleted copy or a deleted avatar's copies never free a used frame.

const photo = (photoId: string) => ({ kind: "photo", cell: { photo: { source: "scene", photoId } } });
const ownPhoto = { kind: "photo", cell: { photo: { source: "own", mediaId: "media-own-1" } } };
const collage = (...photoIds: string[]) => ({ kind: "collage", cells: photoIds.map((photoId) => ({ photo: { source: "scene", photoId } })) });
const video = (mediaId: string) => ({ kind: "video", mediaId });

const ORIGINS: Record<string, { clipId: string; photoId: string }> = {
  "media-copy-1": { clipId: "clip-0000001", photoId: "photo-b" },
  "media-copy-2": { clipId: "clip-0000002", photoId: "photo-d" },
  "media-copy-3": { clipId: "clip-0000003", photoId: "photo-b" },
};
const originOf: FrameOrigin = (mediaId) => ORIGINS[mediaId];

describe("framePhotoIds", () => {
  test("is the scene photos and then the photo of every clip copy, in order, each once", () => {
    const clips = [photo("photo-a"), video("media-copy-1"), collage("photo-c", "photo-e"), video("media-copy-2")];
    expect(framePhotoIds(clips, originOf)).toEqual(["photo-a", "photo-c", "photo-e", "photo-b", "photo-d"]);
  });

  test("counts a photo once when the photo itself and a clip of it are both there", () => {
    expect(framePhotoIds([photo("photo-b"), video("media-copy-1")], originOf)).toEqual(["photo-b"]);
  });

  test("counts two sibling clips of one photo as one frame", () => {
    expect(framePhotoIds([video("media-copy-1"), video("media-copy-3")], originOf)).toEqual(["photo-b"]);
  });

  test("an own video that is no clip's copy, an own photo and a missing media add nothing", () => {
    expect(framePhotoIds([video("media-own-video"), ownPhoto, video("media-gone")], originOf)).toEqual([]);
  });

  test("without any clip copy it is exactly scenePhotoIds", () => {
    const clips = [photo("photo-a"), collage("photo-c", "photo-e"), ownPhoto];
    expect(framePhotoIds(clips, originOf)).toEqual(scenePhotoIds(clips));
  });
});

describe("clipFramesOf", () => {
  test("is one entry per clip copy, in clip order, with the copy, the clip and the photo", () => {
    const clips = [photo("photo-a"), video("media-copy-2"), video("media-own-video"), video("media-copy-1")];
    expect(clipFramesOf(clips, originOf)).toEqual([
      { mediaId: "media-copy-2", clipId: "clip-0000002", photoId: "photo-d" },
      { mediaId: "media-copy-1", clipId: "clip-0000001", photoId: "photo-b" },
    ]);
  });

  test("names a copy once even when a spec uses it twice", () => {
    expect(clipFramesOf([video("media-copy-1"), video("media-copy-1")], originOf)).toHaveLength(1);
  });

  test("is empty for a spec of scene photos", () => {
    expect(clipFramesOf([photo("photo-a")], originOf)).toEqual([]);
  });
});

describe("recordFramePhotoIds", () => {
  test("reads the scene photos and the snapshot, never the media", () => {
    const record = { spec: { clips: [photo("photo-a"), video("media-copy-1")] }, clipFrames: [{ photoId: "photo-b" }] };
    expect(recordFramePhotoIds(record)).toEqual(["photo-a", "photo-b"]);
  });

  test("an old record without clipFrames reads as it always did", () => {
    const record = { spec: { clips: [photo("photo-a"), video("media-copy-1")] } };
    expect(recordFramePhotoIds(record)).toEqual(["photo-a"]);
  });

  test("names a photo once when a scene cell and the snapshot both name it", () => {
    const record = { spec: { clips: [photo("photo-a")] }, clipFrames: [{ photoId: "photo-a" }, { photoId: "photo-b" }] };
    expect(recordFramePhotoIds(record)).toEqual(["photo-a", "photo-b"]);
  });
});

describe("the record's schema", () => {
  const world = useWorld();

  test("takes clipFrames and keeps them", () => {
    const record = { ...sampleRecord(world()), clipFrames: [{ mediaId: "media-copy-0001", clipId: "clip-0000001", photoId: "photo-bbbbb" }] };
    expect(VideoRecordSchema.parse(record).clipFrames).toEqual([{ mediaId: "media-copy-0001", clipId: "clip-0000001", photoId: "photo-bbbbb" }]);
  });

  test("an old record without clipFrames parses as before", () => {
    expect(VideoRecordSchema.parse(sampleRecord(world())).clipFrames).toBeUndefined();
  });

  test("a clipFrames entry that is not a frame makes the record unreadable, never a record that frees the photo", () => {
    expect(VideoRecordSchema.safeParse({ ...sampleRecord(world()), clipFrames: [{ mediaId: "media-copy-0001" }] }).success).toBe(false);
    expect(VideoRecordSchema.safeParse({ ...sampleRecord(world()), clipFrames: "photo-bbbbb" }).success).toBe(false);
  });

  test("more frames than a montage has clips is not a record", () => {
    const frame = (n: number) => ({ mediaId: `media-copy-${String(n).padStart(4, "0")}`, clipId: `clip-${String(n).padStart(7, "0")}`, photoId: `photo-${String(n).padStart(5, "0")}` });
    expect(VideoRecordSchema.safeParse({ ...sampleRecord(world()), clipFrames: Array.from({ length: 21 }, (_, n) => frame(n)) }).success).toBe(false);
  });
});
