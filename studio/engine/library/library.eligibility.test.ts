import { describe, expect, test } from "bun:test";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AGE_MIN_CONFIDENCE } from "../avatars/ageCheck";
import { openLibrary, type LibraryDeps } from "./library";
import type { PhotoQa, PhotoSidecar } from "./schemas";
import {
  PNG_1X1,
  SAMPLE_AVATAR,
  SAMPLE_IMPORTED_SOURCE,
  SAMPLE_SOURCE,
  expectLibraryError,
  samplePhotoMeta,
  sequentialIds,
  steppingClock,
  useTempDir,
} from "./testing/helpers";
import { sceneSpec, videoRecordJson, writeVideoRecord } from "./testing/videoRecords";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Task 3a.2: the one eligibility rule, "used" derived from the video records,
// the reserved set from an injected provider, and the owner's reject marks.
// Records are written straight to disk (testing/videoRecords.ts): the commit
// that writes them for real is task 3a.8b.

const root = useTempDir("studio-eligibility-");

const PASSING: PhotoQa = { age: { adult: true, confidence: 0.95 } };

function deps(extra: LibraryDeps = {}): LibraryDeps {
  return { now: steppingClock(), newId: sequentialIds(), ...extra };
}

const scene = (qa: PhotoQa = {}, category = "home") => samplePhotoMeta({ source: { ...SAMPLE_SOURCE, category }, qa });

/** A saved avatar: a master portrait (a promoted candidate: generated, no scene category) and its library. */
async function savedAvatar(extra: LibraryDeps = {}, name = "Mia") {
  const { library } = await openLibrary(root(), deps(extra));
  const avatar = await library.createAvatar({ ...SAMPLE_AVATAR, name });
  const master = await library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta({ qa: PASSING }));
  await library.updateAvatar(avatar.id, { status: "active", masterPhotoId: master.id });
  return { library, avatar, master };
}

const ids = (photos: readonly PhotoSidecar[]) => photos.map((p) => p.id);

describe("eligiblePhotos: which photos may go into a video", () => {
  test("returns generated scene photos, oldest first", async () => {
    const { library, avatar } = await savedAvatar();
    const a = await library.addPhoto(avatar.id, PNG_1X1, scene(PASSING));
    const b = await library.addPhoto(avatar.id, PNG_1X1, scene(PASSING, "travel"));
    expect(ids(library.eligiblePhotos(avatar.id))).toEqual([a.id, b.id]);
  });

  test("a scene photo with no age verdict is eligible: the per-photo check is off by default", async () => {
    const { library, avatar } = await savedAvatar();
    const unchecked = await library.addPhoto(avatar.id, PNG_1X1, scene({}));
    expect(ids(library.eligiblePhotos(avatar.id))).toEqual([unchecked.id]);
  });

  test("a photo with no verdict is eligible, but the same photo with a failing verdict is not", async () => {
    const { library, avatar } = await savedAvatar();
    const unchecked = await library.addPhoto(avatar.id, PNG_1X1, scene({ faceCos: 0.9 }));
    const refused = await library.addPhoto(avatar.id, PNG_1X1, scene({ age: { adult: false, confidence: 0.99 } }));
    expect(ids(library.eligiblePhotos(avatar.id))).toEqual([unchecked.id]);
    expect(library.photoStates(avatar.id).get(refused.id)?.eligible).toBe(false);
  });

  test("never the master portrait of an avatar made from a candidate", async () => {
    const { library, avatar, master } = await savedAvatar();
    expect(ids(library.eligiblePhotos(avatar.id))).not.toContain(master.id);
    expect(library.photoStates(avatar.id).get(master.id)?.eligible).toBe(false);
  });

  test("never the master, even when it somehow carries a scene category", async () => {
    const { library, avatar } = await savedAvatar();
    const odd = await library.addPhoto(avatar.id, PNG_1X1, scene(PASSING));
    await library.updateAvatar(avatar.id, { masterPhotoId: odd.id });
    expect(library.eligiblePhotos(avatar.id)).toEqual([]);
  });

  test("never an unpicked candidate: a generated portrait with no scene category", async () => {
    const { library, avatar } = await savedAvatar();
    const candidate = await library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta({ qa: PASSING }));
    expect(ids(library.eligiblePhotos(avatar.id))).not.toContain(candidate.id);
  });

  test("never an imported avatar's photo", async () => {
    const { library } = await openLibrary(root(), deps());
    const { avatar, photo } = await library.createImportedAvatar({
      ...SAMPLE_AVATAR,
      photoBytes: PNG_1X1,
      photoMeta: samplePhotoMeta({ source: SAMPLE_IMPORTED_SOURCE, qa: PASSING }),
    });
    expect(photo.source.kind).toBe("imported");
    expect(library.eligiblePhotos(avatar.id)).toEqual([]);
  });

  test("never a photo whose age verdict says the person is not an adult", async () => {
    const { library, avatar } = await savedAvatar();
    await library.addPhoto(avatar.id, PNG_1X1, scene({ age: { adult: false, confidence: 0.99 } }));
    expect(library.eligiblePhotos(avatar.id)).toEqual([]);
  });

  test("the age threshold is inclusive: exactly the minimum confidence passes, one step under fails", async () => {
    const { library, avatar } = await savedAvatar();
    const at = await library.addPhoto(avatar.id, PNG_1X1, scene({ age: { adult: true, confidence: AGE_MIN_CONFIDENCE } }));
    await library.addPhoto(avatar.id, PNG_1X1, scene({ age: { adult: true, confidence: AGE_MIN_CONFIDENCE - 0.01 } }));
    expect(ids(library.eligiblePhotos(avatar.id))).toEqual([at.id]);
  });

  test("never another avatar's photo, and nothing for an unknown avatar", async () => {
    const { library, avatar } = await savedAvatar();
    const other = await library.createAvatar({ ...SAMPLE_AVATAR, name: "Lena" });
    const theirs = await library.addPhoto(other.id, PNG_1X1, scene(PASSING));
    const mine = await library.addPhoto(avatar.id, PNG_1X1, scene(PASSING));
    expect(ids(library.eligiblePhotos(avatar.id))).toEqual([mine.id]);
    expect(ids(library.eligiblePhotos(other.id))).toEqual([theirs.id]);
    expect(library.eligiblePhotos("avatar-unknown")).toEqual([]);
  });
});

