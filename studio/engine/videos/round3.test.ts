import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { commitVideo } from "./commit";
import { NODE_COMMIT_FS } from "./commitFs";
import { deleteVideo } from "./delete";
import { FileStateChecker } from "./fileState";
import { commitIntent, writeIntent } from "./intents";
import { CommitTracker } from "./live";
import { withRootLock } from "./rootLock";
import { videoPaths } from "./record";
import { recoverVideos, type ExportRootRef } from "./recovery";
import { CrashError, errnoError, exportFiles, failureOf, fakeVideoBytes, FINAL, libraryVideoFiles, openFolder, rig, sampleRecord, unhandledRejectionsDuring, useWorld, writeTemp, type Rig, type World } from "./testing/kit";
useNativeGlobals();

// Round 3 (the last) of 3a.8b.1: the write-once commit must work where hard links do not exist,
// and the small hardening the second review asked for.

const world = useWorld();
const rootRef = (w: World): ExportRootRef => ({ root: w.exportRoot, rootId: w.rootId, caseInsensitive: false });
const usedIn = (w: World, library: { photoStates(id: string): Map<string, { usedIn: string[] }> }): string[] => library.photoStates(w.avatar.id).get(w.photos[0]?.id ?? "")?.usedIn ?? [];
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const kill = (r: Rig, at: string) => ({ reached: (step: string): void => { if (step === at) { r.fs.die(); throw new CrashError(step); } } });

describe("B1: a library without hard links (exFAT, FAT32, some SMB)", () => {
  test.each(["ENOTSUP", "EPERM", "EISDIR"])("the commit still commits when link fails with %s: the record is written by an exclusive rename", async (code) => {
    const r = await rig(world);
    r.fs.override({ link: () => Promise.reject(errnoError(code)) });
    const out = await r.run();
    expect(out.result.relPath).toBe(FINAL);
    expect(await exportFiles(r.w)).toEqual([FINAL]);
    expect(await libraryVideoFiles(r.w)).toEqual([`${r.input.videoId}.json`]);
    expect(usedIn(r.w, await r.w.reopen())).toEqual([r.input.videoId]);
  });

  test.each(["ENOTSUP", "EPERM", "EISDIR"])("recovery adopts an intent when link fails with %s", async (code) => {
    const r = await rig(world);
    await failureOf(r.run({ hooks: kill(r, "dir-synced") }));
    const library = await r.w.reopen();
    const fs = { ...NODE_COMMIT_FS, link: () => Promise.reject(errnoError(code)) };
    const report = await recoverVideos({ library, exportRoot: rootRef(r.w) }, { fs });
    expect(report.adopted).toEqual([r.input.videoId]);
    expect(await libraryVideoFiles(r.w)).toEqual([`${r.input.videoId}.json`]);
    expect(usedIn(r.w, library)).toEqual([r.input.videoId]);
  });

  test("the fallback never replaces a record that exists: EEXIST, and the intent stays", async () => {
    const w = world();
    const record = sampleRecord(w);
    await writeIntent(NODE_COMMIT_FS, w.libraryRoot, record);
    const paths = videoPaths(w.libraryRoot, w.avatar.id);
    writeFileSync(paths.record(record.id), "the earlier record");
    const fs = { ...NODE_COMMIT_FS, link: () => Promise.reject(errnoError("ENOTSUP")) };
    await expect(commitIntent(fs, w.libraryRoot, w.avatar.id, record.id)).rejects.toMatchObject({ code: "EEXIST" });
    expect(readFileSync(paths.record(record.id), "utf8")).toBe("the earlier record");
    expect(existsSync(paths.intent(record.id))).toBe(true);
  });

  test("a link that reports an error after it linked, with a record lookup that fails too: nothing is rolled back", async () => {
    const r = await rig(world);
    const paths = videoPaths(r.w.libraryRoot, r.w.avatar.id);
    let linked = false;
    r.fs.override({
      link: async (a, b) => {
        await NODE_COMMIT_FS.link(a, b);
        linked = true;
        throw errnoError("EIO");
      },
      lstat: async (p) => {
        if (linked && p === paths.record(r.input.videoId)) throw errnoError("EIO");
        return NODE_COMMIT_FS.lstat(p);
      },
    });
    const out = await r.run();
    expect(out.result.relPath).toBe(FINAL);
    expect(existsSync(join(r.w.exportRoot, FINAL))).toBe(true);
    expect(existsSync(paths.record(r.input.videoId))).toBe(true);
  });
});

