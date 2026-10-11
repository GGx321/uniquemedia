import { describe, expect, test } from "bun:test";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openLibrary, type Library, type LibraryDeps } from "./library";
import type { PhotoQa, PhotoSidecar } from "./schemas";
import {
  expectLibraryError,
  JPEG_HEADER_ONLY,
  PNG_1X1,
  rejectionOf,
  SAMPLE_AVATAR,
  SAMPLE_IMPORTED_SOURCE,
  SAMPLE_SOURCE,
  samplePhotoMeta,
  sequentialIds,
  steppingClock,
  useTempDir,
} from "./testing/helpers";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Stage 5, S5.3a: the library side of the reference portrait. A portrait is an ordinary generated photo of an imported avatar with the slot `portrait-N` and its likeness to
// the imported photo in `qa.faceCos`. The master moves to a picked portrait (or back to the source), the manifest commits first and the cleanup follows (I5.18).

const root = useTempDir("studio-portraits-");

function deps(extra: LibraryDeps = {}): LibraryDeps {
  return { now: steppingClock(), newId: sequentialIds(), ...extra };
}

const importedMeta = () => samplePhotoMeta({ mediaType: "image/jpeg", source: SAMPLE_IMPORTED_SOURCE });
const portraitMeta = (slot: number, faceCos: number | undefined, qa: PhotoQa = {}) =>
  samplePhotoMeta({ source: { ...SAMPLE_SOURCE, slot: `portrait-${slot}` }, qa: faceCos === undefined ? qa : { faceCos, ...qa } });

/** An imported avatar (master = the imported photo, bytes distinct from every portrait's), opened with `extra` deps. */
async function importedAvatar(extra: LibraryDeps = {}) {
  const { library } = await openLibrary(root(), deps(extra));
  const { avatar, photo: source } = await library.createImportedAvatar({ ...SAMPLE_AVATAR, photoBytes: JPEG_HEADER_ONLY, photoMeta: importedMeta() });
  return { library, avatar, source };
}

/** An imported avatar with three pending portraits, a run photo and another avatar's photo. */
async function withPortraits(extra: LibraryDeps = {}) {
  const { library, avatar, source } = await importedAvatar(extra);
  const p1 = await library.addPhoto(avatar.id, PNG_1X1, portraitMeta(1, 0.76));
  const p2 = await library.addPhoto(avatar.id, PNG_1X1, portraitMeta(2, 0.72));
  const p3 = await library.addPhoto(avatar.id, PNG_1X1, portraitMeta(3, 0.61));
  const runPhoto = await library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta({ source: { ...SAMPLE_SOURCE, slot: "slot-1", category: "cafe" } }));
  const other = await library.createAvatar({ ...SAMPLE_AVATAR, name: "Lena" });
  const otherPhoto = await library.addPhoto(other.id, PNG_1X1, portraitMeta(1, 0.9));
  return { library, avatar, source, p1, p2, p3, runPhoto, other, otherPhoto };
}

const photosDir = (avatarId: string) => join(root(), "avatars", avatarId, "photos");
const manifestPath = (avatarId: string) => join(root(), "avatars", avatarId, "avatar.json");
const idsOf = (photos: readonly PhotoSidecar[]) => photos.map((p) => p.id);

async function manifestOnDisk(avatarId: string): Promise<{ masterPhotoId: string }> {
  return JSON.parse(await readFile(manifestPath(avatarId), "utf8"));
}

/** Makes removing `photo` fail the way a locked file does on Windows: its sidecar path is now a non-empty folder. */
async function makeUnremovable(avatarId: string, photo: PhotoSidecar): Promise<void> {
  const json = join(photosDir(avatarId), `${photo.id}.json`);
  await rm(json);
  await mkdir(json);
  await writeFile(join(json, "lock"), "x");
}

