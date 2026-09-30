import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import type { JobState } from "../../shared/engine";
import type { RunFfmpegArgvOptions } from "../../node/runFfmpeg";
import { JobRegistry } from "../jobs";
import { RenderQueue } from "../renderQueue/queue";
import { CommitTracker, createRenderExecute, totalFramesOf, type RenderPlan, type VideoRenderDeps } from "./execute";
import { partNameOf, type VideoRecord } from "./record";
import { NODE_COMMIT_FS } from "./commitFs";
import { acceptingVerify, exportFiles, fakeVideoBytes, FINAL, libraryVideoFiles, MARKER, specOf, useWorld, watchUnhandledRejections, type World } from "./testing/kit";
useNativeGlobals();

// 3a.8b.2: what `createRenderExecute` does about the export folder BETWEEN its checks. The up-front check
// (invariant 35) is minutes old when pass 2 writes `.studio-part-<jobId>.mp4` by path, so the folder and its
// marker are looked at again right before pass 2 and right before the name is claimed; the temp is created by
// the job itself, exclusively and without following a link; and a commit that hangs cannot hold a queue slot for good.

const world = useWorld();
const BYTES = fakeVideoBytes(4096, 11);
const JOB = "job-00000001";

const writingRun = async (opts: RunFfmpegArgvOptions): Promise<void> => {
  await mkdir(dirname(opts.output), { recursive: true });
  await writeFile(opts.output, BYTES);
};

const planOf = (w: World, over: Partial<RenderPlan> = {}): RenderPlan => ({
  jobId: JOB,
  videoId: "video-00000001",
  avatarId: w.avatar.id,
  safeName: "Mia",
  exportRoot: { root: w.exportRoot, rootId: w.rootId },
  spec: specOf(w.avatar.id, [w.photos[0]?.id ?? ""], 1000),
  resolvePhoto: () => ({ path: "/photos/p.jpg", width: 720, height: 1280 }),
  overlays: [],
  audio: { kind: "silent" },
  montageId: null,
  videoKind: "photo",
  music: null,
  ...over,
});

interface Rig {
  readonly w: World;
  readonly tracker: CommitTracker;
  readonly queue: RenderQueue;
  readonly committed: VideoRecord[];
  readonly logs: string[];
  states(): JobState[];
  submit(plan?: RenderPlan): void;
}

function rig(over: Partial<VideoRenderDeps> = {}): Rig {
  const w = world();
  const tracker = new CommitTracker();
  const committed: VideoRecord[] = [];
  const logs: string[] = [];
  const deps: VideoRenderDeps = {
    library: w.library,
    tracker,
    renderTmpDir: w.renderTmp,
    caseProbe: { isCaseInsensitive: async () => false },
    now: () => new Date(2026, 8, 29, 10, 0, 0),
    verify: acceptingVerify,
    runDeps: { run: writingRun },
    onCommitted: (record) => void committed.push(record),
    log: (line) => logs.push(line),
    ...over,
  };
  const execute = createRenderExecute(deps);
  const queue = new RenderQueue({ jobs: new JobRegistry(), size: () => 1 });
  return {
    w,
    tracker,
    queue,
    committed,
    logs,
    states: () => queue.states(),
    submit: (plan = planOf(w)) => {
      const result = queue.submit({ jobId: plan.jobId, ref: { videoId: plan.videoId, avatarId: plan.avatarId, montageId: plan.montageId }, totalFrames: totalFramesOf(plan.spec.clips), photoIds: [w.photos[0]?.id ?? ""], execute: execute(plan) });
      expect(result).toEqual({ ok: true });
    },
  };
}

const markerJson = (rootId: string): string => JSON.stringify({ schemaVersion: 1, rootId, createdAt: "2026-09-29T09:00:00.000Z" });

