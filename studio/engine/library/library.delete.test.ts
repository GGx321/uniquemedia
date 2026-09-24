import { describe, expect, test } from "bun:test";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { openLibrary, type LibraryDeps } from "./library";
import { expectLibraryError, PNG_1X1, SAMPLE_AVATAR, samplePhotoMeta, sequentialIds, steppingClock, useTempDir } from "./testing/helpers";

const root = useTempDir("studio-delete-");

function deps(extra: LibraryDeps = {}): LibraryDeps {
  return {
    now: steppingClock(),
    newId: sequentialIds(),
    renderThumbnail: async (_input, output) => {
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, "webp");
    },
    ...extra,
  };
}

/** A draft (test-id-0001) with two candidates (test-id-0002, test-id-0003), and another avatar (test-id-0004) with a photo (test-id-0005). */
async function draftWithCandidates() {
  const { library } = await openLibrary(root(), deps());
  const draft = await library.createAvatar(SAMPLE_AVATAR);
  const keep = await library.addPhoto(draft.id, PNG_1X1, samplePhotoMeta());
  const drop = await library.addPhoto(draft.id, PNG_1X1, samplePhotoMeta());
  const other = await library.createAvatar({ ...SAMPLE_AVATAR, name: "Lena" });
  const otherPhoto = await library.addPhoto(other.id, PNG_1X1, samplePhotoMeta());
  const photosDir = join(root(), "avatars", draft.id, "photos");
  return { library, draft, keep, drop, other, otherPhoto, photosDir };
}

describe("deletePhoto", () => {
  test("removes the image and its sidecar and forgets the photo", async () => {
    const { library, draft, keep, drop, photosDir } = await draftWithCandidates();

    await library.deletePhoto(draft.id, drop.id);

    expect((await readdir(photosDir)).sort()).toEqual([keep.file, `${keep.id}.json`].sort());
    expect(library.getPhoto(drop.id)).toBeUndefined();
    expect(library.photosByAvatar(draft.id).map((p) => p.id)).toEqual([keep.id]);
    expect(library.photoCount(draft.id)).toBe(1);
  });

  test("a reopen lists only the photos left and quarantines nothing", async () => {
    const { library, draft, keep, drop } = await draftWithCandidates();
    await library.deletePhoto(draft.id, drop.id);

    const reopened = await openLibrary(root(), deps());

    expect(reopened.library.photosByAvatar(draft.id).map((p) => p.id)).toEqual([keep.id]);
    expect(reopened.report.quarantined).toEqual([]);
  });

  test("removes the photo's thumbnail too", async () => {
    const { library, draft, drop } = await draftWithCandidates();
    const thumb = await library.thumbnail(draft.id, drop.id);

    await library.deletePhoto(draft.id, drop.id);

    expect(await readdir(dirname(thumb))).toEqual([]);
  });

  test("refuses a photo of another avatar and leaves it in place", async () => {
    const { library, draft, other, otherPhoto } = await draftWithCandidates();

    await expectLibraryError(library.deletePhoto(draft.id, otherPhoto.id), "photo-not-found");

    expect(library.photosByAvatar(other.id)).toEqual([otherPhoto]);
    expect((await readdir(join(root(), "avatars", other.id, "photos"))).sort()).toEqual([otherPhoto.file, `${otherPhoto.id}.json`].sort());
  });

  test("refuses an unknown photo", async () => {
    const { library, draft } = await draftWithCandidates();

    await expectLibraryError(library.deletePhoto(draft.id, "unknown-photo"), "photo-not-found");
  });

  test("refuses the avatar's master photo: a manifest never names a missing master", async () => {
    const { library, draft, keep, photosDir } = await draftWithCandidates();
    await library.updateAvatar(draft.id, { status: "active", masterPhotoId: keep.id });

    await expectLibraryError(library.deletePhoto(draft.id, keep.id), "photo-is-master");

    expect(library.referencePhoto(draft.id)?.photo).toEqual(keep);
    expect(await readdir(photosDir)).toContain(keep.file);
  });
});