describe("sourcePhoto", () => {
  test("is the imported photo of an imported avatar", async () => {
    const { library, avatar, source } = await importedAvatar();
    expect(library.sourcePhoto(avatar.id)).toEqual(source);
  });

  test("is null for a wizard avatar", async () => {
    const { library } = await openLibrary(root(), deps());
    const mia = await library.createAvatar(SAMPLE_AVATAR);
    const master = await library.addPhoto(mia.id, PNG_1X1, samplePhotoMeta());
    await library.updateAvatar(mia.id, { masterPhotoId: master.id, status: "active" });
    expect(library.sourcePhoto(mia.id)).toBeNull();
  });

  test("is null for an unknown avatar", async () => {
    const { library } = await importedAvatar();
    expect(library.sourcePhoto("unknown-avatar")).toBeNull();
  });

  test("is still the imported photo after the master has moved to a portrait", async () => {
    const { library, avatar, source, p1 } = await withPortraits();
    await library.switchMaster(avatar.id, p1.id);
    expect(library.sourcePhoto(avatar.id)).toEqual(source);
  });

  test("the oldest imported photo wins when two were made by hand", async () => {
    const { library, avatar, source } = await importedAvatar();
    await library.addPhoto(avatar.id, JPEG_HEADER_ONLY, importedMeta());
    expect(library.sourcePhoto(avatar.id)).toEqual(source);
  });

  test("another avatar's imported photo is never this avatar's source", async () => {
    const { library, avatar } = await importedAvatar();
    const lena = await library.createAvatar({ ...SAMPLE_AVATAR, name: "Lena" });
    const lenaMaster = await library.addPhoto(lena.id, PNG_1X1, samplePhotoMeta());
    await library.updateAvatar(lena.id, { masterPhotoId: lenaMaster.id, status: "active" });
    expect(library.sourcePhoto(lena.id)).toBeNull();
    expect(library.sourcePhoto(avatar.id)?.avatarId).toBe(avatar.id);
  });
});

describe("portraitCandidates", () => {
  test("lists the avatar's portraits, best likeness first", async () => {
    const { library, avatar, p1, p2, p3 } = await withPortraits();
    expect(idsOf(library.portraitCandidates(avatar.id))).toEqual([p1.id, p2.id, p3.id]);
  });

  test("breaks a tie by photo id", async () => {
    const { library, avatar } = await importedAvatar();
    const a = await library.addPhoto(avatar.id, PNG_1X1, portraitMeta(1, 0.7));
    const b = await library.addPhoto(avatar.id, PNG_1X1, portraitMeta(2, 0.7));
    expect(idsOf(library.portraitCandidates(avatar.id))).toEqual([a.id, b.id].sort());
  });

  test("leaves out the imported photo, run photos, wizard candidates and another avatar's portraits", async () => {
    const { library, avatar, p1, p2, p3 } = await withPortraits();
    await library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta({ source: { ...SAMPLE_SOURCE, slot: "candidate-1" } }));
    expect(idsOf(library.portraitCandidates(avatar.id))).toEqual([p1.id, p2.id, p3.id]);
  });

  test("leaves out the master when the master is a portrait", async () => {
    const { library, avatar, p1 } = await withPortraits();
    await library.switchMaster(avatar.id, p1.id);
    const next = await library.addPhoto(avatar.id, PNG_1X1, portraitMeta(4, 0.66));
    expect(idsOf(library.portraitCandidates(avatar.id))).toEqual([next.id]);
  });

  test("still lists a portrait below the gate or with a failing age verdict: the pick refuses it, the library does not hide it", async () => {
    const { library, avatar } = await importedAvatar();
    const low = await library.addPhoto(avatar.id, PNG_1X1, portraitMeta(1, 0.4));
    const young = await library.addPhoto(avatar.id, PNG_1X1, portraitMeta(2, 0.9, { age: { adult: false, confidence: 0.9 } }));
    expect(idsOf(library.portraitCandidates(avatar.id)).sort()).toEqual([low.id, young.id].sort());
  });

  test("is empty for an avatar with none and for an unknown avatar", async () => {
    const { library, avatar } = await importedAvatar();
    expect(library.portraitCandidates(avatar.id)).toEqual([]);
    expect(library.portraitCandidates("unknown-avatar")).toEqual([]);
  });
});

