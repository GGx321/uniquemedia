import { describe, expect, test } from "bun:test";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openLibrary, type Library, type LibraryDeps } from "./library";
import {
  PNG_1X1,
  SAMPLE_AVATAR,
  SAMPLE_SOURCE,
  expectLibraryError,
  samplePhotoMeta,
  sequentialIds,
  steppingClock,
  useTempDir,
} from "./testing/helpers";

const root = useTempDir("studio-index-");

function deps(extra: LibraryDeps = {}): LibraryDeps {
  return { now: steppingClock(), newId: sequentialIds(), ...extra };
}

async function addPhoto(library: Library, avatarId: string, category?: string) {
  const source = category === undefined ? SAMPLE_SOURCE : { ...SAMPLE_SOURCE, category };
  return library.addPhoto(avatarId, PNG_1X1, samplePhotoMeta({ source }));
}

/** Two avatars; Mia has three photos (glamour, cafe, glamour), Lena one (cafe). */
async function twoAvatars() {
  const { library } = await openLibrary(root(), deps());
  const mia = await library.createAvatar(SAMPLE_AVATAR);
  const lena = await library.createAvatar({ ...SAMPLE_AVATAR, name: "Lena" });
  const m1 = await addPhoto(library, mia.id, "glamour");
  const l1 = await addPhoto(library, lena.id, "cafe");
  const m2 = await addPhoto(library, mia.id, "cafe");
  const m3 = await addPhoto(library, mia.id, "glamour");
  return { library, mia, lena, m1, m2, m3, l1 };
}

const ids = (photos: { id: string }[]) => photos.map((p) => p.id);

describe("index queries", () => {
  test("photosByAvatar returns only that avatar's photos, oldest first", async () => {
    const { library, mia, lena, m1, m2, m3, l1 } = await twoAvatars();
    expect(ids(library.photosByAvatar(mia.id))).toEqual([m1.id, m2.id, m3.id]);
    expect(ids(library.photosByAvatar(lena.id))).toEqual([l1.id]);
  });

  test("photosByAvatar keeps creation order after a reopen", async () => {
    const { mia, m1, m2, m3 } = await twoAvatars();
    const { library } = await openLibrary(root(), deps());
    expect(ids(library.photosByAvatar(mia.id))).toEqual([m1.id, m2.id, m3.id]);
  });

  test("photosByAvatar is empty for an unknown avatar", async () => {
    const { library } = await twoAvatars();
    expect(library.photosByAvatar("unknown-avatar")).toEqual([]);
  });

  test("photosByCategory filters one avatar's photos by scene category", async () => {
    const { library, mia, lena, m1, m3, l1 } = await twoAvatars();
    expect(ids(library.photosByCategory(mia.id, "glamour"))).toEqual([m1.id, m3.id]);
    expect(ids(library.photosByCategory(lena.id, "cafe"))).toEqual([l1.id]);
    expect(library.photosByCategory(lena.id, "glamour")).toEqual([]);
  });

  test("photoCount counts one avatar's photos", async () => {
    const { library, mia, lena } = await twoAvatars();
    expect(library.photoCount(mia.id)).toBe(3);
    expect(library.photoCount(lena.id)).toBe(1);
    expect(library.photoCount("unknown-avatar")).toBe(0);
  });
});

