import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmod, link as fsLink, mkdir, mkdtemp, open as fsOpen, readdir, readFile, realpath, rename, rm, stat, symlink, unlink as fsUnlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { ExportStatus } from "../shared/engine";
import {
  checkExportRoot,
  createFileExclusive,
  EXPORT_MARKER_FILE,
  ExportMarker,
  exportStatusOf,
  NODE_EXPORT_ROOT_FS,
  pathsOverlap,
  publishFileExclusive,
  readSmallRegularFile,
  type ExportRootFs,
  type PublishOps,
} from "./exportRoot";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

let dir = "";
let library = "";
let exportPath = "";
let idCounter = 0;

beforeEach(async () => {
  // realpath: on macOS the temp dir sits behind a /private symlink; the checks below compare canonical paths.
  dir = await realpath(await mkdtemp(join(tmpdir(), "studio-export-root-")));
  library = join(dir, "library");
  exportPath = join(dir, "export");
  await mkdir(library);
  idCounter = 0;
});
afterEach(async () => {
  await chmod(exportPath, 0o755).catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
});

const NOW = new Date("2026-09-29T12:00:00.000Z");

function check(overrides: Partial<Parameters<typeof checkExportRoot>[0]> = {}) {
  return checkExportRoot({
    fs: NODE_EXPORT_ROOT_FS,
    exportPath,
    libraryPath: library,
    mayCreate: false,
    newId: () => `root-${String(++idCounter).padStart(8, "0")}`,
    now: () => NOW,
    caseInsensitive: false,
    ...overrides,
  });
}

/** The real filesystem with some methods replaced: a disk that fails in a chosen way. */
function faulty(patch: Partial<ExportRootFs>): ExportRootFs {
  return { ...NODE_EXPORT_ROOT_FS, ...patch };
}

function errno(code: string): Error {
  return Object.assign(new Error(code), { code });
}

async function marker(): Promise<unknown> {
  return JSON.parse(await readFile(join(exportPath, EXPORT_MARKER_FILE), "utf8"));
}

describe("the export folder exists and is usable", () => {
  test("an existing folder is ok and is given a marker", async () => {
    await mkdir(exportPath);
    const result = await check();
    expect(result.ok).toBe(true);
    expect(result).toMatchObject({ root: exportPath, rootId: ExportMarker.parse(await marker()).rootId });
  });

  test("the marker holds the root id and the creation time, and nothing else", async () => {
    await mkdir(exportPath);
    await check({ newId: () => "fresh-root-id" });
    expect(await marker()).toEqual({ schemaVersion: 1, rootId: "fresh-root-id", createdAt: "2026-09-29T12:00:00.000Z" });
  });

  test("the probe leaves nothing behind but the marker", async () => {
    await mkdir(exportPath);
    await check();
    expect(await readdir(exportPath)).toEqual([EXPORT_MARKER_FILE]);
  });

  test("a second check keeps the same root id and does not rewrite the marker", async () => {
    await mkdir(exportPath);
    const first = await check();
    const before = await readFile(join(exportPath, EXPORT_MARKER_FILE), "utf8");
    const second = await check({ now: () => new Date("2027-01-01T00:00:00.000Z") });
    expect(second).toEqual(first);
    expect(await readFile(join(exportPath, EXPORT_MARKER_FILE), "utf8")).toBe(before);
  });

  test("a folder that was moved or renamed keeps its root id", async () => {
    await mkdir(exportPath);
    const first = await check();
    const moved = join(dir, "export-renamed");
    await rename(exportPath, moved);
    const second = await check({ exportPath: moved });
    expect(second.ok && first.ok && second.rootId === first.rootId).toBe(true);
  });

  test("an existing valid marker is adopted, not replaced", async () => {
    await mkdir(exportPath);
    await writeFile(join(exportPath, EXPORT_MARKER_FILE), JSON.stringify({ schemaVersion: 1, rootId: "from-another-machine", createdAt: "2025-05-05T05:05:05.000Z" }));
    const result = await check();
    expect(result).toEqual({ ok: true, rootId: "from-another-machine", root: exportPath });
  });

  test("a folder holding the owner's other files is fine, and they are left alone", async () => {
    await mkdir(exportPath);
    await writeFile(join(exportPath, "holiday.mp4"), "video");
    await check();
    expect(await readFile(join(exportPath, "holiday.mp4"), "utf8")).toBe("video");
  });
});

