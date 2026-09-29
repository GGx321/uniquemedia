import { describe, expect, test } from "bun:test";
import { appendFile, chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openLibrary, type LibraryDeps } from "./library";
import type { PhotoQa, PhotoSidecar } from "./schemas";
import { PNG_1X1, SAMPLE_AVATAR, SAMPLE_SOURCE, expectLibraryError, samplePhotoMeta, sequentialIds, steppingClock, useTempDir } from "./testing/helpers";
import { sceneSpec, videoRecordJson, writeVideoRecord } from "./testing/videoRecords";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Task 3a.2, review round 1: strict record shapes, versions, misfiled records,
// concurrency of the used index, the incremental index 3a.8b builds on, and the
// per-photo eligibility check.

const root = useTempDir("studio-eligibility-review-");

const PASSING: PhotoQa = { age: { adult: true, confidence: 0.95 } };
const deps = (extra: LibraryDeps = {}): LibraryDeps => ({ now: steppingClock(), newId: sequentialIds(), ...extra });
const scene = (qa: PhotoQa = {}) => samplePhotoMeta({ source: { ...SAMPLE_SOURCE, category: "home" }, qa });
const ids = (photos: readonly PhotoSidecar[]) => photos.map((p) => p.id);

async function savedAvatar(extra: LibraryDeps = {}, name = "Mia") {
  const { library } = await openLibrary(root(), deps(extra));
  const avatar = await library.createAvatar({ ...SAMPLE_AVATAR, name });
  const master = await library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta({ qa: PASSING }));
  await library.updateAvatar(avatar.id, { status: "active", masterPhotoId: master.id });
  return { library, avatar, master };
}

/** Writes a record file verbatim under avatar `folderAvatarId`'s videos folder. */
async function writeRaw(folderAvatarId: string, name: string, value: unknown): Promise<void> {
  const dir = join(root(), "avatars", folderAvatarId, "videos");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), typeof value === "string" ? value : JSON.stringify(value));
}

const CELL = (photoId: string) => ({ photo: { source: "scene", photoId }, focus: null });

describe("a record whose clips do not have the shape their kind promises", () => {
  const P = "photo-00000001";
  const wrongShapes: [string, unknown[]][] = [
    ["a photo clip with no cell", [{ kind: "photo" }]],
    ["a photo clip whose cell is under another name", [{ kind: "photo", resolvedCell: CELL(P) }]],
    ["a clip of an unknown kind", [{ kind: "gif", cell: CELL(P) }]],
    ["no clips at all", []],
    ["a collage with no cells", [{ kind: "collage", cells: [] }]],
    ["a collage with one cell", [{ kind: "collage", cells: [CELL(P)] }]],
    ["a photo clip with an empty cell: a record holds the resolved spec, which has none", [{ kind: "photo", cell: { photo: null, focus: null } }]],
    ["a collage with an empty cell", [{ kind: "collage", cells: [CELL(P), { photo: null, focus: null }] }]],
    ["a collage with five cells", [{ kind: "collage", cells: [1, 2, 3, 4, 5].map(() => CELL(P)) }]],
  ];

  test.each(wrongShapes)("%s is unreadable, and closes the avatar instead of freeing its photos", async (_label, clips) => {
    const { avatar } = await savedAvatar();
    await writeRaw(avatar.id, "video-00000001.json", { schemaVersion: 1, id: "video-00000001", avatarId: avatar.id, spec: { clips } });
    const { library: reopened, report } = await openLibrary(root(), deps());
    expect(report.logIssues).toHaveLength(1);
    expect(() => reopened.eligibleUnusedPhotos(avatar.id)).toThrow(expect.objectContaining({ code: "log-needs-repair" }));
  });

  test("an own video clip needs no cell", async () => {
    const { library, avatar } = await savedAvatar();
    const photo = await library.addPhoto(avatar.id, PNG_1X1, scene(PASSING));
    const clips = [{ kind: "video", mediaId: "media-00000001" }, { kind: "photo", cell: { photo: { source: "own", mediaId: "media-00000002" }, focus: null } }, { kind: "photo", cell: CELL(photo.id) }];
    await writeRaw(avatar.id, "video-00000001.json", { schemaVersion: 1, id: "video-00000001", avatarId: avatar.id, spec: { clips } });
    const { library: reopened, report } = await openLibrary(root(), deps());
    expect(report.logIssues).toEqual([]);
    expect(reopened.photoStates(avatar.id).get(photo.id)?.usedIn).toEqual(["video-00000001"]);
  });
});