describe("markUsed and unusedPhotos", () => {
  test("every photo starts unused", async () => {
    const { library, mia, m1, m2, m3 } = await twoAvatars();
    expect(ids(library.unusedPhotos(mia.id))).toEqual([m1.id, m2.id, m3.id]);
  });

  test("a photo marked used drops out of the unused list", async () => {
    const { library, mia, m1, m2, m3 } = await twoAvatars();
    await library.markUsed(m1.id, "video-0001");
    expect(ids(library.unusedPhotos(mia.id))).toEqual([m2.id, m3.id]);
  });

  test("appends { photoId, videoId, at } to the avatar's used.jsonl", async () => {
    let clock = new Date("2026-01-01T00:00:00.000Z");
    const { library } = await openLibrary(root(), deps({ now: () => clock }));
    const mia = await library.createAvatar(SAMPLE_AVATAR);
    const photo = await addPhoto(library, mia.id);
    clock = new Date("2026-09-24T15:00:00.000Z");

    await library.markUsed(photo.id, "video-0001");

    expect(await readFile(join(root(), "avatars", mia.id, "used.jsonl"), "utf8")).toBe(
      `${JSON.stringify({ photoId: photo.id, videoId: "video-0001", at: "2026-09-24T15:00:00.000Z" })}\n`
    );
  });

  test("used marks survive a reopen", async () => {
    const { library, mia, m1, m2, m3 } = await twoAvatars();
    await library.markUsed(m2.id, "video-0001");

    const reopened = await openLibrary(root(), deps());

    expect(ids(reopened.library.unusedPhotos(mia.id))).toEqual([m1.id, m3.id]);
  });

  test("a torn last line in used.jsonl does not block opening and committed marks still count", async () => {
    const { library, mia, m1, m2, m3 } = await twoAvatars();
    await library.markUsed(m1.id, "video-0001");
    await appendFile(join(root(), "avatars", mia.id, "used.jsonl"), `{"photoId":"${m2.id}","vid`);

    const reopened = await openLibrary(root(), deps());

    expect(ids(reopened.library.unusedPhotos(mia.id))).toEqual([m2.id, m3.id]);
  });

  test("a corrupt middle line in one avatar's used.jsonl is reported without failing the open", async () => {
    const { library, mia, m1 } = await twoAvatars();
    await library.markUsed(m1.id, "video-0001");
    await appendFile(join(root(), "avatars", mia.id, "used.jsonl"), "not json\n");
    await library.markUsed(m1.id, "video-0002");

    const reopened = await openLibrary(root(), deps());

    expect(reopened.report.logIssues).toHaveLength(1);
    expect(reopened.report.logIssues[0]).toMatchObject({ avatarId: mia.id, file: "used.jsonl" });
    expect(reopened.report.logIssues[0].detail).toContain(":2");
    expect(reopened.report.avatars).toBe(2);
  });

  test("until that log is repaired, the avatar's markUsed and unusedPhotos refuse; other avatars work", async () => {
    const { library, mia, lena, m1, m2, l1 } = await twoAvatars();
    await library.markUsed(m1.id, "video-0001");
    await appendFile(join(root(), "avatars", mia.id, "used.jsonl"), "not json\n");

    const { library: reopened } = await openLibrary(root(), deps());

    await expectLibraryError(reopened.markUsed(m2.id, "video-0002"), "log-needs-repair");
    expect(() => reopened.unusedPhotos(mia.id)).toThrow(expect.objectContaining({ code: "log-needs-repair" }));
    await reopened.markUsed(l1.id, "video-0003");
    expect(reopened.unusedPhotos(lena.id)).toEqual([]);
    // Nothing was appended to the broken log.
    expect((await readFile(join(root(), "avatars", mia.id, "used.jsonl"), "utf8")).split("\n").filter(Boolean)).toHaveLength(2);
  });

  test("repairing the log by hand and reopening unblocks the avatar", async () => {
    const { library, mia, m1, m2, m3 } = await twoAvatars();
    await library.markUsed(m1.id, "video-0001");
    const usedPath = join(root(), "avatars", mia.id, "used.jsonl");
    const good = await readFile(usedPath, "utf8");
    await appendFile(usedPath, "not json\n");
    await openLibrary(root(), deps());
    await writeFile(usedPath, good);

    const { library: reopened, report } = await openLibrary(root(), deps());

    expect(report.logIssues).toEqual([]);
    expect(ids(reopened.unusedPhotos(mia.id))).toEqual([m2.id, m3.id]);
  });

  test("refuses a photo the library does not hold", async () => {
    const { library } = await twoAvatars();
    await expectLibraryError(library.markUsed("not-a-photo", "video-0001"), "photo-not-found");
  });

  test("refuses a video id that breaks the id pattern", async () => {
    const { library, m1 } = await twoAvatars();
    await expectLibraryError(library.markUsed(m1.id, "../video"), "invalid-id");
  });
});
