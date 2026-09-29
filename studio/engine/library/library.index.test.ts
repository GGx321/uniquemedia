import { describe, expect, test } from "bun:test";
import { openLibrary, type Library, type LibraryDeps } from "./library";
import {
  PNG_1X1,
  SAMPLE_AVATAR,
  SAMPLE_SOURCE,
  samplePhotoMeta,
  sequentialIds,
  steppingClock,
  useTempDir,
} from "./testing/helpers";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

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
