import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openLibrary } from "../library";
import { PNG_1X1, SAMPLE_AVATAR, SAMPLE_IMPORTED_SOURCE, SAMPLE_SOURCE, samplePhotoMeta, sequentialIds, steppingClock, useTempDir } from "../library/testing/helpers";
import { avatarDeleteCounts } from "./delete";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// «Удалить аватар»: what the confirmation counts. Photos are the gallery's (run photos), candidates are the stored photos that are neither
// a gallery photo nor the master, drafts are the montage drafts in the avatar's folder, videos are the video records.

const root = useTempDir("studio-delete-counts-");

const scene = (category = "home") => samplePhotoMeta({ source: { ...SAMPLE_SOURCE, category } });

async function open() {
  return (await openLibrary(root(), { now: steppingClock(), newId: sequentialIds() })).library;
}

describe("avatarDeleteCounts", () => {
  test("counts the gallery photos of an active avatar, not its master", async () => {
    const library = await open();
    const avatar = await library.createAvatar(SAMPLE_AVATAR);
    const master = await library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta());
    await library.updateAvatar(avatar.id, { status: "active", masterPhotoId: master.id });
    await library.addPhoto(avatar.id, PNG_1X1, scene("home"));
    await library.addPhoto(avatar.id, PNG_1X1, scene("travel"));

    expect(await avatarDeleteCounts(library, avatar.id)).toEqual({ photos: 2, candidates: 0, drafts: 0, videos: 0 });
  });

  test("counts the unpicked candidates of a draft as candidates", async () => {
    const library = await open();
    const draft = await library.createAvatar(SAMPLE_AVATAR);
    await library.addPhoto(draft.id, PNG_1X1, samplePhotoMeta());
    await library.addPhoto(draft.id, PNG_1X1, samplePhotoMeta());
    await library.addPhoto(draft.id, PNG_1X1, samplePhotoMeta());

    expect(await avatarDeleteCounts(library, draft.id)).toEqual({ photos: 0, candidates: 3, drafts: 0, videos: 0 });
  });

  test("an imported photo that is the master is neither a gallery photo nor a candidate", async () => {
    const library = await open();
    const { avatar } = await library.createImportedAvatar({ ...SAMPLE_AVATAR, photoBytes: PNG_1X1, photoMeta: samplePhotoMeta({ source: SAMPLE_IMPORTED_SOURCE }) });

    expect(await avatarDeleteCounts(library, avatar.id)).toEqual({ photos: 0, candidates: 0, drafts: 0, videos: 0 });
  });

  test("counts the montage drafts and the video records", async () => {
    const library = await open();
    const avatar = await library.createAvatar(SAMPLE_AVATAR);
    const master = await library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta());
    await library.updateAvatar(avatar.id, { status: "active", masterPhotoId: master.id });
    await mkdir(library.montagesDir(avatar.id), { recursive: true });
    await writeFile(join(library.montagesDir(avatar.id), "montage-0001.json"), "{}");
    await writeFile(join(library.montagesDir(avatar.id), "montage-0002.json"), "{}");
    library.addVideoRecordToIndex(avatar.id, { videoId: "video-0001", photoIds: [] });

    expect(await avatarDeleteCounts(library, avatar.id)).toEqual({ photos: 0, candidates: 0, drafts: 2, videos: 1 });
  });

  test("does not count another avatar's photos", async () => {
    const library = await open();
    const avatar = await library.createAvatar(SAMPLE_AVATAR);
    const other = await library.createAvatar({ ...SAMPLE_AVATAR, name: "Lena" });
    await library.addPhoto(other.id, PNG_1X1, scene());

    expect(await avatarDeleteCounts(library, avatar.id)).toEqual({ photos: 0, candidates: 0, drafts: 0, videos: 0 });
  });
});
