import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { openLibrary, type LibraryDeps } from "./library";
import type { PhotoSidecar } from "./schemas";
import {
  JPEG_HEADER_ONLY,
  PNG_1X1,
  SAMPLE_AVATAR,
  SAMPLE_SOURCE,
  expectLibraryError,
  rejectionOf,
  samplePhotoMeta,
  sequentialIds,
  steppingClock,
  useTempDir,
} from "./testing/helpers";

const root = useTempDir("studio-photos-");

function deps(extra: LibraryDeps = {}): LibraryDeps {
  return { now: steppingClock(), newId: sequentialIds(), ...extra };
}

/** A library with one avatar (test-id-0001) and one committed photo (test-id-0002). */
async function libraryWithOnePhoto() {
  const { library } = await openLibrary(root(), deps());
  const avatar = await library.createAvatar(SAMPLE_AVATAR);
  const photo = await library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta());
  const photosDir = join(root(), "avatars", avatar.id, "photos");
  return { library, avatar, photo, photosDir };
}

describe("addPhoto", () => {
  test("stores the image and a sidecar describing it, and indexes it", async () => {
    let clock = new Date("2026-01-01T00:00:00.000Z");
    const { library } = await openLibrary(root(), deps({ now: () => clock }));
    const avatar = await library.createAvatar(SAMPLE_AVATAR);
    clock = new Date("2026-09-24T12:00:00.000Z");

    const photo = await library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta({ width: 1, height: 1 }));

    const expected: PhotoSidecar = {
      schemaVersion: 1,
      id: "test-id-0002",
      avatarId: "test-id-0001",
      file: "test-id-0002.png",
      mediaType: "image/png",
      width: 1,
      height: 1,
      bytes: PNG_1X1.length,
      sha256: createHash("sha256").update(PNG_1X1).digest("hex"),
      source: SAMPLE_SOURCE,
      qa: {},
      createdAt: "2026-09-24T12:00:00.000Z",
    };
    expect(photo).toEqual(expected);
    const photosDir = join(root(), "avatars", avatar.id, "photos");
    expect(new Uint8Array(await readFile(join(photosDir, "test-id-0002.png")))).toEqual(PNG_1X1);
    expect(JSON.parse(await readFile(join(photosDir, "test-id-0002.json"), "utf8"))).toEqual(expected);
    expect(library.getPhoto("test-id-0002")).toEqual(expected);
  });

  test("commits the image before the sidecar", async () => {
    const renames: string[] = [];
    const { library } = await openLibrary(
      root(),
      deps({ testHooks: { beforeRename: (finalPath) => void renames.push(finalPath) } })
    );
    const avatar = await library.createAvatar(SAMPLE_AVATAR);
    renames.length = 0;

    await library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta());

    const photosDir = join(root(), "avatars", avatar.id, "photos");
    expect(renames).toEqual([join(photosDir, "test-id-0002.png"), join(photosDir, "test-id-0002.json")]);
  });

  test("a crash after the image rename and before the sidecar leaves an orphan that the next open quarantines", async () => {
    const crash = new Error("simulated crash");
    const { library } = await openLibrary(
      root(),
      deps({
        testHooks: {
          beforeRename: (finalPath) => {
            if (finalPath.includes(`${sep}photos${sep}`) && finalPath.endsWith(".json")) throw crash;
          },
        },
      })
    );
    const avatar = await library.createAvatar(SAMPLE_AVATAR);

    expect(await rejectionOf(library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta()))).toBe(crash);
    expect(library.getPhoto("test-id-0002")).toBeUndefined();

    const reopened = await openLibrary(root(), deps());

    expect(reopened.library.getPhoto("test-id-0002")).toBeUndefined();
    expect(reopened.report.photos).toBe(0);
    const reasons = reopened.report.quarantined.map((q) => q.reason).sort();
    expect(reasons).toEqual(["orphan-image", "temp-file"]);
    const orphan = reopened.report.quarantined.find((q) => q.reason === "orphan-image");
    expect(orphan?.from).toBe(join("avatars", avatar.id, "photos", "test-id-0002.png"));
    expect(new Uint8Array(await readFile(join(root(), orphan?.to ?? "missing")))).toEqual(PNG_1X1);
    expect(await readdir(join(root(), "avatars", avatar.id, "photos"))).toEqual([]);
  });

  test("refuses bytes that are not the declared media type and writes nothing", async () => {
    const { library } = await openLibrary(root(), deps());
    const avatar = await library.createAvatar(SAMPLE_AVATAR);

    await expectLibraryError(
      library.addPhoto(avatar.id, JPEG_HEADER_ONLY, samplePhotoMeta({ mediaType: "image/png" })),
      "media-type-mismatch"
    );

    expect(await readdir(join(root(), "avatars", avatar.id, "photos"))).toEqual([]);
  });

  test("refuses bytes that are no known image at all", async () => {
    const { library } = await openLibrary(root(), deps());
    const avatar = await library.createAvatar(SAMPLE_AVATAR);
    const html = new TextEncoder().encode("<html><script>alert(1)</script></html>");

    await expectLibraryError(library.addPhoto(avatar.id, html, samplePhotoMeta()), "media-type-mismatch");
  });

  test("refuses an unknown avatar", async () => {
    const { library } = await openLibrary(root(), deps());
    await expectLibraryError(library.addPhoto("unknown-avatar", PNG_1X1, samplePhotoMeta()), "avatar-not-found");
  });

  test("refuses invalid metadata with invalid-record and writes nothing", async () => {
    const { library } = await openLibrary(root(), deps());
    const avatar = await library.createAvatar(SAMPLE_AVATAR);

    await expectLibraryError(
      library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta({ source: { ...SAMPLE_SOURCE, costMicros: 0.5 } })),
      "invalid-record"
    );

    expect(await readdir(join(root(), "avatars", avatar.id, "photos"))).toEqual([]);
  });

  test("a reopened library indexes committed photos and counts them", async () => {
    const { photo } = await libraryWithOnePhoto();

    const { library, report } = await openLibrary(root(), deps());

    expect(report.photos).toBe(1);
    expect(report.quarantined).toEqual([]);
    expect(library.getPhoto(photo.id)).toEqual(photo);
  });
});