describe("record versions and misfiled records", () => {
  test("a record from a newer Studio is a distinct problem: too-new, and the refusal is library-too-new", async () => {
    const { avatar } = await savedAvatar();
    await writeRaw(avatar.id, "video-00000001.json", { schemaVersion: 2, id: "video-00000001", avatarId: avatar.id });
    const { library: reopened, report } = await openLibrary(root(), deps());
    expect(report.logIssues).toEqual([expect.objectContaining({ avatarId: avatar.id, file: "videos/video-00000001.json", reason: "too-new" })]);
    expect(() => reopened.eligibleUnusedPhotos(avatar.id)).toThrow(expect.objectContaining({ code: "library-too-new" }));
    expect(reopened.eligibleUnusedCount(avatar.id)).toBe(0);
  });

  test("an unreadable record has the reason unreadable", async () => {
    const { avatar } = await savedAvatar();
    await writeRaw(avatar.id, "video-00000001.json", "{ nope");
    const { report } = await openLibrary(root(), deps());
    expect(report.logIssues[0]).toMatchObject({ reason: "unreadable" });
  });

  test("a record filed under avatar A but naming avatar B closes B too", async () => {
    const { library, avatar } = await savedAvatar();
    const other = await library.createAvatar({ ...SAMPLE_AVATAR, name: "Lena" });
    const photo = await library.addPhoto(other.id, PNG_1X1, scene(PASSING));
    await writeRaw(avatar.id, "video-00000001.json", videoRecordJson("video-00000001", sceneSpec(other.id, [photo.id])));
    const { library: reopened } = await openLibrary(root(), deps());
    expect(() => reopened.eligibleUnusedPhotos(other.id)).toThrow(expect.objectContaining({ code: "log-needs-repair" }));
    expect(reopened.eligibleUnusedCount(other.id)).toBe(0);
  });

  test("B's own reload does not clear the closure A's misfiled record caused; removing that record does", async () => {
    const { library, avatar } = await savedAvatar();
    const other = await library.createAvatar({ ...SAMPLE_AVATAR, name: "Lena" });
    const photo = await library.addPhoto(other.id, PNG_1X1, scene(PASSING));
    await writeRaw(avatar.id, "video-00000001.json", videoRecordJson("video-00000001", sceneSpec(other.id, [photo.id])));
    await library.reloadVideoRecords(avatar.id);
    await library.reloadVideoRecords(other.id);
    expect(() => library.eligibleUnusedPhotos(other.id)).toThrow(expect.objectContaining({ code: "log-needs-repair" }));
    await rm(join(root(), "avatars", avatar.id, "videos", "video-00000001.json"));
    await library.reloadVideoRecords(avatar.id);
    expect(ids(library.eligibleUnusedPhotos(other.id))).toEqual([photo.id]);
  });
});

describe("the two closed states behave alike", () => {
  test("an unreadable rejected.jsonl also makes eligibleUnusedPhotos refuse with log-needs-repair, and the count 0", async () => {
    const { library, avatar } = await savedAvatar();
    await library.addPhoto(avatar.id, PNG_1X1, scene(PASSING));
    await appendFile(join(root(), "avatars", avatar.id, "rejected.jsonl"), "not json\n");
    const { library: reopened } = await openLibrary(root(), deps());
    expect(() => reopened.eligibleUnusedPhotos(avatar.id)).toThrow(expect.objectContaining({ code: "log-needs-repair" }));
    expect(reopened.eligibleUnusedCount(avatar.id)).toBe(0);
  });
});

/** A gate the first record read waits on, so a test can act while a reload is mid-flight. */
function gatedFirstRead() {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  let held = false;
  return {
    release: () => release(),
    hook: async () => {
      if (!held) {
        held = true;
        await gate;
      }
    },
  };
}

