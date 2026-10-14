import { describe, expect, test } from "bun:test";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import type { Library } from "../library";
import { NODE_COMMIT_FS } from "./commitFs";
import { indexCommittedRecord, type IndexPort } from "./indexRecord";
import { commitIntent, writeIntent } from "./intents";
import { sampleRecord, useWorld, type World } from "./testing/kit";
useNativeGlobals();

// 5b.2, S5.WA2 (I5.60, caller 1 of §5.1.3): the used index at commit takes a record's FRAMES: its scene photos and the photos of its clip frames. A video that holds a clip's copy uses the clip's photo.

const world = useWorld();
const frameOf = (w: World, photoIndex: number, n = 1) => ({ mediaId: `media-copy-000${n}`, clipId: `clip-000000${n}`, photoId: w.photos[photoIndex]?.id ?? "photo-missing" });
const usedIn = (library: Library, w: World, photoIndex: number): string[] => library.photoStates(w.avatar.id).get(w.photos[photoIndex]?.id ?? "")?.usedIn ?? [];

async function committed(w: World, clipFrames: ReturnType<typeof frameOf>[]) {
  const record = { ...sampleRecord(w, { photoIds: [w.photos[0]?.id ?? ""] }), clipFrames };
  await writeIntent(NODE_COMMIT_FS, w.libraryRoot, record);
  await commitIntent(NODE_COMMIT_FS, w.libraryRoot, w.avatar.id, record.id);
  return record;
}

function port(library: Library, over: Partial<IndexPort> = {}): IndexPort {
  return {
    addVideoRecordToIndex: (avatarId, record) => library.addVideoRecordToIndex(avatarId, record),
    reloadVideoRecords: (avatarId) => library.reloadVideoRecords(avatarId),
    flagVideoIndexStale: (avatarId, videoId) => library.flagVideoIndexStale(avatarId, videoId),
    ...over,
  };
}

describe("indexCommittedRecord with clip frames", () => {
  test("makes the clip's photo used, as well as the scene photo", async () => {
    const w = world();
    const record = await committed(w, [frameOf(w, 1)]);

    expect(await indexCommittedRecord(port(w.library), record, () => undefined)).toBe("indexed");

    expect(usedIn(w.library, w, 0)).toEqual([record.id]);
    expect(usedIn(w.library, w, 1)).toEqual([record.id]);
    expect(usedIn(w.library, w, 2)).toEqual([]);
    expect(w.library.eligibleUnusedPhotos(w.avatar.id).map((p) => p.id)).toEqual([w.photos[2]?.id]);
  });

  test("hands the index the frames and the clip ids in one record", async () => {
    const w = world();
    const record = await committed(w, [frameOf(w, 1), frameOf(w, 2, 2)]);
    const seen: unknown[] = [];

    await indexCommittedRecord(port(w.library, { addVideoRecordToIndex: (avatarId, use) => (seen.push(use), w.library.addVideoRecordToIndex(avatarId, use)) }), record, () => undefined);

    expect(seen).toMatchObject([{ videoId: record.id, photoIds: [w.photos[0]?.id, w.photos[1]?.id, w.photos[2]?.id], clipIds: ["clip-0000001", "clip-0000002"] }]);
  });

  test("a record with no clip frames is indexed as before, with no clip ids", async () => {
    const w = world();
    const record = await committed(w, []);
    const seen: Record<string, unknown>[] = [];
    await indexCommittedRecord(port(w.library, { addVideoRecordToIndex: (avatarId, use) => (seen.push({ ...use }), w.library.addVideoRecordToIndex(avatarId, use)) }), { ...record, clipFrames: undefined }, () => undefined);
    expect(seen).toHaveLength(1);
    expect("clipIds" in (seen[0] ?? {})).toBe(false);
  });

  test("when the index update throws, the rebuild from disk uses the clip's photo too", async () => {
    const w = world();
    const record = await committed(w, [frameOf(w, 1)]);
    const outcome = await indexCommittedRecord(
      port(w.library, {
        addVideoRecordToIndex: () => {
          throw new Error("index exploded");
        },
      }),
      record,
      () => undefined,
    );
    expect(outcome).toBe("reloaded");
    expect(usedIn(w.library, w, 1)).toEqual([record.id]);
  });
});
