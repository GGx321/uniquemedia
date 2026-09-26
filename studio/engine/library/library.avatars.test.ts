import { describe, expect, test } from "bun:test";
import { cp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openLibrary, type LibraryDeps, type NewAvatar } from "./library";
import type { AvatarManifest, AvatarStatus } from "./schemas";
import {
  PNG_1X1,
  expectLibraryError,
  samplePhotoMeta,
  rejectionOf,
  sequentialIds,
  steppingClock,
  tempFilesIn,
  useTempDir,
} from "./testing/helpers";

const root = useTempDir("studio-avatars-");

const MIA: NewAvatar = {
  name: "Mia",
  age: 25,
  traits: { hair: "chestnut", eyes: "hazel" },
  descriptor: "a 25-year-old woman with hazel eyes and chestnut hair",
};

function deps(extra: LibraryDeps = {}): LibraryDeps {
  return { now: steppingClock(), newId: sequentialIds("avatar"), ...extra };
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

describe("createAvatar", () => {
  test("writes a draft manifest with a generated id, the clock's time and no master yet", async () => {
    let clock = new Date("2026-01-01T00:00:00.000Z");
    const { library } = await openLibrary(root(), deps({ now: () => clock }));
    clock = new Date("2026-09-24T12:34:56.000Z");

    const avatar = await library.createAvatar(MIA);

    const expected: AvatarManifest = {
      schemaVersion: 2,
      id: "avatar-0001",
      ...MIA,
      masterPhotoId: null,
      status: "draft",
      createdAt: "2026-09-24T12:34:56.000Z",
    };
    expect(avatar).toEqual(expected);
    expect(await readJson(join(root(), "avatars", "avatar-0001", "avatar.json"))).toEqual(expected);
    expect(library.getAvatar("avatar-0001")).toEqual(expected);
  });

  test("keeps a list-valued trait a list on disk", async () => {
    const { library } = await openLibrary(root(), deps());
    await library.createAvatar({ ...MIA, traits: { marks: ["freckles", "mole"], vibe: "coffee" } });
    expect(await readJson(join(root(), "avatars", "avatar-0001", "avatar.json"))).toMatchObject({
      schemaVersion: 2,
      traits: { marks: ["freckles", "mole"], vibe: "coffee" },
    });
  });

  test("creates an empty photos folder for the avatar", async () => {
    const { library } = await openLibrary(root(), deps());
    await library.createAvatar(MIA);
    expect((await stat(join(root(), "avatars", "avatar-0001", "photos"))).isDirectory()).toBe(true);
  });

  test("rejects an under-21 avatar with invalid-record and writes nothing", async () => {
    const { library } = await openLibrary(root(), deps());

    await expectLibraryError(library.createAvatar({ ...MIA, age: 20 }), "invalid-record");

    expect(await readdir(join(root(), "avatars"))).toEqual([]);
    expect(library.listAvatars()).toEqual([]);
  });

  test("refuses an id from the generator that breaks the id pattern", async () => {
    const { library } = await openLibrary(root(), deps({ newId: () => "BAD" }));
    await expectLibraryError(library.createAvatar(MIA), "invalid-id");
  });

  test("a crash before the avatar folder is renamed into place leaves no avatar behind", async () => {
    const crash = new Error("simulated crash");
    const { library } = await openLibrary(root(), deps({ testHooks: { beforeRename: () => { throw crash; } } }));

    expect(await rejectionOf(library.createAvatar(MIA))).toBe(crash);

    expect(library.listAvatars()).toEqual([]);
    const reopened = await openLibrary(root(), deps());
    expect(reopened.library.listAvatars()).toEqual([]);
    expect(reopened.report.avatars).toBe(0);
  });

  test("the temp folder of a crashed create is quarantined, not deleted, on the next open", async () => {
    const crash = new Error("simulated crash");
    const first = await openLibrary(root(), deps({ testHooks: { beforeRename: () => { throw crash; } } }));
    await rejectionOf(first.library.createAvatar(MIA));

    const { report } = await openLibrary(root(), deps());

    expect(report.quarantined).toHaveLength(1);
    const [entry] = report.quarantined;
    expect(entry.reason).toBe("temp-file");
    expect(entry.from).toMatch(/^avatars[\\/]\.avatar-0001\..+\.tmp$/);
    expect(await readJson(join(root(), entry.to, "avatar.json"))).toMatchObject({ id: "avatar-0001", name: "Mia" });
    expect(await readdir(join(root(), "avatars"))).toEqual([]);
  });
});

describe("listAvatars and reopen", () => {
  test("a reopened library lists the avatars created before, in creation order", async () => {
    const first = await openLibrary(root(), deps());
    await first.library.createAvatar(MIA);
    await first.library.createAvatar({ ...MIA, name: "Lena" });

    const { library, report } = await openLibrary(root(), deps());

    expect(report.avatars).toBe(2);
    expect(library.listAvatars().map((a) => a.name)).toEqual(["Mia", "Lena"]);
  });

  test("an avatar folder with an invalid manifest is quarantined whole and reported", async () => {
    const first = await openLibrary(root(), deps());
    await first.library.createAvatar(MIA);
    await first.library.createAvatar({ ...MIA, name: "Lena" });
    const brokenDir = join(root(), "avatars", "avatar-0002");
    await writeFile(join(brokenDir, "avatar.json"), JSON.stringify({ schemaVersion: 1, id: "avatar-0002", age: 19 }));

    const { library, report } = await openLibrary(root(), deps());

    expect(library.listAvatars().map((a) => a.id)).toEqual(["avatar-0001"]);
    expect(report.avatars).toBe(1);
    expect(report.quarantined).toHaveLength(1);
    expect(report.quarantined[0]).toMatchObject({ from: join("avatars", "avatar-0002"), reason: "invalid-manifest" });
    expect(report.quarantined[0].detail).toBeString();
    expect(await readJson(join(root(), report.quarantined[0].to, "avatar.json"))).toMatchObject({ age: 19 });
  });

  test("an avatar folder whose manifest still has a language key is quarantined", async () => {
    const first = await openLibrary(root(), deps());
    const mia = await first.library.createAvatar(MIA);
    const path = join(root(), "avatars", mia.id, "avatar.json");
    await writeFile(path, JSON.stringify({ ...mia, language: "en" }));

    const { library, report } = await openLibrary(root(), deps());

    expect(library.listAvatars()).toEqual([]);
    expect(report.quarantined.map((q) => [q.from, q.reason])).toEqual([[join("avatars", mia.id), "invalid-manifest"]]);
    expect(report.quarantined[0].detail).toContain("language");
  });

  test("an avatar folder whose manifest id differs from the folder name is quarantined", async () => {
    const first = await openLibrary(root(), deps());
    await first.library.createAvatar(MIA);
    await cp(join(root(), "avatars", "avatar-0001"), join(root(), "avatars", "copied-avatar"), { recursive: true });

    const { library, report } = await openLibrary(root(), deps());

    expect(library.listAvatars().map((a) => a.id)).toEqual(["avatar-0001"]);
    expect(report.quarantined.map((q) => [q.from, q.reason])).toEqual([
      [join("avatars", "copied-avatar"), "invalid-manifest"],
    ]);
  });

  test("listAvatars filters by status when asked, and lists every status otherwise", async () => {
    const { library } = await openLibrary(root(), deps());
    const draft = await library.createAvatar(MIA);
    const active = await library.createAvatar({ ...MIA, name: "Lena" });
    const archived = await library.createAvatar({ ...MIA, name: "Olga" });
    for (const avatar of [active, archived]) {
      const photo = await library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta());
      await library.updateAvatar(avatar.id, { masterPhotoId: photo.id, status: "active" });
    }
    await library.updateAvatar(archived.id, { status: "archived" });

    const ids = (status?: AvatarStatus[]) =>
      library.listAvatars(status === undefined ? undefined : { status }).map((a) => a.id);
    expect(ids()).toEqual([draft.id, active.id, archived.id]);
    expect(ids(["draft"])).toEqual([draft.id]);
    expect(ids(["active", "archived"])).toEqual([active.id, archived.id]);
    expect(ids([])).toEqual([]);
  });

  test("getAvatar returns undefined for an unknown id", async () => {
    const { library } = await openLibrary(root(), deps());
    expect(library.getAvatar("unknown-avatar")).toBeUndefined();
  });
});

