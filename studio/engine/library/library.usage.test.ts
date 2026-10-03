import { describe, expect, test } from "bun:test";
import { appendFile, lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { openLibrary, type LibraryDeps } from "./library";
import type { PhotoQa, PhotoSidecar } from "./schemas";
import { PNG_1X1, SAMPLE_AVATAR, SAMPLE_SOURCE, expectLibraryError, samplePhotoMeta, sequentialIds, steppingClock, useTempDir } from "./testing/helpers";
import { sceneSpec, videoRecordJson, writeVideoRecord } from "./testing/videoRecords";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Task 3e.2: an avatar whose usage the library cannot vouch for (3a.2's fail-closed state) says WHY (`usageReasons`, the
// contract's `AvatarSummary.usage`, K16), and has two ways out the owner can take from the «Фото» screen:
//   - «Убрать повреждённую запись»: `quarantineBrokenRecords` MOVES every record file that cannot be read (never deletes, never a
//     sound record, never a record from a newer Studio) into the library's quarantine, and reads the records again;
//   - «Восстановить отметки»: `rebuildRejectLog` COPIES rejected.jsonl into the quarantine, then replaces it at once with the
//     lines that read, so every readable mark is kept.
// Both decide from the disk as it is now, and both are safe to repeat.

const root = useTempDir("studio-usage-");

const PASSING: PhotoQa = { age: { adult: true, confidence: 0.95 } };
const scene = () => samplePhotoMeta({ source: { ...SAMPLE_SOURCE, category: "home" }, qa: PASSING });
const ids = (photos: readonly PhotoSidecar[]) => photos.map((p) => p.id);

function deps(extra: LibraryDeps = {}): LibraryDeps {
  return { now: steppingClock(), newId: sequentialIds(), ...extra };
}

async function savedAvatar(name = "Mia") {
  const { library } = await openLibrary(root(), deps());
  const avatar = await library.createAvatar({ ...SAMPLE_AVATAR, name });
  const master = await library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta({ qa: PASSING }));
  await library.updateAvatar(avatar.id, { status: "active", masterPhotoId: master.id });
  return { library, avatar };
}

const videosDir = (avatarId: string) => join(root(), "avatars", avatarId, "videos");
const rejectsPath = (avatarId: string) => join(root(), "avatars", avatarId, "rejected.jsonl");

/** Every file under the library's quarantine, as paths relative to it, with their bytes. */
async function quarantined(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const base = join(root(), "quarantine");
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else out.set(relative(base, path).split("\\").join("/"), await readFile(path, "utf8"));
    }
  };
  await walk(base);
  return out;
}

const exists = async (path: string): Promise<boolean> =>
  lstat(path).then(
    () => true,
    () => false,
  );

/** A library reopened over the disk as the test left it: what the library reads at open. */
async function reopen() {
  return (await openLibrary(root(), deps())).library;
}

