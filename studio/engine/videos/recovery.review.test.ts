import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { sweepPartFiles } from "../renderQueue/sweep";
import { commitVideo, type CommitInput } from "./commit";
import { NODE_COMMIT_FS } from "./commitFs";
import { CommitTracker } from "./execute";
import { commitIntent, writeIntent } from "./intents";
import { partNameOf, videoPaths } from "./record";
import { NODE_LIBRARY_READ_FS, recoverVideos, type ExportRootRef } from "./recovery";
import {
  acceptingVerify,
  CrashError,
  errnoError,
  exportFiles,
  failureOf,
  fakeVideoBytes,
  faultyFs,
  FINAL,
  libraryVideoFiles,
  listTree,
  openFolder,
  rig,
  sampleRecord,
  sha256Of,
  specOf,
  useWorld,
  writeTemp,
  type World,
} from "./testing/kit";
useNativeGlobals();

// Review round 1 of 3a.8b.1, recovery side: it must never race a live commit,
// must judge a root by its marker, and must touch only what is provably ours.

const world = useWorld();
const rootRef = (w: World): ExportRootRef => ({ root: w.exportRoot, rootId: w.rootId, caseInsensitive: false });
const usedIn = (w: World, library: { photoStates(id: string): Map<string, { usedIn: string[] }> }): string[] => library.photoStates(w.avatar.id).get(w.photos[0]?.id ?? "")?.usedIn ?? [];
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("recovery and a live commit exclude each other (per export root)", () => {
  test.each(["intent-written", "renamed", "dir-synced"] as const)("recovery started while the commit is at %s waits for it, and neither undoes the other", async (step) => {
    const r = await rig(world);
    const tracker = new CommitTracker();
    tracker.addJob(r.input.jobId, r.input.videoId);
    tracker.addTemp(r.temp);
    let recovery: ReturnType<typeof recoverVideos> | undefined;
    const out = await r.run({
      onClaimed: (path) => tracker.addPlaceholder(path),
      hooks: {
        reached: async (reached) => {
          if (reached !== step) return;
          recovery = recoverVideos({ library: r.w.library, exportRoot: rootRef(r.w), live: tracker });
          await sleep(40); // long enough for an unlocked recovery to run its whole course
        },
      },
    });
    const report = await recovery;
    expect(out.record.file.relPath).toBe(FINAL);
    expect(report).toMatchObject({ adopted: [], dropped: [], removed: { placeholders: 0, partTemps: 0 } });
    expect(await exportFiles(r.w)).toEqual([FINAL]);
    expect(await libraryVideoFiles(r.w)).toEqual([`${r.input.videoId}.json`]);
    expect(readFileSync(join(r.w.exportRoot, FINAL))).toEqual(Buffer.from(r.bytes));
  });

  test("a placeholder claimed after recovery began is not deleted, and a second job never takes its name (the snapshot race)", async () => {
    const w = world();
    const folder = await openFolder(w);
    const tracker = new CommitTracker();
    const bytesA = fakeVideoBytes(4096, 11);
    const bytesB = fakeVideoBytes(5000, 22);
    // As `createRenderExecute` does before it runs a job: the job's id and temp are live from the start.
    for (const [job, video, bytes] of [["job-0000000a", "video-0000000a", bytesA], ["job-0000000b", "video-0000000b", bytesB]] as const) {
      tracker.addJob(job, video);
      tracker.addTemp(writeTemp(folder, job, bytes));
    }
    const target = { folder, root: w.exportRoot, rootId: w.rootId, caseInsensitive: false };
    const input = (job: string, video: string): CommitInput => ({ jobId: job, videoId: video, avatarId: w.avatar.id, videoKind: "photo", date: "2026-09-29", createdAt: "2026-09-29T10:00:00.000Z", frames: 30, durationMs: 1000, montageId: null, music: null, spec: specOf(w.avatar.id, [w.photos[0]?.id ?? ""]), forbiddenStrings: [] });
    const deps = () => ({ fs: faultyFs(), libraryRoot: w.libraryRoot, library: w.library, verify: acceptingVerify, onClaimed: (p: string) => tracker.addPlaceholder(p) });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const a = commitVideo(target, input("job-0000000a", "video-0000000a"), { ...deps(), hooks: { reached: async (s) => (s === "name-claimed" ? gate : undefined) } });
    await sleep(40);
    const recovery = recoverVideos({ library: w.library, exportRoot: rootRef(w), live: tracker });
    const b = commitVideo(target, input("job-0000000b", "video-0000000b"), deps());
    await sleep(40);
    release();
    const [ra, rb] = await Promise.all([a, b]);
    await recovery;
    expect(new Set([ra.record.file.relPath, rb.record.file.relPath]).size).toBe(2);
    expect(sha256Of(readFileSync(join(w.exportRoot, ra.record.file.relPath)))).toBe(sha256Of(bytesA));
    expect(sha256Of(readFileSync(join(w.exportRoot, rb.record.file.relPath)))).toBe(sha256Of(bytesB));
  });

  test("the tracker hands out live views: a path added after the view was taken is in it", () => {
    const tracker = new CommitTracker();
    const temps = tracker.tempPaths();
    const placeholders = tracker.placeholderPaths();
    tracker.addTemp("/x/Mia/.studio-part-job-00000001.mp4");
    tracker.addPlaceholder("/x/Mia/2026-09-29_photo_001.mp4");
    expect(temps.size).toBe(1);
    expect(placeholders.size).toBe(1);
    expect(tracker.hasTemp("/x/Mia/.studio-part-job-00000001.mp4")).toBe(true);
    expect(tracker.hasTemp("/X/mia/./.STUDIO-PART-JOB-00000001.MP4")).toBe(true); // compared as places, not strings
  });

  test("an intent of a job that is live is deferred as `live`, untouched", async () => {
    const w = world();
    const record = sampleRecord(w);
    await writeIntent(NODE_COMMIT_FS, w.libraryRoot, record);
    const tracker = new CommitTracker();
    tracker.addJob(record.jobId, record.id);
    const report = await recoverVideos({ library: w.library, exportRoot: rootRef(w), live: tracker });
    expect(report.deferred).toEqual([{ videoId: record.id, reason: "live" }]);
    expect(await libraryVideoFiles(w)).toEqual([`.pending/${record.id}.json`]);
  });
});