describe("reloadVideoRecords under concurrency", () => {
  test("a record deleted while the folder is being read is gone, not corruption", async () => {
    let doomed = "";
    const { library, avatar } = await savedAvatar({
      testHooks: {
        beforeReadVideoRecord: async (path) => {
          if (path.endsWith(doomed)) await rm(path);
        },
      },
    });
    const photo = await library.addPhoto(avatar.id, PNG_1X1, scene(PASSING));
    await writeVideoRecord(root(), "video-00000001", sceneSpec(avatar.id, [photo.id]));
    await writeVideoRecord(root(), "video-00000002", sceneSpec(avatar.id, [photo.id]));
    doomed = "video-00000002.json";
    await library.reloadVideoRecords(avatar.id);
    expect(library.photoStates(avatar.id).get(photo.id)?.usedIn).toEqual(["video-00000001"]);
    expect(() => library.eligibleUnusedPhotos(avatar.id)).not.toThrow();
  });

  test("two reloads run one after the other, so the later one's view wins", async () => {
    const gated = gatedFirstRead();
    const { library, avatar } = await savedAvatar({ testHooks: { beforeReadVideoRecord: gated.hook } });
    const a = await library.addPhoto(avatar.id, PNG_1X1, scene(PASSING));
    const b = await library.addPhoto(avatar.id, PNG_1X1, scene(PASSING));
    await writeVideoRecord(root(), "video-00000001", sceneSpec(avatar.id, [a.id]));
    const first = library.reloadVideoRecords(avatar.id);
    await new Promise((r) => setTimeout(r, 20));
    await writeVideoRecord(root(), "video-00000002", sceneSpec(avatar.id, [b.id]));
    const second = library.reloadVideoRecords(avatar.id);
    gated.release();
    await Promise.all([first, second]);
    expect(library.eligibleUnusedPhotos(avatar.id)).toEqual([]);
    expect(library.videoCount(avatar.id)).toBe(2);
  });

  test("an incremental add made while a reload is reading is not lost to that reload", async () => {
    const gated = gatedFirstRead();
    const { library, avatar } = await savedAvatar({ testHooks: { beforeReadVideoRecord: gated.hook } });
    const a = await library.addPhoto(avatar.id, PNG_1X1, scene(PASSING));
    const b = await library.addPhoto(avatar.id, PNG_1X1, scene(PASSING));
    await writeVideoRecord(root(), "video-00000001", sceneSpec(avatar.id, [a.id]));
    const reload = library.reloadVideoRecords(avatar.id);
    await new Promise((r) => setTimeout(r, 20));
    // Another video's commit: its record is on disk and the index is told directly.
    await writeVideoRecord(root(), "video-00000002", sceneSpec(avatar.id, [b.id]));
    library.addVideoRecordToIndex(avatar.id, { videoId: "video-00000002", photoIds: [b.id] });
    gated.release();
    await reload;
    expect(library.photoStates(avatar.id).get(b.id)?.usedIn).toEqual(["video-00000002"]);
  });

  test("an incremental remove made while a reload is reading is not undone by that reload", async () => {
    const gated = gatedFirstRead();
    const { library, avatar } = await savedAvatar({ testHooks: { beforeReadVideoRecord: gated.hook } });
    const a = await library.addPhoto(avatar.id, PNG_1X1, scene(PASSING));
    const path = await writeVideoRecord(root(), "video-00000001", sceneSpec(avatar.id, [a.id]));
    library.addVideoRecordToIndex(avatar.id, { videoId: "video-00000001", photoIds: [a.id] });
    const reload = library.reloadVideoRecords(avatar.id);
    await new Promise((r) => setTimeout(r, 20));
    await rm(path);
    library.removeVideoRecordFromIndex(avatar.id, "video-00000001");
    gated.release();
    await reload;
    expect(ids(library.eligibleUnusedPhotos(avatar.id))).toEqual([a.id]);
  });
});