describe("creation on first use", () => {
  test("the default folder is created when it is missing, with parents", async () => {
    const nested = join(dir, "Studio", "export");
    const result = await check({ exportPath: nested, mayCreate: true });
    expect(result.ok).toBe(true);
    expect((await stat(nested)).isDirectory()).toBe(true);
    expect(await readdir(nested)).toEqual([EXPORT_MARKER_FILE]);
  });

  test("a folder the owner chose is not created: reason missing", async () => {
    const result = await check({ mayCreate: false });
    expect(result).toEqual({ ok: false, reason: "missing" });
  });

  test("a missing chosen folder is left missing", async () => {
    await check({ mayCreate: false });
    expect(await stat(exportPath).catch(() => null)).toBeNull();
  });

  test("a default folder that cannot be created is not writable", async () => {
    const fs = faulty({ mkdirp: async () => Promise.reject(errno("EACCES")) });
    expect(await check({ fs, mayCreate: true })).toEqual({ ok: false, reason: "not-writable" });
  });

  test("a default folder under a plain file is not a directory", async () => {
    await writeFile(join(dir, "Studio"), "a file");
    const result = await check({ exportPath: join(dir, "Studio", "export"), mayCreate: true });
    expect(result).toEqual({ ok: false, reason: "not-a-directory" });
  });
});

describe("what is not a usable folder", () => {
  test("a file in its place is not a directory", async () => {
    await writeFile(exportPath, "not a folder");
    expect(await check({ mayCreate: true })).toEqual({ ok: false, reason: "not-a-directory" });
  });

  test("a file in its place is left as it was", async () => {
    await writeFile(exportPath, "not a folder");
    await check({ mayCreate: true });
    expect(await readFile(exportPath, "utf8")).toBe("not a folder");
  });

  test("a symlink to a file is not a directory", async () => {
    await writeFile(join(dir, "target"), "x");
    await symlink(join(dir, "target"), exportPath);
    expect(await check()).toEqual({ ok: false, reason: "not-a-directory" });
  });

  test("a dangling symlink is missing", async () => {
    await symlink(join(dir, "gone"), exportPath);
    expect(await check()).toEqual({ ok: false, reason: "missing" });
  });

  test("a read-only folder is not writable (the probe cannot be created)", async () => {
    await mkdir(exportPath);
    const fs = faulty({ createExclusive: async () => Promise.reject(errno("EACCES")) });
    expect(await check({ fs })).toEqual({ ok: false, reason: "not-writable" });
  });

  test("a read-only folder gets no marker", async () => {
    await mkdir(exportPath);
    const fs = faulty({ createExclusive: async () => Promise.reject(errno("EROFS")) });
    await check({ fs });
    expect(await readdir(exportPath)).toEqual([]);
  });

  test.skipIf(process.getuid?.() === 0)("a real read-only folder is not writable", async () => {
    await mkdir(exportPath);
    await chmod(exportPath, 0o555);
    expect(await check()).toEqual({ ok: false, reason: "not-writable" });
  });

  test("a probe that is created but cannot be removed is not writable", async () => {
    await mkdir(exportPath);
    const fs = faulty({ remove: async () => Promise.reject(errno("EPERM")) });
    expect(await check({ fs })).toEqual({ ok: false, reason: "not-writable" });
  });

  test("an unexpected error while looking at the folder is a refusal, not a throw", async () => {
    const fs = faulty({ stat: async () => Promise.reject(errno("EIO")) });
    expect(await check({ fs })).toEqual({ ok: false, reason: "not-writable" });
  });

  test("an error that is not even an Error is a refusal, not a throw", async () => {
    const fs = faulty({ stat: async () => Promise.reject("boom") });
    expect(await check({ fs })).toEqual({ ok: false, reason: "not-writable" });
  });
});