describe("the photos of a pending intent are held until recovery resolves it (stage 3 review 3-M3)", () => {
  const photo = (w: World, library: { photoStates(id: string): Map<string, { reserved: boolean; usedIn: string[] }> }) => library.photoStates(w.avatar.id).get(w.photos[0]?.id ?? "");

  test("an intent deferred because the export folder is absent keeps its photos out of reach: reserved, not free, for as long as it is pending", async () => {
    const w = world();
    const bytes = fakeVideoBytes(2048);
    const record = sampleRecord(w, { bytes });
    await writeIntent(NODE_COMMIT_FS, w.libraryRoot, record);
    const library = await w.reopen();

    const report = await recoverVideos({ library, exportRoot: null });

    expect(report.deferred).toEqual([{ videoId: record.id, reason: "export-unavailable" }]);
    expect(photo(w, library)).toMatchObject({ reserved: true, usedIn: [] });
    expect(library.eligibleUnusedPhotos(w.avatar.id).map((p) => p.id)).not.toContain(w.photos[0]?.id);
  });

  test("an export root that never answers (or errors) still leaves the intent's photos held: the library is read before the root is looked at (review round 1, M2)", async () => {
    const w = world();
    const record = sampleRecord(w, {});
    await writeIntent(NODE_COMMIT_FS, w.libraryRoot, record);
    const library = await w.reopen();
    const fs = faultyFs();
    fs.override({ realpath: () => new Promise<string>(() => undefined) });

    const report = await recoverVideos({ library, exportRoot: rootRef(w) }, { fs, ioTimeoutMs: 100 });

    expect(report.skipped.map((s) => s.code)).toContain("ETIMEDOUT");
    expect(photo(w, library)).toMatchObject({ reserved: true, usedIn: [] });
  });

  test("a transient read error of the intent (it reads as `unreadable`) keeps the hold it had: nothing is known about it (review round 2, M2)", async () => {
    const w = world();
    const record = sampleRecord(w, {});
    await writeIntent(NODE_COMMIT_FS, w.libraryRoot, record);
    const library = await w.reopen();
    library.holdPendingPhotos(w.avatar.id, record.id, [w.photos[0]?.id ?? ""]);
    const libraryFs = { readdir: NODE_LIBRARY_READ_FS.readdir, readFile: () => Promise.reject(errnoError("EIO")) };

    const report = await recoverVideos({ library, exportRoot: rootRef(w), only: { videoIds: [record.id] } }, { libraryFs });

    expect(report.left).toEqual([{ file: `avatars/${w.avatar.id}/videos/.pending/${record.id}.json`, reason: "unreadable" }]);
    expect(photo(w, library)?.reserved).toBe(true);
  });

  test.each([
    ["a read error (EBUSY)", { readdir: NODE_LIBRARY_READ_FS.readdir, readFile: () => Promise.reject(errnoError("EBUSY")) }, false],
    ["an intent from a newer Studio", undefined, true],
  ] as const)("an intent that cannot be read at open (%s) fails closed: ALL the avatar's photos are held, as nothing is known of which it names (follow-up L1)", async (_name, libraryFs, tooNew) => {
    const w = world();
    const record = sampleRecord(w, {});
    await writeIntent(NODE_COMMIT_FS, w.libraryRoot, record);
    if (tooNew) writeFileSync(videoPaths(w.libraryRoot, w.avatar.id).intent(record.id), JSON.stringify({ ...record, schemaVersion: 99 }));
    const library = await w.reopen();

    const report = await recoverVideos({ library, exportRoot: rootRef(w) }, libraryFs === undefined ? {} : { libraryFs });

    expect(report.left).toHaveLength(1);
    expect(library.eligibleUnusedPhotos(w.avatar.id)).toEqual([]);
    expect(photo(w, library)?.reserved).toBe(true);
  });

  test("once the intent reads again, the hold narrows to the photos it names", async () => {
    const w = world();
    const record = sampleRecord(w, {});
    await writeIntent(NODE_COMMIT_FS, w.libraryRoot, record);
    const library = await w.reopen();
    await recoverVideos({ library, exportRoot: null }, { libraryFs: { readdir: NODE_LIBRARY_READ_FS.readdir, readFile: () => Promise.reject(errnoError("EBUSY")) } });
    expect(library.eligibleUnusedPhotos(w.avatar.id)).toEqual([]);

    await recoverVideos({ library, exportRoot: null });

    expect(library.eligibleUnusedPhotos(w.avatar.id).map((p) => p.id)).toEqual(w.photos.slice(1).map((p) => p.id));
  });

  test("an intent a live job owns keeps the hold that was made for it: recovery neither makes nor drops it", async () => {
    const w = world();
    const record = sampleRecord(w, {});
    await writeIntent(NODE_COMMIT_FS, w.libraryRoot, record);
    const library = await w.reopen();
    library.holdPendingPhotos(w.avatar.id, record.id, [w.photos[0]?.id ?? ""]);
    const tracker = new CommitTracker();
    tracker.addJob(record.jobId, record.id);

    await recoverVideos({ library, exportRoot: rootRef(w), live: tracker });

    expect(photo(w, library)?.reserved).toBe(true);
  });

  test("an intent for another export root is held the same way", async () => {
    const w = world();
    const record = sampleRecord(w, { rootId: "11111111-2222-4333-8444-555555555555" });
    await writeIntent(NODE_COMMIT_FS, w.libraryRoot, record);
    const library = await w.reopen();

    const report = await recoverVideos({ library, exportRoot: rootRef(w) });

    expect(report.deferred).toEqual([{ videoId: record.id, reason: "other-root" }]);
    expect(photo(w, library)?.reserved).toBe(true);
  });

  test("the hold ends when the intent is adopted: the photos are USED by the record, not reserved, and in one video only", async () => {
    const w = world();
    const bytes = fakeVideoBytes(2048);
    const record = sampleRecord(w, { bytes });
    await writeIntent(NODE_COMMIT_FS, w.libraryRoot, record);
    mkdirSync(join(w.exportRoot, "Mia"), { recursive: true });
    writeFileSync(join(w.exportRoot, FINAL), bytes);
    const library = await w.reopen();
    await recoverVideos({ library, exportRoot: null });
    expect(photo(w, library)?.reserved).toBe(true);

    const report = await recoverVideos({ library, exportRoot: rootRef(w) });

    expect(report.adopted).toEqual([record.id]);
    expect(photo(w, library)).toMatchObject({ reserved: false, usedIn: [record.id] });
  });

  test("the hold ends when the intent is dropped: its photos are free again", async () => {
    const w = world();
    const record = sampleRecord(w, {});
    await writeIntent(NODE_COMMIT_FS, w.libraryRoot, record);
    const library = await w.reopen();
    await recoverVideos({ library, exportRoot: null });
    expect(photo(w, library)?.reserved).toBe(true);

    // The root is usable now and the intent's file never existed.
    const report = await recoverVideos({ library, exportRoot: rootRef(w) });

    expect(report.dropped).toEqual([{ videoId: record.id, reason: "no-file" }]);
    expect(photo(w, library)).toMatchObject({ reserved: false, usedIn: [] });
  });

  test("an intent a running job owns is not held by recovery: the queue's reservation covers it, and a rollback must not leave the photos stuck", async () => {
    const w = world();
    const record = sampleRecord(w, {});
    await writeIntent(NODE_COMMIT_FS, w.libraryRoot, record);
    const tracker = new CommitTracker();
    tracker.addJob(record.jobId, record.id);
    const library = await w.reopen();

    const report = await recoverVideos({ library, exportRoot: rootRef(w), live: tracker });

    expect(report.deferred).toEqual([{ videoId: record.id, reason: "live" }]);
    expect(photo(w, library)?.reserved).toBe(false);
  });
});