describe("the incremental index for a commit and a delete", () => {
  test("adding a record marks its photos used at once, and removing it frees them", async () => {
    const { library, avatar } = await savedAvatar();
    const photo = await library.addPhoto(avatar.id, PNG_1X1, scene(PASSING));
    library.addVideoRecordToIndex(avatar.id, { videoId: "video-00000001", photoIds: [photo.id] });
    expect(library.photoStates(avatar.id).get(photo.id)?.usedIn).toEqual(["video-00000001"]);
    expect(library.videoCount(avatar.id)).toBe(1);
    library.removeVideoRecordFromIndex(avatar.id, "video-00000001");
    expect(ids(library.eligibleUnusedPhotos(avatar.id))).toEqual([photo.id]);
    expect(library.videoCount(avatar.id)).toBe(0);
  });

  test("adding the same record twice counts it once", async () => {
    const { library, avatar } = await savedAvatar();
    const photo = await library.addPhoto(avatar.id, PNG_1X1, scene(PASSING));
    library.addVideoRecordToIndex(avatar.id, { videoId: "video-00000001", photoIds: [photo.id] });
    library.addVideoRecordToIndex(avatar.id, { videoId: "video-00000001", photoIds: [photo.id] });
    expect(library.videoCount(avatar.id)).toBe(1);
  });

  test("removing an unknown record is a no-op, and an unknown avatar is refused", async () => {
    const { library, avatar } = await savedAvatar();
    library.removeVideoRecordFromIndex(avatar.id, "video-00000404");
    expect(() => library.addVideoRecordToIndex("avatar-unknown", { videoId: "video-00000001", photoIds: [] })).toThrow(expect.objectContaining({ code: "avatar-not-found" }));
  });

  test("a photo is never free between a render's record entering the index and its reservation ending", async () => {
    const reserved = new Set<string>();
    const { library, avatar } = await savedAvatar({ reservedPhotos: () => reserved });
    const photo = await library.addPhoto(avatar.id, PNG_1X1, scene(PASSING));
    reserved.add(photo.id);
    expect(library.eligibleUnusedPhotos(avatar.id)).toEqual([]);
    library.addVideoRecordToIndex(avatar.id, { videoId: "video-00000001", photoIds: [photo.id] }); // the commit
    reserved.delete(photo.id); // only then does the render let go
    expect(library.eligibleUnusedPhotos(avatar.id)).toEqual([]);
  });
});

describe("setRejected details", () => {
  test("refuses the master even when it carries a scene category", async () => {
    const { library, avatar } = await savedAvatar();
    const odd = await library.addPhoto(avatar.id, PNG_1X1, scene(PASSING));
    await library.updateAvatar(avatar.id, { masterPhotoId: odd.id });
    await expectLibraryError(library.setRejected(avatar.id, odd.id, true), "photo-not-found");
  });

  test("answers whether it changed anything", async () => {
    const { library, avatar } = await savedAvatar();
    const photo = await library.addPhoto(avatar.id, PNG_1X1, scene(PASSING));
    expect(await library.setRejected(avatar.id, photo.id, false)).toBe(false);
    expect(await library.setRejected(avatar.id, photo.id, true)).toBe(true);
    expect(await library.setRejected(avatar.id, photo.id, true)).toBe(false);
    expect(await library.setRejected(avatar.id, photo.id, false)).toBe(true);
  });
});

