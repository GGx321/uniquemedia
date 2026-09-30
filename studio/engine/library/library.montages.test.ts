import { describe, expect, test } from "bun:test";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openLibrary, type Library, type LibraryDeps } from "./library";
import { expectLibraryError, PNG_1X1, SAMPLE_AVATAR, samplePhotoMeta, sequentialIds, steppingClock, useTempDir } from "./testing/helpers";
import { sceneSpec, writeVideoRecord } from "./testing/videoRecords";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Where an avatar's montage drafts live (`avatars/<avatarId>/montages/`), how the library open treats the leftovers of
// a crashed draft write, and how many videos were rendered from a draft (a video record names its draft).

const root = useTempDir("studio-montages-lib-");

function deps(extra: LibraryDeps = {}): LibraryDeps {
  return { now: steppingClock(), newId: sequentialIds(), ...extra };
}

async function avatarWithPhotos(library: Library, count: number) {
  const avatar = await library.createAvatar(SAMPLE_AVATAR);
  const photoIds: string[] = [];
  for (let i = 0; i < count; i++) photoIds.push((await library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta())).id);
  return { avatar, photoIds };
}

describe("Library.montagesDir", () => {
  test("is the montages folder of the avatar, inside the library", async () => {
    const { library } = await openLibrary(root(), deps());
    const avatar = await library.createAvatar(SAMPLE_AVATAR);

    expect(library.montagesDir(avatar.id)).toBe(join(root(), "avatars", avatar.id, "montages"));
  });

  test("refuses an avatar id that could walk out of the folder", async () => {
    const { library } = await openLibrary(root(), deps());

    expect(() => library.montagesDir("../escape-1")).toThrow(/invalid|pattern/i);
    expect(() => library.montagesDir("a/b-1234567")).toThrow();
  });
});

describe("opening a library with a crashed draft write", () => {
  test("moves the temp file of an interrupted draft write to quarantine and leaves the drafts alone", async () => {
    const first = await openLibrary(root(), deps());
    const avatar = await first.library.createAvatar(SAMPLE_AVATAR);
    const dir = first.library.montagesDir(avatar.id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "montage-0001.json"), "{}");
    await writeFile(join(dir, ".montage-0001.json.0a1b2c3d4e5f.tmp"), '{"schemaVersion":1,');

    const { report } = await openLibrary(root(), deps());

    expect(report.quarantined.map((q) => q.reason)).toEqual(["temp-file"]);
    expect(await readdir(dir)).toEqual(["montage-0001.json"]);
  });

  test("a library with a montages folder and no temp files opens without a quarantine entry", async () => {
    const first = await openLibrary(root(), deps());
    const avatar = await first.library.createAvatar(SAMPLE_AVATAR);
    await mkdir(first.library.montagesDir(avatar.id), { recursive: true });
    await writeFile(join(first.library.montagesDir(avatar.id), "montage-0001.json"), "{}");

    const { report } = await openLibrary(root(), deps());

    expect(report.quarantined).toEqual([]);
  });
});

describe("Library.videoCountForMontage", () => {
  test("counts the records that name the draft, after a reopen", async () => {
    const first = await openLibrary(root(), deps());
    const { avatar, photoIds } = await avatarWithPhotos(first.library, 3);
    const [a, b, c] = photoIds;
    await writeVideoRecord(root(), "video-0000001", sceneSpec(avatar.id, [a ?? ""]), { montageId: "montage-0001" });
    await writeVideoRecord(root(), "video-0000002", sceneSpec(avatar.id, [b ?? ""]), { montageId: "montage-0001" });
    await writeVideoRecord(root(), "video-0000003", sceneSpec(avatar.id, [c ?? ""]), { montageId: "montage-0002" });

    const { library } = await openLibrary(root(), deps());

    expect(library.videoCountForMontage(avatar.id, "montage-0001")).toBe(2);
    expect(library.videoCountForMontage(avatar.id, "montage-0002")).toBe(1);
  });

  test("does not count a record of a headless spec (montageId null) or one written before drafts existed (no montageId)", async () => {
    const first = await openLibrary(root(), deps());
    const { avatar, photoIds } = await avatarWithPhotos(first.library, 2);
    await writeVideoRecord(root(), "video-0000001", sceneSpec(avatar.id, [photoIds[0] ?? ""]), { montageId: null });
    await writeVideoRecord(root(), "video-0000002", sceneSpec(avatar.id, [photoIds[1] ?? ""]));

    const { library } = await openLibrary(root(), deps());

    expect(library.videoCount(avatar.id)).toBe(2);
    expect(library.videoCountForMontage(avatar.id, "montage-0001")).toBe(0);
  });

  test("a record with a montageId of the wrong type is still a usable record, counted for no draft", async () => {
    const first = await openLibrary(root(), deps());
    const { avatar, photoIds } = await avatarWithPhotos(first.library, 1);
    await writeVideoRecord(root(), "video-0000001", sceneSpec(avatar.id, [photoIds[0] ?? ""]), { montageId: 42 });

    const { library } = await openLibrary(root(), deps());

    expect(library.videoCount(avatar.id)).toBe(1);
    expect(library.videoCountForMontage(avatar.id, "montage-0001")).toBe(0);
    expect(library.eligibleUnusedCount(avatar.id)).toBe(0); // the record still marks its photo used
  });

  test("follows a record the commit adds to the index", async () => {
    const { library } = await openLibrary(root(), deps());
    const { avatar, photoIds } = await avatarWithPhotos(library, 1);

    library.addVideoRecordToIndex(avatar.id, { videoId: "video-0000001", photoIds, montageId: "montage-0001" });

    expect(library.videoCountForMontage(avatar.id, "montage-0001")).toBe(1);
  });

  test("follows a record that is removed from the index", async () => {
    const { library } = await openLibrary(root(), deps());
    const { avatar, photoIds } = await avatarWithPhotos(library, 1);
    library.addVideoRecordToIndex(avatar.id, { videoId: "video-0000001", photoIds, montageId: "montage-0001" });

    library.removeVideoRecordFromIndex(avatar.id, "video-0000001");

    expect(library.videoCountForMontage(avatar.id, "montage-0001")).toBe(0);
  });

  test("is 0 for an avatar with no videos, and for one the library does not have", async () => {
    const { library } = await openLibrary(root(), deps());
    const { avatar } = await avatarWithPhotos(library, 0);

    expect(library.videoCountForMontage(avatar.id, "montage-0001")).toBe(0);
    expect(library.videoCountForMontage("nobody-12345", "montage-0001")).toBe(0);
  });
});

describe("the id of a draft that comes from a caller", () => {
  test("a draft id is checked before it becomes a path segment", async () => {
    const { library } = await openLibrary(root(), deps());
    const avatar = await library.createAvatar(SAMPLE_AVATAR);

    await expectLibraryError(Promise.resolve().then(() => library.montageFilePath(avatar.id, "../x")), "invalid-id");
    expect(library.montageFilePath(avatar.id, "montage-0001")).toBe(join(root(), "avatars", avatar.id, "montages", "montage-0001.json"));
  });
});
