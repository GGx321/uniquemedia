import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { openLibrary } from "./library";
import { PNG_1X1, SAMPLE_AVATAR, samplePhotoMeta, sequentialIds, steppingClock, useTempDir } from "./testing/helpers";
useNativeGlobals();

// `photoFilePath` is where a render's resolver finds a scene photo (3a.8b.2): the library's own naming, nothing
// taken from a caller's string.

const root = useTempDir("studio-photofilepath-");

describe("photoFilePath", () => {
  test("names the photo's own file inside its avatar's photos folder", async () => {
    const { library } = await openLibrary(root(), { now: steppingClock(), newId: sequentialIds() });
    const avatar = await library.createAvatar(SAMPLE_AVATAR);
    const photo = await library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta());

    expect(library.photoFilePath(photo.id)).toBe(join(root(), "avatars", avatar.id, "photos", photo.file));
  });

  test("is undefined for a photo the library does not have", async () => {
    const { library } = await openLibrary(root(), { now: steppingClock(), newId: sequentialIds() });

    expect(library.photoFilePath("no-such-photo")).toBeUndefined();
  });
});