describe("the folder must not overlap the library", () => {
  test("the same folder as the library", async () => {
    expect(await check({ exportPath: library })).toEqual({ ok: false, reason: "overlaps-library" });
  });

  test("a folder inside the library", async () => {
    const inside = join(library, "videos-out");
    await mkdir(inside);
    expect(await check({ exportPath: inside })).toEqual({ ok: false, reason: "overlaps-library" });
  });

  test("a folder that contains the library", async () => {
    expect(await check({ exportPath: dir })).toEqual({ ok: false, reason: "overlaps-library" });
  });

  test("a default folder inside the library is refused before anything is created", async () => {
    const inside = join(library, "Studio", "export");
    expect(await check({ exportPath: inside, mayCreate: true })).toEqual({ ok: false, reason: "overlaps-library" });
    expect(await readdir(library)).toEqual([]);
  });

  test("nothing is written into the library by a refused check", async () => {
    await check({ exportPath: library });
    expect(await readdir(library)).toEqual([]);
  });

  test("a symlink that leads into the library is the library", async () => {
    await symlink(library, exportPath);
    expect(await check()).toEqual({ ok: false, reason: "overlaps-library" });
  });

  test("a sibling whose name only starts like the library's is not an overlap", async () => {
    const sibling = join(dir, "library-export");
    await mkdir(sibling);
    expect((await check({ exportPath: sibling })).ok).toBe(true);
  });

  test("a library that does not exist yet does not stop a folder elsewhere", async () => {
    await mkdir(exportPath);
    expect((await check({ libraryPath: join(dir, "not-yet", "library") })).ok).toBe(true);
  });

  test("a folder inside a library that does not exist yet is still an overlap", async () => {
    const future = join(dir, "not-yet", "library");
    expect(await check({ libraryPath: future, exportPath: join(future, "out"), mayCreate: true })).toEqual({ ok: false, reason: "overlaps-library" });
  });

  test("another letter case is an overlap on a case-insensitive disk", async () => {
    const result = await check({ exportPath: join(dir, "LIBRARY-NOT-THERE", "out"), libraryPath: join(dir, "library-not-there"), caseInsensitive: true });
    expect(result).toEqual({ ok: false, reason: "overlaps-library" });
  });
});

