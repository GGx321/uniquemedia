import { describe, expect, test } from "bun:test";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { openLibrary } from "./library";
import { SAMPLE_AVATAR, expectLibraryError, sequentialIds, steppingClock, useTempDir } from "./testing/helpers";

const root = useTempDir("studio-history-");

async function libraryWithAvatar() {
  const { library } = await openLibrary(root(), { now: steppingClock(), newId: sequentialIds() });
  const avatar = await library.createAvatar(SAMPLE_AVATAR);
  return { library, avatarId: avatar.id };
}

function scene(n: number) {
  return { location: `location-${n}`, outfit: `outfit-${n}`, at: `2026-09-24T10:00:0${n}.000Z` };
}

describe("appendHistory", () => {
  test("appends { location, outfit, at } to the avatar's history.jsonl", async () => {
    const { library, avatarId } = await libraryWithAvatar();

    await library.appendHistory(avatarId, scene(1));

    expect(await readFile(join(root(), "avatars", avatarId, "history.jsonl"), "utf8")).toBe(
      `${JSON.stringify(scene(1))}\n`
    );
  });

  test("refuses an unknown avatar", async () => {
    const { library } = await libraryWithAvatar();
    await expectLibraryError(library.appendHistory("unknown-avatar", scene(1)), "avatar-not-found");
  });

  test("refuses an empty location with invalid-record", async () => {
    const { library, avatarId } = await libraryWithAvatar();
    await expectLibraryError(library.appendHistory(avatarId, { ...scene(1), location: "" }), "invalid-record");
  });

  test("refuses a timestamp that is not ISO 8601 UTC", async () => {
    const { library, avatarId } = await libraryWithAvatar();
    await expectLibraryError(library.appendHistory(avatarId, { ...scene(1), at: "yesterday" }), "invalid-record");
  });
});

describe("recentPairs", () => {
  test("returns the most recent entries first, limited to n", async () => {
    const { library, avatarId } = await libraryWithAvatar();
    for (const n of [1, 2, 3, 4]) await library.appendHistory(avatarId, scene(n));

    expect(await library.recentPairs(avatarId, 2)).toEqual([scene(4), scene(3)]);
  });

  test("returns everything when n exceeds the history by one", async () => {
    const { library, avatarId } = await libraryWithAvatar();
    for (const n of [1, 2, 3]) await library.appendHistory(avatarId, scene(n));

    expect(await library.recentPairs(avatarId, 4)).toEqual([scene(3), scene(2), scene(1)]);
  });

  test("returns nothing for n = 0", async () => {
    const { library, avatarId } = await libraryWithAvatar();
    await library.appendHistory(avatarId, scene(1));
    expect(await library.recentPairs(avatarId, 0)).toEqual([]);
  });

  test("returns nothing for an avatar without history", async () => {
    const { library, avatarId } = await libraryWithAvatar();
    expect(await library.recentPairs(avatarId, 5)).toEqual([]);
  });

  test("refuses an unknown or path-like avatar id instead of reading outside the library", async () => {
    const { library } = await libraryWithAvatar();
    await expectLibraryError(library.recentPairs("unknown-avatar", 1), "avatar-not-found");
    await expectLibraryError(library.recentPairs("../../etc", 1), "avatar-not-found");
  });

  test("rejects a negative or fractional n", async () => {
    const { library, avatarId } = await libraryWithAvatar();
    await expect(library.recentPairs(avatarId, -1)).rejects.toBeInstanceOf(RangeError);
    await expect(library.recentPairs(avatarId, 1.5)).rejects.toBeInstanceOf(RangeError);
  });

  test("skips a torn last line", async () => {
    const { library, avatarId } = await libraryWithAvatar();
    await library.appendHistory(avatarId, scene(1));
    await appendFile(join(root(), "avatars", avatarId, "history.jsonl"), '{"location":"loc');

    expect(await library.recentPairs(avatarId, 5)).toEqual([scene(1)]);
  });

  test("history survives a reopen", async () => {
    const { library, avatarId } = await libraryWithAvatar();
    await library.appendHistory(avatarId, scene(1));

    const reopened = await openLibrary(root());

    expect(await reopened.library.recentPairs(avatarId, 1)).toEqual([scene(1)]);
  });
});
