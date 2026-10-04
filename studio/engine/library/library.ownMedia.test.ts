import { describe, expect, test } from "bun:test";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { openLibrary, type LibraryDeps } from "./library";
import { MediaRecords } from "./mediaRecords";
import type { PhotoQa } from "./schemas";
import { PNG_1X1, SAMPLE_AVATAR, SAMPLE_SOURCE, samplePhotoMeta, sequentialIds, steppingClock, useTempDir } from "./testing/helpers";
import { sceneSpec, writeVideoRecord } from "./testing/videoRecords";
useNativeGlobals();

// Invariant 24 (3f.1b): own media are the owner's own files, in `<library>/media/`. They are never avatar photos, so they never count as
// used or unused, never appear in a photo count, and never reach `eligibleUnusedPhotos` — whatever id they carry, and whether or not a
// rendered video's record names them in a cell.

const root = useTempDir("studio-own-media-lib-");

const PASSING: PhotoQa = { age: { adult: true, confidence: 0.95 } };
const scene = () => samplePhotoMeta({ source: { ...SAMPLE_SOURCE, category: "home" }, qa: PASSING });

function deps(extra: LibraryDeps = {}): LibraryDeps {
  return { now: steppingClock(), newId: sequentialIds(), ...extra };
}

async function savedAvatar() {
  const { library } = await openLibrary(root(), deps());
  const avatar = await library.createAvatar({ ...SAMPLE_AVATAR, name: "Mia" });
  const master = await library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta({ qa: PASSING }));
  await library.updateAvatar(avatar.id, { status: "active", masterPhotoId: master.id });
  return { library, avatar };
}

/** Stores one own photo of the library through the real records, under a chosen id. */
async function storeOwnPhoto(mediaId: string): Promise<void> {
  const staging = join(root(), "media", ".staging");
  await mkdir(staging, { recursive: true });
  const source = join(staging, `staged-${mediaId}.media`);
  await writeFile(source, "own photo bytes");
  const records = new MediaRecords({ root: root(), newId: () => mediaId, now: () => new Date("2026-10-04T10:00:00.000Z"), warn: () => undefined });
  await records.commit({ sourcePath: source, kind: "photo", format: "jpeg", name: "mine.jpg", facts: { width: 10, height: 10, durationMs: null, sourceFps: null, hdrToSdr: false, loopFrames: null, delayFrames: null } });
}

describe("own media and the photo counts", () => {
  test("a library with own media opens with its photo counts as they were, and the media folder untouched", async () => {
    const { library, avatar } = await savedAvatar();
    const photo = await library.addPhoto(avatar.id, PNG_1X1, scene());
    const before = { count: library.photoCount(avatar.id), unused: library.eligibleUnusedCount(avatar.id), ids: library.photosByAvatar(avatar.id).map((p) => p.id).sort() };
    await storeOwnPhoto("media-00000001");
    await storeOwnPhoto("media-00000002");

    const { library: reopened, report } = await openLibrary(root(), deps());
    expect({ count: reopened.photoCount(avatar.id), unused: reopened.eligibleUnusedCount(avatar.id), ids: reopened.photosByAvatar(avatar.id).map((p) => p.id).sort() }).toEqual(before);
    expect(reopened.eligibleUnusedPhotos(avatar.id).map((p) => p.id)).toEqual([photo.id]);
    expect((await readdir(join(root(), "media"))).filter((n) => n !== ".staging").sort()).toEqual(["media-00000001.jpg", "media-00000001.json", "media-00000002.jpg", "media-00000002.json"]);
    expect(report.quarantined).toEqual([]);
  });

  test("an own photo is no photo of the avatar: it is not found among the library's photos, whatever its id", async () => {
    const { library, avatar } = await savedAvatar();
    const photo = await library.addPhoto(avatar.id, PNG_1X1, scene());
    // The own media carries the very id of a scene photo.
    await storeOwnPhoto(photo.id);
    const reopened = (await openLibrary(root(), deps())).library;
    expect(reopened.getPhoto(photo.id)?.source).toMatchObject({ kind: "generated" });
    expect(reopened.photosByAvatar(avatar.id).filter((p) => p.id === photo.id)).toHaveLength(1);
  });

  test("a rendered video that places an own media in a cell uses no scene photo", async () => {
    const { library, avatar } = await savedAvatar();
    const photo = await library.addPhoto(avatar.id, PNG_1X1, scene());
    await storeOwnPhoto("media-00000001");
    await writeVideoRecord(root(), "video-00000001", sceneSpec(avatar.id, [], { ownMediaId: "media-00000001" }));
    const reopened = (await openLibrary(root(), deps())).library;
    expect(reopened.eligibleUnusedPhotos(avatar.id).map((p) => p.id)).toEqual([photo.id]);
    expect(reopened.photoStates(avatar.id).get(photo.id)?.usedIn).toEqual([]);
  });

  test("an own media with the id of a scene photo, named by a video's cell, does not mark that photo used", async () => {
    const { library, avatar } = await savedAvatar();
    const photo = await library.addPhoto(avatar.id, PNG_1X1, scene());
    await storeOwnPhoto(photo.id);
    await writeVideoRecord(root(), "video-00000001", sceneSpec(avatar.id, [], { ownMediaId: photo.id }));
    const reopened = (await openLibrary(root(), deps())).library;
    expect(reopened.eligibleUnusedPhotos(avatar.id).map((p) => p.id)).toEqual([photo.id]);
    expect(reopened.photoStates(avatar.id).get(photo.id)?.usedIn).toEqual([]);
  });

  test("deleting the own media changes no photo count", async () => {
    const { library, avatar } = await savedAvatar();
    await library.addPhoto(avatar.id, PNG_1X1, scene());
    await storeOwnPhoto("media-00000001");
    const records = new MediaRecords({ root: root(), newId: sequentialIds("media"), now: () => new Date(), warn: () => undefined });
    await records.recover();
    const counts = (): number[] => [library.photoCount(avatar.id), library.eligibleUnusedCount(avatar.id)];
    const before = counts();
    await records.remove("media-00000001");
    expect(counts()).toEqual(before);
  });
});
