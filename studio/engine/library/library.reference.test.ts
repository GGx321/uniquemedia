import { describe, expect, test } from "bun:test";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { openLibrary, type LibraryDeps } from "./library";
import {
  PNG_1X1,
  SAMPLE_AVATAR,
  samplePhotoMeta,
  sequentialIds,
  steppingClock,
  useTempDir,
} from "./testing/helpers";

const root = useTempDir("studio-reference-");

function deps(extra: LibraryDeps = {}): LibraryDeps {
  return { now: steppingClock(), newId: sequentialIds(), ...extra };
}

/** Mia with a master portrait, and Lena with a photo of her own. */
async function avatarsWithMaster() {
  const { library } = await openLibrary(root(), deps());
  const mia = await library.createAvatar(SAMPLE_AVATAR);
  const master = await library.addPhoto(mia.id, PNG_1X1, samplePhotoMeta());
  await library.updateAvatar(mia.id, { masterPhotoId: master.id, status: "active" });
  const lena = await library.createAvatar({ ...SAMPLE_AVATAR, name: "Lena" });
  const lenaPhoto = await library.addPhoto(lena.id, PNG_1X1, samplePhotoMeta());
  return { library, mia, master, lena, lenaPhoto };
}

function manifestPath(avatarId: string): string {
  return join(root(), "avatars", avatarId, "avatar.json");
}

describe("referencePhoto", () => {
  test("is null while no master is picked", async () => {
    const { library } = await openLibrary(root(), deps());
    const mia = await library.createAvatar(SAMPLE_AVATAR);
    expect(library.referencePhoto(mia.id)).toBeNull();
  });

  test("returns the master photo and the path of its image", async () => {
    const { library, mia, master } = await avatarsWithMaster();
    expect(library.referencePhoto(mia.id)).toEqual({
      photo: master,
      path: join(root(), "avatars", mia.id, "photos", master.file),
    });
  });

  test("is null for a draft, even one whose master is already set", async () => {
    const { library } = await openLibrary(root(), deps());
    const mia = await library.createAvatar(SAMPLE_AVATAR);
    const candidate = await library.addPhoto(mia.id, PNG_1X1, samplePhotoMeta());
    await library.updateAvatar(mia.id, { masterPhotoId: candidate.id });

    expect(library.getAvatar(mia.id)?.status).toBe("draft");
    expect(library.referencePhoto(mia.id)).toBeNull();
  });

  test("is null for an unknown avatar", async () => {
    const { library } = await avatarsWithMaster();
    expect(library.referencePhoto("unknown-avatar")).toBeNull();
  });
});

describe("master check on open", () => {
  test("a quarantined master is reported as missing, the manifest is left as is, and there is no reference", async () => {
    const { mia, master } = await avatarsWithMaster();
    await rm(join(root(), "avatars", mia.id, "photos", master.file));
    const manifestBefore = await readFile(manifestPath(mia.id), "utf8");

    const { library, report } = await openLibrary(root(), deps());

    expect(report.masterIssues).toEqual([{ avatarId: mia.id, masterPhotoId: master.id, reason: "missing" }]);
    expect(library.referencePhoto(mia.id)).toBeNull();
    expect(await readFile(manifestPath(mia.id), "utf8")).toBe(manifestBefore);
  });

  test("a manifest edited to point at another avatar's photo is reported and gives no reference", async () => {
    const { lena, lenaPhoto, mia } = await avatarsWithMaster();
    const manifest = JSON.parse(await readFile(manifestPath(mia.id), "utf8"));
    await writeFile(manifestPath(mia.id), JSON.stringify({ ...manifest, masterPhotoId: lenaPhoto.id }));

    const { library, report } = await openLibrary(root(), deps());

    expect(report.masterIssues).toEqual([{ avatarId: mia.id, masterPhotoId: lenaPhoto.id, reason: "other-avatar" }]);
    expect(library.referencePhoto(mia.id)).toBeNull();
    expect(library.referencePhoto(lena.id)).toBeNull();
  });

  test("restoring the master from quarantine heals the avatar on the next open", async () => {
    const { mia, master } = await avatarsWithMaster();
    await rm(join(root(), "avatars", mia.id, "photos", master.file));
    const first = await openLibrary(root(), deps());
    expect(first.report.masterIssues).toHaveLength(1);
    // The sidecar went to quarantine; put it back with a fresh copy of the image.
    const sidecarEntry = first.report.quarantined.find((q) => q.reason === "orphan-sidecar");
    if (!sidecarEntry) throw new Error("expected the master's sidecar in quarantine");
    await mkdir(dirname(join(root(), sidecarEntry.from)), { recursive: true });
    await rename(join(root(), sidecarEntry.to), join(root(), sidecarEntry.from));
    await writeFile(join(root(), "avatars", mia.id, "photos", master.file), PNG_1X1);

    const { library, report } = await openLibrary(root(), deps());

    expect(report.masterIssues).toEqual([]);
    expect(library.referencePhoto(mia.id)?.photo).toEqual(master);
  });
});