describe("removeIfOurs: identity AND shape (FAT reuses inodes)", () => {
  test("a name that reports our inode but is not the file we placed is left alone", async () => {
    const r = await rig(world);
    const finalPath = join(r.w.exportRoot, FINAL);
    const ours = await NODE_COMMIT_FS.lstat(r.temp);
    const OWNER = Buffer.from("owner's file that got our old inode ".repeat(20));
    let swapped = false;
    r.fs.override({
      lstat: async (p) => {
        const facts = await NODE_COMMIT_FS.lstat(p);
        return swapped && p === finalPath ? { ...facts, dev: ours.dev, ino: ours.ino } : facts; // the reused inode, once the owner's file is there
      },
    });
    await failureOf(
      r.run({
        hooks: {
          reached: (step) => {
            if (step === "renamed") {
              unlinkSync(finalPath);
              writeFileSync(finalPath, OWNER);
              swapped = true;
            }
          },
        },
      }),
    );
    expect(readFileSync(finalPath).equals(OWNER)).toBe(true);
  });

  test("the identity is the exact one from the disk: two inodes that are equal as doubles are not equal as identities", async () => {
    const identity = await NODE_COMMIT_FS.createExclusive(join(world().dir, "x"));
    expect(typeof identity.ino).toBe("string");
    expect(identity.ino).toBe(String(statSync(join(world().dir, "x"), { bigint: true }).ino));
  });
});