describe("one per-photo check", () => {
  test("isEligible is true for a good photo and false for a missing, foreign, master, rejected or age-failed one", async () => {
    const { library, avatar, master } = await savedAvatar();
    const other = await library.createAvatar({ ...SAMPLE_AVATAR, name: "Lena" });
    const good = await library.addPhoto(avatar.id, PNG_1X1, scene(PASSING));
    const rejected = await library.addPhoto(avatar.id, PNG_1X1, scene(PASSING));
    const failing = await library.addPhoto(avatar.id, PNG_1X1, scene({ age: { adult: false, confidence: 0.9 } }));
    const theirs = await library.addPhoto(other.id, PNG_1X1, scene(PASSING));
    await library.setRejected(avatar.id, rejected.id, true);
    expect(library.isEligible(avatar.id, good.id)).toBe(true);
    for (const id of ["photo-00000404", theirs.id, master.id, rejected.id, failing.id]) expect(library.isEligible(avatar.id, id)).toBe(false);
  });

  test("a photo that is used is still eligible: used and reserved are other axes", async () => {
    const { library, avatar } = await savedAvatar();
    const photo = await library.addPhoto(avatar.id, PNG_1X1, scene(PASSING));
    library.addVideoRecordToIndex(avatar.id, { videoId: "video-00000001", photoIds: [photo.id] });
    expect(library.isEligible(avatar.id, photo.id)).toBe(true);
  });

  test("assertEligible passes a good photo, and throws photo-not-found for a missing or foreign one and photo-not-eligible for the rest", async () => {
    const { library, avatar, master } = await savedAvatar();
    const other = await library.createAvatar({ ...SAMPLE_AVATAR, name: "Lena" });
    const good = await library.addPhoto(avatar.id, PNG_1X1, scene(PASSING));
    const theirs = await library.addPhoto(other.id, PNG_1X1, scene(PASSING));
    expect(() => library.assertEligible(avatar.id, good.id)).not.toThrow();
    expect(() => library.assertEligible(avatar.id, "photo-00000404")).toThrow(expect.objectContaining({ code: "photo-not-found" }));
    expect(() => library.assertEligible(avatar.id, theirs.id)).toThrow(expect.objectContaining({ code: "photo-not-found" }));
    expect(() => library.assertEligible(avatar.id, master.id)).toThrow(expect.objectContaining({ code: "photo-not-eligible" }));
  });

  test("an unreadable rejected.jsonl makes nothing eligible, per photo too", async () => {
    const { avatar, library } = await savedAvatar();
    const photo = await library.addPhoto(avatar.id, PNG_1X1, scene(PASSING));
    await appendFile(join(root(), "avatars", avatar.id, "rejected.jsonl"), "not json\n");
    const { library: reopened } = await openLibrary(root(), deps());
    expect(reopened.isEligible(avatar.id, photo.id)).toBe(false);
  });
});

describe("round 2", () => {
  test("removing a record the index never knew still stops a running reload from resurrecting it", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { library, avatar } = await savedAvatar({
      testHooks: {
        // Held before the SECOND record is read, so the first has already been read when it is deleted.
        beforeReadVideoRecord: async (path) => {
          if (path.endsWith("video-00000002.json")) await gate;
        },
      },
    });
    const a = await library.addPhoto(avatar.id, PNG_1X1, scene(PASSING));
    const first = await writeVideoRecord(root(), "video-00000001", sceneSpec(avatar.id, [a.id]));
    await writeVideoRecord(root(), "video-00000002", sceneSpec(avatar.id, [a.id]));
    const reload = library.reloadVideoRecords(avatar.id);
    await new Promise((r) => setTimeout(r, 20));
    await rm(first);
    library.removeVideoRecordFromIndex(avatar.id, "video-00000001"); // the index never knew it
    release();
    await reload;
    expect(library.photoStates(avatar.id).get(a.id)?.usedIn).toEqual(["video-00000002"]);
    expect(library.videoCount(avatar.id)).toBe(1);
  });

  test.skipIf(process.platform === "win32")("a record file that cannot be read is an unreadable problem, and the library still opens", async () => {
    const { library, avatar } = await savedAvatar();
    const photo = await library.addPhoto(avatar.id, PNG_1X1, scene(PASSING));
    const path = await writeVideoRecord(root(), "video-00000001", sceneSpec(avatar.id, [photo.id]));
    await chmod(path, 0o000);
    try {
      const { library: reopened, report } = await openLibrary(root(), deps());
      expect(report.logIssues).toEqual([expect.objectContaining({ avatarId: avatar.id, file: "videos/video-00000001.json", reason: "unreadable" })]);
      expect(() => reopened.eligibleUnusedPhotos(avatar.id)).toThrow(expect.objectContaining({ code: "log-needs-repair" }));
      await reopened.reloadVideoRecords(avatar.id);
      expect(reopened.eligibleUnusedCount(avatar.id)).toBe(0);
    } finally {
      await chmod(path, 0o600);
    }
  });
});
