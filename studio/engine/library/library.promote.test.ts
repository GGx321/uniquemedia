import { describe, expect, test } from "bun:test";
import { chmod, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { openLibrary, type LibraryDeps } from "./library";
import { expectLibraryError, PNG_1X1, SAMPLE_AVATAR, samplePhotoMeta, sequentialIds, steppingClock, useTempDir } from "./testing/helpers";

const root = useTempDir("studio-promote-");

function deps(extra: LibraryDeps = {}): LibraryDeps {
  return { now: steppingClock(), newId: sequentialIds(), ...extra };
}

/** A draft (test-id-0001) with three candidates (test-id-0002..0004), and another avatar (test-id-0005) with a photo (test-id-0006). */
async function draftWithCandidates(extra: LibraryDeps = {}) {
  const { library } = await openLibrary(root(), deps(extra));
  const draft = await library.createAvatar(SAMPLE_AVATAR);
  const candidates = [
    await library.addPhoto(draft.id, PNG_1X1, samplePhotoMeta()),
    await library.addPhoto(draft.id, PNG_1X1, samplePhotoMeta()),
    await library.addPhoto(draft.id, PNG_1X1, samplePhotoMeta()),
  ];
  const other = await library.createAvatar({ ...SAMPLE_AVATAR, name: "Lena" });
  const otherPhoto = await library.addPhoto(other.id, PNG_1X1, samplePhotoMeta());
  const avatarDir = join(root(), "avatars", draft.id);
  return { library, draft, candidates, other, otherPhoto, avatarDir, photosDir: join(avatarDir, "photos") };
}

function filesOf(photos: { id: string; file: string }[]): string[] {
  return photos.flatMap((p) => [p.file, `${p.id}.json`]).sort();
}

describe("promoteDraft", () => {
  test("makes the draft active with the chosen master and name, and deletes every other photo", async () => {
    const { library, draft, candidates, avatarDir, photosDir } = await draftWithCandidates();
    const chosen = candidates[1];
    if (chosen === undefined) throw new Error("expected a candidate");

    const manifest = await library.promoteDraft(draft.id, { masterPhotoId: chosen.id, name: "Mia" });

    expect(manifest).toMatchObject({ id: draft.id, status: "active", masterPhotoId: chosen.id, name: "Mia" });
    expect(JSON.parse(await readFile(join(avatarDir, "avatar.json"), "utf8"))).toEqual(manifest);
    expect(library.getAvatar(draft.id)).toEqual(manifest);
    expect(library.photosByAvatar(draft.id)).toEqual([chosen]);
    expect((await readdir(photosDir)).sort()).toEqual(filesOf([chosen]));
    expect(library.referencePhoto(draft.id)?.photo).toEqual(chosen);
  });

  test("a manifest the schema refuses is found before anything is deleted: every candidate stays, still a draft", async () => {
    const { library, draft, candidates, photosDir } = await draftWithCandidates();

    await expectLibraryError(library.promoteDraft(draft.id, { masterPhotoId: candidates[0]?.id ?? "", name: "" }), "invalid-record");

    expect(library.getAvatar(draft.id)?.status).toBe("draft");
    expect(library.photosByAvatar(draft.id)).toEqual(candidates);
    expect((await readdir(photosDir)).sort()).toEqual(filesOf(candidates));
  });

  test.skipIf(process.platform === "win32")("a manifest that cannot be written is found before anything is deleted: every candidate stays, still a draft", async () => {
    const { library, draft, candidates, avatarDir, photosDir } = await draftWithCandidates();
    // The avatar's folder refuses new files (the new manifest's temp); its photos folder does not.
    await chmod(avatarDir, 0o555);
    try {
      await expect(library.promoteDraft(draft.id, { masterPhotoId: candidates[0]?.id ?? "", name: "Mia" })).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      await chmod(avatarDir, 0o755);
    }

    expect(library.getAvatar(draft.id)?.status).toBe("draft");
    expect(library.photosByAvatar(draft.id)).toEqual(candidates);
    expect((await readdir(photosDir)).sort()).toEqual(filesOf(candidates));
  });

  test("a crash before the new manifest is renamed into place leaves a draft with only the chosen photo, which can be promoted again", async () => {
    const crash = new Error("crash before the manifest's rename");
    const { draft, candidates } = await draftWithCandidates();
    const chosen = candidates[2];
    if (chosen === undefined) throw new Error("expected a candidate");
    const beforeRename = (finalPath: string): void => {
      if (finalPath.endsWith("avatar.json")) throw crash;
    };
    const crashing = await openLibrary(root(), deps({ testHooks: { beforeRename } }));
    await expect(crashing.library.promoteDraft(draft.id, { masterPhotoId: chosen.id, name: "Mia" })).rejects.toBe(crash);

    const { library, report } = await openLibrary(root(), deps());

    expect(library.getAvatar(draft.id)?.status).toBe("draft");
    expect(library.photosByAvatar(draft.id).map((p) => p.id)).toEqual([chosen.id]);
    expect(report.quarantined.every((q) => q.reason === "temp-file")).toBe(true);
    expect(await library.promoteDraft(draft.id, { masterPhotoId: chosen.id, name: "Mia" })).toMatchObject({ status: "active", masterPhotoId: chosen.id });
  });

  test("refuses a photo of another avatar and an avatar that is not a draft, deleting nothing", async () => {
    const { library, draft, candidates, other, otherPhoto } = await draftWithCandidates();

    await expectLibraryError(library.promoteDraft(draft.id, { masterPhotoId: otherPhoto.id, name: "Mia" }), "photo-not-found");
    await library.updateAvatar(other.id, { status: "active", masterPhotoId: otherPhoto.id });
    await expectLibraryError(library.promoteDraft(other.id, { masterPhotoId: otherPhoto.id, name: "Lena" }), "not-a-draft");

    expect(library.photosByAvatar(draft.id)).toEqual(candidates);
    expect(library.photosByAvatar(other.id)).toEqual([otherPhoto]);
  });

  test("refuses an unknown avatar", async () => {
    const { library, candidates } = await draftWithCandidates();

    await expectLibraryError(library.promoteDraft("unknown-avatar", { masterPhotoId: candidates[0]?.id ?? "", name: "Mia" }), "avatar-not-found");
  });
});

describe("a crash in the middle of deletePhoto", () => {
  test("leaves an image without its sidecar, which the next open quarantines; the draft keeps its other candidates and can be promoted", async () => {
    const { draft, candidates, photosDir } = await draftWithCandidates();
    const [kept, dropped, alsoKept] = candidates;
    if (kept === undefined || dropped === undefined || alsoKept === undefined) throw new Error("expected three candidates");
    // What deletePhoto leaves when the process dies between its two removals: the sidecar (the commit) gone, the image still there.
    await rm(join(photosDir, `${dropped.id}.json`));

    const { library, report } = await openLibrary(root(), deps());

    expect(report.quarantined).toMatchObject([{ reason: "orphan-image", from: join("avatars", draft.id, "photos", dropped.file) }]);
    expect(library.photosByAvatar(draft.id).map((p) => p.id)).toEqual([kept.id, alsoKept.id]);
    expect(await library.promoteDraft(draft.id, { masterPhotoId: kept.id, name: "Mia" })).toMatchObject({ status: "active", masterPhotoId: kept.id });
    expect((await readdir(photosDir)).sort()).toEqual(filesOf([kept]));
  });
});