describe("adoption", () => {
  test("a record that already names the same file stops a second intent from being adopted (two records, one file)", async () => {
    const w = world();
    const bytes = fakeVideoBytes(4096);
    const first = await rig(world, { bytes });
    await failureOf(first.run({ hooks: { reached: (s) => { if (s === "renamed") { first.fs.die(); throw new CrashError(s); } } } }));
    await recoverVideos({ library: await w.reopen(), exportRoot: null }); // no root: A's intent is deferred
    rmFile(join(w.exportRoot, FINAL)); // the owner deletes A's file
    const folder = await openFolder(w);
    writeTemp(folder, "job-00000002", bytes);
    const target = { folder, root: w.exportRoot, rootId: w.rootId, caseInsensitive: false };
    await commitVideo(target, { ...first.input, jobId: "job-00000002", videoId: "video-00000002" }, { fs: NODE_COMMIT_FS, libraryRoot: w.libraryRoot, library: w.library, verify: acceptingVerify });
    const report = await recoverVideos({ library: await w.reopen(), exportRoot: rootRef(w) });
    expect(report.adopted).toEqual([]);
    expect(await libraryVideoFiles(w)).toEqual(["video-00000002.json"]);
  });

  test("a record that names the same path but another file's bytes does not own the file: an intent whose verified file stands there is adopted, not dropped as file-claimed (stage 3 review 3-M2)", async () => {
    const w = world();
    // Video A's record names Mia/..._001.mp4 with ITS bytes; the owner deleted that file and a later render's file took the name.
    const old = sampleRecord(w, { videoId: "video-0000000a", jobId: "job-0000000a", bytes: fakeVideoBytes(2048, 1) });
    await writeIntent(NODE_COMMIT_FS, w.libraryRoot, old);
    await commitIntent(NODE_COMMIT_FS, w.libraryRoot, w.avatar.id, old.id);
    // The new video's commit crashed between the rename and the link: its verified bytes sit under the name, its intent is pending.
    const bytes = fakeVideoBytes(3000, 7);
    const crashed = sampleRecord(w, { bytes, videoId: "video-0000000b", jobId: "job-0000000b", photoIds: [w.photos[1]?.id ?? ""] });
    await writeIntent(NODE_COMMIT_FS, w.libraryRoot, crashed);
    mkdirSync(join(w.exportRoot, "Mia"), { recursive: true });
    writeFileSync(join(w.exportRoot, FINAL), bytes);

    const library = await w.reopen();
    const report = await recoverVideos({ library, exportRoot: rootRef(w) });

    expect(report.dropped).toEqual([]);
    expect(report.adopted).toEqual([crashed.id]);
    expect(await libraryVideoFiles(w)).toEqual([`${old.id}.json`, `${crashed.id}.json`]);
    // The video keeps its record, so its photo stays used.
    expect(library.photoStates(w.avatar.id).get(w.photos[1]?.id ?? "")?.usedIn).toEqual([crashed.id]);
  });

  test.each([true, false])("a record that names the same file in another letter case claims it on a case-insensitive root, not on a case-sensitive one (caseInsensitive: %p)", async (caseInsensitive) => {
    const bytes = fakeVideoBytes(2048);
    {
      const w = world();
      const lower = sampleRecord(w, { bytes, videoId: "video-0000000a", jobId: "job-0000000a", relPath: "mia/2026-09-29_photo_001.mp4" });
      await writeIntent(NODE_COMMIT_FS, w.libraryRoot, lower);
      await commitIntent(NODE_COMMIT_FS, w.libraryRoot, w.avatar.id, lower.id);
      const pending = sampleRecord(w, { bytes, videoId: "video-0000000b", jobId: "job-0000000b", photoIds: [w.photos[1]?.id ?? ""] });
      await writeIntent(NODE_COMMIT_FS, w.libraryRoot, pending);
      mkdirSync(join(w.exportRoot, "Mia"), { recursive: true });
      writeFileSync(join(w.exportRoot, FINAL), bytes);

      const report = await recoverVideos({ library: await w.reopen(), exportRoot: { ...rootRef(w), caseInsensitive } });

      expect(report.dropped.map((d) => d.reason)).toEqual(caseInsensitive ? ["file-claimed"] : []);
    }
  });

  test("an intent whose stored mtime is not the file's is still adopted when it is the only one naming the file (the bytes are verified)", async () => {
    const w = world();
    const bytes = fakeVideoBytes(2048);
    const record = sampleRecord(w, { bytes, mtimeMs: 1_000 });
    await writeIntent(NODE_COMMIT_FS, w.libraryRoot, record);
    mkdirSync(join(w.exportRoot, "Mia"), { recursive: true });
    writeFileSync(join(w.exportRoot, FINAL), bytes);
    const report = await recoverVideos({ library: w.library, exportRoot: rootRef(w) });
    expect(report.adopted).toEqual([record.id]);
    expect(existsSync(join(w.exportRoot, FINAL))).toBe(true);
  });

  test("an fsync that fails during the adopting rename does not leave the index without the record", async () => {
    const r = await rig(world);
    await failureOf(r.run({ hooks: { reached: (s) => { if (s === "dir-synced") { r.fs.die(); throw new CrashError(s); } } } }));
    const library = await r.w.reopen();
    const fs = faultyFs();
    const paths = videoPaths(r.w.libraryRoot, r.w.avatar.id);
    fs.override({ fsyncDir: async (p) => { if (p === paths.videosDir || p === paths.pendingDir) throw errnoError("EIO"); return NODE_COMMIT_FS.fsyncDir(p); } });
    const report = await recoverVideos({ library, exportRoot: rootRef(r.w) }, { fs });
    expect(report.adopted).toEqual([r.input.videoId]);
    expect(usedIn(r.w, library)).toEqual([r.input.videoId]);
    expect(await libraryVideoFiles(r.w)).toEqual([`${r.input.videoId}.json`]);
  });
});