describe("the lock key ignores the case flag, and waits are bounded and abortable", () => {
  test("a commit that thinks the volume folds case and a recovery that thinks it does not still exclude each other", async () => {
    const w = world();
    const r = await rig(world);
    let recovery: ReturnType<typeof recoverVideos> | undefined;
    const target = { ...r.target(), caseInsensitive: true };
    const tracker = new CommitTracker();
    tracker.addJob(r.input.jobId, r.input.videoId);
    tracker.addTemp(r.temp);
    const out = await commitVideo(target, r.input, {
      fs: r.fs,
      libraryRoot: w.libraryRoot,
      library: w.library,
      verify: async (path) => (await import("./testing/kit")).acceptingVerify(path),
      onClaimed: (p) => tracker.addPlaceholder(p),
      hooks: {
        reached: async (step) => {
          if (step !== "intent-written") return;
          recovery = recoverVideos({ library: w.library, exportRoot: { ...rootRef(w), caseInsensitive: false } }); // no live tracker: only the lock protects the commit
          await sleep(40);
        },
      },
    });
    const report = await recovery;
    expect(out.record.file.relPath).toBe(FINAL);
    expect(report).toMatchObject({ adopted: [], dropped: [], removed: { placeholders: 0 } });
    expect(await exportFiles(w)).toEqual([FINAL]);
  });

  test("a commit waiting for the lock honours its cancel and ends with the abort reason", async () => {
    const a = await rig(world);
    const b = await rig(world, { input: { jobId: "job-00000002", videoId: "video-00000002" } });
    const seen = await unhandledRejectionsDuring(async () => {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let holding: () => void = () => undefined;
      const holdsTheLock = new Promise<void>((resolve) => (holding = resolve));
      let queuing: () => void = () => undefined;
      const isQueuing = new Promise<void>((resolve) => (queuing = resolve));
      const outcome = (promise: Promise<unknown>): Promise<unknown> => promise.then(() => "done", (e: unknown) => e);
      // Ordered by the commits' own hooks, never by sleeping: on a slow runner the first commit may not have the lock after 40 ms.
      const first = a.run({
        hooks: {
          reached: async (step) => {
            if (step !== "name-claimed") return;
            holding(); // past the claim, so inside the lock
            await gate;
          },
        },
      });
      const firstOutcome = outcome(first);
      try {
        await Promise.race([holdsTheLock, firstOutcome.then((e) => Promise.reject(new Error(`the first commit ended before it held the lock: ${String(e)}`)))]);
        const controller = new AbortController();
        const reason = new Error("cancelled while waiting");
        const second = outcome(
          b.run({
            signal: controller.signal,
            hooks: { reached: (step) => (step === "temp-synced" ? queuing() : undefined) }, // the last step before it asks for the lock
          }),
        );
        await Promise.race([isQueuing, second.then((e) => Promise.reject(new Error(`the second commit ended before it queued: ${String(e)}`)))]);
        controller.abort(reason);
        expect(await second).toBe(reason);
        expect(existsSync(b.temp)).toBe(false); // its temp is removed, nothing was claimed
      } finally {
        release();
        await firstOutcome; // a commit this test started is always settled here, even when an assertion above failed
      }
      expect((await first).result.relPath).toBe(FINAL);
      expect(await exportFiles(a.w)).toEqual([FINAL]);
    });
    expect(seen).toEqual([]);
  });

  test("a waiter that gave up leaves nothing unobserved when the lock later comes free for its abandoned turn", async () => {
    const w = world();
    const seen = await unhandledRejectionsDuring(async () => {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let holding: () => void = () => undefined;
      const holdsTheLock = new Promise<void>((resolve) => (holding = resolve));
      const holder = withRootLock(NODE_COMMIT_FS, w.exportRoot, async () => {
        holding();
        await gate;
      });
      let ran = false;
      try {
        await holdsTheLock;
        const waiter = await failureOf(
          withRootLock(
            NODE_COMMIT_FS,
            w.exportRoot,
            async () => {
              ran = true;
            },
            { waitMs: 10 },
          ),
        );
        expect((waiter as Error).name).toBe("LockWaitTimeout");
      } finally {
        release();
        await holder.catch(() => undefined);
      }
      expect(ran).toBe(false); // the abandoned turn never runs the work, and its own rejection is swallowed
    });
    expect(seen).toEqual([]);
  });

  test("recovery waits a bounded time for a busy root, then defers its intents as root-busy instead of hanging", async () => {
    const a = await rig(world);
    const w = a.w;
    const other = sampleRecord(w, { videoId: "video-00000002", jobId: "job-00000002", relPath: "Mia/2026-09-29_photo_002.mp4" });
    await writeIntent(NODE_COMMIT_FS, w.libraryRoot, other);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve)); // a hung fsync, as far as the lock can tell
    let holding: () => void = () => undefined;
    const holdsTheLock = new Promise<void>((resolve) => (holding = resolve));
    // Ordered by the commit's own hook, never by sleeping: "name-claimed" is past the claim, so inside the root lock.
    const first = a.run({
      hooks: {
        reached: async (step) => {
          if (step !== "name-claimed") return;
          holding();
          await gate;
        },
      },
    });
    const firstOutcome = first.then(
      () => "done",
      (e: unknown) => e,
    );
    try {
      await Promise.race([holdsTheLock, firstOutcome.then((e) => Promise.reject(new Error(`the commit ended before it held the lock: ${String(e)}`)))]);
      const started = performance.now();
      const report = await recoverVideos({ library: w.library, exportRoot: rootRef(w) }, { lockWaitMs: 60 });
      expect(performance.now() - started).toBeLessThan(1500);
      expect(report.deferred).toEqual([{ videoId: other.id, reason: "root-busy" }]);
      expect(await libraryVideoFiles(w)).toContain(`.pending/${other.id}.json`);
    } finally {
      release();
      await firstOutcome; // a commit this test started is always settled here, even when an assertion above failed
    }
    expect(await firstOutcome).toBe("done");
  });

  test("recovery never throws when the root's realpath fails between its check and the lock: it reports skipped and defers", async () => {
    const w = world();
    const record = sampleRecord(w);
    await writeIntent(NODE_COMMIT_FS, w.libraryRoot, record);
    let calls = 0;
    const fs = { ...NODE_COMMIT_FS, realpath: async (p: string) => (++calls >= 2 ? Promise.reject(errnoError("EIO")) : NODE_COMMIT_FS.realpath(p)) };
    const report = await recoverVideos({ library: w.library, exportRoot: rootRef(w) }, { fs });
    expect(report.skipped.some((s) => s.code === "EIO")).toBe(true);
    expect(report.deferred).toEqual([{ videoId: record.id, reason: "export-unavailable" }]);
  });
});