describe("the root marker", () => {
  async function seed(content: string | Uint8Array): Promise<void> {
    await mkdir(exportPath);
    await writeFile(join(exportPath, EXPORT_MARKER_FILE), content);
  }

  test.each([
    ["JSON that does not parse", "{not json"],
    ["an empty file", ""],
    ["a JSON array", "[]"],
    ["a JSON null", "null"],
    ["a missing rootId", JSON.stringify({ schemaVersion: 1, createdAt: "2026-09-29T12:00:00.000Z" })],
    ["a rootId that is not an id", JSON.stringify({ schemaVersion: 1, rootId: "../x", createdAt: "2026-09-29T12:00:00.000Z" })],
    ["a createdAt that is not a time", JSON.stringify({ schemaVersion: 1, rootId: "root-00000009", createdAt: "yesterday" })],
    ["no schemaVersion", JSON.stringify({ rootId: "root-00000009", createdAt: "2026-09-29T12:00:00.000Z" })],
    ["a schemaVersion of 0", JSON.stringify({ schemaVersion: 0, rootId: "root-00000009", createdAt: "2026-09-29T12:00:00.000Z" })],
    ["a fractional schemaVersion", JSON.stringify({ schemaVersion: 1.5, rootId: "root-00000009", createdAt: "2026-09-29T12:00:00.000Z" })],
    ["a schemaVersion that is a string", JSON.stringify({ schemaVersion: "1", rootId: "root-00000009", createdAt: "2026-09-29T12:00:00.000Z" })],
    ["binary junk", new Uint8Array([0, 255, 254, 1, 2])],
    ["a file far too large", "x".repeat(100_000)],
  ])("%s is an invalid marker", async (_label, content) => {
    await seed(content);
    expect(await check()).toEqual({ ok: false, reason: "invalid-marker" });
  });

  test("a version 1 marker with a field this build does not know is still valid, and is not rewritten", async () => {
    const text = JSON.stringify({ schemaVersion: 1, rootId: "root-00000009", createdAt: "2026-09-29T12:00:00.000Z", label: "future" });
    await seed(text);
    expect(await check()).toEqual({ ok: true, rootId: "root-00000009", root: exportPath });
    expect(await readFile(join(exportPath, EXPORT_MARKER_FILE), "utf8")).toBe(text);
  });

  test("a marker of a newer schema version is refused as newer-marker, not as damaged", async () => {
    await seed(JSON.stringify({ schemaVersion: 2, rootId: "root-00000009", createdAt: "2026-09-29T12:00:00.000Z", shards: [1] }));
    expect(await check()).toEqual({ ok: false, reason: "newer-marker" });
  });

  test("a newer marker is judged by its version alone, whatever else it holds", async () => {
    await seed(JSON.stringify({ schemaVersion: 7, somethingElse: true }));
    expect(await check()).toEqual({ ok: false, reason: "newer-marker" });
  });

  test("a newer marker is left as it was", async () => {
    const text = JSON.stringify({ schemaVersion: 2, rootId: "root-00000009" });
    await seed(text);
    await check();
    expect(await readFile(join(exportPath, EXPORT_MARKER_FILE), "utf8")).toBe(text);
  });

  test("a marker that is a symlink to another root's marker is invalid, not adopted", async () => {
    await mkdir(exportPath);
    const other = join(dir, "other-marker.json");
    await writeFile(other, JSON.stringify({ schemaVersion: 1, rootId: "another-root-1", createdAt: "2026-09-29T12:00:00.000Z" }));
    await symlink(other, join(exportPath, EXPORT_MARKER_FILE));
    expect(await check()).toEqual({ ok: false, reason: "invalid-marker" });
  });

  test.skipIf(process.platform === "win32")("a FIFO swapped in as the marker is invalid and the check does not block", async () => {
    await mkdir(exportPath);
    spawnSync("mkfifo", [join(exportPath, EXPORT_MARKER_FILE)]);
    expect(await check()).toEqual({ ok: false, reason: "invalid-marker" });
  });

  test("an invalid marker is never replaced", async () => {
    await seed("{not json");
    await check();
    expect(await readFile(join(exportPath, EXPORT_MARKER_FILE), "utf8")).toBe("{not json");
  });

  test("a directory in the marker's place is an invalid marker", async () => {
    await mkdir(join(exportPath, EXPORT_MARKER_FILE), { recursive: true });
    expect(await check()).toEqual({ ok: false, reason: "invalid-marker" });
  });

  test("a marker that cannot be read is an invalid marker", async () => {
    await seed(JSON.stringify({ rootId: "root-00000009", createdAt: "2026-09-29T12:00:00.000Z" }));
    const fs = faulty({ readSmallFile: async () => Promise.reject(errno("EACCES")) });
    expect(await check({ fs })).toEqual({ ok: false, reason: "invalid-marker" });
  });

  test("a marker written by a racing check is adopted", async () => {
    await mkdir(exportPath);
    let reads = 0;
    const raced = JSON.stringify({ schemaVersion: 1, rootId: "the-winner", createdAt: "2026-09-29T11:59:59.000Z" });
    const fs = faulty({
      readSmallFile: async (path, max) => {
        reads++;
        if (reads === 1) throw errno("ENOENT");
        return raced.length <= max ? raced : "";
      },
      publishExclusive: async () => {
        throw errno("EEXIST");
      },
    });
    expect(await check({ fs })).toEqual({ ok: true, rootId: "the-winner", root: exportPath });
  });

  test("a newId that is not a valid id throws instead of writing a marker the next read would reject", async () => {
    await mkdir(exportPath);
    await expect(check({ newId: () => "BAD ID" })).rejects.toThrow();
    expect(await readdir(exportPath)).toEqual([]);
  });
});

