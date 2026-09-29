import { describe, expect, test } from "bun:test";
import { existsSync, utimesSync, writeFileSync } from "node:fs";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { NODE_COMMIT_FS, type CommitFs } from "./commitFs";
import { writeIntent } from "./intents";
import { partNameOf, videoPaths } from "./record";
import { recoverVideos, type ExportRootRef } from "./recovery";
import { withRootLock } from "./rootLock";
import { sampleRecord, useWorld, type World } from "./testing/kit";
import { join } from "node:path";
useNativeGlobals();

// 3a.8b.2 review: recovery runs in the background holding the export root's lock, so it must never hold it for long.
// It reads the library BEFORE taking the lock, every disk call inside is bounded (a pulled USB drive gives up the run),
// a library that is no longer live stops it, and a targeted run settles only the intents it is given.

const world = useWorld();
const rootRef = (w: World): ExportRootRef => ({ root: w.exportRoot, rootId: w.rootId, caseInsensitive: false });
const never = <T,>(): Promise<T> => new Promise<T>(() => undefined);

/** An intent whose file is not there: a normal run drops it as `no-file`. */
async function orphanIntent(w: World, n: number): Promise<string> {
  const id = `video-0000000${n}`;
  await writeIntent(NODE_COMMIT_FS, w.libraryRoot, sampleRecord(w, { videoId: id, jobId: `job-0000000${n}`, relPath: `Mia/2026-09-29_photo_00${n}.mp4` }));
  return videoPaths(w.libraryRoot, w.avatar.id).intent(id);
}

describe("recovery gives way", () => {
  test("a run whose signal is already aborted does nothing: no lock, no intent touched", async () => {
    const w = world();
    const intent = await orphanIntent(w, 1);
    const library = await w.reopen();

    const report = await recoverVideos({ library, exportRoot: rootRef(w), signal: AbortSignal.abort() });

    expect(existsSync(intent)).toBe(true);
    expect(report.dropped).toEqual([]);
  });

  test("a signal aborted inside the lock ends the run before it settles anything: the intents wait for the next open", async () => {
    const w = world();
    const intent = await orphanIntent(w, 1);
    const library = await w.reopen();
    const controller = new AbortController();

    await recoverVideos({ library, exportRoot: rootRef(w), signal: controller.signal }, { hooks: { locked: () => controller.abort() } });

    expect(existsSync(intent)).toBe(true);
  });
});

describe("recovery's disk calls are bounded", () => {
  test("a disk call that never answers gives up the run and RELEASES the export root's lock", async () => {
    const w = world();
    const intent = await orphanIntent(w, 1);
    const library = await w.reopen();
    const hanging: CommitFs = { ...NODE_COMMIT_FS, lstat: (path) => (path === intent ? never() : NODE_COMMIT_FS.lstat(path)) };
    const started = Date.now();

    const report = await recoverVideos({ library, exportRoot: rootRef(w) }, { fs: hanging, ioTimeoutMs: 40 });

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(report.skipped.length).toBeGreaterThan(0);
    // the lock is free again at once, not after the hung call wakes
    await expect(withRootLock(NODE_COMMIT_FS, w.exportRoot, async () => "acquired", { waitMs: 500 })).resolves.toBe("acquired");
    expect(existsSync(intent)).toBe(true);
  });

  test("after one call gave up, the rest of the run is not tried (a dead drive is not asked again and again)", async () => {
    const w = world();
    await orphanIntent(w, 1);
    await orphanIntent(w, 2);
    const library = await w.reopen();
    let calls = 0;
    const hanging: CommitFs = {
      ...NODE_COMMIT_FS,
      lstat: (path) => {
        if (path.endsWith("video-00000001.json") || path.endsWith("video-00000002.json")) {
          calls++;
          return never();
        }
        return NODE_COMMIT_FS.lstat(path);
      },
    };

    await recoverVideos({ library, exportRoot: rootRef(w) }, { fs: hanging, ioTimeoutMs: 40 });

    expect(calls).toBe(1);
  });
});