describe("updateAvatar", () => {
  test("persists a new name", async () => {
    const { library } = await openLibrary(root(), deps());
    await library.createAvatar(MIA);

    const updated = await library.updateAvatar("avatar-0001", { name: "Mia R." });

    expect(updated).toMatchObject({ name: "Mia R.", status: "draft", age: 25 });
    const reopened = await openLibrary(root(), deps());
    expect(reopened.library.getAvatar("avatar-0001")).toMatchObject({ name: "Mia R." });
  });

  test("picking a master activates a draft, and an active avatar can be archived", async () => {
    const { library } = await openLibrary(root(), deps());
    const mia = await library.createAvatar(MIA);
    const photo = await library.addPhoto(mia.id, PNG_1X1, samplePhotoMeta());

    await library.updateAvatar(mia.id, { masterPhotoId: photo.id, status: "active" });
    await library.updateAvatar(mia.id, { status: "archived" });

    const reopened = await openLibrary(root(), deps());
    expect(reopened.library.getAvatar(mia.id)).toMatchObject({ status: "archived", masterPhotoId: photo.id });
  });

  test("a draft cannot become active or archived without a master", async () => {
    const { library } = await openLibrary(root(), deps());
    const mia = await library.createAvatar(MIA);

    await expectLibraryError(library.updateAvatar(mia.id, { status: "active" }), "invalid-record");
    await expectLibraryError(library.updateAvatar(mia.id, { status: "archived" }), "invalid-record");

    expect(library.getAvatar(mia.id)?.status).toBe("draft");
  });

  test("persists a rewritten descriptor, leaving the name, master and status untouched", async () => {
    const { library } = await openLibrary(root(), deps());
    const mia = await library.createAvatar(MIA);
    const photo = await library.addPhoto(mia.id, PNG_1X1, samplePhotoMeta());
    await library.updateAvatar(mia.id, { masterPhotoId: photo.id, status: "active" });

    const updated = await library.updateAvatar(mia.id, { descriptor: "a rewritten 25-year-old woman." });

    expect(updated).toMatchObject({ name: "Mia", status: "active", masterPhotoId: photo.id, descriptor: "a rewritten 25-year-old woman." });
    const reopened = await openLibrary(root(), deps());
    expect(reopened.library.getAvatar(mia.id)).toMatchObject({ descriptor: "a rewritten 25-year-old woman." });
  });

  test("refuses an unknown avatar with avatar-not-found", async () => {
    const { library } = await openLibrary(root(), deps());
    await expectLibraryError(library.updateAvatar("unknown-avatar", { name: "X" }), "avatar-not-found");
  });

  test("refuses an empty name with invalid-record and keeps the manifest", async () => {
    const { library } = await openLibrary(root(), deps());
    await library.createAvatar(MIA);

    await expectLibraryError(library.updateAvatar("avatar-0001", { name: "" }), "invalid-record");

    expect(library.getAvatar("avatar-0001")).toMatchObject({ name: "Mia" });
  });

  test("a crash between the temp write and the rename keeps the old manifest on disk and in memory", async () => {
    let armed = false;
    const crash = new Error("simulated crash");
    const { library } = await openLibrary(
      root(),
      deps({
        testHooks: {
          beforeRename: (finalPath) => {
            if (armed && finalPath.endsWith("avatar.json")) throw crash;
          },
        },
      })
    );
    await library.createAvatar(MIA);
    armed = true;

    expect(await rejectionOf(library.updateAvatar("avatar-0001", { name: "Changed" }))).toBe(crash);

    const avatarDir = join(root(), "avatars", "avatar-0001");
    expect(await readJson(join(avatarDir, "avatar.json"))).toMatchObject({ name: "Mia" });
    expect(library.getAvatar("avatar-0001")).toMatchObject({ name: "Mia" });
    expect(await tempFilesIn(avatarDir)).toHaveLength(1);

    const reopened = await openLibrary(root(), deps());
    expect(reopened.library.getAvatar("avatar-0001")).toMatchObject({ name: "Mia" });
    expect(reopened.report.quarantined.map((q) => q.reason)).toEqual(["temp-file"]);
    expect(await tempFilesIn(avatarDir)).toEqual([]);
  });
});