describe("rejected marks: the owner's own «do not use»", () => {
  test("a rejected photo is not eligible, and restoring it makes it eligible again", async () => {
    const { library, avatar } = await savedAvatar();
    const photo = await library.addPhoto(avatar.id, PNG_1X1, scene(PASSING));

    await library.setRejected(avatar.id, photo.id, true);
    expect(library.eligiblePhotos(avatar.id)).toEqual([]);
    expect(library.photoStates(avatar.id).get(photo.id)).toMatchObject({ rejected: true, eligible: false });

    await library.setRejected(avatar.id, photo.id, false);
    expect(ids(library.eligiblePhotos(avatar.id))).toEqual([photo.id]);
    expect(library.photoStates(avatar.id).get(photo.id)).toMatchObject({ rejected: false, eligible: true });
  });

  test("a mark survives a reopen, the last op per photo winning", async () => {
    const { library, avatar } = await savedAvatar();
    const kept = await library.addPhoto(avatar.id, PNG_1X1, scene(PASSING));
    const dropped = await library.addPhoto(avatar.id, PNG_1X1, scene(PASSING));
    await library.setRejected(avatar.id, dropped.id, true);
    await library.setRejected(avatar.id, kept.id, true);
    await library.setRejected(avatar.id, kept.id, false);

    const reopened = (await openLibrary(root(), deps())).library;
    expect(ids(reopened.eligiblePhotos(avatar.id))).toEqual([kept.id]);
  });

  test("appends { photoId, op, at } lines to the avatar's rejected.jsonl", async () => {
    const { library, avatar } = await savedAvatar();
    const photo = await library.addPhoto(avatar.id, PNG_1X1, scene(PASSING));
    await library.setRejected(avatar.id, photo.id, true);
    await library.setRejected(avatar.id, photo.id, false);
    const lines = (await readFile(join(root(), "avatars", avatar.id, "rejected.jsonl"), "utf8")).split("\n").filter(Boolean);
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { photoId: photo.id, op: "reject", at: expect.any(String) },
      { photoId: photo.id, op: "restore", at: expect.any(String) },
    ]);
  });

  test("marking a photo the way it already is writes nothing", async () => {
    const { library, avatar } = await savedAvatar();
    const photo = await library.addPhoto(avatar.id, PNG_1X1, scene(PASSING));
    await library.setRejected(avatar.id, photo.id, false);
    await library.setRejected(avatar.id, photo.id, true);
    await library.setRejected(avatar.id, photo.id, true);
    const lines = (await readFile(join(root(), "avatars", avatar.id, "rejected.jsonl"), "utf8")).split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
  });

  test("only a scene photo of that avatar can be marked", async () => {
    const { library, avatar, master } = await savedAvatar();
    const other = await library.createAvatar({ ...SAMPLE_AVATAR, name: "Lena" });
    const theirs = await library.addPhoto(other.id, PNG_1X1, scene(PASSING));
    const candidate = await library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta());
    await expectLibraryError(library.setRejected(avatar.id, theirs.id, true), "photo-not-found");
    await expectLibraryError(library.setRejected(avatar.id, master.id, true), "photo-not-found");
    await expectLibraryError(library.setRejected(avatar.id, candidate.id, true), "photo-not-found");
    await expectLibraryError(library.setRejected(avatar.id, "photo-unknown", true), "photo-not-found");
    await expectLibraryError(library.setRejected("avatar-unknown", theirs.id, true), "avatar-not-found");
  });

  test("a torn last line in rejected.jsonl is skipped and the committed marks still count", async () => {
    const { library, avatar } = await savedAvatar();
    const a = await library.addPhoto(avatar.id, PNG_1X1, scene(PASSING));
    const b = await library.addPhoto(avatar.id, PNG_1X1, scene(PASSING));
    await library.setRejected(avatar.id, a.id, true);
    await appendFile(join(root(), "avatars", avatar.id, "rejected.jsonl"), `{"photoId":"${b.id}","op":"rej`);

    const { library: reopened, report } = await openLibrary(root(), deps());
    expect(report.logIssues).toEqual([]);
    expect(ids(reopened.eligiblePhotos(avatar.id))).toEqual([b.id]);
  });

  test("a corrupt rejected.jsonl fails closed: nothing of that avatar is eligible, it is reported, marking refuses", async () => {
    const { library, avatar } = await savedAvatar();
    const photo = await library.addPhoto(avatar.id, PNG_1X1, scene(PASSING));
    const lena = await library.createAvatar({ ...SAMPLE_AVATAR, name: "Lena" });
    const lenas = await library.addPhoto(lena.id, PNG_1X1, scene(PASSING));
    await library.setRejected(avatar.id, photo.id, true);
    await appendFile(join(root(), "avatars", avatar.id, "rejected.jsonl"), "not json\n");

    const { library: reopened, report } = await openLibrary(root(), deps());
    expect(report.logIssues).toHaveLength(1);
    expect(report.logIssues[0]).toMatchObject({ avatarId: avatar.id, file: "rejected.jsonl" });
    expect(reopened.eligiblePhotos(avatar.id)).toEqual([]);
    await expectLibraryError(reopened.setRejected(avatar.id, photo.id, false), "log-needs-repair");
    expect(ids(reopened.eligiblePhotos(lena.id))).toEqual([lenas.id]);
  });
});