describe("switchMaster to a pending portrait", () => {
  test("moves the master, answers the new manifest and writes it", async () => {
    const { library, avatar, p2 } = await withPortraits();

    const manifest = await library.switchMaster(avatar.id, p2.id);

    expect(manifest).toMatchObject({ id: avatar.id, status: "active", masterPhotoId: p2.id });
    expect(library.getAvatar(avatar.id)).toEqual(manifest);
    expect(await manifestOnDisk(avatar.id)).toMatchObject({ masterPhotoId: p2.id });
    expect(library.referencePhoto(avatar.id)?.photo).toEqual(p2);
  });

  test("removes the other pending portraits from memory and from disk", async () => {
    const { library, avatar, source, p1, p2, p3, runPhoto } = await withPortraits();

    await library.switchMaster(avatar.id, p2.id);

    expect(library.getPhoto(p1.id)).toBeUndefined();
    expect(library.getPhoto(p3.id)).toBeUndefined();
    const files = await readdir(photosDir(avatar.id));
    for (const gone of [p1, p3]) expect(files).not.toContain(gone.file);
    for (const kept of [source, p2, runPhoto]) expect(files).toContain(kept.file);
  });

  test("never removes the imported photo or a run photo", async () => {
    const { library, avatar, source, p1, runPhoto } = await withPortraits();

    await library.switchMaster(avatar.id, p1.id);

    expect(library.getPhoto(source.id)).toEqual(source);
    expect(library.getPhoto(runPhoto.id)).toEqual(runPhoto);
    expect(library.sourcePhoto(avatar.id)).toEqual(source);
  });

  test("never touches another avatar's portraits", async () => {
    const { library, avatar, p1, otherPhoto } = await withPortraits();

    await library.switchMaster(avatar.id, p1.id);

    expect(library.getPhoto(otherPhoto.id)).toEqual(otherPhoto);
  });

  test("removes the portrait that was the master before, once the next one is picked", async () => {
    const { library, avatar, source, p1, p2 } = await withPortraits();
    await library.switchMaster(avatar.id, p1.id);
    const later = await library.addPhoto(avatar.id, PNG_1X1, portraitMeta(4, 0.8));

    await library.switchMaster(avatar.id, later.id);

    expect(library.getPhoto(p1.id)).toBeUndefined();
    expect(library.getPhoto(p2.id)).toBeUndefined();
    expect(library.referencePhoto(avatar.id)?.photo).toEqual(later);
    expect(library.getPhoto(source.id)).toEqual(source);
    expect(await readdir(photosDir(avatar.id))).not.toContain(p1.file);
  });

  test("the removed portraits are no longer listed as candidates", async () => {
    const { library, avatar, p1 } = await withPortraits();
    await library.switchMaster(avatar.id, p1.id);
    expect(library.portraitCandidates(avatar.id)).toEqual([]);
  });
});

describe("switchMaster back to the source photo", () => {
  test("is allowed, and removes the portrait that was the master", async () => {
    const { library, avatar, source, p1 } = await withPortraits();
    await library.switchMaster(avatar.id, p1.id);

    const manifest = await library.switchMaster(avatar.id, source.id);

    expect(manifest.masterPhotoId).toBe(source.id);
    expect(await manifestOnDisk(avatar.id)).toMatchObject({ masterPhotoId: source.id });
    expect(library.getPhoto(p1.id)).toBeUndefined();
    expect(library.getPhoto(source.id)).toEqual(source);
    expect(library.referencePhoto(avatar.id)?.photo).toEqual(source);
  });
});

