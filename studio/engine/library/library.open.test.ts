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

const root = useTempDir("studio-open-");

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

describe("openLibrary", () => {
  test("turns an empty folder into a library and reports it empty", async () => {
    const { report } = await openLibrary(root(), { now: steppingClock("2026-09-24T10:00:00.000Z") });

    expect(await readJson(join(root(), "library.json"))).toEqual({
      schemaVersion: 1,
      createdAt: "2026-09-24T10:00:00.000Z",
    });
    expect(report).toEqual({ avatars: 0, photos: 0, quarantined: [], masterIssues: [], logIssues: [] });
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
    await writeFile(manifestPath, JSON.stringify({ ...lena, schemaVersion: 2, newField: true }));
    const before = await tree(root());

    await expectLibraryError(openLibrary(root()), "library-too-new");

    expect(await tree(root())).toEqual(before);
    expect(await readJson(manifestPath)).toMatchObject({ schemaVersion: 2, newField: true });
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