describe("used: derived from the video records", () => {
  test("a photo is unused when there are no records and no videos folder at all", async () => {
    const { library, avatar } = await savedAvatar();
    const photo = await library.addPhoto(avatar.id, PNG_1X1, scene(PASSING));
    expect(ids(library.eligibleUnusedPhotos(avatar.id))).toEqual([photo.id]);
    expect(library.photoStates(avatar.id).get(photo.id)).toMatchObject({ usedIn: [] });
    expect(library.videoCount(avatar.id)).toBe(0);
  });

  test("a photo a record lists is used, and drops out of the eligible-unused list but not the eligible one", async () => {
    const { library, avatar } = await savedAvatar();
    const used = await library.addPhoto(avatar.id, PNG_1X1, scene(PASSING));
    const free = await library.addPhoto(avatar.id, PNG_1X1, scene(PASSING));
    await writeVideoRecord(root(), "video-00000001", sceneSpec(avatar.id, [used.id]));

    const reopened = (await openLibrary(root(), deps())).library;
    expect(ids(reopened.eligiblePhotos(avatar.id))).toEqual([used.id, free.id]);
    expect(ids(reopened.eligibleUnusedPhotos(avatar.id))).toEqual([free.id]);
    expect(reopened.photoStates(avatar.id).get(used.id)).toMatchObject({ usedIn: ["video-00000001"], eligible: true });
  });

  test("the export file does not exist anywhere, yet the record keeps its photo used", async () => {
    const { library, avatar } = await savedAvatar();
    const photo = await library.addPhoto(avatar.id, PNG_1X1, scene(PASSING));
    await writeVideoRecord(root(), "video-00000001", sceneSpec(avatar.id, [photo.id]));
    const reopened = (await openLibrary(root(), deps())).library;
    expect(reopened.photoStates(avatar.id).get(photo.id)?.usedIn).toEqual(["video-00000001"]);
  });

  test("photos in a collage's cells are used too", async () => {
    const { library, avatar } = await savedAvatar();
    const a = await library.addPhoto(avatar.id, PNG_1X1, scene(PASSING));
    const b = await library.addPhoto(avatar.id, PNG_1X1, scene(PASSING));
    const c = await library.addPhoto(avatar.id, PNG_1X1, scene(PASSING));
    await writeVideoRecord(root(), "video-00000001", sceneSpec(avatar.id, [a.id, b.id], { collage: true }));
    const reopened = (await openLibrary(root(), deps())).library;
    expect(ids(reopened.eligibleUnusedPhotos(avatar.id))).toEqual([c.id]);
  });

  test("a photo in two videos lists both, sorted, and stays used until both records are gone", async () => {
    const { library, avatar } = await savedAvatar();
    const photo = await library.addPhoto(avatar.id, PNG_1X1, scene(PASSING));
    const first = await writeVideoRecord(root(), "video-00000002", sceneSpec(avatar.id, [photo.id]));
    await writeVideoRecord(root(), "video-00000001", sceneSpec(avatar.id, [photo.id]));
    await library.reloadVideoRecords(avatar.id);
    expect(library.photoStates(avatar.id).get(photo.id)?.usedIn).toEqual(["video-00000001", "video-00000002"]);

    await rm(first);
    await library.reloadVideoRecords(avatar.id);
    expect(library.photoStates(avatar.id).get(photo.id)?.usedIn).toEqual(["video-00000001"]);
  });

  test("deleting the record frees its photos", async () => {
    const { library, avatar } = await savedAvatar();
    const photo = await library.addPhoto(avatar.id, PNG_1X1, scene(PASSING));
    const record = await writeVideoRecord(root(), "video-00000001", sceneSpec(avatar.id, [photo.id]));
    await library.reloadVideoRecords(avatar.id);
    expect(library.eligibleUnusedPhotos(avatar.id)).toEqual([]);

    await rm(record);
    await library.reloadVideoRecords(avatar.id);
    expect(ids(library.eligibleUnusedPhotos(avatar.id))).toEqual([photo.id]);
    const reopened = (await openLibrary(root(), deps())).library;
    expect(ids(reopened.eligibleUnusedPhotos(avatar.id))).toEqual([photo.id]);
  });

  test("an own upload in a cell counts as nothing: it uses no scene photo", async () => {
    const { library, avatar } = await savedAvatar();
    const photo = await library.addPhoto(avatar.id, PNG_1X1, scene(PASSING));
    await writeVideoRecord(root(), "video-00000001", sceneSpec(avatar.id, [], { ownMediaId: "media-00000001" }));
    const reopened = (await openLibrary(root(), deps())).library;
    expect(ids(reopened.eligibleUnusedPhotos(avatar.id))).toEqual([photo.id]);
    expect(reopened.videoCount(avatar.id)).toBe(1);
  });

  test("videoCount counts the avatar's own records only", async () => {
    const { library, avatar } = await savedAvatar();
    const other = await library.createAvatar({ ...SAMPLE_AVATAR, name: "Lena" });
    const p = await library.addPhoto(avatar.id, PNG_1X1, scene(PASSING));
    const q = await library.addPhoto(other.id, PNG_1X1, scene(PASSING));
    await writeVideoRecord(root(), "video-00000001", sceneSpec(avatar.id, [p.id]));
    await writeVideoRecord(root(), "video-00000002", sceneSpec(avatar.id, [p.id]));
    await writeVideoRecord(root(), "video-00000003", sceneSpec(other.id, [q.id]));
    const reopened = (await openLibrary(root(), deps())).library;
    expect(reopened.videoCount(avatar.id)).toBe(2);
    expect(reopened.videoCount(other.id)).toBe(1);
  });

  test("a used photo the owner also rejected is both, and neither state hides the other", async () => {
    const { library, avatar } = await savedAvatar();
    const photo = await library.addPhoto(avatar.id, PNG_1X1, scene(PASSING));
    await writeVideoRecord(root(), "video-00000001", sceneSpec(avatar.id, [photo.id]));
    await library.setRejected(avatar.id, photo.id, true);
    const reopened = (await openLibrary(root(), deps())).library;
    expect(reopened.photoStates(avatar.id).get(photo.id)).toMatchObject({ usedIn: ["video-00000001"], rejected: true, eligible: false });
  });

  test("the pending-intents folder and stray files are not records", async () => {
    const { library, avatar } = await savedAvatar();
    const photo = await library.addPhoto(avatar.id, PNG_1X1, scene(PASSING));
    const pending = join(root(), "avatars", avatar.id, "videos", ".pending");
    await mkdir(pending, { recursive: true });
    await writeFile(join(pending, "video-00000001.json"), JSON.stringify(videoRecordJson("video-00000001", sceneSpec(avatar.id, [photo.id]))));
    await writeFile(join(root(), "avatars", avatar.id, "videos", ".DS_Store"), "x");
    const { library: reopened, report } = await openLibrary(root(), deps());
    expect(report.logIssues).toEqual([]);
    expect(reopened.videoCount(avatar.id)).toBe(0);
    expect(ids(reopened.eligibleUnusedPhotos(avatar.id))).toEqual([photo.id]);
  });

  test("a legacy used.jsonl no longer marks anything used and never blocks", async () => {
    const { library, avatar } = await savedAvatar();
    const photo = await library.addPhoto(avatar.id, PNG_1X1, scene(PASSING));
    await writeFile(join(root(), "avatars", avatar.id, "used.jsonl"), "not json\n");
    const { library: reopened, report } = await openLibrary(root(), deps());
    expect(report.logIssues).toEqual([]);
    expect(ids(reopened.eligibleUnusedPhotos(avatar.id))).toEqual([photo.id]);
  });
});