describe("startup reconciliation of photos", () => {
  test("a sidecar whose image is missing is quarantined and not indexed", async () => {
    const { photo, photosDir } = await libraryWithOnePhoto();
    await rm(join(photosDir, photo.file));

    const { library, report } = await openLibrary(root(), deps());

    expect(library.getPhoto(photo.id)).toBeUndefined();
    expect(report.photos).toBe(0);
    expect(report.quarantined.map((q) => [q.from, q.reason])).toEqual([
      [join("avatars", photo.avatarId, "photos", `${photo.id}.json`), "orphan-sidecar"],
    ]);
    expect(await readdir(photosDir)).toEqual([]);
  });

  test("a sidecar that is not JSON is quarantined with its image and reported", async () => {
    const { photo, photosDir } = await libraryWithOnePhoto();
    await writeFile(join(photosDir, `${photo.id}.json`), '{"schemaVersion":1,');

    const { library, report } = await openLibrary(root(), deps());

    expect(library.getPhoto(photo.id)).toBeUndefined();
    const invalid = report.quarantined.find((q) => q.reason === "invalid-sidecar");
    expect(invalid?.from).toBe(join("avatars", photo.avatarId, "photos", `${photo.id}.json`));
    expect(invalid?.detail).toContain("not valid JSON");
    expect(report.quarantined.map((q) => q.reason).sort()).toEqual(["invalid-sidecar", "orphan-image"]);
    expect(await readdir(photosDir)).toEqual([]);
  });

  test("a sidecar recording a source other than a generated frame is quarantined", async () => {
    const { photo, photosDir } = await libraryWithOnePhoto();
    const tampered = { ...photo, source: { ...photo.source, kind: "user" } };
    await writeFile(join(photosDir, `${photo.id}.json`), JSON.stringify(tampered));

    const { library, report } = await openLibrary(root(), deps());

    expect(library.getPhoto(photo.id)).toBeUndefined();
    expect(report.quarantined.map((q) => q.reason).sort()).toEqual(["invalid-sidecar", "orphan-image"]);
  });

  test("a sidecar filed under another photo's name or another avatar is quarantined", async () => {
    const { photo, photosDir } = await libraryWithOnePhoto();
    await writeFile(join(photosDir, `${photo.id}.json`), JSON.stringify({ ...photo, avatarId: "other-avatar" }));

    const { library, report } = await openLibrary(root(), deps());

    expect(library.getPhoto(photo.id)).toBeUndefined();
    expect(report.quarantined.find((q) => q.reason === "invalid-sidecar")?.detail).toContain("other-avatar");
  });

  test("an image truncated to zero bytes under a valid sidecar is quarantined with its sidecar", async () => {
    const { photo, photosDir } = await libraryWithOnePhoto();
    await writeFile(join(photosDir, photo.file), new Uint8Array(0));

    const { library, report } = await openLibrary(root(), deps());

    expect(library.getPhoto(photo.id)).toBeUndefined();
    expect(report.quarantined.map((q) => [q.from, q.reason]).sort()).toEqual(
      [
        [join("avatars", photo.avatarId, "photos", `${photo.id}.json`), "invalid-image"],
        [join("avatars", photo.avatarId, "photos", photo.file), "invalid-image"],
      ].sort()
    );
    expect(report.quarantined[0].detail).toContain("bytes");
    expect(await readdir(photosDir)).toEqual([]);
  });

  test("an image with the right size but other bytes fails the hash and is quarantined", async () => {
    const { photo, photosDir } = await libraryWithOnePhoto();
    const tampered = new Uint8Array(PNG_1X1);
    tampered[tampered.length - 1] ^= 0xff;
    await writeFile(join(photosDir, photo.file), tampered);

    const { library, report } = await openLibrary(root(), deps());

    expect(library.getPhoto(photo.id)).toBeUndefined();
    expect(report.quarantined.map((q) => q.reason)).toEqual(["invalid-image", "invalid-image"]);
    expect(report.quarantined[0].detail).toContain("sha256");
  });

  test("a directory named like the image does not crash the open; it and its sidecar are quarantined", async () => {
    const { photo, photosDir } = await libraryWithOnePhoto();
    await rm(join(photosDir, photo.file));
    await mkdir(join(photosDir, photo.file));

    const { library, report } = await openLibrary(root(), deps());

    expect(library.getPhoto(photo.id)).toBeUndefined();
    expect(report.quarantined.map((q) => [q.from, q.reason]).sort()).toEqual(
      [
        [join("avatars", photo.avatarId, "photos", `${photo.id}.json`), "invalid-image"],
        [join("avatars", photo.avatarId, "photos", photo.file), "invalid-image"],
      ].sort()
    );
    expect(await readdir(photosDir)).toEqual([]);
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "an unreadable image is quarantined with its sidecar instead of failing the open",
    async () => {
      const { photo, photosDir } = await libraryWithOnePhoto();
      await chmod(join(photosDir, photo.file), 0o000);

      const { library, report } = await openLibrary(root(), deps());

      expect(library.getPhoto(photo.id)).toBeUndefined();
      expect(report.quarantined.map((q) => q.reason)).toEqual(["invalid-image", "invalid-image"]);
      expect(report.quarantined[0].detail).toContain("EACCES");
    }
  );

  test("an image symlink pointing outside the library is not a photo, even with a matching sha256", async () => {
    const { library, avatar, photo, photosDir } = await libraryWithOnePhoto();
    await library.updateAvatar(avatar.id, { masterPhotoId: photo.id, status: "active" });
    const outside = await mkdtemp(join(tmpdir(), "studio-outside-"));
    try {
      const outsideImage = join(outside, "same-bytes.png");
      await writeFile(outsideImage, PNG_1X1);
      await rm(join(photosDir, photo.file));
      await symlink(outsideImage, join(photosDir, photo.file));

      const { library: reopened, report } = await openLibrary(root(), deps());

      expect(reopened.getPhoto(photo.id)).toBeUndefined();
      expect(reopened.referencePhoto(avatar.id)).toBeNull();
      expect(report.quarantined.map((q) => q.reason)).toEqual(["invalid-image", "invalid-image"]);
      expect(new Uint8Array(await readFile(outsideImage))).toEqual(PNG_1X1);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("files that are not library records are left where they are", async () => {
    const { photo, photosDir } = await libraryWithOnePhoto();
    await writeFile(join(photosDir, ".DS_Store"), "x");
    await writeFile(join(photosDir, "notes.txt"), "x");

    const { library, report } = await openLibrary(root(), deps());

    expect(report.quarantined).toEqual([]);
    expect(library.getPhoto(photo.id)).toEqual(photo);
    expect((await readdir(photosDir)).sort()).toEqual(
      [".DS_Store", `${photo.id}.json`, photo.file, "notes.txt"].sort()
    );
  });
});

describe("master photo", () => {
  test("can be set to one of the avatar's own photos", async () => {
    const { library, avatar, photo } = await libraryWithOnePhoto();

    await library.updateAvatar(avatar.id, { masterPhotoId: photo.id });

    const reopened = await openLibrary(root(), deps());
    expect(reopened.library.getAvatar(avatar.id)?.masterPhotoId).toBe(photo.id);
  });

  test("cannot point at a photo the library does not hold", async () => {
    const { library, avatar } = await libraryWithOnePhoto();
    await expectLibraryError(library.updateAvatar(avatar.id, { masterPhotoId: "not-a-photo" }), "photo-not-found");
    expect(library.getAvatar(avatar.id)?.masterPhotoId).toBeNull();
  });

  test("cannot point at another avatar's photo", async () => {
    const { library, photo } = await libraryWithOnePhoto();
    const other = await library.createAvatar({ ...SAMPLE_AVATAR, name: "Lena" });

    await expectLibraryError(library.updateAvatar(other.id, { masterPhotoId: photo.id }), "photo-not-found");
  });
});