describe("usageReasons: why an avatar's usage cannot be trusted", () => {
  test("a sound avatar has none, and its unused photos are listed", async () => {
    const { library, avatar } = await savedAvatar();
    const free = await library.addPhoto(avatar.id, PNG_1X1, scene());
    expect(library.usageReasons(avatar.id)).toEqual([]);
    expect(ids(library.eligibleUnusedPhotos(avatar.id))).toEqual([free.id]);
  });

  test("a record that cannot be read: record-unreadable", async () => {
    const { avatar } = await savedAvatar();
    await mkdir(videosDir(avatar.id), { recursive: true });
    await writeFile(join(videosDir(avatar.id), "video-00000002.json"), "{ not json");
    expect((await reopen()).usageReasons(avatar.id)).toEqual(["record-unreadable"]);
  });

  test("a reject log with a bad complete line: rejects-unreadable", async () => {
    const { avatar } = await savedAvatar();
    await writeFile(rejectsPath(avatar.id), "not json\n");
    expect((await reopen()).usageReasons(avatar.id)).toEqual(["rejects-unreadable"]);
  });

  test("a torn last line is an interrupted append, not a broken log: no reason", async () => {
    const { library, avatar } = await savedAvatar();
    const photo = await library.addPhoto(avatar.id, PNG_1X1, scene());
    await library.setRejected(avatar.id, photo.id, true);
    await appendFile(rejectsPath(avatar.id), `{"photoId":"${photo.id}","op":"res`);
    expect((await reopen()).usageReasons(avatar.id)).toEqual([]);
  });

  test("a record from a newer Studio: library-too-new", async () => {
    const { avatar } = await savedAvatar();
    await mkdir(videosDir(avatar.id), { recursive: true });
    await writeFile(join(videosDir(avatar.id), "video-00000003.json"), JSON.stringify({ schemaVersion: 2, id: "video-00000003", avatarId: avatar.id }));
    expect((await reopen()).usageReasons(avatar.id)).toEqual(["library-too-new"]);
  });

  test("a used index that missed a committed video: index-stale, until the records are read again", async () => {
    const { library, avatar } = await savedAvatar();
    library.flagVideoIndexStale(avatar.id, "video-00000004");
    expect(library.usageReasons(avatar.id)).toEqual(["index-stale"]);
    await library.reloadVideoRecords(avatar.id);
    expect(library.usageReasons(avatar.id)).toEqual([]);
  });

  test("a record misfiled under another avatar closes the avatar it names, and the one it lies in", async () => {
    const { library, avatar } = await savedAvatar();
    const lena = await library.createAvatar({ ...SAMPLE_AVATAR, name: "Lena" });
    const photo = await library.addPhoto(lena.id, PNG_1X1, scene());
    await mkdir(videosDir(avatar.id), { recursive: true });
    await writeFile(join(videosDir(avatar.id), "video-00000005.json"), JSON.stringify(videoRecordJson("video-00000005", sceneSpec(lena.id, [photo.id]))));
    const reopened = await reopen();
    expect(reopened.usageReasons(lena.id)).toEqual(["record-unreadable"]);
    expect(reopened.usageReasons(avatar.id)).toEqual(["record-unreadable"]);
  });

  test("every reason that holds is named, the decisive first: a newer record, a stale index, a broken record, broken marks", async () => {
    const { avatar } = await savedAvatar();
    await mkdir(videosDir(avatar.id), { recursive: true });
    await writeFile(join(videosDir(avatar.id), "video-00000002.json"), "{ not json");
    await writeFile(join(videosDir(avatar.id), "video-00000003.json"), JSON.stringify({ schemaVersion: 2, id: "video-00000003", avatarId: avatar.id }));
    await writeFile(rejectsPath(avatar.id), "not json\n");
    const library = await reopen();
    library.flagVideoIndexStale(avatar.id, "video-00000004");
    expect(library.usageReasons(avatar.id)).toEqual(["library-too-new", "index-stale", "record-unreadable", "rejects-unreadable"]);
  });

  test("it says exactly when eligibleUnusedPhotos refuses: no reason, no refusal; a reason, a refusal and a count of 0", async () => {
    const cases: Array<(avatarId: string) => Promise<void>> = [
      async () => undefined,
      async (avatarId) => {
        await mkdir(videosDir(avatarId), { recursive: true });
        await writeFile(join(videosDir(avatarId), "video-00000002.json"), "{ not json");
      },
      async (avatarId) => {
        await writeFile(rejectsPath(avatarId), "not json\n");
      },
    ];
    for (const breakIt of cases) {
      await rm(root(), { recursive: true, force: true });
      await mkdir(root(), { recursive: true });
      const { library: first, avatar } = await savedAvatar();
      await first.addPhoto(avatar.id, PNG_1X1, scene());
      await breakIt(avatar.id);
      const library = await reopen();
      const refuses = (() => {
        try {
          library.eligibleUnusedPhotos(avatar.id);
          return false;
        } catch {
          return true;
        }
      })();
      expect(refuses).toBe(library.usageReasons(avatar.id).length > 0);
      if (refuses) expect(library.eligibleUnusedCount(avatar.id)).toBe(0);
    }
  });

  test("an unknown avatar has no reason to report and is refused", async () => {
    const { library } = await savedAvatar();
    expect(() => library.usageReasons("avatar-nobody")).toThrow(expect.objectContaining({ code: "avatar-not-found" }));
  });
});