describe("the library is read BEFORE the export root's lock is taken", () => {
  test("a library that does not answer never holds the lock: a commit can take it meanwhile", async () => {
    const w = world();
    await orphanIntent(w, 1);
    const library = await w.reopen();
    const controller = new AbortController();
    const stuck = recoverVideos({ library, exportRoot: rootRef(w), signal: controller.signal }, { libraryFs: { readdir: () => never(), readFile: () => never() }, ioTimeoutMs: 60_000 });

    let finished = false;
    void stuck.then(() => void (finished = true));

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(finished).toBe(false); // it really is waiting on the library
    await expect(withRootLock(NODE_COMMIT_FS, w.exportRoot, async () => "acquired", { waitMs: 200 })).resolves.toBe("acquired");

    controller.abort();
    await stuck;
  });
});

describe("recovery leaves the root's FRESH scratch alone (the review's Windows failure)", () => {
  // A render's export check creates `.studio-probe-<id>` and removes it a moment later, and a marker's publish makes
  // `.studio-export.json.tmp-<id>`. Recovery runs in the background at engine start and used to sweep every scratch file of
  // those shapes, so it could delete a LIVE one under a check that was running at the same time (a refusal on Windows, where
  // the timing and the sharing rules differ). Only scratch older than a crash-and-restart could be is a leftover.
  const PROBE = ".studio-probe-2f9f5b0e-7a53-4c3e-9d0a-3c1f7b1d2e44";
  const MARKER_TMP = ".studio-export.json.tmp-2f9f5b0e-7a53-4c3e-9d0a-3c1f7b1d2e44";

  test("a probe and a marker temp made moments ago are kept", async () => {
    const w = world();
    writeFileSync(join(w.exportRoot, PROBE), "");
    writeFileSync(join(w.exportRoot, MARKER_TMP), "{}");
    const library = await w.reopen();

    await recoverVideos({ library, exportRoot: rootRef(w) });

    expect(existsSync(join(w.exportRoot, PROBE))).toBe(true);
    expect(existsSync(join(w.exportRoot, MARKER_TMP))).toBe(true);
  });

  test("the same files, old enough to be a crash's leftovers, are swept", async () => {
    const w = world();
    const longAgo = new Date(Date.now() - 10 * 60_000);
    for (const name of [PROBE, MARKER_TMP]) {
      writeFileSync(join(w.exportRoot, name), name === PROBE ? "" : "{}");
      utimesSync(join(w.exportRoot, name), longAgo, longAgo);
    }
    const library = await w.reopen();

    const report = await recoverVideos({ library, exportRoot: rootRef(w) });

    expect(existsSync(join(w.exportRoot, PROBE))).toBe(false);
    expect(existsSync(join(w.exportRoot, MARKER_TMP))).toBe(false);
    expect(report.removed.probes).toBe(1);
  });
});

describe("a targeted run (`only`)", () => {
  test("settles only the intents it names, and sweeps nothing else", async () => {
    const w = world();
    const first = await orphanIntent(w, 1);
    const second = await orphanIntent(w, 2);
    mkdirFolder(w);
    const part = join(w.exportRoot, "Mia", partNameOf("job-00000009"));
    writeFileSync(part, "someone else's temp, no live job");
    const library = await w.reopen();

    const report = await recoverVideos({ library, exportRoot: rootRef(w), only: { videoIds: ["video-00000001"] } });

    expect(existsSync(first)).toBe(false); // dropped: its file is not there
    expect(report.dropped).toEqual([{ videoId: "video-00000001", reason: "no-file" }]);
    expect(existsSync(second)).toBe(true); // not named: untouched
    expect(existsSync(part)).toBe(true); // no sweep in a targeted run
  });
});

function mkdirFolder(w: World): void {
  const { mkdirSync } = require("node:fs") as typeof import("node:fs");
  mkdirSync(join(w.exportRoot, "Mia"), { recursive: true });
}
