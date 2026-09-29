import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import type { Library } from "../library";
import { NODE_COMMIT_FS } from "./commitFs";
import { deleteVideo, VideoFileUnreachableError, VideoNotFoundError, VideoRecordUnreadableError, type DeleteVideoDeps } from "./delete";
import { FileStateChecker } from "./fileState";
import { writeIntent, commitIntent } from "./intents";
import { videoPaths, type VideoRecord } from "./record";
import type { ExportRootRef } from "./recovery";
import { CrashError, errnoError, fakeVideoBytes, faultyFs, libraryVideoFiles, sampleRecord, useWorld, type World } from "./testing/kit";
useNativeGlobals();

// Task 3a.8b.1, `videos.delete`'s library-level logic: the file if it is present,
// then the record, then the used index. With the file gone (or not ours) only
// the record goes («Удалить запись»). DECISION for a "changed" file (its size or
// sha256 no longer matches the record): Studio never deletes it. It is not
// provably the file Studio wrote any more, so it is left for the owner and
// only the record goes (the photos are freed).

const world = useWorld();
const rootRef = (w: World): ExportRootRef => ({ root: w.exportRoot, rootId: w.rootId, caseInsensitive: false });
const used = (library: Library, w: World, i: number): string[] => library.photoStates(w.avatar.id).get(w.photos[i]?.id ?? "")?.usedIn ?? [];

/** A committed video: its file in the export folder and its record in the library, as a finished commit leaves them. */
async function committed(w: World, over: Parameters<typeof sampleRecord>[1] = {}, bytes: Uint8Array = fakeVideoBytes(2048)): Promise<{ record: VideoRecord; path: string; library: Library }> {
  const record = sampleRecord(w, { bytes, ...over });
  const path = join(w.exportRoot, ...record.file.relPath.split("/"));
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, bytes);
  await writeIntent(NODE_COMMIT_FS, w.libraryRoot, record);
  await commitIntent(NODE_COMMIT_FS, w.libraryRoot, w.avatar.id, record.id);
  return { record, path, library: await w.reopen() };
}

const depsOf = (w: World, library: Library, over: Partial<DeleteVideoDeps> = {}): DeleteVideoDeps => ({ library, exportRoot: rootRef(w), checker: new FileStateChecker(), ...over });

describe("a present file", () => {
  test("is deleted, then the record, and the photos are free again", async () => {
    const w = world();
    const { record, path, library } = await committed(w);
    expect(used(library, w, 0)).toEqual([record.id]);
    const out = await deleteVideo(record.id, depsOf(w, library));
    expect(out).toEqual({ videoId: record.id, avatarId: w.avatar.id, fileDeleted: true, fileState: "present" });
    expect(existsSync(path)).toBe(false);
    expect(await libraryVideoFiles(w)).toEqual([]);
    expect(used(library, w, 0)).toEqual([]);
    expect(library.videoCount(w.avatar.id)).toBe(0);
  });

  test("goes in the order file, record, index: no moment where a record points at nothing it can name, or photos are free while the record stands", async () => {
    const w = world();
    const { record, path, library } = await committed(w);
    const fs = faultyFs();
    await deleteVideo(record.id, depsOf(w, library, { fs }));
    const paths = videoPaths(w.libraryRoot, w.avatar.id);
    const effects = fs.calls.filter((c) => c.startsWith("unlink") || c.startsWith("fsyncDir"));
    expect(effects).toEqual([`unlink ${path}`, `fsyncDir ${join(w.exportRoot, "Mia")}`, `unlink ${paths.intent(record.id)}`, `unlink ${paths.record(record.id)}`, `fsyncDir ${paths.videosDir}`]);
  });

  test("frees only its own photos: another video's stay used", async () => {
    const w = world();
    const first = await committed(w, { videoId: "video-00000001", photoIds: [w.photos[0]?.id ?? ""], relPath: "Mia/2026-09-29_photo_001.mp4" });
    await committed(w, { videoId: "video-00000002", photoIds: [w.photos[1]?.id ?? ""], relPath: "Mia/2026-09-29_photo_002.mp4" }, fakeVideoBytes(3000, 3));
    const library = await w.reopen();
    await deleteVideo(first.record.id, depsOf(w, library));
    expect(used(library, w, 0)).toEqual([]);
    expect(used(library, w, 1)).toEqual(["video-00000002"]);
  });

  test("the library opened again agrees: the record is gone from disk, so nothing is used", async () => {
    const w = world();
    const { record, library } = await committed(w);
    await deleteVideo(record.id, depsOf(w, library));
    const reopened = await w.reopen();
    expect(reopened.videoCount(w.avatar.id)).toBe(0);
    expect(used(reopened, w, 0)).toEqual([]);
  });

  test("a file that cannot be removed (still open in a player) keeps both the file and the record: nothing half done", async () => {
    const w = world();
    const { record, path, library } = await committed(w);
    const fs = faultyFs();
    fs.failOnce("unlink", errnoError("EBUSY"), (args) => args[0] === path);
    await expect(deleteVideo(record.id, depsOf(w, library, { fs }))).rejects.toMatchObject({ code: "EBUSY" });
    expect(existsSync(path)).toBe(true);
    expect(await libraryVideoFiles(w)).toEqual([`${record.id}.json`]);
    expect(used(library, w, 0)).toEqual([record.id]);
  });

  test("a record that cannot be removed after the file went leaves a record reading `missing`, the photos still used, and a retry finishes it", async () => {
    const w = world();
    const { record, path, library } = await committed(w);
    const fs = faultyFs();
    const paths = videoPaths(w.libraryRoot, w.avatar.id);
    fs.failOnce("unlink", errnoError("EIO"), (args) => args[0] === paths.record(record.id));
    await expect(deleteVideo(record.id, depsOf(w, library, { fs }))).rejects.toMatchObject({ code: "EIO" });
    expect(existsSync(path)).toBe(false);
    expect(used(library, w, 0)).toEqual([record.id]);
    const retried = await deleteVideo(record.id, depsOf(w, library));
    expect(retried).toMatchObject({ fileDeleted: false, fileState: "missing" });
    expect(used(library, w, 0)).toEqual([]);
  });

  test("a crash right after the file is removed leaves a record that reads `missing` and keeps the photos used", async () => {
    const w = world();
    const { record, path, library } = await committed(w);
    const fs = faultyFs();
    fs.override({
      unlink: async (target) => {
        await NODE_COMMIT_FS.unlink(target);
        if (target === path) {
          fs.die();
          throw new CrashError("after the file was removed");
        }
      },
    });
    await expect(deleteVideo(record.id, depsOf(w, library, { fs }))).rejects.toThrow(); // the process died mid-delete
    const reopened = await w.reopen();
    expect(used(reopened, w, 0)).toEqual([record.id]);
    expect(await new FileStateChecker().check(sampleRecord(w), rootRef(w), { verify: "full" })).toBe("missing");
  });
});

