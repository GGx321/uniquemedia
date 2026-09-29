import { describe, expect, test } from "bun:test";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { commitIntent, writeIntent } from "./intents";
import { videoPaths, VideoRecordSchema } from "./record";
import { errnoError, faultyFs, listTree, readText, sampleRecord, useWorld } from "./testing/kit";
useNativeGlobals();

// Task 3a.8b.1, Commit row steps 4 and 6: the intent is the full record-to-be,
// written temp + fsync + rename; the record is that same file renamed, write-once.

const world = useWorld();

describe("writeIntent", () => {
  test("puts the full record at videos/.pending/<videoId>.json and leaves no temp behind", async () => {
    const w = world();
    const record = sampleRecord(w);
    await writeIntent(faultyFs(), w.libraryRoot, record);
    const paths = videoPaths(w.libraryRoot, w.avatar.id);
    expect(VideoRecordSchema.parse(JSON.parse(await readText(paths.intent(record.id))))).toEqual(record);
    expect(await readdir(paths.pendingDir)).toEqual([`${record.id}.json`]);
  });

  test("makes the file durable, then renames it, then flushes the .pending folder, in that order", async () => {
    const w = world();
    const fs = faultyFs();
    const record = sampleRecord(w);
    await writeIntent(fs, w.libraryRoot, record);
    const kinds = fs.calls.map((c) => c.split(" ")[0]);
    const write = kinds.indexOf("writeNew");
    const rename = kinds.indexOf("rename");
    expect(write).toBeGreaterThanOrEqual(0);
    expect(rename).toBeGreaterThan(write);
    expect(kinds.slice(rename + 1)).toContain("fsyncDir");
    expect(fs.calls.filter((c) => c.startsWith("fsyncDir")).at(-1)).toBe(`fsyncDir ${videoPaths(w.libraryRoot, w.avatar.id).pendingDir}`);
  });

  test("a folder it had to create is flushed into its parent, so the intent's own home survives a crash", async () => {
    const w = world();
    const fs = faultyFs();
    await writeIntent(fs, w.libraryRoot, sampleRecord(w));
    const paths = videoPaths(w.libraryRoot, w.avatar.id);
    expect(fs.calls).toContain(`fsyncDir ${paths.videosDir}`);
  });

  test("a full disk on the intent leaves neither an intent nor a temp, and the error reaches the caller", async () => {
    const w = world();
    const fs = faultyFs();
    fs.override({
      writeNew: async (path) => {
        await writeFile(path, '{"half":'); // the disk filled while writing: a partial file exists
        throw errnoError("ENOSPC", "no space left on device");
      },
    });
    await expect(writeIntent(fs, w.libraryRoot, sampleRecord(w))).rejects.toMatchObject({ code: "ENOSPC" });
    const paths = videoPaths(w.libraryRoot, w.avatar.id);
    expect(await readdir(paths.pendingDir)).toEqual([]);
  });

  test("an intent for a record that does not fit the schema is refused before anything is written", async () => {
    const w = world();
    const fs = faultyFs();
    const broken = { ...sampleRecord(w), frames: 0 };
    await expect(writeIntent(fs, w.libraryRoot, broken)).rejects.toThrow();
    expect(fs.calls).toEqual([]);
  });

  test("calls the beforeRename hook after the temp is durable and before the rename: where a crash leaves a temp and no intent", async () => {
    const w = world();
    const fs = faultyFs();
    let seen: string[] = [];
    await expect(
      writeIntent(fs, w.libraryRoot, sampleRecord(w), {
        beforeRename: () => {
          seen = [...fs.calls];
          fs.die();
          throw new Error("killed");
        },
      }),
    ).rejects.toThrow("killed");
    expect(seen.some((c) => c.startsWith("writeNew"))).toBe(true);
    expect(seen.some((c) => c.startsWith("rename"))).toBe(false);
    const paths = videoPaths(w.libraryRoot, w.avatar.id);
    const left = await readdir(paths.pendingDir);
    expect(left).toHaveLength(1);
    expect(left[0]).toMatch(/^\..*\.tmp$/);
  });
});

