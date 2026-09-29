import { describe, expect, test } from "bun:test";
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import type { Library } from "../library";
import { NODE_COMMIT_FS } from "./commitFs";
import { deleteVideo, type DeleteVideoDeps } from "./delete";
import { hashFile } from "./fileBytes";
import { FileStateChecker } from "./fileState";
import { commitIntent, writeIntent } from "./intents";
import { videoPaths, type VideoRecord } from "./record";
import type { ExportRootRef } from "./recovery";
import { errnoError, fakeVideoBytes, faultyFs, libraryVideoFiles, sampleRecord, useWorld, type World } from "./testing/kit";
useNativeGlobals();

// Review round 1 of 3a.8b.1: a delete removes a file only when it is provably Studio's,
// judged by the root's marker and by the file's identity over the whole check.

const world = useWorld();
const rootRef = (w: World): ExportRootRef => ({ root: w.exportRoot, rootId: w.rootId, caseInsensitive: false });
const used = (library: Library, w: World): string[] => library.photoStates(w.avatar.id).get(w.photos[0]?.id ?? "")?.usedIn ?? [];
const OWNER = Buffer.from("owner's re-export ".repeat(300));

async function committed(w: World, bytes: Uint8Array = fakeVideoBytes(2048)): Promise<{ record: VideoRecord; path: string; library: Library }> {
  const record = sampleRecord(w, { bytes });
  const path = join(w.exportRoot, ...record.file.relPath.split("/"));
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, bytes);
  await writeIntent(NODE_COMMIT_FS, w.libraryRoot, record);
  await commitIntent(NODE_COMMIT_FS, w.libraryRoot, w.avatar.id, record.id);
  return { record, path, library: await w.reopen() };
}
const depsOf = (w: World, library: Library, over: Partial<DeleteVideoDeps> = {}): DeleteVideoDeps => ({ library, exportRoot: rootRef(w), checker: new FileStateChecker(), ...over });

describe("the root is judged by its marker", () => {
  test("an empty folder at the same path (no marker): fileState is `elsewhere`, not `missing`", async () => {
    const w = world();
    const { record } = await committed(w);
    renameSync(w.exportRoot, `${w.exportRoot}.unplugged`);
    mkdirSync(w.exportRoot);
    expect(await new FileStateChecker().check(record, rootRef(w), { verify: "cheap" })).toBe("elsewhere");
  });

  test("delete never touches a file under a root whose marker is not the record's, and still removes the record", async () => {
    const w = world();
    const { record, path, library } = await committed(w);
    writeFileSync(join(w.exportRoot, ".studio-export.json"), JSON.stringify({ schemaVersion: 1, rootId: "root-99999999", createdAt: "2026-09-29T10:00:00.000Z" }));
    const out = await deleteVideo(record.id, depsOf(w, library));
    expect(out).toMatchObject({ fileDeleted: false, fileState: "elsewhere" });
    expect(existsSync(path)).toBe(true);
    expect(await libraryVideoFiles(w)).toEqual([]);
  });

  test("a marker changed between two listings is read again, not remembered", async () => {
    const w = world();
    const { record } = await committed(w);
    const checker = new FileStateChecker();
    expect(await checker.check(record, rootRef(w), { verify: "cheap" })).toBe("present");
    writeFileSync(join(w.exportRoot, ".studio-export.json"), JSON.stringify({ schemaVersion: 1, rootId: "root-99999999", createdAt: "2026-09-29T10:00:00.000Z" }));
    expect(await checker.check(record, rootRef(w), { verify: "cheap" })).toBe("elsewhere");
  });
});