describe("only the record goes", () => {
  test("missing: the owner already deleted the file, so «Удалить запись» removes the record and frees the photos", async () => {
    const w = world();
    const { record, path, library } = await committed(w);
    renameSync(path, join(w.dir, "posted.mp4"));
    const out = await deleteVideo(record.id, depsOf(w, library));
    expect(out).toMatchObject({ fileDeleted: false, fileState: "missing" });
    expect(readFileSync(join(w.dir, "posted.mp4"))).toEqual(Buffer.from(fakeVideoBytes(2048)));
    expect(await libraryVideoFiles(w)).toEqual([]);
    expect(used(library, w, 0)).toEqual([]);
  });

  test("elsewhere, «Удалить запись»: the file lives in another export root, which Studio never touches", async () => {
    const w = world();
    const { record, path, library } = await committed(w, { rootId: "root-99999999" });
    const out = await deleteVideo(record.id, depsOf(w, library, { mode: "record" }));
    expect(out).toMatchObject({ fileDeleted: false, fileState: "elsewhere" });
    expect(existsSync(path)).toBe(true); // a same-named file in THIS root, not the record's: untouched
    expect(await libraryVideoFiles(w)).toEqual([]);
  });

  test("elsewhere, «Удалить запись»: with no usable export folder the file is not touched either", async () => {
    const w = world();
    const { record, path, library } = await committed(w);
    const out = await deleteVideo(record.id, depsOf(w, library, { exportRoot: null, mode: "record" }));
    expect(out).toMatchObject({ fileDeleted: false, fileState: "elsewhere" });
    expect(existsSync(path)).toBe(true);
    expect(await libraryVideoFiles(w)).toEqual([]);
  });

  test("«Удалить запись» NEVER deletes the file, even one that is present and untouched: the record goes, the photos are freed, the state says what the file was", async () => {
    const w = world();
    const { record, path, library } = await committed(w);
    const out = await deleteVideo(record.id, depsOf(w, library, { mode: "record" }));
    expect(out).toMatchObject({ fileDeleted: false, fileState: "present" });
    expect(readFileSync(path)).toEqual(Buffer.from(fakeVideoBytes(2048)));
    expect(await libraryVideoFiles(w)).toEqual([]);
    expect(used(library, w, 0)).toEqual([]);
  });

  test("«Удалить» with the record's file in another root refuses, and removes nothing: the record and the used marks stay", async () => {
    const w = world();
    const { record, path, library } = await committed(w, { rootId: "root-99999999" });
    await expect(deleteVideo(record.id, depsOf(w, library, { mode: "video" }))).rejects.toBeInstanceOf(VideoFileUnreachableError);
    expect(existsSync(path)).toBe(true);
    expect(await libraryVideoFiles(w)).toEqual([`${record.id}.json`]);
    expect(used(library, w, 0)).toEqual([record.id]);
  });

  test("«Удалить» with no usable export folder refuses too, and removes nothing", async () => {
    const w = world();
    const { record, path, library } = await committed(w);
    await expect(deleteVideo(record.id, depsOf(w, library, { exportRoot: null, mode: "video" }))).rejects.toBeInstanceOf(VideoFileUnreachableError);
    expect(existsSync(path)).toBe(true);
    expect(await libraryVideoFiles(w)).toEqual([`${record.id}.json`]);
  });

  test("changed by content (same size): the file is NEVER deleted, it is not provably ours any more; the record goes and the photos are freed", async () => {
    const w = world();
    const { record, path, library } = await committed(w);
    const edited = fakeVideoBytes(2048, 77);
    writeFileSync(path, edited);
    const out = await deleteVideo(record.id, depsOf(w, library));
    expect(out).toMatchObject({ fileDeleted: false, fileState: "changed" });
    expect(readFileSync(path)).toEqual(Buffer.from(edited));
    expect(await libraryVideoFiles(w)).toEqual([]);
    expect(used(library, w, 0)).toEqual([]);
  });

  test("changed by a same-size edit that kept the mtime (invisible to a stat): delete's full check still catches it, and the file stays", async () => {
    const w = world();
    const bytes = fakeVideoBytes(2048);
    const first = await committed(w, {}, bytes);
    const mtimeMs = Math.floor(statSync(first.path).mtimeMs);
    const record = sampleRecord(w, { bytes, mtimeMs });
    await writeFile(videoPaths(w.libraryRoot, w.avatar.id).record(record.id), `${JSON.stringify(record)}\n`);
    const edited = fakeVideoBytes(2048, 5);
    writeFileSync(first.path, edited);
    utimesSync(first.path, new Date(mtimeMs), new Date(mtimeMs));
    const out = await deleteVideo(record.id, depsOf(w, await w.reopen()));
    expect(out).toMatchObject({ fileDeleted: false, fileState: "changed" });
    expect(readFileSync(first.path)).toEqual(Buffer.from(edited));
  });

  test("changed by size: the file stays", async () => {
    const w = world();
    const { record, path, library } = await committed(w);
    writeFileSync(path, "the owner re-exported this");
    const out = await deleteVideo(record.id, depsOf(w, library));
    expect(out).toMatchObject({ fileDeleted: false, fileState: "changed" });
    expect(readFileSync(path, "utf8")).toBe("the owner re-exported this");
  });

  test("changed because the avatar's folder is now a symlink: nothing is deleted through it, not even a file with the right bytes", async () => {
    const w = world();
    const bytes = fakeVideoBytes(2048);
    const { record, library } = await committed(w, {}, bytes);
    renameSync(join(w.exportRoot, "Mia"), join(w.dir, "moved"));
    symlinkSync(join(w.dir, "moved"), join(w.exportRoot, "Mia"));
    const out = await deleteVideo(record.id, depsOf(w, library));
    expect(out).toMatchObject({ fileDeleted: false, fileState: "changed" });
    expect(readFileSync(join(w.dir, "moved", "2026-09-29_photo_001.mp4"))).toEqual(Buffer.from(bytes));
  });

  test("changed because the file is a symlink: the link is left, and so is its target", async () => {
    const w = world();
    const bytes = fakeVideoBytes(2048);
    const { record, path, library } = await committed(w, {}, bytes);
    renameSync(path, join(w.dir, "real.mp4"));
    symlinkSync(join(w.dir, "real.mp4"), path);
    const out = await deleteVideo(record.id, depsOf(w, library));
    expect(out).toMatchObject({ fileDeleted: false, fileState: "changed" });
    expect(existsSync(join(w.dir, "real.mp4"))).toBe(true);
    expect(existsSync(path)).toBe(true);
  });
});