describe("the marker is read again: a volume swapped in at the same path is not the root that was checked", () => {
  test("a root whose marker names another id when the job starts fails EXPORT_UNAVAILABLE before ffmpeg, and creates no folder", async () => {
    let ran = false;
    const r = rig({ runDeps: { run: async (opts) => (ran = true, writingRun(opts)) } });
    await writeFile(join(r.w.exportRoot, MARKER), markerJson("another-root-01"));

    r.submit();
    await r.queue.idle();

    expect(r.states()[0]).toMatchObject({ status: "failed", error: { code: "EXPORT_UNAVAILABLE", exportReason: "missing" } });
    expect(ran).toBe(false);
    expect(existsSync(join(r.w.exportRoot, "Mia"))).toBe(false);
  });

  test("a marker swapped while pass 1 ran fails the job before pass 2 starts", async () => {
    const calls: string[] = [];
    const r = rig({
      runDeps: {
        run: async (opts) => {
          calls.push(opts.output);
          if (calls.length === 1) await writeFile(join(r.w.exportRoot, MARKER), markerJson("another-root-01"));
          await writingRun(opts);
        },
      },
    });

    r.submit();
    await r.queue.idle();

    expect(r.states()[0]).toMatchObject({ status: "failed", error: { code: "EXPORT_UNAVAILABLE", exportReason: "missing" } });
    expect(calls).toHaveLength(1); // pass 1 only
    expect(await exportFiles(r.w)).toEqual([]);
  });

  test("a marker swapped after pass 2, before the name is claimed, fails the job with no placeholder, no record and no used mark", async () => {
    const r = rig({
      verify: async (path) => {
        await writeFile(join(r.w.exportRoot, MARKER), markerJson("another-root-01"));
        return acceptingVerify(path);
      },
    });

    r.submit();
    await r.queue.idle();

    expect(r.states()[0]).toMatchObject({ status: "failed", error: { code: "EXPORT_UNAVAILABLE", exportReason: "missing" } });
    expect(await exportFiles(r.w)).toEqual([]);
    expect(await libraryVideoFiles(r.w)).toEqual([]);
    expect(r.w.library.photoStates(r.w.avatar.id).get(r.w.photos[0]?.id ?? "")?.usedIn).toEqual([]);
  });
});

describe("the export folder is checked again right before pass 2", () => {
  test("an avatar folder swapped for a symlink to elsewhere fails the job before pass 2, and nothing is written through the link", async () => {
    const outside = join(world().dir, "elsewhere");
    await mkdir(outside);
    const calls: string[] = [];
    const r = rig({
      runDeps: {
        run: async (opts) => {
          calls.push(opts.output);
          if (calls.length === 1) {
            // pass 1 is over the folder's head: the owner (or anything) swaps it now
            await rm(join(r.w.exportRoot, "Mia"), { recursive: true, force: true });
            symlinkSync(outside, join(r.w.exportRoot, "Mia"));
          }
          await writingRun(opts);
        },
      },
    });

    r.submit();
    await r.queue.idle();

    expect(r.states()[0]).toMatchObject({ status: "failed", error: { code: "EXPORT_UNAVAILABLE", exportReason: "not-writable" } });
    expect(calls).toHaveLength(1);
    expect(readdirSync(outside)).toEqual([]);
    expect(await libraryVideoFiles(r.w)).toEqual([]);
  });

  test("the folder's own detail names no path", async () => {
    const outside = join(world().dir, "elsewhere");
    await mkdir(outside);
    let n = 0;
    const r = rig({
      runDeps: {
        run: async (opts) => {
          if (++n === 1) {
            await rm(join(r.w.exportRoot, "Mia"), { recursive: true, force: true });
            symlinkSync(outside, join(r.w.exportRoot, "Mia"));
          }
          await writingRun(opts);
        },
      },
    });

    r.submit();
    await r.queue.idle();

    expect(r.states()[0]?.status).toBe("failed");
    expect(JSON.stringify(r.states()[0])).not.toContain(r.w.dir);
  });
});