describe("the probe", () => {
  test("a probe file this call did not create is not removed", async () => {
    await mkdir(exportPath);
    const removed: string[] = [];
    const fs = faulty({
      createExclusive: async () => Promise.reject(errno("EEXIST")),
      remove: async (path) => {
        removed.push(path);
      },
    });
    expect(await check({ fs })).toEqual({ ok: false, reason: "not-writable" });
    expect(removed).toEqual([]);
  });

  test("a probe this call created is removed even when a later step fails", async () => {
    await mkdir(exportPath);
    const removed: string[] = [];
    const fs = faulty({
      remove: async (path) => {
        removed.push(path);
        if (removed.length === 1) throw errno("EPERM");
      },
    });
    await check({ fs });
    expect(removed.length).toBe(2);
  });
});

describe("concurrent checks on a fresh folder", () => {
  test("thirty at once all succeed with one root id (nobody reads a half-written marker)", async () => {
    await mkdir(exportPath);
    const results = await Promise.all(Array.from({ length: 30 }, () => check()));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(new Set(results.map((r) => (r.ok ? r.rootId : "")))).toHaveProperty("size", 1);
  });

  test("the marker on disk is the one every check reports", async () => {
    await mkdir(exportPath);
    const results = await Promise.all(Array.from({ length: 10 }, () => check()));
    const onDisk = ExportMarker.parse(await marker()).rootId;
    expect(results.every((r) => r.ok && r.rootId === onDisk)).toBe(true);
  });
});

describe("publishFileExclusive", () => {
  const real: PublishOps = { open: fsOpen, link: fsLink, unlink: fsUnlink };

  test("publishes the whole content and leaves no temp file", async () => {
    await mkdir(exportPath);
    const target = join(exportPath, "m.json");
    await publishFileExclusive(target, "hello", real);
    expect(await readFile(target, "utf8")).toBe("hello");
    expect(await readdir(exportPath)).toEqual(["m.json"]);
  });

  test("rejects with EEXIST and leaves an existing file alone", async () => {
    await mkdir(exportPath);
    const target = join(exportPath, "m.json");
    await writeFile(target, "mine");
    await expect(publishFileExclusive(target, "theirs", real)).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(target, "utf8")).toBe("mine");
    expect(await readdir(exportPath)).toEqual(["m.json"]);
  });

  test("a write that fails leaves nothing under the final name", async () => {
    await mkdir(exportPath);
    const target = join(exportPath, "m.json");
    const failing: PublishOps = {
      ...real,
      open: async (path, flags) => {
        const handle = await fsOpen(path, flags);
        return Object.assign(handle, {
          writeFile: async () => {
            throw errno("ENOSPC");
          },
        });
      },
    };
    await expect(publishFileExclusive(target, "hello", failing)).rejects.toMatchObject({ code: "ENOSPC" });
    expect(await readdir(exportPath)).toEqual([]);
  });

  test.each(["EISDIR", "EPERM", "ENOTSUP", "EIO", "EACCES", "ENOSYS", "EXDEV"])("a link() failing with %s falls back to an exclusive create (exFAT reports EISDIR)", async (code) => {
    await mkdir(exportPath);
    const target = join(exportPath, "m.json");
    await publishFileExclusive(target, "hello", { ...real, link: async () => Promise.reject(errno(code)) });
    expect(await readFile(target, "utf8")).toBe("hello");
    expect(await readdir(exportPath)).toEqual(["m.json"]);
  });

  test("a link() failing with EEXIST is a collision, not a reason to fall back", async () => {
    await mkdir(exportPath);
    const target = join(exportPath, "m.json");
    await writeFile(target, "mine");
    let opens = 0;
    const counting: PublishOps = { ...real, open: async (path, flags) => (opens++, fsOpen(path, flags)) };
    await expect(publishFileExclusive(target, "theirs", counting)).rejects.toMatchObject({ code: "EEXIST" });
    expect(opens).toBe(1);
  });

  test("when the fallback create then fails for a real reason, that reason is reported", async () => {
    await mkdir(exportPath);
    const target = join(exportPath, "m.json");
    const noSpace: PublishOps = {
      ...real,
      link: async () => Promise.reject(errno("EISDIR")),
      open: async (path, flags) => {
        if (path === target) throw errno("ENOSPC");
        return fsOpen(path, flags);
      },
    };
    await expect(publishFileExclusive(target, "hello", noSpace)).rejects.toMatchObject({ code: "ENOSPC" });
    expect(await readdir(exportPath)).toEqual([]);
  });

  test("on a volume without hard links it falls back to an exclusive create", async () => {
    await mkdir(exportPath);
    const target = join(exportPath, "m.json");
    const noLinks: PublishOps = { ...real, link: async () => Promise.reject(errno("EPERM")) };
    await publishFileExclusive(target, "hello", noLinks);
    expect(await readFile(target, "utf8")).toBe("hello");
    expect(await readdir(exportPath)).toEqual(["m.json"]);
  });

  test("the fallback still refuses to overwrite", async () => {
    await mkdir(exportPath);
    const target = join(exportPath, "m.json");
    await writeFile(target, "mine");
    const noLinks: PublishOps = { ...real, link: async () => Promise.reject(errno("ENOTSUP")) };
    await expect(publishFileExclusive(target, "theirs", noLinks)).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(target, "utf8")).toBe("mine");
  });

  test("a failed fallback write removes the half-written file", async () => {
    await mkdir(exportPath);
    const target = join(exportPath, "m.json");
    const broken: PublishOps = {
      link: async () => Promise.reject(errno("EPERM")),
      unlink: fsUnlink,
      open: async (path, flags) => {
        const handle = await fsOpen(path, flags);
        // Only the final file's write fails: the temp file was written fine and hard links are what is missing.
        if (path !== target) return handle;
        return Object.assign(handle, {
          writeFile: async () => {
            throw errno("EIO");
          },
        });
      },
    };
    await expect(publishFileExclusive(target, "hello", broken)).rejects.toMatchObject({ code: "EIO" });
    expect(await readdir(exportPath)).toEqual([]);
  });
});