describe("what cannot be deleted", () => {
  test("an unknown video is NotFound, and nothing changes", async () => {
    const w = world();
    const { record, library } = await committed(w);
    await expect(deleteVideo("video-99999999", depsOf(w, library))).rejects.toBeInstanceOf(VideoNotFoundError);
    expect(await libraryVideoFiles(w)).toEqual([`${record.id}.json`]);
  });

  test("a video id that could walk out of the library is refused as not found, never turned into a path", async () => {
    const w = world();
    const { library } = await committed(w);
    await expect(deleteVideo("../../avatars", depsOf(w, library))).rejects.toBeInstanceOf(VideoNotFoundError);
  });

  test("a record that cannot be read is refused: its file cannot be named, so nothing is deleted, and the avatar stays closed until it is repaired", async () => {
    const w = world();
    const { record, path, library } = await committed(w);
    await writeFile(videoPaths(w.libraryRoot, w.avatar.id).record(record.id), "{ broken");
    await expect(deleteVideo(record.id, depsOf(w, library))).rejects.toBeInstanceOf(VideoRecordUnreadableError);
    expect(existsSync(path)).toBe(true);
    expect(await readFile(videoPaths(w.libraryRoot, w.avatar.id).record(record.id), "utf8")).toBe("{ broken");
  });

  test("two deletes of the same video at once: one removes it, the other finds it gone", async () => {
    const w = world();
    const { record, library } = await committed(w);
    const results = await Promise.allSettled([deleteVideo(record.id, depsOf(w, library)), deleteVideo(record.id, depsOf(w, library))]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: expect.any(VideoNotFoundError) });
  });
});