function rmFile(path: string): void {
  renameSync(path, `${path}.deleted-by-owner`);
}

describe("a root is judged by its marker, not by the id a record remembers", () => {
  test("an empty folder at the same path (no marker) defers the intents: nothing is dropped as `no-file`", async () => {
    const r = await rig(world);
    await failureOf(r.run({ hooks: { reached: (s) => { if (s === "renamed") { r.fs.die(); throw new CrashError(s); } } } }));
    renameSync(r.w.exportRoot, `${r.w.exportRoot}.drive-unplugged`);
    mkdirSync(r.w.exportRoot);
    const report = await recoverVideos({ library: await r.w.reopen(), exportRoot: rootRef(r.w) });
    expect(report.dropped).toEqual([]);
    expect(report.deferred).toEqual([{ videoId: r.input.videoId, reason: "export-unavailable" }]);
    expect(await libraryVideoFiles(r.w)).toEqual([`.pending/${r.input.videoId}.json`]);
  });

  test("a marker with another id defers them too", async () => {
    const r = await rig(world);
    await failureOf(r.run({ hooks: { reached: (s) => { if (s === "renamed") { r.fs.die(); throw new CrashError(s); } } } }));
    writeFileSync(join(r.w.exportRoot, ".studio-export.json"), JSON.stringify({ schemaVersion: 1, rootId: "root-99999999", createdAt: "2026-09-29T10:00:00.000Z" }));
    const report = await recoverVideos({ library: await r.w.reopen(), exportRoot: rootRef(r.w) });
    expect(report.deferred).toEqual([{ videoId: r.input.videoId, reason: "export-unavailable" }]);
  });
});