describe("an unreadable video record", () => {
  async function withBrokenRecord(brokenName: string, brokenText: string) {
    const { library, avatar } = await savedAvatar();
    const used = await library.addPhoto(avatar.id, PNG_1X1, scene(PASSING));
    const free = await library.addPhoto(avatar.id, PNG_1X1, scene(PASSING));
    await writeVideoRecord(root(), "video-00000001", sceneSpec(avatar.id, [used.id]));
    await writeFile(join(root(), "avatars", avatar.id, "videos", brokenName), brokenText);
    const opened = await openLibrary(root(), deps());
    return { ...opened, avatar, used, free };
  }

  test("is reported, with the readable records still counted", async () => {
    const { library, report, avatar, used } = await withBrokenRecord("video-00000002.json", "{ not json");
    expect(report.logIssues).toHaveLength(1);
    expect(report.logIssues[0]).toMatchObject({ avatarId: avatar.id, file: "videos/video-00000002.json" });
    expect(library.photoStates(avatar.id).get(used.id)?.usedIn).toEqual(["video-00000001"]);
    expect(library.videoCount(avatar.id)).toBe(1);
  });

  test("makes eligibleUnusedPhotos refuse, because the missing record may hold photos that look free", async () => {
    const { library, avatar } = await withBrokenRecord("video-00000002.json", "{ not json");
    expect(() => library.eligibleUnusedPhotos(avatar.id)).toThrow(expect.objectContaining({ code: "log-needs-repair" }));
  });

  test("counts as zero eligible-unused photos, and leaves eligiblePhotos alone", async () => {
    const { library, avatar, used, free } = await withBrokenRecord("video-00000002.json", "{ not json");
    expect(library.eligibleUnusedCount(avatar.id)).toBe(0);
    expect(ids(library.eligiblePhotos(avatar.id))).toEqual([used.id, free.id]);
  });

  test("counts a record whose photo refs do not fit the shape as unreadable", async () => {
    const bad = { schemaVersion: 1, id: "video-00000002", avatarId: "x", spec: { clips: [{ cell: { photo: { source: "scene", photoId: 7 } } }] } };
    const { library, avatar } = await withBrokenRecord("video-00000002.json", JSON.stringify(bad));
    expect(() => library.eligibleUnusedPhotos(avatar.id)).toThrow(expect.objectContaining({ code: "log-needs-repair" }));
  });

  test("counts a record whose file name is not its id as unreadable, its photos still used", async () => {
    const { library, report, avatar, free } = await (async () => {
      const { library, avatar } = await savedAvatar();
      const free = await library.addPhoto(avatar.id, PNG_1X1, scene(PASSING));
      await writeVideoRecord(root(), "video-00000001", sceneSpec(avatar.id, [free.id]));
      const path = join(root(), "avatars", avatar.id, "videos");
      await writeFile(join(path, "video-00000009.json"), await readFile(join(path, "video-00000001.json"), "utf8"));
      const opened = await openLibrary(root(), deps());
      return { ...opened, avatar, free };
    })();
    expect(report.logIssues).toHaveLength(1);
    expect(library.eligibleUnusedCount(avatar.id)).toBe(0);
    expect(library.photoStates(avatar.id).get(free.id)?.usedIn).toEqual(["video-00000001"]);
  });

  test("counts a record filed under the wrong avatar as unreadable, and not as that avatar's video", async () => {
    const { library, avatar } = await savedAvatar();
    const other = await library.createAvatar({ ...SAMPLE_AVATAR, name: "Lena" });
    const photo = await library.addPhoto(other.id, PNG_1X1, scene(PASSING));
    const dir = join(root(), "avatars", avatar.id, "videos");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "video-00000001.json"), JSON.stringify(videoRecordJson("video-00000001", sceneSpec(other.id, [photo.id]))));
    const { library: reopened, report } = await openLibrary(root(), deps());
    expect(report.logIssues).toHaveLength(1);
    expect(reopened.videoCount(avatar.id)).toBe(0);
  });

  test("clears once the broken file is gone and the records are reloaded", async () => {
    const { library, avatar, free } = await withBrokenRecord("video-00000002.json", "{ not json");
    await rm(join(root(), "avatars", avatar.id, "videos", "video-00000002.json"));
    await library.reloadVideoRecords(avatar.id);
    expect(ids(library.eligibleUnusedPhotos(avatar.id))).toEqual([free.id]);
  });
});

