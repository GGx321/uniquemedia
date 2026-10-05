import { describe, expect, test } from "bun:test";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openLibrary } from "./library";
import {
  PNG_1X1,
  SAMPLE_AVATAR,
  expectLibraryError,
  samplePhotoMeta,
  sequentialIds,
  steppingClock,
  useTempDir,
} from "./testing/helpers";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

const root = useTempDir("studio-open-");

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

describe("openLibrary", () => {
  test("turns an empty folder into a library and reports it empty", async () => {
    const { library, report } = await openLibrary(root(), { now: steppingClock("2026-09-24T10:00:00.000Z") });

    expect(await readJson(join(root(), "library.json"))).toEqual({
      schemaVersion: 1,
      createdAt: "2026-09-24T10:00:00.000Z",
    });
    expect(report).toEqual({ avatars: 0, photos: 0, quarantined: [], masterIssues: [], logIssues: [] });
    // Review (real bug, canary run 36272376999): a deleted-then-recreated
    // folder can share the original's canonical path AND dev:ino on Linux
    // (a freed inode is routinely reused) — folderIdentity alone cannot
    // tell them apart. Library.createdAt is the fingerprint the engine
    // checks in addition: a fresh folder has none at all, an unrelated
    // library has a different one.
    expect(library.createdAt).toBe("2026-09-24T10:00:00.000Z");
  });

  test("createdAt is the folder's own library.json, whoever opens it and however many times", async () => {
    const first = await openLibrary(root(), { now: steppingClock("2026-09-24T10:00:00.000Z") });
    const second = await openLibrary(root(), { now: steppingClock("2027-01-01T00:00:00.000Z") });

    expect(first.library.createdAt).toBe("2026-09-24T10:00:00.000Z");
    // Re-opening an existing library reads its own recorded createdAt, never the re-opener's clock.
    expect(second.library.createdAt).toBe("2026-09-24T10:00:00.000Z");
  });

  test("treats a folder holding only OS metadata files as empty", async () => {
    await writeFile(join(root(), ".DS_Store"), "x");
    await writeFile(join(root(), "Thumbs.db"), "x");
    await writeFile(join(root(), "desktop.ini"), "x");

    await openLibrary(root());

    expect(await readJson(join(root(), "library.json"))).toMatchObject({ schemaVersion: 1 });
  });

  test("refuses a non-empty folder without library.json and leaves it untouched", async () => {
    await writeFile(join(root(), "holiday.jpg"), "x");

    await expectLibraryError(openLibrary(root()), "not-a-library");

    expect((await readdir(root())).sort()).toEqual(["holiday.jpg"]);
  });

  test("refuses a folder with only an unrelated subfolder", async () => {
    await mkdir(join(root(), "Documents"));
    await expectLibraryError(openLibrary(root()), "not-a-library");
  });

  test("refuses a library.json that is not JSON", async () => {
    await writeFile(join(root(), "library.json"), "{ nope");
    await expectLibraryError(openLibrary(root()), "invalid-library-file");
  });

  test("refuses a library.json from a newer schema version as too new", async () => {
    await writeFile(
      join(root(), "library.json"),
      JSON.stringify({ schemaVersion: 2, createdAt: "2026-09-24T10:00:00.000Z" })
    );
    await expectLibraryError(openLibrary(root()), "library-too-new");
  });

  test("refuses a library.json with a schema version that never existed as invalid", async () => {
    await writeFile(
      join(root(), "library.json"),
      JSON.stringify({ schemaVersion: 0, createdAt: "2026-09-24T10:00:00.000Z" })
    );
    await expectLibraryError(openLibrary(root()), "invalid-library-file");
  });

  test("a leftover temp of a crashed library.json write does not make the folder non-empty", async () => {
    await writeFile(join(root(), ".library.json.0a1b2c3d4e5f.tmp"), '{"schemaVersion":1,');

    const { report } = await openLibrary(root());

    expect(await readJson(join(root(), "library.json"))).toMatchObject({ schemaVersion: 1 });
    expect(report.quarantined.map((q) => [q.from, q.reason])).toEqual([[".library.json.0a1b2c3d4e5f.tmp", "temp-file"]]);
  });

  // T6c review round 3, L8: a crash during the (since removed, 2026-10-05)
  // refused-imports write left the exact same shape of leftover as
  // library.json's own — isLibraryFileTemp still recognises it, or an old
  // library's leftover sits at the root forever instead of being quarantined
  // like every other crash leftover.
  test("a leftover temp of a crashed refused-imports.json write does not make the folder non-empty either", async () => {
    await writeFile(join(root(), ".refused-imports.json.0a1b2c3d4e5f.tmp"), '{"schemaVersion":1,');

    const { report } = await openLibrary(root());

    expect(await readJson(join(root(), "library.json"))).toMatchObject({ schemaVersion: 1 });
    expect(report.quarantined.map((q) => [q.from, q.reason])).toEqual([[".refused-imports.json.0a1b2c3d4e5f.tmp", "temp-file"]]);
  });

  test("another dotted temp file still makes the folder non-empty", async () => {
    await writeFile(join(root(), ".notes.tmp"), "x");
    await expectLibraryError(openLibrary(root()), "not-a-library");
  });

  test("reopening keeps the original library.json", async () => {
    await openLibrary(root(), { now: steppingClock("2026-01-01T00:00:00.000Z") });
    await openLibrary(root(), { now: steppingClock("2026-09-24T10:00:00.000Z") });

    expect(await readJson(join(root(), "library.json"))).toEqual({
      schemaVersion: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  });
});

/** Every path under `dir`, sorted — to prove a refused open changed nothing. */
async function tree(dir: string): Promise<string[]> {
  return (await readdir(dir, { recursive: true })).map(String).sort();
}

describe("downgrade protection", () => {
  test("a manifest from a newer schema version refuses the whole library and touches nothing", async () => {
    const { library } = await openLibrary(root(), { newId: sequentialIds() });
    const mia = await library.createAvatar(SAMPLE_AVATAR);
    const lena = await library.createAvatar({ ...SAMPLE_AVATAR, name: "Lena" });
    // Something the open would otherwise quarantine, in the avatar scanned first.
    await writeFile(join(root(), "avatars", mia.id, "photos", "orphan-0001.png"), PNG_1X1);
    const manifestPath = join(root(), "avatars", lena.id, "avatar.json");
    await writeFile(manifestPath, JSON.stringify({ ...lena, schemaVersion: 3, newField: true }));
    const before = await tree(root());

    await expectLibraryError(openLibrary(root()), "library-too-new");

    expect(await tree(root())).toEqual(before);
    expect(await readJson(manifestPath)).toMatchObject({ schemaVersion: 3, newField: true });
  });

  test("a library whose manifests an earlier build wrote (v1, text-only traits) opens as it is, nothing moved", async () => {
    const { library } = await openLibrary(root(), { newId: sequentialIds() });
    const mia = await library.createAvatar(SAMPLE_AVATAR);
    const manifestPath = join(root(), "avatars", mia.id, "avatar.json");
    await writeFile(manifestPath, JSON.stringify({ ...mia, schemaVersion: 1 }));
    const before = await tree(root());

    const reopened = await openLibrary(root());

    expect(reopened.library.getAvatar(mia.id)).toMatchObject({ schemaVersion: 1, traits: SAMPLE_AVATAR.traits });
    expect(reopened.report.quarantined).toEqual([]);
    expect(await tree(root())).toEqual(before);
  });

  test("a photo sidecar from a newer schema version refuses the library and touches nothing", async () => {
    const { library } = await openLibrary(root(), { newId: sequentialIds() });
    const mia = await library.createAvatar(SAMPLE_AVATAR);
    const photo = await library.addPhoto(mia.id, PNG_1X1, samplePhotoMeta());
    const sidecarPath = join(root(), "avatars", mia.id, "photos", `${photo.id}.json`);
    await writeFile(sidecarPath, JSON.stringify({ ...photo, schemaVersion: 3 }));
    await writeFile(join(root(), "avatars", mia.id, "photos", "orphan-0001.png"), PNG_1X1);
    const before = await tree(root());

    await expectLibraryError(openLibrary(root()), "library-too-new");

    expect(await tree(root())).toEqual(before);
  });
});