describe("sweeps stay inside the root recovery checked", () => {
  test("a root path re-pointed after the check: the folder that was checked is swept, the new target is untouched", async () => {
    const w = world();
    const link = join(w.dir, "export-link");
    symlinkSync(w.exportRoot, link);
    const decoy = join(w.dir, "decoy");
    mkdirSync(join(decoy, "Mia"), { recursive: true });
    writeFileSync(join(decoy, ".studio-probe-case-abc123z"), "");
    writeFileSync(join(decoy, "Mia", ".studio-part-job-00000009.mp4"), "owner");
    writeFileSync(join(decoy, "Mia", "2026-09-29_photo_001.mp4"), "");
    mkdirSync(join(w.exportRoot, "Mia"));
    writeFileSync(join(w.exportRoot, "Mia", ".studio-part-job-00000008.mp4"), "ours");
    const report = await recoverVideos(
      { library: w.library, exportRoot: { root: link, rootId: w.rootId, caseInsensitive: false } },
      {
        // The decoy's probe is brand new: without this the fresh-scratch gate (60 s) would keep it alive by itself and the
        // assertion below would prove nothing about WHICH folder is swept.
        scratchMinAgeMs: 0,
        hooks: {
          locked: () => {
            unlinkSync(link);
            symlinkSync(decoy, link);
          },
        },
      },
    );
    expect(existsSync(join(decoy, ".studio-probe-case-abc123z"))).toBe(true);
    expect(existsSync(join(decoy, "Mia", ".studio-part-job-00000009.mp4"))).toBe(true);
    expect(existsSync(join(decoy, "Mia", "2026-09-29_photo_001.mp4"))).toBe(true);
    expect(existsSync(join(w.exportRoot, "Mia", ".studio-part-job-00000008.mp4"))).toBe(false);
    expect(report.removed.partTemps).toBe(1);
  });

  test("a live job's temp is still recognised when the root is spelled through a symlink", async () => {
    const w = world();
    const link = join(w.dir, "export-link");
    symlinkSync(w.exportRoot, link);
    const folder = await openFolder(w);
    void folder;
    mkdirSync(join(w.exportRoot, "Mia"), { recursive: true });
    const temp = join(link, "Mia", ".studio-part-job-00000005.mp4");
    writeFileSync(temp, "x");
    const live = new CommitTracker();
    live.addTemp(temp);
    await recoverVideos({ library: w.library, exportRoot: { root: link, rootId: w.rootId, caseInsensitive: false }, live });
    expect(existsSync(temp)).toBe(true);
  });
});

describe("a matching file whose mtime does not match", () => {
  test("is adopted when no other record or intent names it (DST on FAT32, a copy round trip)", async () => {
    const w = world();
    const bytes = fakeVideoBytes(2048);
    const record = sampleRecord(w, { bytes, mtimeMs: 1_000 });
    await writeIntent(NODE_COMMIT_FS, w.libraryRoot, record);
    mkdirSync(join(w.exportRoot, "Mia"), { recursive: true });
    writeFileSync(join(w.exportRoot, FINAL), bytes);
    const library = await w.reopen();
    const report = await recoverVideos({ library, exportRoot: rootRef(w) });
    expect(report.adopted).toEqual([record.id]);
    expect(usedIn(w, library)).toEqual([record.id]);
  });

  test("is NOT adopted when another intent names the same file: both are deferred as file-shared, in any order, and the file is left", async () => {
    const w = world();
    const bytes = fakeVideoBytes(2048);
    const a = sampleRecord(w, { bytes, mtimeMs: 1_000 });
    const b = sampleRecord(w, { bytes, mtimeMs: 2_000, videoId: "video-00000002", jobId: "job-00000002" });
    await writeIntent(NODE_COMMIT_FS, w.libraryRoot, a);
    await writeIntent(NODE_COMMIT_FS, w.libraryRoot, b);
    mkdirSync(join(w.exportRoot, "Mia"), { recursive: true });
    writeFileSync(join(w.exportRoot, FINAL), bytes);
    const report = await recoverVideos({ library: await w.reopen(), exportRoot: rootRef(w) });
    expect(report.adopted).toEqual([]);
    expect(report.deferred).toEqual([
      { videoId: a.id, reason: "file-shared" },
      { videoId: b.id, reason: "file-shared" },
    ]);
    expect(existsSync(join(w.exportRoot, FINAL))).toBe(true);
    expect(await libraryVideoFiles(w)).toEqual([`.pending/${a.id}.json`, `.pending/${b.id}.json`]);
  });
});

