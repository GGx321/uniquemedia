import { describe, expect, test } from "bun:test";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openLibrary } from "./library";
import { PNG_1X1, SAMPLE_AVATAR, samplePhotoMeta, sequentialIds, steppingClock, useTempDir } from "./testing/helpers";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Stage 1 rendered WebP thumbnails into `avatars/<id>/thumbs/`. Nothing renders them any more (the renderer reads photos over `studio-media://`), but a library
// written by that version may still hold the folder, so the library still sweeps the leftovers of a half-written one when it opens, and removes a photo's
// thumbnail when the photo is deleted.

const root = useTempDir("studio-thumb-");

async function libraryWithPhoto() {
  const { library } = await openLibrary(root(), { now: steppingClock(), newId: sequentialIds() });
  const avatar = await library.createAvatar(SAMPLE_AVATAR);
  const photo = await library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta());
  return { library, avatar, photo };
}

describe("a thumbs folder left by an older version", () => {
  test("open sweeps a half-written leftover out of thumbs", async () => {
    const { avatar, photo } = await libraryWithPhoto();
    const thumbsDir = join(root(), "avatars", avatar.id, "thumbs");
    await mkdir(thumbsDir, { recursive: true });
    const leftover = `${photo.id}.part-0b8f0e9c-7d7e-4c55-9a51-2f0d4c1b8e3a.webp`;
    await writeFile(join(thumbsDir, leftover), "half");

    const { report } = await openLibrary(root());

    expect(report.quarantined.map((q) => [q.from, q.reason])).toEqual([[join("avatars", avatar.id, "thumbs", leftover), "temp-file"]]);
  });

  test("deleting a photo removes the thumbnail an older version made for it", async () => {
    const { library, avatar, photo } = await libraryWithPhoto();
    const thumbsDir = join(root(), "avatars", avatar.id, "thumbs");
    await mkdir(thumbsDir, { recursive: true });
    await writeFile(join(thumbsDir, `${photo.id}.webp`), "webp");

    await library.deletePhoto(avatar.id, photo.id);

    expect(await readdir(thumbsDir)).toEqual([]);
  });
});