describe("delete: the file checked is the file removed", () => {
  test("a file the owner atomically replaces while it is being hashed is not deleted (state `changed`)", async () => {
    const w = world();
    const { record, path, library } = await committed(w);
    const checker = new FileStateChecker({
      hashFile: async (target) => {
        const digest = await hashFile(target);
        writeFileSync(`${target}.owner`, OWNER);
        renameSync(`${target}.owner`, target);
        return digest;
      },
    });
    const out = await deleteVideo(record.id, depsOf(w, library, { checker }));
    expect(out).toMatchObject({ fileDeleted: false, fileState: "changed" });
    expect(readFileSync(path).equals(OWNER)).toBe(true);
  });

  test("a file replaced after the check and before the unlink is not deleted either", async () => {
    const w = world();
    const { record, path, library } = await committed(w);
    let hashed = false;
    let swapped = false;
    const checker = new FileStateChecker({
      hashFile: async (target) => {
        const digest = await hashFile(target);
        hashed = true;
        return digest;
      },
    });
    const fs = faultyFs();
    fs.override({
      lstat: async (target) => {
        if (hashed && !swapped && target === path) {
          swapped = true;
          writeFileSync(`${path}.owner`, OWNER);
          renameSync(`${path}.owner`, path);
        }
        return NODE_COMMIT_FS.lstat(target);
      },
    });
    const out = await deleteVideo(record.id, depsOf(w, library, { checker, fs }));
    expect(out.fileDeleted).toBe(false);
    expect(readFileSync(path).equals(OWNER)).toBe(true);
  });

  test("the owner's hard link to our video keeps its bytes: only our name goes", async () => {
    const w = world();
    const { record, path, library } = await committed(w);
    const theirs = join(w.dir, "owner-copy.mp4");
    linkSync(path, theirs);
    const out = await deleteVideo(record.id, depsOf(w, library));
    expect(out.fileState).toBe("present");
    expect(existsSync(path)).toBe(false);
    expect(readFileSync(theirs).equals(Buffer.from(fakeVideoBytes(2048)))).toBe(true);
  });
});

describe("delete: order and errors", () => {
  test("the index is freed right after the record's unlink, so a failing videos/ flush cannot leave the photos used", async () => {
    const w = world();
    const { record, library } = await committed(w);
    const fs = faultyFs();
    const paths = videoPaths(w.libraryRoot, w.avatar.id);
    fs.failOnce("fsyncDir", errnoError("EIO"), (args) => args[0] === paths.videosDir);
    await expect(deleteVideo(record.id, depsOf(w, library, { fs }))).rejects.toMatchObject({ code: "EIO" });
    expect(await libraryVideoFiles(w)).toEqual([]);
    expect(used(library, w)).toEqual([]);
  });

  test("the export folder is flushed after the file's unlink, before the record goes", async () => {
    const w = world();
    const { record, library } = await committed(w);
    const fs = faultyFs();
    await deleteVideo(record.id, depsOf(w, library, { fs }));
    const paths = videoPaths(w.libraryRoot, w.avatar.id);
    const calls = fs.calls.filter((c) => c.startsWith("unlink") || c.startsWith("fsyncDir"));
    expect(calls).toEqual([expect.stringMatching(/^unlink .*Mia/), `fsyncDir ${join(w.exportRoot, "Mia")}`, `unlink ${paths.intent(record.id)}`, `unlink ${paths.record(record.id)}`, `fsyncDir ${paths.videosDir}`]);
  });

  test("a disk error that reaches the caller carries its code and no path", async () => {
    const w = world();
    const { record, library } = await committed(w);
    const fs = faultyFs();
    fs.override({ unlink: async (path) => NODE_COMMIT_FS.unlink(`${path}-missing`) });
    const error = await deleteVideo(record.id, depsOf(w, library, { fs })).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "ENOENT" });
    expect((error as Error).message).not.toContain(w.dir);
  });

  test("a record from a newer Studio answers library-too-new, not `unreadable`", async () => {
    const w = world();
    const { record, library } = await committed(w);
    await writeFile(videoPaths(w.libraryRoot, w.avatar.id).record(record.id), JSON.stringify({ schemaVersion: 2, id: record.id }));
    await expect(deleteVideo(record.id, depsOf(w, library))).rejects.toMatchObject({ code: "library-too-new" });
  });
});