describe("delete removes a leftover intent so the video cannot come back", () => {
  async function bothOnDisk(w: World) {
    const bytes = fakeVideoBytes(2048);
    const record = sampleRecord(w, { bytes });
    mkdirSync(join(w.exportRoot, "Mia"), { recursive: true });
    writeFileSync(join(w.exportRoot, FINAL), bytes);
    await writeIntent(NODE_COMMIT_FS, w.libraryRoot, record);
    const paths = videoPaths(w.libraryRoot, w.avatar.id);
    writeFileSync(paths.record(record.id), readFileSync(paths.intent(record.id))); // the state after a crash between link and unlink
    return { record, paths, library: await w.reopen() };
  }
  const depsOf = (w: World, library: Awaited<ReturnType<typeof bothOnDisk>>["library"], fs = NODE_COMMIT_FS) => ({ library, exportRoot: rootRef(w), checker: new FileStateChecker(), fs });

  test("the intent is removed with the record", async () => {
    const w = world();
    const { record, library } = await bothOnDisk(w);
    await deleteVideo(record.id, depsOf(w, library));
    expect(await libraryVideoFiles(w)).toEqual([]);
    expect(await exportFiles(w)).toEqual([]);
  });

  test("an unlink of the intent that fails once (antivirus) is retried", async () => {
    const w = world();
    const { record, paths, library } = await bothOnDisk(w);
    let failed = false;
    const fs = { ...NODE_COMMIT_FS, unlink: async (p: string) => (p === paths.intent(record.id) && !failed ? ((failed = true), Promise.reject(errnoError("EBUSY"))) : NODE_COMMIT_FS.unlink(p)) };
    await deleteVideo(record.id, depsOf(w, library, fs));
    expect(await libraryVideoFiles(w)).toEqual([]);
  });

  test("an intent that cannot be removed keeps the RECORD (the delete fails and can be retried): a deleted video never resurrects", async () => {
    const w = world();
    const { record, paths, library } = await bothOnDisk(w);
    const fs = { ...NODE_COMMIT_FS, unlink: async (p: string) => (p === paths.intent(record.id) ? Promise.reject(errnoError("EBUSY")) : NODE_COMMIT_FS.unlink(p)) };
    await expect(deleteVideo(record.id, depsOf(w, library, fs))).rejects.toMatchObject({ code: "EBUSY" });
    expect(await libraryVideoFiles(w)).toContain(`${record.id}.json`);
  });
});

describe("the tracker's job views are live", () => {
  test("liveJobIds() and liveVideoIds() follow later adds and releases", () => {
    const tracker = new CommitTracker();
    const jobs = tracker.liveJobIds();
    const videos = tracker.liveVideoIds();
    tracker.addJob("job-00000001", "video-00000001");
    expect([...jobs]).toEqual(["job-00000001"]);
    expect([...videos]).toEqual(["video-00000001"]);
    tracker.releaseJob("job-00000001");
    expect(jobs.size + videos.size).toBe(0);
  });
});

describe("unhandledRejectionsDuring", () => {
  test("removes its listener when the body throws, and passes the throw on", async () => {
    const baseline = process.listenerCount("unhandledRejection");
    const boom = new Error("the body failed");
    await expect(
      unhandledRejectionsDuring(async () => {
        expect(process.listenerCount("unhandledRejection")).toBe(baseline + 1);
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(process.listenerCount("unhandledRejection")).toBe(baseline);
  });

  test("returns nothing and removes its listener when the body ends cleanly", async () => {
    const baseline = process.listenerCount("unhandledRejection");
    expect(await unhandledRejectionsDuring(async () => undefined)).toEqual([]);
    expect(process.listenerCount("unhandledRejection")).toBe(baseline);
  });
});