describe("quarantineBrokenRecords: «Убрать повреждённую запись»", () => {
  async function withBrokenRecord() {
    const { library: first, avatar } = await savedAvatar();
    const used = await first.addPhoto(avatar.id, PNG_1X1, scene());
    const free = await first.addPhoto(avatar.id, PNG_1X1, scene());
    await writeVideoRecord(root(), "video-00000001", sceneSpec(avatar.id, [used.id]));
    await writeFile(join(videosDir(avatar.id), "video-00000002.json"), "{ not json");
    const library = await reopen();
    return { library, avatar, used, free };
  }

  test("moves the broken record into the quarantine with its bytes, keeps the sound one, and the avatar's usage is trusted again", async () => {
    const { library, avatar, used, free } = await withBrokenRecord();
    expect(library.usageReasons(avatar.id)).toEqual(["record-unreadable"]);

    const outcome = await library.quarantineBrokenRecords(avatar.id);

    expect(outcome.quarantined).toBe(1);
    expect(library.usageReasons(avatar.id)).toEqual([]);
    expect(await exists(join(videosDir(avatar.id), "video-00000002.json"))).toBe(false);
    expect(await exists(join(videosDir(avatar.id), "video-00000001.json"))).toBe(true);
    const moved = [...(await quarantined())];
    expect(moved).toHaveLength(1);
    expect(moved[0]?.[0]).toMatch(new RegExp(`/avatars/${avatar.id}/videos/video-00000002\\.json$`));
    expect(moved[0]?.[1]).toBe("{ not json");
    // The sound record still counts: its photo stays used, the other is free.
    expect(library.photoStates(avatar.id).get(used.id)?.usedIn).toEqual(["video-00000001"]);
    expect(ids(library.eligibleUnusedPhotos(avatar.id))).toEqual([free.id]);
  });

  test("is safe to repeat: a second call finds nothing broken and moves nothing", async () => {
    const { library, avatar } = await withBrokenRecord();
    await library.quarantineBrokenRecords(avatar.id);
    const before = await quarantined();

    const again = await library.quarantineBrokenRecords(avatar.id);

    expect(again.quarantined).toBe(0);
    expect(await quarantined()).toEqual(before);
    expect(library.usageReasons(avatar.id)).toEqual([]);
  });

  test("never moves a record that reads as sound now, even one the library found broken at open (the owner fixed it by hand)", async () => {
    const { library, avatar, used } = await withBrokenRecord();
    const fixed = JSON.stringify(videoRecordJson("video-00000002", sceneSpec(avatar.id, [used.id])));
    await writeFile(join(videosDir(avatar.id), "video-00000002.json"), fixed);

    const outcome = await library.quarantineBrokenRecords(avatar.id);

    expect(outcome.quarantined).toBe(0);
    expect(await readFile(join(videosDir(avatar.id), "video-00000002.json"), "utf8")).toBe(fixed);
    expect(await quarantined()).toEqual(new Map());
    expect(library.usageReasons(avatar.id)).toEqual([]);
    expect(library.photoStates(avatar.id).get(used.id)?.usedIn).toEqual(["video-00000001", "video-00000002"]);
  });

  test("never moves a record from a newer Studio: updating the app is its fix, and the avatar stays closed", async () => {
    const { avatar } = await savedAvatar();
    await mkdir(videosDir(avatar.id), { recursive: true });
    const newer = JSON.stringify({ schemaVersion: 2, id: "video-00000003", avatarId: avatar.id });
    await writeFile(join(videosDir(avatar.id), "video-00000003.json"), newer);
    await writeFile(join(videosDir(avatar.id), "video-00000002.json"), "{ not json");
    const library = await reopen();

    const outcome = await library.quarantineBrokenRecords(avatar.id);

    expect(outcome.quarantined).toBe(1);
    expect(await readFile(join(videosDir(avatar.id), "video-00000003.json"), "utf8")).toBe(newer);
    expect(library.usageReasons(avatar.id)).toEqual(["library-too-new"]);
  });

  test("a stale used index alone moves nothing: no record is broken (the read that follows is what heals it)", async () => {
    const { library: first, avatar } = await savedAvatar();
    const photo = await first.addPhoto(avatar.id, PNG_1X1, scene());
    const library = await reopen();
    await writeVideoRecord(root(), "video-00000004", sceneSpec(avatar.id, [photo.id]));
    library.flagVideoIndexStale(avatar.id, "video-00000004");

    const outcome = await library.quarantineBrokenRecords(avatar.id);

    expect(outcome.quarantined).toBe(0);
    expect(await exists(join(videosDir(avatar.id), "video-00000004.json"))).toBe(true);
    expect(await quarantined()).toEqual(new Map());
    expect(library.photoStates(avatar.id).get(photo.id)?.usedIn).toEqual(["video-00000004"]);
  });

  test("never touches the pending intents, dot files or files that are not records", async () => {
    const { library: first, avatar } = await savedAvatar();
    const photo = await first.addPhoto(avatar.id, PNG_1X1, scene());
    await writeVideoRecord(root(), "video-00000001", sceneSpec(avatar.id, [photo.id]));
    await mkdir(join(videosDir(avatar.id), ".pending"), { recursive: true });
    await writeFile(join(videosDir(avatar.id), ".pending", "video-00000009.json"), "{ half written");
    await writeFile(join(videosDir(avatar.id), ".DS_Store"), "x");
    await writeFile(join(videosDir(avatar.id), "notes.txt"), "mine");
    await writeFile(join(videosDir(avatar.id), "video-00000002.json"), "{ not json");
    const library = await reopen();

    expect((await library.quarantineBrokenRecords(avatar.id)).quarantined).toBe(1);

    expect(await exists(join(videosDir(avatar.id), ".pending", "video-00000009.json"))).toBe(true);
    expect(await exists(join(videosDir(avatar.id), ".DS_Store"))).toBe(true);
    expect(await exists(join(videosDir(avatar.id), "notes.txt"))).toBe(true);
  });

  test("leaves another avatar's own broken record alone: each avatar's recovery is its own", async () => {
    const { library: first, avatar } = await savedAvatar();
    const lena = await first.createAvatar({ ...SAMPLE_AVATAR, name: "Lena" });
    for (const id of [avatar.id, lena.id]) {
      await mkdir(videosDir(id), { recursive: true });
      await writeFile(join(videosDir(id), "video-00000002.json"), "{ not json");
    }
    const library = await reopen();

    await library.quarantineBrokenRecords(avatar.id);

    expect(await exists(join(videosDir(lena.id), "video-00000002.json"))).toBe(true);
    expect(library.usageReasons(lena.id)).toEqual(["record-unreadable"]);
    expect(library.usageReasons(avatar.id)).toEqual([]);
  });

  test("moves a record misfiled under another avatar that names this one, which frees both", async () => {
    const { library: first, avatar } = await savedAvatar();
    const lena = await first.createAvatar({ ...SAMPLE_AVATAR, name: "Lena" });
    const photo = await first.addPhoto(lena.id, PNG_1X1, scene());
    await mkdir(videosDir(avatar.id), { recursive: true });
    const misfiled = JSON.stringify(videoRecordJson("video-00000005", sceneSpec(lena.id, [photo.id])));
    await writeFile(join(videosDir(avatar.id), "video-00000005.json"), misfiled);
    const library = await reopen();

    const outcome = await library.quarantineBrokenRecords(lena.id);

    expect(outcome.quarantined).toBe(1);
    expect(outcome.avatarIds.sort()).toEqual([avatar.id, lena.id].sort());
    expect(await exists(join(videosDir(avatar.id), "video-00000005.json"))).toBe(false);
    expect([...(await quarantined()).values()]).toEqual([misfiled]);
    expect(library.usageReasons(lena.id)).toEqual([]);
    expect(library.usageReasons(avatar.id)).toEqual([]);
  });

  test("in another avatar's folder it moves only the record that names this avatar, never that avatar's own broken one", async () => {
    const { library: first, avatar } = await savedAvatar();
    const lena = await first.createAvatar({ ...SAMPLE_AVATAR, name: "Lena" });
    const photo = await first.addPhoto(lena.id, PNG_1X1, scene());
    await mkdir(videosDir(avatar.id), { recursive: true });
    await writeFile(join(videosDir(avatar.id), "video-00000005.json"), JSON.stringify(videoRecordJson("video-00000005", sceneSpec(lena.id, [photo.id]))));
    await writeFile(join(videosDir(avatar.id), "video-00000006.json"), "{ Mia's own broken record");
    const library = await reopen();

    expect((await library.quarantineBrokenRecords(lena.id)).quarantined).toBe(1);

    expect(await exists(join(videosDir(avatar.id), "video-00000005.json"))).toBe(false);
    expect(await readFile(join(videosDir(avatar.id), "video-00000006.json"), "utf8")).toBe("{ Mia's own broken record");
    expect(library.usageReasons(lena.id)).toEqual([]);
    expect(library.usageReasons(avatar.id)).toEqual(["record-unreadable"]);
  });

  test("a file fixed between the folder's read and its move is looked at again, and stays", async () => {
    const { library: first, avatar } = await savedAvatar();
    const photo = await first.addPhoto(avatar.id, PNG_1X1, scene());
    await mkdir(videosDir(avatar.id), { recursive: true });
    const broken = join(videosDir(avatar.id), "video-00000002.json");
    await writeFile(broken, "{ not json");
    const fixed = JSON.stringify(videoRecordJson("video-00000002", sceneSpec(avatar.id, [photo.id])));
    let reads = 0;
    const { library } = await openLibrary(
      root(),
      deps({
        testHooks: {
          beforeReadVideoRecord: async (path) => {
            if (path !== broken) return;
            reads++;
            // The quarantine's folder read finds it broken (1); the owner fixes it before the look right before the move (2).
            if (reads === 2) await writeFile(broken, fixed);
          },
        },
      }),
    );

    expect((await library.quarantineBrokenRecords(avatar.id)).quarantined).toBe(0);

    expect(await readFile(broken, "utf8")).toBe(fixed);
    expect(await quarantined()).toEqual(new Map());
    expect(library.usageReasons(avatar.id)).toEqual([]);
    expect(library.photoStates(avatar.id).get(photo.id)?.usedIn).toEqual(["video-00000002"]);
  });

  test("a videos folder that is a file is moved aside, and the avatar has no videos and a trusted usage", async () => {
    const { avatar } = await savedAvatar();
    await writeFile(videosDir(avatar.id), "not a folder");
    const library = await reopen();
    expect(library.usageReasons(avatar.id)).toEqual(["record-unreadable"]);

    expect((await library.quarantineBrokenRecords(avatar.id)).quarantined).toBe(1);

    expect(await exists(videosDir(avatar.id))).toBe(false);
    expect([...(await quarantined()).values()]).toEqual(["not a folder"]);
    expect(library.usageReasons(avatar.id)).toEqual([]);
  });

  test("a quarantine that cannot be made leaves every file where it was, and the avatar closed", async () => {
    const { library, avatar } = await withBrokenRecord();
    await writeFile(join(root(), "quarantine"), "a file where the quarantine folder goes");

    await expect(library.quarantineBrokenRecords(avatar.id)).rejects.toThrow();

    expect(await readFile(join(videosDir(avatar.id), "video-00000002.json"), "utf8")).toBe("{ not json");
    expect(await exists(join(videosDir(avatar.id), "video-00000001.json"))).toBe(true);
    expect(library.usageReasons(avatar.id)).toEqual(["record-unreadable"]);
  });

  test("an unknown avatar is refused, and nothing moves", async () => {
    const { library } = await withBrokenRecord();
    await expectLibraryError(library.quarantineBrokenRecords("avatar-nobody"), "avatar-not-found");
    expect(await quarantined()).toEqual(new Map());
  });
});