describe("what recovery may delete", () => {
  test("probe files: only our own two shapes, and only when empty", async () => {
    const w = world();
    const keep = [".studio-probe-notes", ".studio-probe-x"];
    for (const name of keep) writeFileSync(join(w.exportRoot, name), "");
    const gone = [".studio-probe-case-abc123z", ".studio-probe-2f9f5b0e-7a53-4c3e-9d0a-3c1f7b1d2e44"];
    for (const name of gone) writeFileSync(join(w.exportRoot, name), "");
    await recoverVideos({ library: w.library, exportRoot: rootRef(w) }, { scratchMinAgeMs: 0 });
    for (const name of keep) expect(existsSync(join(w.exportRoot, name)), name).toBe(true);
    for (const name of gone) expect(existsSync(join(w.exportRoot, name)), name).toBe(false);
  });

  test("a folder swapped for a symlink after it was listed: nothing behind the link is deleted", async () => {
    const w = world();
    const outside = join(w.dir, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "2026-09-29_photo_001.mp4"), "");
    mkdirSync(join(w.exportRoot, "Mia"));
    writeFileSync(join(w.exportRoot, FINAL), "");
    const fs = faultyFs();
    let swapped = false;
    fs.override({
      lstat: async (path) => {
        if (!swapped && path === join(w.exportRoot, FINAL)) {
          swapped = true;
          renameSync(join(w.exportRoot, "Mia"), join(w.exportRoot, "Mia.moved"));
          symlinkSync(outside, join(w.exportRoot, "Mia"));
        }
        return NODE_COMMIT_FS.lstat(path);
      },
    });
    await recoverVideos({ library: w.library, exportRoot: rootRef(w) }, { fs });
    expect(await listTree(outside)).toEqual(["2026-09-29_photo_001.mp4"]);
  });

  test("a render temp is ours only as .studio-part-<id>.mp4 with a contract id, and only inside a <SafeName>/ folder", async () => {
    const w = world();
    mkdirSync(join(w.exportRoot, "Mia"));
    mkdirSync(join(w.exportRoot, "My Stuff"));
    const keep = [".studio-part-notes.mp4", "My Stuff/.studio-part-job-00000001.mp4", "Mia/.studio-part-notes.mp4", ".studio-part-job-00000001.mp4"];
    for (const name of keep) writeFileSync(join(w.exportRoot, name), "owner content");
    writeFileSync(join(w.exportRoot, "Mia", partNameOf("job-00000002")), "ours");
    const result = await sweepPartFiles(w.exportRoot);
    for (const name of keep) expect(existsSync(join(w.exportRoot, name)), name).toBe(true);
    expect(existsSync(join(w.exportRoot, "Mia", partNameOf("job-00000002")))).toBe(false);
    expect(result.removed).toHaveLength(1);
  });
});