describe("the temp is created by the job, exclusively, before ffmpeg writes it", () => {
  test("at pass 2 the temp already exists as an empty regular file, and the tracker knows it", async () => {
    const facts: Array<{ exists: boolean; size: number; regular: boolean; nlink: number; live: boolean }> = [];
    let n = 0;
    const r = rig({
      runDeps: {
        run: async (opts) => {
          n++;
          if (n === 2) {
            const temp = join(r.w.exportRoot, "Mia", partNameOf(JOB));
            const info = statSync(temp, { throwIfNoEntry: false });
            facts.push({ exists: info !== undefined, size: info?.size ?? -1, regular: info?.isFile() ?? false, nlink: info?.nlink ?? 0, live: r.tracker.hasTemp(temp) });
          }
          await writingRun(opts);
        },
      },
    });

    r.submit();
    await r.queue.idle();

    expect(facts).toEqual([{ exists: true, size: 0, regular: true, nlink: 1, live: true }]);
    expect(r.states()[0]?.status).toBe("done");
    expect(await exportFiles(r.w)).toEqual([FINAL]);
  });

  test("a temp that is already there (a name that is not ours to overwrite) fails the job instead of being written through", async () => {
    let n = 0;
    const r = rig({
      runDeps: {
        run: async (opts) => {
          // something put a file at the temp's name during pass 1
          if (++n === 1) writeFileSync(join(r.w.exportRoot, "Mia", partNameOf(JOB)), "not ours");
          await writingRun(opts);
        },
      },
    });

    r.submit();
    await r.queue.idle();

    expect(r.states()[0]).toMatchObject({ status: "failed", error: { code: "EXPORT_UNAVAILABLE", exportReason: "not-writable" } });
  });

  test("a symlink at the temp's name is never followed", async () => {
    const outside = join(world().dir, "target.bin");
    writeFileSync(outside, "the owner's file");
    let n = 0;
    const r = rig({
      runDeps: {
        run: async (opts) => {
          if (++n === 1) symlinkSync(outside, join(r.w.exportRoot, "Mia", partNameOf(JOB))); // during pass 1
          await writingRun(opts);
        },
      },
    });

    r.submit();
    await r.queue.idle();

    expect(r.states()[0]?.status).toBe("failed");
    expect(readFileSync(outside, "utf8")).toBe("the owner's file");
  });
});

describe("errors from the export folder's own steps carry no path", () => {
  test("an unclassified error from preparing the folder becomes INTERNAL with the errno code only", async () => {
    const r = rig({
      folderFs: {
        mkdir: () => Promise.reject(Object.assign(new Error("EIO: i/o error, mkdir '/Volumes/Reels/Mia'"), { code: "EIO" })),
        lstat: () => Promise.reject(new Error("unused")),
        realpath: () => Promise.reject(new Error("unused")),
      },
    });

    r.submit();
    await r.queue.idle();

    const state = r.states()[0];
    expect(state).toMatchObject({ status: "failed", error: { code: "EXPORT_UNAVAILABLE", exportReason: "not-writable" } });
    expect(JSON.stringify(state)).not.toContain("/Volumes/Reels");
  });
});

describe("the steps before pass 2 are bounded and give way to a cancel", () => {
  const never = <T,>(): Promise<T> => new Promise<T>(() => undefined);

  test.each([
    ["making the avatar's export folder", () => ({ folderFs: { mkdir: () => never<void>(), lstat: () => never<never>(), realpath: () => never<string>() } })],
    ["the case probe", () => ({ caseProbe: { isCaseInsensitive: () => never<boolean>() } })],
  ])("%s that never answers fails the job (EXPORT_UNAVAILABLE not-writable) at the step deadline, and frees the slot", async (_what, over) => {
    const r = rig({ stepDeadlineMs: 40, ...over() });

    r.submit();
    const started = Date.now();
    await r.queue.idle();

    expect(r.states()[0]).toMatchObject({ status: "failed", error: { code: "EXPORT_UNAVAILABLE", exportReason: "not-writable" } });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(r.queue.reservedPhotos(r.w.avatar.id).size).toBe(0);
  });

  test("a flush of the root that never answers fails the job too", async () => {
    const r = rig({ stepDeadlineMs: 40, fs: { ...NODE_COMMIT_FS, fsyncDir: () => never<void>() } });

    r.submit();
    await r.queue.idle();

    expect(r.states()[0]).toMatchObject({ status: "failed", error: { code: "EXPORT_UNAVAILABLE", exportReason: "not-writable" } });
  });

  test("the temp's creation right before pass 2 that never answers fails the job before ffmpeg writes anything", async () => {
    let pass2 = false;
    let n = 0;
    const r = rig({
      stepDeadlineMs: 40,
      createTemp: () => never<void>(),
      runDeps: {
        run: async (opts) => {
          if (++n === 2) pass2 = true;
          await writingRun(opts);
        },
      },
    });

    r.submit();
    await r.queue.idle();

    expect(r.states()[0]).toMatchObject({ status: "failed", error: { code: "EXPORT_UNAVAILABLE", exportReason: "not-writable" } });
    expect(pass2).toBe(false);
    expect(await exportFiles(r.w)).toEqual([]);
  });

  test("a cancel while the export folder is being made ends the job cancelled at once, not at the deadline", async () => {
    const r = rig({ stepDeadlineMs: 60_000, folderFs: { mkdir: () => never<void>(), lstat: () => never<never>(), realpath: () => never<string>() } });

    r.submit();
    await new Promise((resolve) => setTimeout(resolve, 20));
    r.queue.cancel(JOB);
    await r.queue.idle();

    expect(r.states()[0]?.status).toBe("cancelled");
  });

  test("a cancel while the temp is being created ends the job cancelled", async () => {
    const r = rig({ stepDeadlineMs: 60_000, createTemp: () => never<void>() });

    r.submit();
    await until(() => r.states()[0]?.status === "running" && r.tracker.hasJob(JOB));
    await new Promise((resolve) => setTimeout(resolve, 50));
    r.queue.cancel(JOB);
    await r.queue.idle();

    expect(r.states()[0]?.status).toBe("cancelled");
  });
});

