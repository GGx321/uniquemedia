import { describe, expect, test } from "bun:test";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import type { Library } from "../library";
import { NODE_COMMIT_FS } from "./commitFs";
import { indexCommittedRecord, type IndexPort } from "./indexRecord";
import { commitIntent, writeIntent } from "./intents";
import { sampleRecord, useWorld, type World } from "./testing/kit";
useNativeGlobals();

// Task 3a.8b.1: the record is on disk (the commit's last step) but the in-memory
// used index could not take it. DECISION: the record on disk is the truth, so the
// job still ends `done` (this function never throws); the index heals from the
// disk at once (`reloadVideoRecords`), and if even that fails the avatar is
// closed (fail-closed, `log-needs-repair`) until a reload or the next open reads
// the record. What must never happen is the third state: the photos of a video
// that exists looking free, so that a second video could reuse them.

const world = useWorld();

async function committedRecord(w: World) {
  const record = sampleRecord(w);
  await writeIntent(NODE_COMMIT_FS, w.libraryRoot, record);
  await commitIntent(NODE_COMMIT_FS, w.libraryRoot, w.avatar.id, record.id);
  return record;
}

const throws = (): never => {
  throw new Error("index exploded");
};
const usedIn = (library: Library, w: World): string[] => library.photoStates(w.avatar.id).get(w.photos[0]?.id ?? "")?.usedIn ?? [];

function port(library: Library, over: Partial<IndexPort> = {}): IndexPort {
  return {
    addVideoRecordToIndex: (avatarId, record) => library.addVideoRecordToIndex(avatarId, record),
    reloadVideoRecords: (avatarId) => library.reloadVideoRecords(avatarId),
    flagVideoIndexStale: (avatarId, videoId) => library.flagVideoIndexStale(avatarId, videoId),
    ...over,
  };
}

describe("indexCommittedRecord", () => {
  test("adds the record's scene photos to the index in one step", async () => {
    const w = world();
    const record = await committedRecord(w);
    const outcome = await indexCommittedRecord(port(w.library), record, () => undefined);
    expect(outcome).toBe("indexed");
    expect(usedIn(w.library, w)).toEqual([record.id]);
  });

  test("when the index update throws, the index is rebuilt from the record on disk and the photos are used", async () => {
    const w = world();
    const record = await committedRecord(w);
    const logs: string[] = [];
    const outcome = await indexCommittedRecord(port(w.library, { addVideoRecordToIndex: throws }), record, (line) => logs.push(line));
    expect(outcome).toBe("reloaded");
    expect(usedIn(w.library, w)).toEqual([record.id]);
    expect(logs.join("\n")).toContain(record.id);
  });

  test("when the reload fails too, the avatar is closed: its photos are not offered as free, and its usage reads log-needs-repair", async () => {
    const w = world();
    const record = await committedRecord(w);
    const outcome = await indexCommittedRecord(port(w.library, { addVideoRecordToIndex: throws, reloadVideoRecords: () => Promise.reject(new Error("disk")) }), record, () => undefined);
    expect(outcome).toBe("flagged");
    expect(() => w.library.eligibleUnusedPhotos(w.avatar.id)).toThrow(expect.objectContaining({ code: "log-needs-repair" }));
    expect(w.library.eligibleUnusedCount(w.avatar.id)).toBe(0);
  });

  test("a flagged avatar heals when a reload reads the record", async () => {
    const w = world();
    const record = await committedRecord(w);
    await indexCommittedRecord(port(w.library, { addVideoRecordToIndex: throws, reloadVideoRecords: () => Promise.reject(new Error("disk")) }), record, () => undefined);
    await w.library.reloadVideoRecords(w.avatar.id);
    expect(usedIn(w.library, w)).toEqual([record.id]);
    expect(w.library.eligibleUnusedPhotos(w.avatar.id).map((p) => p.id)).toEqual([w.photos[1]?.id, w.photos[2]?.id]);
  });

  test("a flagged avatar heals on the next library open, which reads the record from disk", async () => {
    const w = world();
    const record = await committedRecord(w);
    await indexCommittedRecord(port(w.library, { addVideoRecordToIndex: throws, reloadVideoRecords: () => Promise.reject(new Error("disk")) }), record, () => undefined);
    const reopened = await w.reopen();
    expect(usedIn(reopened, w)).toEqual([record.id]);
    expect(reopened.eligibleUnusedPhotos(w.avatar.id)).toHaveLength(2);
  });

  test("never throws, whatever fails, and logs the failures without a path", async () => {
    const w = world();
    const record = await committedRecord(w);
    const logs: string[] = [];
    await expect(
      indexCommittedRecord(port(w.library, { addVideoRecordToIndex: throws, reloadVideoRecords: () => Promise.reject(new Error(`cannot read ${w.dir}`)) }), record, (line) => logs.push(line)),
    ).resolves.toBe("flagged");
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join("\n")).not.toContain(w.dir);
  });
});
