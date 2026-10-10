import { describe, expect, test } from "bun:test";
import { cp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openLibrary, type LibraryDeps, type NewAvatar, type NewImportedAvatar } from "./library";
import type { AvatarManifest, AvatarStatus } from "./schemas";
import {
  PNG_1X1,
  SAMPLE_IMPORTED_SOURCE,
  expectLibraryError,
  samplePhotoMeta,
  rejectionOf,
  sequentialIds,
  steppingClock,
  tempFilesIn,
  useTempDir,
} from "./testing/helpers";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

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

describe("createImportedAvatar (T6c, M3: atomic — manifest, photo and sidecar publish in one rename)", () => {
  const IMPORTED: NewImportedAvatar = {
    name: "Zoe",
    age: 27,
    traits: { hairColor: "black" },
    descriptor: "a 27-year-old woman with black hair",
    photoBytes: PNG_1X1,
    photoMeta: { mediaType: "image/png", width: 1, height: 1, source: SAMPLE_IMPORTED_SOURCE },
  };

  test("writes an active avatar with her master already set, and the photo file plus its sidecar, in one publish", async () => {
    const { library } = await openLibrary(root(), deps());

    const { avatar, photo } = await library.createImportedAvatar(IMPORTED);

    expect(avatar).toMatchObject({ id: "avatar-0001", name: "Zoe", age: 27, status: "active", masterPhotoId: photo.id });
    expect(photo).toMatchObject({ avatarId: "avatar-0001", source: SAMPLE_IMPORTED_SOURCE });
    expect(library.getAvatar("avatar-0001")).toEqual(avatar);
    expect(library.getPhoto(photo.id)).toEqual(photo);
    expect(await readJson(join(root(), "avatars", "avatar-0001", "avatar.json"))).toEqual(avatar);
    expect(await readJson(join(root(), "avatars", "avatar-0001", "photos", `${photo.id}.json`))).toEqual(photo);
    expect((await stat(join(root(), "avatars", "avatar-0001", "photos", photo.file))).size).toBe(PNG_1X1.length);
  });

  test("the master's own reference works, exactly like a generated avatar's (invariant 9 widened)", async () => {
    const { library } = await openLibrary(root(), deps());
    const { avatar } = await library.createImportedAvatar(IMPORTED);
    expect(library.referencePhoto(avatar.id)?.photo.source.kind).toBe("imported");
  });

  test("rejects a media-type mismatch and writes nothing", async () => {
    const { library } = await openLibrary(root(), deps());
    await expectLibraryError(
      library.createImportedAvatar({ ...IMPORTED, photoMeta: { ...IMPORTED.photoMeta, mediaType: "image/webp" } }),
      "media-type-mismatch",
    );
    expect(await readdir(join(root(), "avatars"))).toEqual([]);
    expect(library.listAvatars()).toEqual([]);
  });

  test("rejects an under-21 avatar with invalid-record and writes nothing", async () => {
    const { library } = await openLibrary(root(), deps());
    await expectLibraryError(library.createImportedAvatar({ ...IMPORTED, age: 20 }), "invalid-record");
    expect(await readdir(join(root(), "avatars"))).toEqual([]);
  });

  // M3: a crash (kill, or any failure) between the writes and the publishing
  // rename must leave nothing published — no dangling avatar with no photo,
  // no half-written manifest visible to listAvatars — mirroring createAvatar's
  // own crash test above: the temp folder is left for the next open's
  // quarantine (evidence kept, never silently deleted), not published.
  test("a crash before the publish rename leaves no avatar, no photo, and no partial state behind", async () => {
    const crash = new Error("simulated crash");
    const { library } = await openLibrary(root(), deps({ testHooks: { beforeRename: () => { throw crash; } } }));

    expect(await rejectionOf(library.createImportedAvatar(IMPORTED))).toBe(crash);

    expect(library.listAvatars()).toEqual([]);
    const reopened = await openLibrary(root(), deps());
    expect(reopened.library.listAvatars()).toEqual([]);
    expect(reopened.report.avatars).toBe(0);
    // Not silently gone: the crashed temp folder is quarantined on the next open, evidence kept.
    expect(reopened.report.quarantined).toHaveLength(1);
    expect(reopened.report.quarantined[0]?.reason).toBe("temp-file");
    await rm(join(root(), reopened.report.quarantined[0]?.to ?? ""), { recursive: true, force: true });
  });
});