describe("switchMaster refuses what cannot be a master (I5.17)", () => {
  async function expectUnchanged(library: Library, avatarId: string, masterBefore: string, before: PhotoSidecar[]): Promise<void> {
    expect(library.getAvatar(avatarId)?.masterPhotoId).toBe(masterBefore);
    expect((await manifestOnDisk(avatarId)).masterPhotoId).toBe(masterBefore);
    expect(library.photosByAvatar(avatarId)).toEqual(before);
  }

  test("a run photo", async () => {
    const { library, avatar, source, runPhoto } = await withPortraits();
    const before = library.photosByAvatar(avatar.id);
    await expectLibraryError(library.switchMaster(avatar.id, runPhoto.id), "not-a-candidate");
    await expectUnchanged(library, avatar.id, source.id, before);
  });

  test("another avatar's photo, even a portrait with a high likeness", async () => {
    const { library, avatar, source, otherPhoto } = await withPortraits();
    const before = library.photosByAvatar(avatar.id);
    await expectLibraryError(library.switchMaster(avatar.id, otherPhoto.id), "not-a-candidate");
    await expectUnchanged(library, avatar.id, source.id, before);
  });

  test("a photo the library does not have", async () => {
    const { library, avatar, source } = await withPortraits();
    const before = library.photosByAvatar(avatar.id);
    await expectLibraryError(library.switchMaster(avatar.id, "no-such-photo"), "not-a-candidate");
    await expectUnchanged(library, avatar.id, source.id, before);
  });

  test("a portrait with likeness 0.54", async () => {
    const { library, avatar, source } = await importedAvatar();
    const low = await library.addPhoto(avatar.id, PNG_1X1, portraitMeta(1, 0.54));
    const before = library.photosByAvatar(avatar.id);
    await expectLibraryError(library.switchMaster(avatar.id, low.id), "not-a-candidate");
    await expectUnchanged(library, avatar.id, source.id, before);
  });

  test("a portrait with exactly the gate's likeness is accepted", async () => {
    const { library, avatar } = await importedAvatar();
    const edge = await library.addPhoto(avatar.id, PNG_1X1, portraitMeta(1, 0.55));
    expect((await library.switchMaster(avatar.id, edge.id)).masterPhotoId).toBe(edge.id);
  });

  test("a portrait with no stored likeness", async () => {
    const { library, avatar, source } = await importedAvatar();
    const unscored = await library.addPhoto(avatar.id, PNG_1X1, portraitMeta(1, undefined));
    const before = library.photosByAvatar(avatar.id);
    await expectLibraryError(library.switchMaster(avatar.id, unscored.id), "not-a-candidate");
    await expectUnchanged(library, avatar.id, source.id, before);
  });

  test("a portrait whose stored age verdict fails today's threshold", async () => {
    const { library, avatar, source } = await importedAvatar();
    const young = await library.addPhoto(avatar.id, PNG_1X1, portraitMeta(1, 0.9, { age: { adult: false, confidence: 0.95 } }));
    const before = library.photosByAvatar(avatar.id);
    await expectLibraryError(library.switchMaster(avatar.id, young.id), "not-a-candidate");
    await expectUnchanged(library, avatar.id, source.id, before);
  });

  test("a wizard candidate (slot candidate-N) of the same avatar", async () => {
    const { library, avatar, source } = await importedAvatar();
    const wizard = await library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta({ source: { ...SAMPLE_SOURCE, slot: "candidate-2" }, qa: { faceCos: 0.9 } }));
    const before = library.photosByAvatar(avatar.id);
    await expectLibraryError(library.switchMaster(avatar.id, wizard.id), "not-a-candidate");
    await expectUnchanged(library, avatar.id, source.id, before);
  });

  test("an avatar that is still a draft", async () => {
    const { library } = await openLibrary(root(), deps());
    const draft = await library.createAvatar(SAMPLE_AVATAR);
    const candidate = await library.addPhoto(draft.id, PNG_1X1, portraitMeta(1, 0.9));
    await expectLibraryError(library.switchMaster(draft.id, candidate.id), "not-a-candidate");
    expect(library.getAvatar(draft.id)?.status).toBe("draft");
  });

  test("an unknown avatar", async () => {
    const { library, p1 } = await withPortraits();
    await expectLibraryError(library.switchMaster("unknown-avatar", p1.id), "avatar-not-found");
  });
});

describe("switchMaster to the photo that is already the master", () => {
  test("writes nothing and answers the manifest as it is", async () => {
    const renames: string[] = [];
    const { library, avatar, source } = await withPortraits({ testHooks: { beforeRename: (path) => void renames.push(path) } });
    const before = library.getAvatar(avatar.id);
    const writesBefore = renames.length;

    const manifest = await library.switchMaster(avatar.id, source.id);

    expect(manifest).toEqual(before as typeof manifest);
    expect(renames.length).toBe(writesBefore);
  });

  test("removes no pending portrait either", async () => {
    const { library, avatar, source, p1, p2, p3 } = await withPortraits();
    await library.switchMaster(avatar.id, source.id);
    expect(idsOf(library.portraitCandidates(avatar.id))).toEqual([p1.id, p2.id, p3.id]);
  });

  test("a master that would not pass the pick gate is answered as it is, not refused", async () => {
    const { library, avatar } = await importedAvatar();
    const weak = await library.addPhoto(avatar.id, PNG_1X1, portraitMeta(1, 0.4));
    await library.updateAvatar(avatar.id, { masterPhotoId: weak.id });
    expect((await library.switchMaster(avatar.id, weak.id)).masterPhotoId).toBe(weak.id);
  });
});

