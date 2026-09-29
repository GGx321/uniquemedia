import { describe, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { FOCUS_FILE } from "./layout";
import { openLibrary } from "./library";
import { PNG_1X1, SAMPLE_AVATAR, expectLibraryError, samplePhotoMeta, sequentialIds, steppingClock, useTempDir } from "./testing/helpers";
useNativeGlobals();

const root = useTempDir("studio-readphoto-");

async function libraryWithOnePhoto() {
  const { library } = await openLibrary(root(), { now: steppingClock(), newId: sequentialIds() });
  const avatar = await library.createAvatar(SAMPLE_AVATAR);
  const photo = await library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta());
  return { library, avatar, photo, file: join(root(), "avatars", avatar.id, "photos", photo.file) };
}

describe("readPhotoVerified", () => {
  test("returns the photo's own bytes", async () => {
    const { library, photo } = await libraryWithOnePhoto();
    expect(Array.from(await library.readPhotoVerified(photo.id))).toEqual(Array.from(PNG_1X1));
  });

  test("refuses a photo the library does not have", async () => {
    const { library } = await libraryWithOnePhoto();
    await expectLibraryError(library.readPhotoVerified("no-such-photo"), "photo-not-found");
  });

  test("refuses a file whose size no longer matches its sidecar", async () => {
    const { library, photo, file } = await libraryWithOnePhoto();
    await writeFile(file, Uint8Array.from([...PNG_1X1, 0]));
    await expectLibraryError(library.readPhotoVerified(photo.id), "reference-corrupt");
  });

  test("refuses a file of the right size whose sha256 no longer matches its sidecar", async () => {
    const { library, photo, file } = await libraryWithOnePhoto();
    const flipped = Uint8Array.from(PNG_1X1);
    flipped[flipped.length - 1] = (flipped[flipped.length - 1] ?? 0) ^ 0xff;
    await writeFile(file, flipped);
    await expectLibraryError(library.readPhotoVerified(photo.id), "reference-corrupt");
  });

  test("rejects when the file is gone", async () => {
    const { library, photo, file } = await libraryWithOnePhoto();
    await rm(file);
    await expect(library.readPhotoVerified(photo.id)).rejects.toThrow();
  });
});

describe("focusCachePath", () => {
  test("is the focus file inside the avatar's own folder", async () => {
    const { library, avatar } = await libraryWithOnePhoto();
    expect(library.focusCachePath(avatar.id)).toBe(join(root(), "avatars", avatar.id, FOCUS_FILE));
  });

  test("refuses an id that is not a library id (it becomes a path segment)", async () => {
    const { library } = await libraryWithOnePhoto();
    expect(() => library.focusCachePath("../escape")).toThrow();
  });
});