describe("rebuildRejectLog: «Восстановить отметки»", () => {
  async function withBrokenLog() {
    const { library: first, avatar } = await savedAvatar();
    const a = await first.addPhoto(avatar.id, PNG_1X1, scene());
    const b = await first.addPhoto(avatar.id, PNG_1X1, scene());
    const c = await first.addPhoto(avatar.id, PNG_1X1, scene());
    await first.setRejected(avatar.id, a.id, true);
    await first.setRejected(avatar.id, b.id, true);
    await appendFile(rejectsPath(avatar.id), "not json\n");
    // A line written after the bad one (by hand, or by an older build) still counts: the log is replayed in order.
    await appendFile(rejectsPath(avatar.id), `${JSON.stringify({ photoId: b.id, op: "restore", at: "2026-09-30T10:00:00.000Z" })}\n`);
    const original = await readFile(rejectsPath(avatar.id), "utf8");
    const library = await reopen();
    return { library, avatar, a, b, c, original };
  }

  test("copies the log into the quarantine first, then keeps every line that reads, in order; the marks replay as before", async () => {
    const { library, avatar, a, b, c, original } = await withBrokenLog();
    expect(library.usageReasons(avatar.id)).toEqual(["rejects-unreadable"]);

    const outcome = await library.rebuildRejectLog(avatar.id);

    expect(outcome).toEqual({ rebuilt: true, kept: 3, dropped: 1 });
    const copies = [...(await quarantined())];
    expect(copies).toHaveLength(1);
    expect(copies[0]?.[0]).toMatch(new RegExp(`/avatars/${avatar.id}/rejected\\.jsonl$`));
    expect(copies[0]?.[1]).toBe(original);
    const lines = (await readFile(rejectsPath(avatar.id), "utf8")).split("\n");
    expect(lines.at(-1)).toBe("");
    expect(lines.slice(0, -1)).toEqual(original.split("\n").filter((line) => line !== "" && line !== "not json"));
    expect(library.usageReasons(avatar.id)).toEqual([]);
    const states = library.photoStates(avatar.id);
    expect(states.get(a.id)?.rejected).toBe(true);
    expect(states.get(b.id)?.rejected).toBe(false);
    expect(states.get(c.id)?.rejected).toBe(false);
    expect(ids(library.eligibleUnusedPhotos(avatar.id))).toEqual([b.id, c.id]);
  });

  test("what it kept is what a reopened library reads", async () => {
    const { library, avatar, a } = await withBrokenLog();
    await library.rebuildRejectLog(avatar.id);
    const reopened = await reopen();
    expect(reopened.usageReasons(avatar.id)).toEqual([]);
    expect(reopened.photoStates(avatar.id).get(a.id)?.rejected).toBe(true);
  });

  test("a torn last line goes too, counted as dropped: it was an append a crash cut short", async () => {
    const { library: first, avatar } = await savedAvatar();
    const a = await first.addPhoto(avatar.id, PNG_1X1, scene());
    await first.setRejected(avatar.id, a.id, true);
    await appendFile(rejectsPath(avatar.id), `not json\n{"photoId":"${a.id}","op":"res`);
    const library = await reopen();

    expect(await library.rebuildRejectLog(avatar.id)).toEqual({ rebuilt: true, kept: 1, dropped: 2 });
    expect(library.photoStates(avatar.id).get(a.id)?.rejected).toBe(true);
  });

  test("a sound log is left as it is: rebuilt false, the same bytes, no copy made", async () => {
    const { library, avatar } = await savedAvatar();
    const a = await library.addPhoto(avatar.id, PNG_1X1, scene());
    await library.setRejected(avatar.id, a.id, true);
    const before = await readFile(rejectsPath(avatar.id), "utf8");

    expect(await library.rebuildRejectLog(avatar.id)).toEqual({ rebuilt: false, kept: 1, dropped: 0 });

    expect(await readFile(rejectsPath(avatar.id), "utf8")).toBe(before);
    expect(await quarantined()).toEqual(new Map());
  });

  test("no log at all: nothing to rebuild, nothing written", async () => {
    const { library, avatar } = await savedAvatar();
    expect(await library.rebuildRejectLog(avatar.id)).toEqual({ rebuilt: false, kept: 0, dropped: 0 });
    expect(await exists(rejectsPath(avatar.id))).toBe(false);
  });

  test("is safe to repeat: the second call finds a sound log", async () => {
    const { library, avatar } = await withBrokenLog();
    await library.rebuildRejectLog(avatar.id);
    const after = await readFile(rejectsPath(avatar.id), "utf8");

    expect(await library.rebuildRejectLog(avatar.id)).toEqual({ rebuilt: false, kept: 3, dropped: 0 });
    expect(await readFile(rejectsPath(avatar.id), "utf8")).toBe(after);
    expect(await quarantined()).toHaveProperty("size", 1);
  });

  test("a log the owner fixed by hand since the open is read again: the avatar is trusted, nothing is copied", async () => {
    const { library, avatar, a, original } = await withBrokenLog();
    await writeFile(rejectsPath(avatar.id), original.split("\n").filter((line) => line !== "not json").join("\n"));

    expect(await library.rebuildRejectLog(avatar.id)).toEqual({ rebuilt: false, kept: 3, dropped: 0 });
    expect(await quarantined()).toEqual(new Map());
    expect(library.usageReasons(avatar.id)).toEqual([]);
    expect(library.photoStates(avatar.id).get(a.id)?.rejected).toBe(true);
  });

  test("a copy that cannot be made leaves the log exactly as it was, and the avatar closed", async () => {
    const { library, avatar, original } = await withBrokenLog();
    await writeFile(join(root(), "quarantine"), "a file where the quarantine folder goes");

    await expect(library.rebuildRejectLog(avatar.id)).rejects.toThrow();

    expect(await readFile(rejectsPath(avatar.id), "utf8")).toBe(original);
    expect(library.usageReasons(avatar.id)).toEqual(["rejects-unreadable"]);
  });

  test("marking works again once the log is rebuilt, and the new mark lands in the new log", async () => {
    const { library, avatar, c } = await withBrokenLog();
    await expectLibraryError(library.setRejected(avatar.id, c.id, true), "log-needs-repair");
    await library.rebuildRejectLog(avatar.id);

    expect(await library.setRejected(avatar.id, c.id, true)).toBe(true);
    expect((await reopen()).photoStates(avatar.id).get(c.id)?.rejected).toBe(true);
  });

  test("another avatar's marks are not touched", async () => {
    const { library: first, avatar } = await savedAvatar();
    const lena = await first.createAvatar({ ...SAMPLE_AVATAR, name: "Lena" });
    const hers = await first.addPhoto(lena.id, PNG_1X1, scene());
    await first.setRejected(lena.id, hers.id, true);
    await writeFile(rejectsPath(avatar.id), "not json\n");
    const library = await reopen();

    await library.rebuildRejectLog(avatar.id);

    expect(library.photoStates(lena.id).get(hers.id)?.rejected).toBe(true);
  });

  test("an unknown avatar is refused, and nothing is written", async () => {
    const { library } = await withBrokenLog();
    await expectLibraryError(library.rebuildRejectLog("avatar-nobody"), "avatar-not-found");
    expect(await quarantined()).toEqual(new Map());
  });
});