describe("createFileExclusive", () => {
  const real: PublishOps = { open: fsOpen, link: fsLink, unlink: fsUnlink };

  test("a write that fails after the file was created removes the file (a probe is never left behind)", async () => {
    await mkdir(exportPath);
    const target = join(exportPath, "probe");
    const failing: PublishOps = {
      ...real,
      open: async (path, flags) => Object.assign(await fsOpen(path, flags), { writeFile: async () => Promise.reject(errno("ENOSPC")) }),
    };
    await expect(createFileExclusive(target, "x", failing)).rejects.toMatchObject({ code: "ENOSPC" });
    expect(await readdir(exportPath)).toEqual([]);
  });

  test("a sync that fails after the file was created removes the file", async () => {
    await mkdir(exportPath);
    const target = join(exportPath, "probe");
    const failing: PublishOps = {
      ...real,
      open: async (path, flags) => Object.assign(await fsOpen(path, flags), { sync: async () => Promise.reject(errno("EIO")) }),
    };
    await expect(createFileExclusive(target, "x", failing)).rejects.toMatchObject({ code: "EIO" });
    expect(await readdir(exportPath)).toEqual([]);
  });

  test("an existing file is reported as EEXIST and is not removed", async () => {
    await mkdir(exportPath);
    const target = join(exportPath, "probe");
    await writeFile(target, "someone else's");
    await expect(createFileExclusive(target, "x", real)).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(target, "utf8")).toBe("someone else's");
  });
});