describe("switchMaster commits before it cleans up (I5.18)", () => {
  test("a crash while the manifest is written leaves the old master and every portrait", async () => {
    const crash = new Error("crash before the manifest's rename");
    let armed = false;
    const beforeRename = (finalPath: string): void => {
      if (armed && finalPath.endsWith("avatar.json")) throw crash;
    };
    const { library, avatar, source, p1, p2, p3 } = await withPortraits({ testHooks: { beforeRename } });
    armed = true;

    expect(await rejectionOf(library.switchMaster(avatar.id, p2.id))).toBe(crash);

    expect(library.getAvatar(avatar.id)?.masterPhotoId).toBe(source.id);
    expect((await manifestOnDisk(avatar.id)).masterPhotoId).toBe(source.id);
    expect(idsOf(library.portraitCandidates(avatar.id))).toEqual([p1.id, p2.id, p3.id]);
    const files = await readdir(photosDir(avatar.id));
    for (const photo of [source, p1, p2, p3]) expect(files).toContain(photo.file);

    const reopened = await openLibrary(root(), deps());
    expect(reopened.library.referencePhoto(avatar.id)?.photo.id).toBe(source.id);
  });

  test("a removal that fails after the commit still answers with the new manifest, and memory and disk name the new master", async () => {
    const { library, avatar, p1, p2, p3 } = await withPortraits();
    await makeUnremovable(avatar.id, p2);

    const manifest = await library.switchMaster(avatar.id, p1.id);

    expect(manifest.masterPhotoId).toBe(p1.id);
    expect(library.getAvatar(avatar.id)?.masterPhotoId).toBe(p1.id);
    expect((await manifestOnDisk(avatar.id)).masterPhotoId).toBe(p1.id);
    expect(library.referencePhoto(avatar.id)?.photo).toEqual(p1);
    expect(library.getPhoto(p1.id)).toEqual(p1);
    // The portrait that could not be removed is a leftover pending candidate, listed and removable later; the one that could be removed is gone.
    expect(idsOf(library.portraitCandidates(avatar.id))).toEqual([p2.id]);
    expect(library.getPhoto(p3.id)).toBeUndefined();
  });

  test("a failed removal is reported by its error code only, never by a path or a name", async () => {
    const reported: string[] = [];
    const { library, avatar, p1, p2 } = await withPortraits({ onPortraitCleanupFailure: (code) => void reported.push(code) });
    await makeUnremovable(avatar.id, p2);

    await library.switchMaster(avatar.id, p1.id);

    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatch(/^[A-Z_0-9]+$/);
    expect(reported[0]).not.toContain(avatar.id);
    expect(reported[0]).not.toContain(p2.id);
  });

  test("memory already names the new master when a failed cleanup is reported (it is updated at the commit, not after the cleanup)", async () => {
    let masterSeen: string | null | undefined;
    let libraryRef: Library | undefined;
    const rig = await withPortraits({
      onPortraitCleanupFailure: () => {
        masterSeen = libraryRef?.getAvatar(rig.avatar.id)?.masterPhotoId;
      },
    });
    libraryRef = rig.library;
    await makeUnremovable(rig.avatar.id, rig.p2);

    await rig.library.switchMaster(rig.avatar.id, rig.p1.id);

    expect(masterSeen).toBe(rig.p1.id);
  });

  test("a leftover is removed by the next discard", async () => {
    const { library, avatar, p1, p2 } = await withPortraits();
    await makeUnremovable(avatar.id, p2);
    await library.switchMaster(avatar.id, p1.id);
    // The lock is gone (the antivirus let go).
    await rm(join(photosDir(avatar.id), `${p2.id}.json`), { recursive: true });

    expect(await library.discardPortraitCandidates(avatar.id)).toBe(1);

    expect(library.portraitCandidates(avatar.id)).toEqual([]);
  });
});