describe("reserved: photos a queued or running render holds", () => {
  test("a reserved photo is not eligible-unused, though it is still eligible", async () => {
    const reserved = new Set<string>();
    const { library, avatar } = await savedAvatar({ reservedPhotos: () => reserved });
    const held = await library.addPhoto(avatar.id, PNG_1X1, scene(PASSING));
    const free = await library.addPhoto(avatar.id, PNG_1X1, scene(PASSING));
    reserved.add(held.id);

    expect(ids(library.eligiblePhotos(avatar.id))).toEqual([held.id, free.id]);
    expect(ids(library.eligibleUnusedPhotos(avatar.id))).toEqual([free.id]);
    expect(library.photoStates(avatar.id).get(held.id)).toMatchObject({ reserved: true, eligible: true });
    expect(library.eligibleUnusedCount(avatar.id)).toBe(1);
  });

  test("the provider is asked again each time, so a released photo is free at once", async () => {
    const reserved = new Set<string>();
    const { library, avatar } = await savedAvatar({ reservedPhotos: () => reserved });
    const photo = await library.addPhoto(avatar.id, PNG_1X1, scene(PASSING));
    reserved.add(photo.id);
    expect(library.eligibleUnusedPhotos(avatar.id)).toEqual([]);
    reserved.delete(photo.id);
    expect(ids(library.eligibleUnusedPhotos(avatar.id))).toEqual([photo.id]);
  });

  test("the provider is asked about the avatar in question", async () => {
    const asked: string[] = [];
    const { library, avatar } = await savedAvatar({ reservedPhotos: (id) => (asked.push(id), new Set()) });
    library.eligibleUnusedPhotos(avatar.id);
    expect(asked).toEqual([avatar.id]);
  });

  test("the photos of a pending commit intent are held until it is resolved: reserved, not eligible-unused, and free again once released (stage 3 review 3-M3)", async () => {
    const { library, avatar } = await savedAvatar();
    const held = await library.addPhoto(avatar.id, PNG_1X1, scene(PASSING));
    const free = await library.addPhoto(avatar.id, PNG_1X1, scene(PASSING));

    library.holdPendingPhotos(avatar.id, "video-00000001", [held.id]);

    expect(library.photoStates(avatar.id).get(held.id)).toMatchObject({ reserved: true, eligible: true, usedIn: [] });
    expect(ids(library.eligibleUnusedPhotos(avatar.id))).toEqual([free.id]);

    library.releasePendingPhotos("video-00000001");

    expect(ids(library.eligibleUnusedPhotos(avatar.id))).toEqual([held.id, free.id]);
  });

  test("a pending hold is per intent: releasing one leaves the photos of another held, and a photo two intents name stays held until both are released", async () => {
    const { library, avatar } = await savedAvatar();
    const a = await library.addPhoto(avatar.id, PNG_1X1, scene(PASSING));
    const b = await library.addPhoto(avatar.id, PNG_1X1, scene(PASSING));
    library.holdPendingPhotos(avatar.id, "video-0000000a", [a.id, b.id]);
    library.holdPendingPhotos(avatar.id, "video-0000000b", [b.id]);

    library.releasePendingPhotos("video-0000000a");
    expect(ids(library.eligibleUnusedPhotos(avatar.id))).toEqual([a.id]);

    library.releasePendingPhotos("video-0000000b");
    expect(ids(library.eligibleUnusedPhotos(avatar.id))).toEqual([a.id, b.id]);
  });

  test("a hold is kept for the avatar it was made for only, and releasing an intent that was never held changes nothing", async () => {
    const { library, avatar } = await savedAvatar({}, "Mia");
    const other = await library.createAvatar({ ...SAMPLE_AVATAR, name: "Zoe" });
    const photo = await library.addPhoto(avatar.id, PNG_1X1, scene(PASSING));

    library.holdPendingPhotos(other.id, "video-00000001", [photo.id]);
    library.releasePendingPhotos("video-00000009");

    expect(ids(library.eligibleUnusedPhotos(avatar.id))).toEqual([photo.id]);
  });

  test("with no provider nothing is reserved", async () => {
    const { library, avatar } = await savedAvatar();
    const photo = await library.addPhoto(avatar.id, PNG_1X1, scene(PASSING));
    expect(library.photoStates(avatar.id).get(photo.id)?.reserved).toBe(false);
  });

  test("a rejected or age-failed photo stays out even when it is neither used nor reserved", async () => {
    const { library, avatar } = await savedAvatar();
    const rejected = await library.addPhoto(avatar.id, PNG_1X1, scene(PASSING));
    await library.addPhoto(avatar.id, PNG_1X1, scene({ age: { adult: false, confidence: 0.9 } }));
    await library.setRejected(avatar.id, rejected.id, true);
    expect(library.eligibleUnusedPhotos(avatar.id)).toEqual([]);
    expect(library.eligibleUnusedCount(avatar.id)).toBe(0);
  });
});