// Owner decision 2026-10-05: the refused-imports list (T6c, H2) is gone — only
// the removed import age check ever fed it. A library an older build wrote may
// still hold its `refused-imports.json`: it must open, and it is left alone.
describe("a legacy refused-imports.json (removed 2026-10-05)", () => {
  const LEGACY_FILE = "refused-imports.json";
  const legacyBodies: Array<[string, string]> = [
    ["a valid list", JSON.stringify({ schemaVersion: 1, sha256: ["b".repeat(64)] })],
    ["a corrupt file", "not json"],
    ["a list from a newer version", JSON.stringify({ schemaVersion: 2, sha256: [] })],
  ];

  test("the library no longer offers a refused-imports lookup or record", async () => {
    const { library } = await openLibrary(root(), deps());
    expect("isRefusedImport" in library).toBe(false);
    expect("recordRefusedImport" in library).toBe(false);
  });

  test.each(legacyBodies)("%s next to library.json: the library still opens, nothing is quarantined, the file is left as it was", async (_label, body) => {
    await openLibrary(root(), deps());
    await writeFile(join(root(), LEGACY_FILE), body);

    const { library, report } = await openLibrary(root(), deps());

    expect(report.quarantined).toEqual([]);
    expect(await readFile(join(root(), LEGACY_FILE), "utf8")).toBe(body);
    // And it is a working library: an avatar still saves and reads back.
    const saved = await library.createAvatar(MIA);
    expect(library.getAvatar(saved.id)?.name).toBe("Mia");
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

  test("hands the validator the manifest as it would be written, and writes it when the validator accepts", async () => {
    const { library } = await openLibrary(root(), deps());
    await library.createAvatar(MIA);
    const seen: { name: string; descriptor: string }[] = [];

    const updated = await library.updateAvatar("avatar-0001", { descriptor: "a new 25-year-old woman." }, (next) => {
      seen.push({ name: next.name, descriptor: next.descriptor });
    });

    expect(seen).toEqual([{ name: "Mia", descriptor: "a new 25-year-old woman." }]);
    expect(updated.descriptor).toBe("a new 25-year-old woman.");
    expect(library.getAvatar("avatar-0001")?.descriptor).toBe("a new 25-year-old woman.");
  });

  test("hands the validator the manifest that is stored right now as well, before the write", async () => {
    const { library } = await openLibrary(root(), deps());
    await library.createAvatar(MIA);
    const stored: string[] = [];

    await library.updateAvatar("avatar-0001", { descriptor: "a new 25-year-old woman." }, (_next, current) => {
      stored.push(current.descriptor);
    });

    expect(stored).toEqual([MIA.descriptor]);
  });

  test("a validator that throws refuses the update, with its own error, and leaves the manifest on disk and in memory", async () => {
    const { library } = await openLibrary(root(), deps());
    await library.createAvatar(MIA);
    const refusal = new Error("validator says no");

    expect(
      await rejectionOf(
        library.updateAvatar("avatar-0001", { descriptor: "a new 25-year-old woman." }, () => {
          throw refusal;
        })
      )
    ).toBe(refusal);

    const avatarDir = join(root(), "avatars", "avatar-0001");
    expect(await readJson(join(avatarDir, "avatar.json"))).toMatchObject({ descriptor: MIA.descriptor });
    expect(library.getAvatar("avatar-0001")?.descriptor).toBe(MIA.descriptor);
    expect(await tempFilesIn(avatarDir)).toHaveLength(0);
  });

  test("the validator runs inside the exclusive section: a queued update is judged against the one before it", async () => {
    const { library } = await openLibrary(root(), deps());
    await library.createAvatar(MIA);
    const namesSeenBy2: string[] = [];

    const first = library.updateAvatar("avatar-0001", { name: "First" });
    const second = library.updateAvatar("avatar-0001", { descriptor: "a second 25-year-old woman." }, (next) => {
      namesSeenBy2.push(next.name);
    });
    await Promise.all([first, second]);

    expect(namesSeenBy2).toEqual(["First"]);
    expect(library.getAvatar("avatar-0001")).toMatchObject({ name: "First", descriptor: "a second 25-year-old woman." });
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

describe("updateAvatarTraits (Stage 5, S5.2a: the body keys, merged under the manifest's lock)", () => {
  const BODY_MIA: NewAvatar = { ...MIA, traits: { build: "slim", hairColor: "black", height: "tall" } };

  test("merges the given keys onto the stored traits, keeps the others, and writes the manifest", async () => {
    const { library } = await openLibrary(root(), deps());
    await library.createAvatar(BODY_MIA);

    const updated = await library.updateAvatarTraits("avatar-0001", { bust: "full", bodyMarks: ["mole-back"] });

    expect(updated.traits).toEqual({ build: "slim", hairColor: "black", height: "tall", bust: "full", bodyMarks: ["mole-back"] });
    expect(library.getAvatar("avatar-0001")).toEqual(updated);
    expect(await readJson(join(root(), "avatars", "avatar-0001", "avatar.json"))).toEqual(updated);
  });

  test("a key given as null is removed, and a key that was never there stays absent", async () => {
    const { library } = await openLibrary(root(), deps());
    await library.createAvatar(BODY_MIA);

    const updated = await library.updateAvatarTraits("avatar-0001", { height: null, figure: null });

    expect(updated.traits).toEqual({ build: "slim", hairColor: "black" });
    expect("height" in updated.traits).toBe(false);
  });

  test("changes nothing but the traits", async () => {
    const { library } = await openLibrary(root(), deps());
    const before = await library.createAvatar(BODY_MIA);

    const updated = await library.updateAvatarTraits("avatar-0001", { bust: "small" });

    expect({ ...updated, traits: before.traits }).toEqual(before);
  });

  test("hands the validator the manifest as it would be written, and the one stored right now", async () => {
    const { library } = await openLibrary(root(), deps());
    await library.createAvatar(BODY_MIA);
    const seen: unknown[] = [];

    await library.updateAvatarTraits("avatar-0001", { bust: "full" }, (next, current) => {
      seen.push({ next: next.traits, current: current.traits });
    });

    expect(seen).toEqual([{ next: { build: "slim", hairColor: "black", height: "tall", bust: "full" }, current: BODY_MIA.traits }]);
  });

  test("a validator that throws refuses the update with its own error and leaves the file and the memory as they were", async () => {
    const { library } = await openLibrary(root(), deps());
    await library.createAvatar(BODY_MIA);
    const refusal = new Error("the composite is too long");

    expect(await rejectionOf(library.updateAvatarTraits("avatar-0001", { bust: "full" }, () => { throw refusal; }))).toBe(refusal);

    const avatarDir = join(root(), "avatars", "avatar-0001");
    expect(await readJson(join(avatarDir, "avatar.json"))).toMatchObject({ traits: BODY_MIA.traits });
    expect(library.getAvatar("avatar-0001")?.traits).toEqual(BODY_MIA.traits);
    expect(await tempFilesIn(avatarDir)).toHaveLength(0);
  });

  test("the validator runs inside the exclusive section: it judges the manifest an update queued before it left", async () => {
    const { library } = await openLibrary(root(), deps());
    await library.createAvatar(BODY_MIA);
    const descriptorsSeen: string[] = [];

    const first = library.updateAvatar("avatar-0001", { descriptor: "a changed 25-year-old woman." });
    const second = library.updateAvatarTraits("avatar-0001", { bust: "full" }, (next) => {
      descriptorsSeen.push(next.descriptor);
    });
    await Promise.all([first, second]);

    expect(descriptorsSeen).toEqual(["a changed 25-year-old woman."]);
    expect(library.getAvatar("avatar-0001")).toMatchObject({ descriptor: "a changed 25-year-old woman.", traits: { bust: "full" } });
  });

  test("two body updates in a row both land: the second merges onto the first", async () => {
    const { library } = await openLibrary(root(), deps());
    await library.createAvatar(BODY_MIA);

    await Promise.all([library.updateAvatarTraits("avatar-0001", { bust: "full" }), library.updateAvatarTraits("avatar-0001", { figure: "pear" })]);

    expect(library.getAvatar("avatar-0001")?.traits).toMatchObject({ bust: "full", figure: "pear" });
  });

  test("refuses a schema-version-1 manifest (its traits are text only; a list of body marks cannot be stored) and leaves it alone", async () => {
    const { library } = await openLibrary(root(), deps());
    await library.createAvatar(MIA);
    const path = join(root(), "avatars", "avatar-0001", "avatar.json");
    const v1 = { ...(await readJson(path) as Record<string, unknown>), schemaVersion: 1, traits: { hair: "chestnut" } };
    await writeFile(path, JSON.stringify(v1));
    const reopened = await openLibrary(root(), deps());

    await expectLibraryError(reopened.library.updateAvatarTraits("avatar-0001", { bodyMarks: ["mole-back"] }), "invalid-record");
    await expectLibraryError(reopened.library.updateAvatarTraits("avatar-0001", { height: "tall" }), "invalid-record");

    expect(await readJson(path)).toEqual(v1);
  });

  test("an unknown avatar is avatar-not-found", async () => {
    const { library } = await openLibrary(root(), deps());
    await expectLibraryError(library.updateAvatarTraits("unknown-avatar", { bust: "full" }), "avatar-not-found");
  });

  test("a crash between the temp write and the rename keeps the old manifest on disk and in memory", async () => {
    let armed = false;
    const crash = new Error("simulated crash");
    const { library } = await openLibrary(root(), deps({ testHooks: { beforeRename: (finalPath) => { if (armed && finalPath.endsWith("avatar.json")) throw crash; } } }));
    await library.createAvatar(BODY_MIA);
    armed = true;

    expect(await rejectionOf(library.updateAvatarTraits("avatar-0001", { bust: "full" }))).toBe(crash);

    expect(await readJson(join(root(), "avatars", "avatar-0001", "avatar.json"))).toMatchObject({ traits: BODY_MIA.traits });
    expect(library.getAvatar("avatar-0001")?.traits).toEqual(BODY_MIA.traits);
  });

  test("keeps the stored body proposal unless the caller asks to drop it", async () => {
    const { library } = await openLibrary(root(), deps());
    const { avatar } = await library.createImportedAvatar({ ...IMPORTED, bodyProposal: PROPOSAL });
    expect(avatar.bodyProposal).toEqual(PROPOSAL);

    const kept = await library.updateAvatarTraits(avatar.id, { height: "tall" });
    expect(kept.bodyProposal).toEqual(PROPOSAL);

    const dropped = await library.updateAvatarTraits(avatar.id, { height: "tall" }, undefined, { clearBodyProposal: true });
    expect("bodyProposal" in dropped).toBe(false);
    expect("bodyProposal" in ((await readJson(join(root(), "avatars", avatar.id, "avatar.json"))) as object)).toBe(false);
  });
});

const IMPORTED: NewImportedAvatar = {
  name: "Zoe",
  age: 27,
  traits: { hairColor: "black" },
  descriptor: "a 27-year-old woman with black hair",
  photoBytes: PNG_1X1,
  photoMeta: { mediaType: "image/png", width: 1, height: 1, source: SAMPLE_IMPORTED_SOURCE },
};
const PROPOSAL = { values: { bust: "full", bodyMarks: [] }, seen: { bust: "photo", height: "not-visible" }, at: "2026-10-10T10:00:00.000Z" };

describe("the stored body proposal (Stage 5, S5.2a)", () => {
  test("createImportedAvatar writes it in the SAME manifest as the avatar, and sets no trait from it", async () => {
    const { library } = await openLibrary(root(), deps());

    const { avatar } = await library.createImportedAvatar({ ...IMPORTED, bodyProposal: PROPOSAL });

    expect(avatar.bodyProposal).toEqual(PROPOSAL);
    expect(avatar.traits).toEqual({ hairColor: "black" });
    expect(await readJson(join(root(), "avatars", "avatar-0001", "avatar.json"))).toEqual(avatar);
    expect((await openLibrary(root(), deps())).library.getAvatar("avatar-0001")?.bodyProposal).toEqual(PROPOSAL);
  });

  test("an import with no proposal has no bodyProposal key at all", async () => {
    const { library } = await openLibrary(root(), deps());
    const { avatar } = await library.createImportedAvatar(IMPORTED);
    expect("bodyProposal" in avatar).toBe(false);
    expect("bodyProposal" in ((await readJson(join(root(), "avatars", "avatar-0001", "avatar.json"))) as object)).toBe(false);
  });

  test("a crash before the publish rename leaves neither the avatar nor her proposal", async () => {
    const crash = new Error("simulated crash");
    const { library } = await openLibrary(root(), deps({ testHooks: { beforeRename: () => { throw crash; } } }));

    expect(await rejectionOf(library.createImportedAvatar({ ...IMPORTED, bodyProposal: PROPOSAL }))).toBe(crash);

    expect(library.listAvatars()).toEqual([]);
  });

  test("clearBodyProposal removes it from the file and the memory", async () => {
    const { library } = await openLibrary(root(), deps());
    const { avatar } = await library.createImportedAvatar({ ...IMPORTED, bodyProposal: PROPOSAL });

    const cleared = await library.clearBodyProposal(avatar.id);

    expect("bodyProposal" in cleared).toBe(false);
    expect(library.getAvatar(avatar.id)).toEqual(cleared);
    expect(await readJson(join(root(), "avatars", avatar.id, "avatar.json"))).toEqual(cleared);
  });

  test("clearBodyProposal on an avatar with none writes nothing", async () => {
    const { library } = await openLibrary(root(), deps());
    const { avatar } = await library.createImportedAvatar(IMPORTED);
    const path = join(root(), "avatars", avatar.id, "avatar.json");
    const before = (await stat(path)).mtimeMs;

    const same = await library.clearBodyProposal(avatar.id);

    expect(same).toEqual(avatar);
    expect((await stat(path)).mtimeMs).toBe(before);
  });

  test("clearBodyProposal for an unknown avatar is avatar-not-found", async () => {
    const { library } = await openLibrary(root(), deps());
    await expectLibraryError(library.clearBodyProposal("unknown-avatar"), "avatar-not-found");
  });

  test.each([
    ["a bad timestamp", { values: {}, seen: {}, at: "yesterday" }],
    ["an extra key", { values: {}, seen: {}, at: "2026-10-10T10:00:00.000Z", note: "x" }],
    ["a value of the wrong type", { values: { bust: { deep: 1 } }, seen: {}, at: "2026-10-10T10:00:00.000Z" }],
    ["not an object", "full"],
  ])("a hand-corrupted proposal (%s) is dropped on open: the avatar is kept, listed and not quarantined", async (_label, corrupted) => {
    const { library } = await openLibrary(root(), deps());
    const { avatar } = await library.createImportedAvatar({ ...IMPORTED, bodyProposal: PROPOSAL });
    const path = join(root(), "avatars", avatar.id, "avatar.json");
    await writeFile(path, JSON.stringify({ ...((await readJson(path)) as object), bodyProposal: corrupted }));

    const reopened = await openLibrary(root(), deps());

    expect(reopened.report.quarantined).toEqual([]);
    expect(reopened.report.avatars).toBe(1);
    const kept = reopened.library.getAvatar(avatar.id);
    expect(kept).toMatchObject({ id: avatar.id, name: "Zoe", status: "active" });
    expect(kept?.bodyProposal).toBeUndefined();
    expect(reopened.library.referencePhoto(avatar.id)).not.toBeNull();
  });

  test("a rewritten descriptor keeps the proposal: only the body commands clear it", async () => {
    const { library } = await openLibrary(root(), deps());
    const { avatar } = await library.createImportedAvatar({ ...IMPORTED, bodyProposal: PROPOSAL });

    const updated = await library.updateAvatar(avatar.id, { descriptor: "a new 27-year-old woman." });

    expect(updated.bodyProposal).toEqual(PROPOSAL);
  });
});