describe("discardPortraitCandidates", () => {
  test("removes every pending portrait and says how many", async () => {
    const { library, avatar, p1, p2, p3 } = await withPortraits();

    const removed = await library.discardPortraitCandidates(avatar.id);

    expect(removed).toBe(3);
    expect(library.portraitCandidates(avatar.id)).toEqual([]);
    const files = await readdir(photosDir(avatar.id));
    for (const gone of [p1, p2, p3]) {
      expect(files).not.toContain(gone.file);
      expect(files).not.toContain(`${gone.id}.json`);
    }
  });

  test("keeps the master when the master is a portrait", async () => {
    const { library, avatar, p1 } = await withPortraits();
    await library.switchMaster(avatar.id, p1.id);
    await library.addPhoto(avatar.id, PNG_1X1, portraitMeta(4, 0.7));

    expect(await library.discardPortraitCandidates(avatar.id)).toBe(1);

    expect(library.referencePhoto(avatar.id)?.photo).toEqual(p1);
  });

  test("keeps the imported photo, run photos and another avatar's portraits", async () => {
    const { library, avatar, source, runPhoto, otherPhoto } = await withPortraits();

    await library.discardPortraitCandidates(avatar.id);

    expect(library.getPhoto(source.id)).toEqual(source);
    expect(library.getPhoto(runPhoto.id)).toEqual(runPhoto);
    expect(library.getPhoto(otherPhoto.id)).toEqual(otherPhoto);
    expect(library.referencePhoto(avatar.id)?.photo).toEqual(source);
  });

  test("answers 0 when there is nothing to discard", async () => {
    const { library, avatar } = await importedAvatar();
    expect(await library.discardPortraitCandidates(avatar.id)).toBe(0);
  });

  test("refuses an unknown avatar", async () => {
    const { library } = await importedAvatar();
    await expectLibraryError(library.discardPortraitCandidates("unknown-avatar"), "avatar-not-found");
  });

  test("a removal that fails is not hidden: the call rejects and the master stays", async () => {
    const { library, avatar, source, p2 } = await withPortraits();
    await makeUnremovable(avatar.id, p2);

    await rejectionOf(library.discardPortraitCandidates(avatar.id));

    expect(library.referencePhoto(avatar.id)?.photo).toEqual(source);
    expect(library.getPhoto(p2.id)).toEqual(p2);
  });
});

