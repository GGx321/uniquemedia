import { describe, expect, test } from "bun:test";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openLibrary, type LibraryDeps } from "./library";
import { expectLibraryError, PNG_1X1, SAMPLE_AVATAR, SAMPLE_SOURCE, samplePhotoMeta, sequentialIds, steppingClock, useTempDir } from "./testing/helpers";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// «Удалить аватар»: the engine takes an avatar out of its in-memory indexes (`detachAvatar`) before main moves the folder to the
// system Trash, and puts it back (`reattachAvatar`) when the Trash refused. Nothing here touches the disk.

const root = useTempDir("studio-detach-");

function deps(extra: LibraryDeps = {}): LibraryDeps {
  return { now: steppingClock(), newId: sequentialIds(), ...extra };
}

const scene = (category = "home") => samplePhotoMeta({ source: { ...SAMPLE_SOURCE, category } });

/** An active avatar with a master, one scene photo and a video record in the index, and another avatar that must stay untouched. */
async function twoAvatars() {
  const { library } = await openLibrary(root(), deps());
  const avatar = await library.createAvatar(SAMPLE_AVATAR);
  const master = await library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta());
  await library.updateAvatar(avatar.id, { status: "active", masterPhotoId: master.id });
  const photo = await library.addPhoto(avatar.id, PNG_1X1, scene());
  await library.setRejected(avatar.id, photo.id, true);
  library.addVideoRecordToIndex(avatar.id, { videoId: "video-0001", photoIds: [photo.id], file: { rootId: "root-0001", relPath: "mia/a.mp4" } });
  library.holdPendingPhotos(avatar.id, "video-0002", [photo.id]);

  const other = await library.createAvatar({ ...SAMPLE_AVATAR, name: "Lena" });
  const otherPhoto = await library.addPhoto(other.id, PNG_1X1, scene());
  library.addVideoRecordToIndex(other.id, { videoId: "video-0003", photoIds: [otherPhoto.id], file: { rootId: "root-0001", relPath: "lena/b.mp4" } });
  return { library, avatar, master, photo, other, otherPhoto };
}

describe("detachAvatar", () => {
  test("the avatar and its photos are no longer found", async () => {
    const { library, avatar, master, photo } = await twoAvatars();

    library.detachAvatar(avatar.id);

    expect(library.getAvatar(avatar.id)).toBeUndefined();
    expect(library.listAvatars().map((a) => a.name)).toEqual(["Lena"]);
    expect(library.getPhoto(master.id)).toBeUndefined();
    expect(library.getPhoto(photo.id)).toBeUndefined();
    expect(library.photosByAvatar(avatar.id)).toEqual([]);
  });

  test("its video records leave the used index and the numbering of export names", async () => {
    const { library, avatar } = await twoAvatars();

    library.detachAvatar(avatar.id);

    expect(library.videoCount(avatar.id)).toBe(0);
    expect(library.namedVideoFiles()).toEqual([{ rootId: "root-0001", relPath: "lena/b.mp4" }]);
  });

  test("its pending intent holds end, so they reserve nothing of a gone avatar", async () => {
    const { library, avatar } = await twoAvatars();
    expect(library.pendingVideoCount(avatar.id)).toBe(1);

    library.detachAvatar(avatar.id);

    expect(library.pendingVideoCount(avatar.id)).toBe(0);
  });

  test("another avatar keeps its photos, records and marks", async () => {
    const { library, avatar, other, otherPhoto } = await twoAvatars();

    library.detachAvatar(avatar.id);

    expect(library.photosByAvatar(other.id).map((p) => p.id)).toEqual([otherPhoto.id]);
    expect(library.videoCount(other.id)).toBe(1);
  });

  test("changes nothing on disk", async () => {
    const { library, avatar } = await twoAvatars();
    const before = (await readdir(join(root(), "avatars", avatar.id), { recursive: true })).sort();

    library.detachAvatar(avatar.id);

    expect((await readdir(join(root(), "avatars", avatar.id), { recursive: true })).sort()).toEqual(before);
  });

  test("an unknown avatar is avatar-not-found", async () => {
    const { library } = await twoAvatars();

    expect(() => library.detachAvatar("no-such-avatar")).toThrow(expect.objectContaining({ code: "avatar-not-found" }));
  });

  test("a draft can be detached too", async () => {
    const { library } = await openLibrary(root(), deps());
    const draft = await library.createAvatar(SAMPLE_AVATAR);
    await library.addPhoto(draft.id, PNG_1X1, samplePhotoMeta());

    library.detachAvatar(draft.id);

    expect(library.listAvatars()).toEqual([]);
    expect(library.photoCount(draft.id)).toBe(0);
  });

  test("a detached avatar cannot be updated or given a photo", async () => {
    const { library, avatar } = await twoAvatars();
    library.detachAvatar(avatar.id);

    await expectLibraryError(library.updateAvatar(avatar.id, { name: "Zed" }), "avatar-not-found");
    await expectLibraryError(library.addPhoto(avatar.id, PNG_1X1, scene()), "avatar-not-found");
  });
});