describe("eligibleUnusedPhotos by category", () => {
  test("keeps only the asked scene category", async () => {
    const { library, avatar } = await savedAvatar();
    await library.addPhoto(avatar.id, PNG_1X1, scene(PASSING, "home"));
    const travel = await library.addPhoto(avatar.id, PNG_1X1, scene(PASSING, "travel"));
    expect(ids(library.eligibleUnusedPhotos(avatar.id, "travel"))).toEqual([travel.id]);
    expect(library.eligibleUnusedPhotos(avatar.id, "glam")).toEqual([]);
  });
});

describe("the photo states are the same answer the lists use", () => {
  test("eligiblePhotos is exactly the photos whose state says eligible", async () => {
    const { library, avatar } = await savedAvatar();
    await library.addPhoto(avatar.id, PNG_1X1, scene(PASSING));
    const gone = await library.addPhoto(avatar.id, PNG_1X1, scene(PASSING));
    await library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta());
    await library.addPhoto(avatar.id, PNG_1X1, scene({ age: { adult: false, confidence: 0.2 } }));
    await library.setRejected(avatar.id, gone.id, true);
    const states = library.photoStates(avatar.id);
    const fromStates = library.photosByAvatar(avatar.id).filter((p) => states.get(p.id)?.eligible === true);
    expect(ids(library.eligiblePhotos(avatar.id))).toEqual(ids(fromStates));
  });
});
