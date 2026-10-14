import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { tempDirFor } from "../../testing/tempDir";
import { openLibrary, type Library } from "../library";
import { SAMPLE_AVATAR, sequentialIds, steppingClock } from "../library/testing/helpers";
import { knownAvatarsOf } from "./knownAvatars";
useNativeGlobals();

// 5b.2, S5.WA2 (I5.59, critic LOW): the engine's view of the library for the library-open sweep of orphan clip copies. A copy may go only when its avatar is not in the index AND its folder
// `avatars/<id>/` is really gone from the disk: an avatar the index lacks but whose folder is there keeps its copies. A look that cannot be trusted says «unknown», which keeps them.

const tmp = tempDirFor({ beforeEach, afterEach }, "studio-known-avatars-");
const libraryDir = (): string => join(tmp(), "library");
beforeEach(async () => {
  await mkdir(libraryDir(), { recursive: true });
});

async function open(): Promise<{ library: Library; avatarId: string }> {
  const { library } = await openLibrary(libraryDir(), { now: steppingClock(), newId: sequentialIds() });
  return { library, avatarId: (await library.createAvatar({ ...SAMPLE_AVATAR, name: "Mia" })).id };
}

const there = async (): Promise<boolean> => true;

describe("knownAvatarsOf", () => {
  test("an avatar in the index is known, and the library's root is the library's", async () => {
    const { library, avatarId } = await open();
    const known = knownAvatarsOf(library, () => true, there);
    expect(known.root).toBe(library.root);
    expect(known.has(avatarId)).toBe(true);
  });

  test("an avatar the index lacks but whose folder is on the disk is there: its copies stay", async () => {
    const { library, avatarId } = await open();
    library.detachAvatar(avatarId);
    const known = knownAvatarsOf(library, () => true, there);
    expect(known.has(avatarId)).toBe(false);
    expect(await known.folderState(avatarId)).toBe("there");
  });

  test("an avatar whose folder is gone from the disk is gone", async () => {
    const { library, avatarId } = await open();
    library.detachAvatar(avatarId);
    await rm(library.avatarDirPath(avatarId), { recursive: true, force: true });
    expect(await knownAvatarsOf(library, () => true, there).folderState(avatarId)).toBe("gone");
  });

  test("a look at a library that is not on the disk now says unknown, whatever the folder says", async () => {
    const { library, avatarId } = await open();
    await rm(library.avatarDirPath(avatarId), { recursive: true, force: true });
    expect(await knownAvatarsOf(library, () => true, async () => false).folderState(avatarId)).toBe("unknown");
  });

  test("a library that is no longer the live one keeps everything: every avatar is known, every folder unknown", async () => {
    const { library, avatarId } = await open();
    library.detachAvatar(avatarId);
    const known = knownAvatarsOf(library, () => false, there);
    expect(known.has(avatarId)).toBe(true);
    expect(await known.folderState(avatarId)).toBe("unknown");
  });

  test("an id that is no library id, or a folder that cannot be looked at (a file where the avatars folder goes), is unknown", async () => {
    const { library, avatarId } = await open();
    const known = knownAvatarsOf(library, () => true, there);
    expect(await known.folderState("../outside")).toBe("unknown");
    await rm(join(libraryDir(), "avatars"), { recursive: true, force: true });
    await writeFile(join(libraryDir(), "avatars"), "not a folder");
    expect(await known.folderState(avatarId)).toBe("unknown");
  });
});
