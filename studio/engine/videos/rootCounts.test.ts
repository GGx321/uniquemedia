import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { PNG_1X1, SAMPLE_AVATAR, samplePhotoMeta } from "../library/testing/helpers";
import { NODE_COMMIT_FS } from "./commitFs";
import { commitIntent, writeIntent } from "./intents";
import { countRecordsByRoot, libraryHasVideoRecords } from "./rootCounts";
import { videoPaths, type VideoRecord } from "./record";
import { sampleRecord, useWorld, type World } from "./testing/kit";
useNativeGlobals();

// 3e.3: after the owner points Settings at a folder, how many video records resolve in it (they name its `rootId`) and how
// many stay in another folder. Counted over every avatar, archived ones included: an archived avatar's videos are still videos.

const world = useWorld();
const OTHER_ROOT = "root-00000099";

async function commit(w: World, record: VideoRecord): Promise<void> {
  await writeIntent(NODE_COMMIT_FS, w.libraryRoot, record);
  await commitIntent(NODE_COMMIT_FS, w.libraryRoot, record.avatarId, record.id);
}

describe("countRecordsByRoot", () => {
  test("a library with no videos has nothing resolved and nothing elsewhere", async () => {
    const w = world();

    expect(await countRecordsByRoot(w.library, w.rootId)).toEqual({ resolved: 0, elsewhere: 0, unreadable: 0, truncated: false });
  });

  test("counts the records that name the root as resolved and the others as elsewhere", async () => {
    const w = world();
    await commit(w, sampleRecord(w, { videoId: "video-0000000a", jobId: "job-0000000a" }));
    await commit(w, sampleRecord(w, { videoId: "video-0000000b", jobId: "job-0000000b" }));
    await commit(w, sampleRecord(w, { videoId: "video-0000000c", jobId: "job-0000000c", rootId: OTHER_ROOT }));

    expect(await countRecordsByRoot(w.library, w.rootId)).toMatchObject({ resolved: 2, elsewhere: 1 });
    expect(await countRecordsByRoot(w.library, OTHER_ROOT)).toMatchObject({ resolved: 1, elsewhere: 2 });
  });

  test("a root no record names resolves nothing: every record is elsewhere", async () => {
    const w = world();
    await commit(w, sampleRecord(w, { videoId: "video-0000000a", jobId: "job-0000000a" }));

    expect(await countRecordsByRoot(w.library, "root-00000042")).toMatchObject({ resolved: 0, elsewhere: 1 });
  });

  test("counts the records of every avatar, an archived one included", async () => {
    const w = world();
    const archived = await w.library.createAvatar({ ...SAMPLE_AVATAR, name: "Nora" });
    const master = await w.library.addPhoto(archived.id, PNG_1X1, samplePhotoMeta());
    await w.library.updateAvatar(archived.id, { status: "archived", masterPhotoId: master.id });
    await commit(w, sampleRecord(w, { videoId: "video-0000000a", jobId: "job-0000000a" }));
    await commit(w, { ...sampleRecord(w, { videoId: "video-0000000b", jobId: "job-0000000b", rootId: OTHER_ROOT }), avatarId: archived.id });

    expect(await countRecordsByRoot(w.library, w.rootId)).toMatchObject({ resolved: 1, elsewhere: 1 });
  });

  test("a file that is not a usable record is reported apart and counted in neither", async () => {
    const w = world();
    await commit(w, sampleRecord(w, { videoId: "video-0000000a", jobId: "job-0000000a" }));
    writeFileSync(`${videoPaths(w.libraryRoot, w.avatar.id).videosDir}/video-0000000b.json`, "{ not json");

    expect(await countRecordsByRoot(w.library, w.rootId)).toEqual({ resolved: 1, elsewhere: 0, unreadable: 1, truncated: false });
  });

  test("says so when an avatar has more record files than one read takes, so the counts may be short", async () => {
    const w = world();
    for (const n of ["a", "b", "c"]) await commit(w, sampleRecord(w, { videoId: `video-0000000${n}`, jobId: `job-0000000${n}` }));

    const counts = await countRecordsByRoot(w.library, w.rootId, { maxFilesPerAvatar: 2 });

    expect(counts.truncated).toBe(true);
    expect(counts.resolved).toBe(2);
  });
});

describe("libraryHasVideoRecords", () => {
  test("is false for a library with no videos", async () => {
    expect(await libraryHasVideoRecords(world().library)).toBe(false);
  });

  test("is true once any avatar has a record", async () => {
    const w = world();
    await commit(w, sampleRecord(w, { videoId: "video-0000000a", jobId: "job-0000000a", rootId: OTHER_ROOT }));

    expect(await libraryHasVideoRecords(w.library)).toBe(true);
  });

  test("is true for a record file nobody could read: it may be the one that names the damaged marker", async () => {
    const w = world();
    mkdirSync(videoPaths(w.libraryRoot, w.avatar.id).videosDir, { recursive: true });
    writeFileSync(`${videoPaths(w.libraryRoot, w.avatar.id).videosDir}/video-0000000b.json`, "{ not json");

    expect(await libraryHasVideoRecords(w.library)).toBe(true);
  });
});
