import { describe, expect, test } from "bun:test";
import { existsSync, linkSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { NODE_COMMIT_FS } from "./commitFs";
import { recoverVideos } from "./recovery";
import { videoPaths } from "./record";
import { CrashError, errnoError, exportFiles, failureOf, FINAL, libraryVideoFiles, rig, useWorld, type Rig } from "./testing/kit";
useNativeGlobals();

// Review round 1 of 3a.8b.1 (security and state-machine reviews), commit side:
// the name is only ever touched while it is OUR inode, a record that exists is
// never rolled back, and a folder check that fails after the claim keeps the intent.

const world = useWorld();
const OWNER = Buffer.from("OWNER'S OWN VIDEO - precious bytes, not Studio's\n".repeat(50));
const rootRef = (r: Rig) => ({ root: r.w.exportRoot, rootId: r.w.rootId, caseInsensitive: false });

/** Puts an owner's file where our placeholder was, the way another process could between two steps. */
function swapInOwnerFile(r: Rig): void {
  const finalPath = join(r.w.exportRoot, FINAL);
  unlinkSync(finalPath);
  writeFileSync(finalPath, OWNER);
}
const ownerSurvives = (r: Rig): boolean => existsSync(join(r.w.exportRoot, FINAL)) && readFileSync(join(r.w.exportRoot, FINAL)).equals(OWNER);

describe("placeholder identity: only our own inode is renamed over or removed", () => {
  test("an owner's file that replaced the placeholder is refused before the rename, and survives", async () => {
    const r = await rig(world);
    const error = await failureOf(r.run({ hooks: { reached: (step) => (step === "intent-written" ? swapInOwnerFile(r) : undefined) } }));
    expect(error).toMatchObject({ engineError: { code: "EXPORT_UNAVAILABLE", exportReason: "not-writable" } });
    expect(ownerSurvives(r)).toBe(true);
    expect(await libraryVideoFiles(r.w)).toEqual([]);
  });

  test("the same swap with a rename that fails: the rollback leaves the owner's file", async () => {
    const r = await rig(world);
    r.fs.override({
      rename: async (from, to) => {
        if (from === r.temp) {
          swapInOwnerFile(r);
          throw errnoError("EIO");
        }
        return NODE_COMMIT_FS.rename(from, to);
      },
    });
    await failureOf(r.run());
    expect(ownerSurvives(r)).toBe(true);
  });

  test("a file swapped in right after the rename is refused, and the rollback leaves it", async () => {
    const r = await rig(world);
    const error = await failureOf(r.run({ hooks: { reached: (step) => (step === "renamed" ? swapInOwnerFile(r) : undefined) } }));
    expect(error).toMatchObject({ engineError: { code: "EXPORT_UNAVAILABLE" } });
    expect(ownerSurvives(r)).toBe(true);
    expect(await libraryVideoFiles(r.w)).not.toContain(`${r.input.videoId}.json`);
  });

  test("a hard link to an owner's file in place of the placeholder is refused, and the owner's original is intact", async () => {
    const r = await rig(world);
    const original = join(r.w.dir, "owner-original.mp4");
    writeFileSync(original, OWNER);
    await failureOf(
      r.run({
        hooks: {
          reached: (step) => {
            if (step === "intent-written") {
              unlinkSync(join(r.w.exportRoot, FINAL));
              linkSync(original, join(r.w.exportRoot, FINAL));
            }
          },
        },
      }),
    );
    expect(readFileSync(original).equals(OWNER)).toBe(true);
    expect(readFileSync(join(r.w.exportRoot, FINAL)).equals(OWNER)).toBe(true);
  });

  test("a rename that reports EXDEV fails EXPORT_UNAVAILABLE and leaves a clean folder: temp and placeholder share a folder, so there is no copy fallback", async () => {
    const r = await rig(world);
    r.fs.failOnce("rename", errnoError("EXDEV"), (args) => args[0] === r.temp);
    const error = await failureOf(r.run());
    expect(error).toMatchObject({ engineError: { code: "EXPORT_UNAVAILABLE", exportReason: "not-writable" } });
    expect(await exportFiles(r.w)).toEqual([]);
    expect(await libraryVideoFiles(r.w)).toEqual([]);
    expect(Object.keys(r.fs)).not.toContain("copyOver");
  });
});

describe("a record that already exists is never rolled back", () => {
  test("EEXIST for the same video (the record is ours already): the commit ends done and nothing is deleted", async () => {
    const r = await rig(world);
    const paths = videoPaths(r.w.libraryRoot, r.w.avatar.id);
    let record = "";
    // The record for this very video appears while the commit is at its last step (e.g. a recovery adopted it).
    const out = await r.run({
      hooks: {
        reached: async (step) => {
          if (step === "dir-synced") {
            record = await readFile(paths.intent(r.input.videoId), "utf8");
            writeFileSync(paths.record(r.input.videoId), record);
          }
        },
      },
    });
    expect(out.record.file.relPath).toBe(FINAL);
    expect(existsSync(join(r.w.exportRoot, FINAL))).toBe(true);
    expect(existsSync(paths.record(r.input.videoId))).toBe(true);
  });

  test("EEXIST for another record under our id: the commit fails and deletes NOTHING", async () => {
    const r = await rig(world);
    const paths = videoPaths(r.w.libraryRoot, r.w.avatar.id);
    const error = await failureOf(
      r.run({
        hooks: {
          reached: (step) => {
            if (step === "dir-synced") writeFileSync(paths.record(r.input.videoId), "someone else's record");
          },
        },
      }),
    );
    expect(error).toMatchObject({ engineError: { code: "INTERNAL" } });
    expect(existsSync(join(r.w.exportRoot, FINAL))).toBe(true);
    expect(await readFile(paths.record(r.input.videoId), "utf8")).toBe("someone else's record");
  });

  test("a failed fsync of .pending after the record exists is only logged: the commit is done", async () => {
    const r = await rig(world);
    const paths = videoPaths(r.w.libraryRoot, r.w.avatar.id);
    let pendingSyncs = 0;
    r.fs.override({
      fsyncDir: async (path) => {
        if (path === paths.pendingDir && ++pendingSyncs === 2) throw errnoError("EIO");
        return NODE_COMMIT_FS.fsyncDir(path);
      },
    });
    const out = await r.run();
    expect(out.result.relPath).toBe(FINAL);
    expect(await libraryVideoFiles(r.w)).toEqual([`${r.input.videoId}.json`]);
    expect(r.logs.join("\n")).toContain("EIO");
  });

  test("a failed fsync of videos/ is retried once; and if it keeps failing the video still counts as committed", async () => {
    const r = await rig(world);
    const paths = videoPaths(r.w.libraryRoot, r.w.avatar.id);
    let linked = false;
    r.fs.override({
      fsyncDir: async (path) => {
        if (linked && path === paths.videosDir) throw errnoError("EIO");
        return NODE_COMMIT_FS.fsyncDir(path);
      },
    });
    const out = await r.run({ hooks: { reached: (step) => void (linked = linked || step === "record-linked") } });
    expect(out.result.relPath).toBe(FINAL);
    expect(existsSync(join(r.w.exportRoot, FINAL))).toBe(true);
    expect(r.fs.calls.slice(r.fs.calls.findIndex((c) => c.startsWith("link "))).filter((c) => c === `fsyncDir ${paths.videosDir}`)).toHaveLength(2); // the flush and its one retry
  });

  test("killed after the record is linked but before the intent is removed: recovery drops the intent and the record stands", async () => {
    const r = await rig(world);
    await failureOf(
      r.run({
        hooks: {
          reached: (step) => {
            if (step === "record-linked") {
              r.fs.die();
              throw new CrashError(step);
            }
          },
        },
      }),
    );
    expect((await libraryVideoFiles(r.w)).sort()).toEqual([`.pending/${r.input.videoId}.json`, `${r.input.videoId}.json`]);
    const library = await r.w.reopen();
    await recoverVideos({ library, exportRoot: rootRef(r) });
    expect(await libraryVideoFiles(r.w)).toEqual([`${r.input.videoId}.json`]);
    expect(library.photoStates(r.w.avatar.id).get(r.w.photos[0]?.id ?? "")?.usedIn).toEqual([r.input.videoId]);
  });
});

describe("a folder check that fails after the claim keeps the intent (recovery decides)", () => {
  test("EIO from realpath after the rename: neither the finished video nor its intent is thrown away, and recovery adopts it", async () => {
    const r = await rig(world);
    let failing = false;
    r.fs.override({
      realpath: async (path) => {
        if (failing) throw errnoError("EIO");
        return NODE_COMMIT_FS.realpath(path);
      },
    });
    await failureOf(r.run({ hooks: { reached: (step) => void (failing = failing || step === "renamed") } }));
    expect(existsSync(join(r.w.exportRoot, FINAL))).toBe(true);
    expect(await libraryVideoFiles(r.w)).toEqual([`.pending/${r.input.videoId}.json`]);
    expect(r.logs.join("\n")).toContain("EIO");
    const library = await r.w.reopen();
    const report = await recoverVideos({ library, exportRoot: rootRef(r) });
    expect(report.adopted).toEqual([r.input.videoId]);
  });
});

describe("rollback is durable and survives a crash at every step", () => {
  test("after the rollback's unlinks the export folder and .pending are flushed", async () => {
    const r = await rig(world);
    r.fs.failOnce("rename", errnoError("EACCES"), (args) => args[0] === r.temp);
    await failureOf(r.run());
    const paths = videoPaths(r.w.libraryRoot, r.w.avatar.id);
    const lastUnlink = r.fs.calls.map((c, i) => (c.startsWith("unlink") ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
    expect(r.fs.calls.slice(lastUnlink + 1)).toEqual(expect.arrayContaining([`fsyncDir ${join(r.w.exportRoot, "Mia")}`, `fsyncDir ${paths.pendingDir}`]));
  });

  test.each([0, 1, 2, 3, 4, 5, 6, 7, 8])("a crash at the rollback's disk call #%d leaves a state recovery settles to a clean folder, no record and free photos", async (k) => {
    const r = await rig(world);
    r.fs.failOnce("rename", errnoError("EACCES"), (args) => args[0] === r.temp);
    let armed = false;
    let seen = 0;
    const wrap = <A extends unknown[], T>(fn: (...a: A) => Promise<T>) => async (...a: A): Promise<T> => {
      if (armed && seen++ === k) {
        r.fs.die();
        throw new CrashError(`rollback call ${k}`);
      }
      return fn(...a);
    };
    r.fs.override({
      unlink: wrap((p: string) => NODE_COMMIT_FS.unlink(p)),
      fsyncDir: wrap((p: string) => NODE_COMMIT_FS.fsyncDir(p)),
      lstat: wrap((p: string) => NODE_COMMIT_FS.lstat(p)),
      realpath: wrap((p: string) => NODE_COMMIT_FS.realpath(p)),
    });
    // The rename failure is the moment the rollback starts.
    const original = NODE_COMMIT_FS.rename;
    r.fs.override({
      rename: async (from, to) => {
        if (from === r.temp) {
          armed = true;
          throw errnoError("EACCES");
        }
        return original(from, to);
      },
    });
    await failureOf(r.run());
    const library = await r.w.reopen();
    await recoverVideos({ library, exportRoot: rootRef(r) });
    expect(await exportFiles(r.w)).toEqual([]);
    expect(await libraryVideoFiles(r.w)).toEqual([]);
    expect(library.photoStates(r.w.avatar.id).get(r.w.photos[0]?.id ?? "")?.usedIn).toEqual([]);
  });
});