describe("reattachAvatar", () => {
  test("brings back the avatar, its photos, its reject marks and its video records as they were", async () => {
    const { library, avatar, master, photo } = await twoAvatars();
    const manifest = library.getAvatar(avatar.id);
    const states = library.photoStates(avatar.id);

    const detached = library.detachAvatar(avatar.id);
    library.reattachAvatar(detached);

    expect(library.getAvatar(avatar.id)).toEqual(manifest);
    expect(library.photosByAvatar(avatar.id).map((p) => p.id)).toEqual([master.id, photo.id]);
    expect(library.photoStates(avatar.id)).toEqual(states);
    expect(library.videoCount(avatar.id)).toBe(1);
    expect(library.pendingVideoCount(avatar.id)).toBe(1);
  });

  test("keeps the order of the list: oldest first", async () => {
    const { library, avatar } = await twoAvatars();

    library.reattachAvatar(library.detachAvatar(avatar.id));

    expect(library.listAvatars().map((a) => a.name)).toEqual(["Mia", "Lena"]);
  });

  test("an avatar that was reattached can be updated again", async () => {
    const { library, avatar } = await twoAvatars();

    library.reattachAvatar(library.detachAvatar(avatar.id));

    expect((await library.updateAvatar(avatar.id, { name: "Zed" })).name).toBe("Zed");
  });

  test("refuses to overwrite an avatar that has the same id again", async () => {
    const { library, avatar } = await twoAvatars();
    const detached = library.detachAvatar(avatar.id);
    library.reattachAvatar(detached);

    expect(() => library.reattachAvatar(detached)).toThrow(expect.objectContaining({ code: "invalid-record" }));
  });
});

describe("avatarDirPath", () => {
  test("is the avatar's folder inside the library", async () => {
    const { library, avatar } = await twoAvatars();

    expect(library.avatarDirPath(avatar.id)).toBe(join(library.root, "avatars", avatar.id));
  });

  test("refuses an id that is not a library id, so it never becomes a path", async () => {
    const { library } = await twoAvatars();

    expect(() => library.avatarDirPath("../outside")).toThrow(expect.objectContaining({ code: "invalid-id" }));
  });
});

describe("montageCount", () => {
  test("counts the draft files and nothing else in the montages folder", async () => {
    const { library, avatar } = await twoAvatars();
    const dir = library.montagesDir(avatar.id);
    await mkdir(join(dir, "nested"), { recursive: true });
    await writeFile(join(dir, "montage-0001.json"), "{}");
    await writeFile(join(dir, "montage-0002.json"), "{}");
    await writeFile(join(dir, ".montage-0003.json.abcdef.tmp"), "{}");
    await writeFile(join(dir, "notes.txt"), "x");

    expect(await library.montageCount(avatar.id)).toBe(2);
  });

  test("is 0 when the avatar has no montages folder", async () => {
    const { library, avatar } = await twoAvatars();

    expect(await library.montageCount(avatar.id)).toBe(0);
  });
});