describe("a crash INSIDE recovery is settled by the next run", () => {
  const scenarios: Array<{ name: string; step: string; adopted: boolean }> = [
    { name: "an intent to adopt", step: "renamed", adopted: true },
    { name: "an intent whose file is still empty", step: "intent-written", adopted: false },
    { name: "a bare placeholder", step: "name-claimed", adopted: false },
    { name: "a record and an intent side by side", step: "record-linked", adopted: true },
  ];
  for (const scenario of scenarios) {
    test.each(Array.from({ length: 16 }, (_, k) => k))(`${scenario.name}: killed at recovery's disk call #%d, the next run reaches the same end`, async (k) => {
      const r = await rig(world);
      await failureOf(r.run({ hooks: { reached: (s) => { if (s === scenario.step) { r.fs.die(); throw new CrashError(s); } } } }));
      const library = await r.w.reopen();
      const fs = faultyFs();
      let seen = 0;
      const guard = <A extends unknown[], T>(fn: (...a: A) => Promise<T>) => async (...a: A): Promise<T> => {
        if (seen++ === k) {
          fs.die();
          throw new CrashError(`recovery call ${k}`);
        }
        return fn(...a);
      };
      fs.override({ unlink: guard((p: string) => NODE_COMMIT_FS.unlink(p)), link: guard((a: string, b: string) => NODE_COMMIT_FS.link(a, b)), rename: guard((a: string, b: string) => NODE_COMMIT_FS.rename(a, b)), fsyncDir: guard((p: string) => NODE_COMMIT_FS.fsyncDir(p)) });
      await recoverVideos({ library, exportRoot: rootRef(r.w) }, { fs }).catch(() => undefined);
      const again = await r.w.reopen();
      await recoverVideos({ library: again, exportRoot: rootRef(r.w) });
      expect(await exportFiles(r.w)).toEqual(scenario.adopted ? [FINAL] : []);
      expect(await libraryVideoFiles(r.w)).toEqual(scenario.adopted ? [`${r.input.videoId}.json`] : []);
      expect(usedIn(r.w, again)).toEqual(scenario.adopted ? [r.input.videoId] : []);
    });
  }
});