describe("loadReference and loadOriginal of the source (invariant 9 stays: the library is the only mint)", () => {
  async function withPortraitMaster(extra: LibraryDeps = {}) {
    const rig = await withPortraits(extra);
    await rig.library.switchMaster(rig.avatar.id, rig.p1.id);
    return rig;
  }

  test("loadReference defaults to the master", async () => {
    const seen: Uint8Array[] = [];
    const { library, avatar } = await withPortraitMaster({ downscaleReference: async (bytes) => (seen.push(bytes), Uint8Array.from([7])) });

    await library.loadReference(avatar.id);

    expect(seen).toEqual([PNG_1X1]);
  });

  test("loadReference of the source downscales the imported photo, not the portrait master", async () => {
    const seen: Uint8Array[] = [];
    const marker = Uint8Array.from([9, 9]);
    const { library, avatar } = await withPortraitMaster({ downscaleReference: async (bytes) => (seen.push(bytes), marker) });

    const loaded = await library.loadReference(avatar.id, undefined, "source");

    expect(loaded).toEqual(marker as NonNullable<typeof loaded>);
    expect(seen).toEqual([JPEG_HEADER_ONLY]);
  });

  test("loadReference of the source passes the abort signal on", async () => {
    let received: AbortSignal | undefined;
    const { library, avatar } = await withPortraitMaster({ downscaleReference: async (bytes, signal) => ((received = signal), bytes) });
    const controller = new AbortController();

    await library.loadReference(avatar.id, controller.signal, "source");

    expect(received).toBe(controller.signal);
  });

  test("loadReference of the source checks the sidecar's size before downscaling", async () => {
    let calls = 0;
    const { library, avatar, source } = await withPortraitMaster({ downscaleReference: async (bytes) => (calls++, bytes) });
    await writeFile(join(photosDir(avatar.id), source.file), Buffer.concat([Buffer.from(JPEG_HEADER_ONLY), Buffer.from([0])]));

    await expectLibraryError(library.loadReference(avatar.id, undefined, "source"), "reference-corrupt");
    expect(calls).toBe(0);
  });

  test("loadReference of the source checks the sidecar's sha256 before downscaling", async () => {
    let calls = 0;
    const { library, avatar, source } = await withPortraitMaster({ downscaleReference: async (bytes) => (calls++, bytes) });
    const rotted = Buffer.from(JPEG_HEADER_ONLY);
    rotted[rotted.length - 1] = (rotted[rotted.length - 1] ?? 0) ^ 0xff;
    await writeFile(join(photosDir(avatar.id), source.file), rotted);

    await expectLibraryError(library.loadReference(avatar.id, undefined, "source"), "reference-corrupt");
    expect(calls).toBe(0);
  });

  test("loadReference of the source falls back to the master for a wizard avatar", async () => {
    const seen: Uint8Array[] = [];
    const { library } = await openLibrary(root(), deps({ downscaleReference: async (bytes) => (seen.push(bytes), bytes) }));
    const mia = await library.createAvatar(SAMPLE_AVATAR);
    const master = await library.addPhoto(mia.id, PNG_1X1, samplePhotoMeta());
    await library.updateAvatar(mia.id, { masterPhotoId: master.id, status: "active" });

    await library.loadReference(mia.id, undefined, "source");

    expect(seen).toEqual([PNG_1X1]);
  });

  describe("a portrait master whose source photo is gone (I5.20: never a silent fallback to the portrait)", () => {
    async function sourceLost() {
      const rig = await withPortraitMaster();
      await rm(join(photosDir(rig.avatar.id), `${rig.source.id}.json`));
      const reopened = await openLibrary(root(), deps());
      expect(reopened.library.sourcePhoto(rig.avatar.id)).toBeNull();
      return { library: reopened.library, avatar: rig.avatar };
    }

    test("loadReference of the source refuses with source-unavailable", async () => {
      const { library, avatar } = await sourceLost();
      await expectLibraryError(library.loadReference(avatar.id, undefined, "source"), "source-unavailable");
    });

    test("loadOriginal of the source refuses with source-unavailable", async () => {
      const { library, avatar } = await sourceLost();
      await expectLibraryError(library.loadOriginal(avatar.id, "source"), "source-unavailable");
    });

    test("the master reads still work", async () => {
      const { library, avatar } = await sourceLost();
      expect(await library.loadOriginal(avatar.id, "master")).toEqual(PNG_1X1);
    });
  });

  test("loadReference of the source is null while there is no usable master, like the master's", async () => {
    const { library } = await openLibrary(root(), deps());
    const draft = await library.createAvatar(SAMPLE_AVATAR);
    expect(await library.loadReference(draft.id, undefined, "source")).toBeNull();
    expect(await library.loadReference("unknown-avatar", undefined, "source")).toBeNull();
  });

  test("loadOriginal of the source is the imported photo's raw bytes, and of the master the portrait's", async () => {
    const { library, avatar } = await withPortraitMaster();
    expect(await library.loadOriginal(avatar.id, "source")).toEqual(JPEG_HEADER_ONLY);
    expect(await library.loadOriginal(avatar.id, "master")).toEqual(PNG_1X1);
    expect(await library.loadOriginal(avatar.id)).toEqual(PNG_1X1);
  });

  test("loadOriginal of the source checks the sidecar like the master's", async () => {
    const { library, avatar, source } = await withPortraitMaster();
    await writeFile(join(photosDir(avatar.id), source.file), Buffer.from([1, 2, 3]));
    await expectLibraryError(library.loadOriginal(avatar.id, "source"), "reference-corrupt");
  });

  test("loadOriginal of the source falls back to the master for a wizard avatar, and is null with no master", async () => {
    const { library } = await openLibrary(root(), deps());
    const mia = await library.createAvatar(SAMPLE_AVATAR);
    expect(await library.loadOriginal(mia.id, "source")).toBeNull();
    const master = await library.addPhoto(mia.id, PNG_1X1, samplePhotoMeta());
    await library.updateAvatar(mia.id, { masterPhotoId: master.id, status: "active" });
    expect(await library.loadOriginal(mia.id, "source")).toEqual(PNG_1X1);
  });

  test("loadMasterOriginal is still the master's raw bytes", async () => {
    const { library, avatar } = await withPortraitMaster();
    expect(await library.loadMasterOriginal(avatar.id)).toEqual(PNG_1X1);
  });
});