describe("the case probe of the export volume", () => {
  test("a probe that throws fails the job with the errno code only, before any folder is made", async () => {
    const r = rig({ caseProbe: { isCaseInsensitive: () => Promise.reject(Object.assign(new Error("EIO: i/o error, open '/Volumes/Reels/.studio-probe-case-x'"), { code: "EIO" })) } });

    r.submit();
    await r.queue.idle();

    const state = r.states()[0];
    expect(state).toMatchObject({ status: "failed", error: { code: "EXPORT_UNAVAILABLE", exportReason: "not-writable" } });
    expect(JSON.stringify(state)).not.toContain("/Volumes/Reels");
    expect(existsSync(join(r.w.exportRoot, "Mia"))).toBe(false);
  });
});

describe("the commit has its own deadline", () => {
  const hangAt = (step: string, release: Promise<void>): NonNullable<VideoRenderDeps["hooks"]> => ({
    reached: async (reached) => {
      if (reached === step) await release;
    },
  });

  test("a commit stuck before the claim ends the job (EXPORT_UNAVAILABLE), frees the queue, and cleans up once it wakes: nothing is saved", async () => {
    let wake: () => void = () => undefined;
    const release = new Promise<void>((resolve) => {
      wake = resolve;
    });
    const r = rig({ commitDeadlineMs: 30, hooks: hangAt("temp-synced", release) });

    r.submit();
    await r.queue.idle();

    expect(r.states()[0]).toMatchObject({ status: "failed", error: { code: "EXPORT_UNAVAILABLE", exportReason: "not-writable" } });
    expect(r.queue.reservedPhotos(r.w.avatar.id).size).toBe(0);
    // the stuck commit is still alive: recovery must not take its temp for a crash's leftover
    expect(r.tracker.hasJob(JOB)).toBe(true);

    wake();
    await until(() => !r.tracker.hasJob(JOB));

    expect(await exportFiles(r.w)).toEqual([]);
    expect(await libraryVideoFiles(r.w)).toEqual([]);
    expect(r.committed).toEqual([]);
  });

  test("a commit that outlives its pre-claim deadline and then fails on its own leaves no unhandled rejection", async () => {
    const unhandled = watchUnhandledRejections();
    let wake: () => void = () => undefined;
    const release = new Promise<void>((resolve) => {
      wake = resolve;
    });
    const r = rig({ commitDeadlineMs: 30, hooks: hangAt("temp-synced", release) });
    try {
      r.submit();
      await r.queue.idle();
      expect(r.states()[0]).toMatchObject({ status: "failed", error: { code: "EXPORT_UNAVAILABLE" } });
      await rm(r.w.exportRoot, { recursive: true, force: true }); // what the woken commit finds is a folder that is gone: it fails by itself
    } finally {
      wake();
      await until(() => !r.tracker.hasJob(JOB));
    }
    expect(await unhandled.settle()).toEqual([]);
  });

  test("after the pre-claim deadline the photos are free again: the reservation is released and nothing marks them used", async () => {
    let wake: () => void = () => undefined;
    const release = new Promise<void>((resolve) => {
      wake = resolve;
    });
    const r = rig({ commitDeadlineMs: 30, hooks: hangAt("temp-synced", release) });

    r.submit();
    await r.queue.idle();

    const photo = r.w.photos[0]?.id ?? "";
    expect(r.queue.reservedPhotos(r.w.avatar.id).has(photo)).toBe(false);
    expect(r.w.library.photoStates(r.w.avatar.id).get(photo)?.usedIn).toEqual([]);
    wake();
    await until(() => !r.tracker.hasJob(JOB));
    expect(r.w.library.photoStates(r.w.avatar.id).get(photo)?.usedIn).toEqual([]); // the woken commit never claims: it was told to stop
  });

  test("a commit stuck AFTER the claim is never failed and never released: the job stays running in its saving phase, the photos stay reserved, and the record lands", async () => {
    let wake: () => void = () => undefined;
    const release = new Promise<void>((resolve) => {
      wake = resolve;
    });
    const r = rig({ commitDeadlineMs: 30, hooks: hangAt("name-claimed", release) });

    r.submit();
    await new Promise((resolve) => setTimeout(resolve, 200)); // six deadlines later

    const photo = r.w.photos[0]?.id ?? "";
    expect(r.states()[0]).toMatchObject({ status: "running", saving: true });
    expect(r.queue.active()).toBe(1); // what a library switch and a shutdown wait for
    expect(r.queue.reservedPhotos(r.w.avatar.id).has(photo)).toBe(true);
    expect(r.tracker.hasJob(JOB)).toBe(true);

    wake();
    await r.queue.idle();

    expect(r.states()[0]).toMatchObject({ status: "done", result: { relPath: FINAL } });
    expect(await exportFiles(r.w)).toEqual([FINAL]);
    expect(r.committed.map((record) => record.id)).toEqual(["video-00000001"]);
    expect(r.w.library.photoStates(r.w.avatar.id).get(photo)?.usedIn).toEqual(["video-00000001"]);
    expect(r.queue.reservedPhotos(r.w.avatar.id).size).toBe(0);
  });

  test("a cancel during that stall is ignored: the job still ends done", async () => {
    let wake: () => void = () => undefined;
    const release = new Promise<void>((resolve) => {
      wake = resolve;
    });
    const r = rig({ commitDeadlineMs: 30, hooks: hangAt("name-claimed", release) });

    r.submit();
    await until(() => r.states().some((state) => "saving" in state && state.saving === true));
    r.queue.cancel(JOB);
    wake();
    await r.queue.idle();

    expect(r.states()[0]?.status).toBe("done");
  });

  test("a commit inside its deadline is not disturbed", async () => {
    const r = rig({ commitDeadlineMs: 60_000 });

    r.submit();
    await r.queue.idle();

    expect(r.states()[0]?.status).toBe("done");
  });
});

describe("onCommitted", () => {
  test("is called once with the record, after the used index has it and before the job ends", async () => {
    const seen: Array<{ id: string; used: string[]; status: string | undefined }> = [];
    const r = rig({
      onCommitted: (record) => {
        seen.push({ id: record.id, used: r.w.library.photoStates(r.w.avatar.id).get(r.w.photos[0]?.id ?? "")?.usedIn ?? [], status: r.states()[0]?.status });
      },
    });

    r.submit();
    await r.queue.idle();

    expect(seen).toEqual([{ id: "video-00000001", used: ["video-00000001"], status: "running" }]);
  });

  test("is not called for a job that failed", async () => {
    const r = rig({ verify: async () => ({ result: { ok: false, reasons: [{ code: "UUID_BOX", message: "m" }] }, sha256: null, bytes: 1 }) });

    r.submit();
    await r.queue.idle();

    expect(r.committed).toEqual([]);
  });

  test("a listener that throws does not fail the job that already committed", async () => {
    const r = rig({
      onCommitted: () => {
        throw new Error("the window is gone");
      },
    });

    r.submit();
    await r.queue.idle();

    expect(r.states()[0]?.status).toBe("done");
  });
});

async function until(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  if (!condition()) throw new Error("timed out");
}
