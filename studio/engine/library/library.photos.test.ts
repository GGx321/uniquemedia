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
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

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