describe("readSmallRegularFile", () => {
  test("reads a regular file", async () => {
    await mkdir(exportPath);
    await writeFile(join(exportPath, "m"), "hello");
    expect(await readSmallRegularFile(join(exportPath, "m"), 100)).toBe("hello");
  });

  test("a file with a second hard link is refused (it could be another root's marker)", async () => {
    await mkdir(exportPath);
    await writeFile(join(dir, "theirs"), "hello");
    await fsLink(join(dir, "theirs"), join(exportPath, "m"));
    await expect(readSmallRegularFile(join(exportPath, "m"), 100)).rejects.toThrow();
  });

  test("a symlink is refused even where the platform has no O_NOFOLLOW (lstat first)", async () => {
    await mkdir(exportPath);
    await writeFile(join(dir, "theirs"), "hello");
    await symlink(join(dir, "theirs"), join(exportPath, "m"));
    await expect(readSmallRegularFile(join(exportPath, "m"), 100, 0)).rejects.toThrow();
  });

  test("a missing file still rejects with ENOENT, so an absent marker is told from a bad one", async () => {
    await mkdir(exportPath);
    await expect(readSmallRegularFile(join(exportPath, "nope"), 100, 0)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("a hard-linked marker", () => {
  test("is an invalid marker, not another root's identity", async () => {
    await mkdir(exportPath);
    await writeFile(join(dir, "theirs.json"), JSON.stringify({ schemaVersion: 1, rootId: "another-root-1", createdAt: "2026-09-29T12:00:00.000Z" }));
    await fsLink(join(dir, "theirs.json"), join(exportPath, EXPORT_MARKER_FILE));
    expect(await check()).toEqual({ ok: false, reason: "invalid-marker" });
  });
});

describe("free space", () => {
  test("twice the estimate is required: free space below it is refused", async () => {
    await mkdir(exportPath);
    const fs = faulty({ freeBytes: async () => 199 });
    expect(await check({ fs, requiredBytes: 100 })).toEqual({ ok: false, reason: "not-enough-space" });
  });

  test("exactly twice the estimate is enough", async () => {
    await mkdir(exportPath);
    const fs = faulty({ freeBytes: async () => 200 });
    expect((await check({ fs, requiredBytes: 100 })).ok).toBe(true);
  });

  test("free space that cannot be read does not block a render", async () => {
    await mkdir(exportPath);
    const fs = faulty({ freeBytes: async () => null });
    expect((await check({ fs, requiredBytes: 100 })).ok).toBe(true);
  });

  test("without an estimate the free space is not even asked for", async () => {
    await mkdir(exportPath);
    const fs = faulty({
      freeBytes: async () => {
        throw new Error("must not be called");
      },
    });
    expect((await check({ fs })).ok).toBe(true);
  });

  test("the real disk answers a number", async () => {
    const free = await NODE_EXPORT_ROOT_FS.freeBytes(dir);
    expect(typeof free === "number" && free > 0).toBe(true);
  });
});

describe("exportStatusOf", () => {
  test("a usable folder is ok", () => {
    expect(exportStatusOf({ ok: true, rootId: "root-00000001", root: "/x" })).toEqual({ status: "ok" });
  });

  test("a refusal carries its reason, in the shape the snapshot parses", () => {
    const status = exportStatusOf({ ok: false, reason: "overlaps-library" });
    expect(status).toEqual({ status: "unavailable", reason: "overlaps-library" });
    expect(ExportStatus.safeParse(status).success).toBe(true);
  });
});

describe("pathsOverlap", () => {
  test.each([
    ["the same path", "/a/b", "/a/b", true],
    ["a child", "/a/b", "/a/b/c", true],
    ["a parent", "/a/b/c", "/a/b", true],
    ["a name that only starts alike", "/a/lib", "/a/lib2", false],
    ["a sibling", "/a/x", "/a/y", false],
    ["a trailing slash", "/a/b/", "/a/b", true],
    ["a dot-dot that walks out", "/a/b/../c", "/a/b", false],
  ])("posix: %s", (_label, a, b, expected) => {
    expect(pathsOverlap(a, b, { api: posix, caseInsensitive: false })).toBe(expected);
  });

  test("posix: another letter case is another folder when the disk is case-sensitive", () => {
    expect(pathsOverlap("/A/B", "/a/b/c", { api: posix, caseInsensitive: false })).toBe(false);
  });

  test("posix: another letter case is the same folder when the disk is case-insensitive", () => {
    expect(pathsOverlap("/A/B", "/a/b/c", { api: posix, caseInsensitive: true })).toBe(true);
  });

  test.each([
    ["another drive letter case", "C:\\Studio\\Lib", "c:\\studio\\lib\\out", true],
    ["another drive", "C:\\Studio\\Lib", "D:\\Studio\\Lib", false],
    ["a name that only starts alike", "C:\\Lib", "C:\\Library", false],
    ["a trailing backslash", "C:\\Lib\\", "C:\\Lib\\out", true],
  ])("win32: %s", (_label, a, b, expected) => {
    expect(pathsOverlap(a, b, { api: win32, caseInsensitive: true })).toBe(expected);
  });
});