describe("commitIntent", () => {
  test("renames the intent to videos/<videoId>.json: the record exists, the intent does not", async () => {
    const w = world();
    const record = sampleRecord(w);
    await writeIntent(faultyFs(), w.libraryRoot, record);
    await commitIntent(faultyFs(), w.libraryRoot, w.avatar.id, record.id);
    const paths = videoPaths(w.libraryRoot, w.avatar.id);
    expect(VideoRecordSchema.parse(JSON.parse(await readText(paths.record(record.id))))).toEqual(record);
    expect(await readdir(paths.pendingDir)).toEqual([]);
  });

  test("flushes videos/ after the rename, so the record's entry is durable, and .pending/ so the intent's removal is", async () => {
    const w = world();
    const record = sampleRecord(w);
    await writeIntent(faultyFs(), w.libraryRoot, record);
    const fs = faultyFs();
    await commitIntent(fs, w.libraryRoot, w.avatar.id, record.id);
    const paths = videoPaths(w.libraryRoot, w.avatar.id);
    expect(fs.calls.filter((c) => !c.startsWith("lstat"))).toEqual([`rename ${paths.intent(record.id)} -> ${paths.record(record.id)}`, `fsyncDir ${paths.videosDir}`, `fsyncDir ${paths.pendingDir}`]);
  });

  test("never replaces a record that is already there: it is write-once, and the intent stays for recovery to judge", async () => {
    const w = world();
    const record = sampleRecord(w);
    const paths = videoPaths(w.libraryRoot, w.avatar.id);
    await writeIntent(faultyFs(), w.libraryRoot, record);
    await writeFile(paths.record(record.id), "the earlier record");
    await expect(commitIntent(faultyFs(), w.libraryRoot, w.avatar.id, record.id)).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readText(paths.record(record.id))).toBe("the earlier record");
    expect(await listTree(paths.pendingDir)).toEqual([`${record.id}.json`]);
  });

  test("a missing intent is an error, not a silent no-op: the commit would otherwise claim a record it never wrote", async () => {
    const w = world();
    await mkdir(videoPaths(w.libraryRoot, w.avatar.id).pendingDir, { recursive: true });
    await expect(commitIntent(faultyFs(), w.libraryRoot, w.avatar.id, "video-00000001")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("the record it makes is one the library's own reader accepts, and the used index picks it up on open", async () => {
    const w = world();
    const record = sampleRecord(w, { photoIds: [w.photos[0]?.id ?? "", w.photos[1]?.id ?? ""] });
    await writeIntent(faultyFs(), w.libraryRoot, record);
    await commitIntent(faultyFs(), w.libraryRoot, w.avatar.id, record.id);
    const reopened = await w.reopen();
    expect(reopened.videoCount(w.avatar.id)).toBe(1);
    const states = reopened.photoStates(w.avatar.id);
    expect(states.get(w.photos[0]?.id ?? "")?.usedIn).toEqual([record.id]);
    expect(states.get(w.photos[1]?.id ?? "")?.usedIn).toEqual([record.id]);
    expect(states.get(w.photos[2]?.id ?? "")?.usedIn).toEqual([]);
    expect(reopened.eligibleUnusedPhotos(w.avatar.id).map((p) => p.id)).toEqual([w.photos[2]?.id]);
  });

  test("an intent alone does not make its photos used: only a committed record does (invariant 24)", async () => {
    const w = world();
    const record = sampleRecord(w);
    await writeIntent(faultyFs(), w.libraryRoot, record);
    const reopened = await w.reopen();
    expect(reopened.videoCount(w.avatar.id)).toBe(0);
    expect(reopened.photoStates(w.avatar.id).get(w.photos[0]?.id ?? "")?.usedIn).toEqual([]);
  });
});
