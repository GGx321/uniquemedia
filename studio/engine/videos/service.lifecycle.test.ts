import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { EngineFailure } from "../engineFailure";
import type { MontageDraft } from "../../shared/engine/montage";
import { NODE_COMMIT_FS } from "./commitFs";
import { commitIntent, writeIntent } from "./intents";
import { recoverVideos, type RecoveryReport } from "./recovery";
import type { VideoRecord } from "./record";
import { errnoError, faultyFs, FINAL, sampleRecord, specOf, useWorld, type World } from "./testing/kit";
import { DEFAULT_STALE_RETRY_DELAYS_MS } from "./service";
import { FakeTimers, serviceRig, until, withOverrides } from "./testing/serviceKit";
useNativeGlobals();

// What happens around a library opening and the engine stopping (3a.8b.2): recovery in the BACKGROUND with the very
// tracker the renders register in, adopted videos announced, the render-tmp sweep beside it, a stale used index read
// again in the background, and a bounded, graceful stop.

const world = useWorld();
const photoId = (w: World, i: number): string => w.photos[i]?.id ?? "";
const specFor = (w: World, i = 0): MontageDraft => specOf(w.avatar.id, [photoId(w, i)], 4_000);

const EMPTY_REPORT: RecoveryReport = { adopted: [], dropped: [], deferred: [], left: [], removed: { placeholders: 0, intentTemps: 0, markerTemps: 0, probes: 0, partTemps: 0 }, skipped: [] };

async function committedRecord(w: World, over: Parameters<typeof sampleRecord>[1] = {}): Promise<VideoRecord> {
  const record = sampleRecord(w, over);
  await writeIntent(NODE_COMMIT_FS, w.libraryRoot, record);
  await commitIntent(NODE_COMMIT_FS, w.libraryRoot, w.avatar.id, record.id);
  return record;
}

describe("recovery when a library opens", () => {
  test("runs in the background: libraryOpened returns at once, even when recovery hangs for ever, and commands still work", async () => {
    const w = world();
    const never = new Promise<RecoveryReport>(() => undefined);
    const r = serviceRig(w, { deps: { recover: { run: () => never } } });

    const returned = r.service.libraryOpened(w.library);

    expect(returned).toBeUndefined();
    expect(await r.service.list(w.avatar.id)).toEqual([]);
    const { jobId } = await r.service.render({ spec: specFor(w) });
    await r.queue.idle();
    expect(r.jobs.stateOf(jobId)?.status).toBe("done");
  });

  test("is called with the SAME tracker the renders register in, and a root looked at afresh", async () => {
    const w = world();
    const calls: Array<{ live: unknown; exportRoot: unknown }> = [];
    const r = serviceRig(w, {
      deps: {
        recover: {
          run: async (input) => {
            calls.push({ live: input.live, exportRoot: input.exportRoot });
            return EMPTY_REPORT;
          },
        },
      },
    });

    r.service.libraryOpened(w.library);
    await r.service.settled();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.live).toBe(r.tracker);
    expect(calls[0]?.exportRoot).toEqual({ root: w.exportRoot, rootId: w.rootId, caseInsensitive: false });
    expect(r.checks).toHaveLength(1);
  });

  test("an unusable export root is passed as null, so its intents are kept and nothing is judged", async () => {
    const w = world();
    const seen: unknown[] = [];
    const r = serviceRig(w, {
      deps: {
        checkExport: async () => ({ ok: false, reason: "missing" }),
        recover: {
          run: async (input) => {
            seen.push(input.exportRoot);
            return EMPTY_REPORT;
          },
        },
      },
    });

    r.service.libraryOpened(w.library);
    await r.service.settled();

    expect(seen).toEqual([null]);
  });

  test("is never called from a render's commit path", async () => {
    const w = world();
    let calls = 0;
    const r = serviceRig(w, {
      deps: {
        recover: {
          run: async () => {
            calls++;
            return EMPTY_REPORT;
          },
        },
      },
    });

    await r.service.render({ spec: specFor(w) });
    await r.queue.idle();
    await r.service.settled();

    expect(calls).toBe(0);
  });

  test("really settles a crash: a video whose commit died after the rename is adopted, and announced with video.changed", async () => {
    const w = world();
    // The crash: the intent and the renamed file are there, the record is not.
    const bytes = new Uint8Array(3000).fill(7);
    const record = sampleRecord(w, { bytes });
    const path = join(w.exportRoot, "Mia", "2026-09-29_photo_001.mp4");
    mkdirSync(join(w.exportRoot, "Mia"), { recursive: true });
    writeFileSync(path, bytes);
    await writeIntent(NODE_COMMIT_FS, w.libraryRoot, record);
    const r = serviceRig(w);

    r.service.libraryOpened(w.library);
    await r.service.settled();

    expect(w.library.photoStates(w.avatar.id).get(photoId(w, 0))?.usedIn).toEqual([record.id]);
    const changed = r.stamped().filter((e) => e.type === "video.changed");
    expect(changed.map((e) => (e.type === "video.changed" && e.payload.change === "upserted" ? [e.payload.video.videoId, e.payload.video.fileState] : null))).toEqual([[record.id, "present"]]);
  });

  test("an adopted video is announced only while its library is still the live one", async () => {
    const w = world();
    const record = await committedRecord(w);
    const other = withOverrides(w.library, {});
    const r = serviceRig(w, {
      deps: {
        openLibrary: () => other, // the live library is another instance by the time recovery ends
        recover: { run: async () => ({ ...EMPTY_REPORT, adopted: [record.id] }) },
      },
    });

    r.service.libraryOpened(w.library);
    await r.service.settled();

    expect(r.events).toEqual([]);
  });

  test("a recovery that throws is logged by kind, settles, and does not stop the next one", async () => {
    const w = world();
    let attempt = 0;
    const r = serviceRig(w, {
      deps: {
        recover: {
          run: async () => {
            attempt++;
            if (attempt === 1) throw Object.assign(new Error(`EIO: i/o error, scandir '${w.exportRoot}'`), { code: "EIO" });
            return EMPTY_REPORT;
          },
        },
      },
    });

    r.service.libraryOpened(w.library);
    await r.service.settled();
    r.service.libraryOpened(w.library);
    await r.service.settled();

    expect(attempt).toBe(2);
    expect(r.logs.join("\n")).toContain("EIO");
    expect(r.logs.join("\n")).not.toContain(w.exportRoot);
  });
});

describe("a commit that stalls after its claim (the review's double-use probe)", () => {
  test("its job stays running and its photos stay reserved, so a second render of them is refused and the photo is used exactly once", async () => {
    const w = world();
    let wake: () => void = () => undefined;
    const release = new Promise<void>((resolve) => {
      wake = resolve;
    });
    const r = serviceRig(w, {
      size: 2,
      deps: { renderOverrides: { commitDeadlineMs: 50, hooks: { reached: async (step) => (step === "name-claimed" ? release : undefined) } } },
    });

    const first = await r.service.render({ spec: specFor(w) });
    await until(() => r.jobs.stateOf(first.jobId)?.status === "running" && r.tracker.placeholderPaths().size === 1, "the first commit to claim its name");
    await new Promise((resolve) => setTimeout(resolve, 200)); // four deadlines later
    expect(r.jobs.stateOf(first.jobId)).toMatchObject({ status: "running", saving: true });

    const second = await r.service.render({ spec: specFor(w) }).then(
      () => "accepted",
      (error: unknown) => (error instanceof EngineFailure ? error.error.code : "other"),
    );
    expect(second).toBe("PHOTO_UNAVAILABLE");

    wake();
    await r.queue.idle();
    expect(w.library.photoStates(w.avatar.id).get(photoId(w, 0))?.usedIn).toEqual([first.videoId]);
  });
});

describe("recovery of a library that is no longer the live one", () => {
  test("a switch tells the earlier library's recovery to stop, and the new one starts without waiting for it", async () => {
    const w = world();
    const signals: Array<{ library: unknown; signal: AbortSignal | undefined }> = [];
    const first = w.library;
    const second = withOverrides(w.library, {});
    const r = serviceRig(w, {
      deps: {
        recover: {
          run: (input) => {
            signals.push({ library: input.library, signal: input.signal });
            return input.library === first ? new Promise<RecoveryReport>(() => undefined) : Promise.resolve(EMPTY_REPORT); // the first one ignores its signal and hangs
          },
        },
      },
    });

    r.service.libraryOpened(first);
    await until(() => signals.length === 1, "the first recovery to start");
    r.service.libraryOpened(second);
    await until(() => signals.length === 2, "the second recovery to start although the first is stuck");

    expect(signals[0]?.signal?.aborted).toBe(true);
    expect(signals[1]?.signal?.aborted).toBe(false);
  });
});

describe("a commit that fails and leaves its intent is settled INSIDE the job, while the reservation is held", () => {
  const boom = (): Error => new Error("the disk broke after the rename");

  test("the file could not be taken back (a player, an antivirus holds it): the video is adopted before the job ends, and the job ends DONE", async () => {
    const w = world();
    const fs = faultyFs();
    fs.override({ unlink: () => Promise.reject(errnoError("EBUSY")) });
    const r = serviceRig(w, {
      deps: { renderOverrides: { fs, hooks: { reached: (step) => void (step === "renamed" && (() => { throw boom(); })()) } } },
    });

    const { jobId, videoId } = await r.service.render({ spec: specFor(w) });
    await r.queue.idle();

    expect(r.jobs.stateOf(jobId)).toMatchObject({ status: "done", result: { videoId } });
    expect(w.library.photoStates(w.avatar.id).get(photoId(w, 0))?.usedIn).toEqual([videoId]);
    expect(existsSync(join(w.libraryRoot, "avatars", w.avatar.id, "videos", ".pending", `${videoId}.json`))).toBe(false);
    const kinds = r.stamped().map((e) => e.type);
    expect(kinds).not.toContain("job.failed");
    expect(kinds.indexOf("video.changed")).toBeLessThan(kinds.indexOf("job.done"));
    expect(r.tracker.liveJobIds().size).toBe(0);
  });

  test("the review's probe: the record link and the rename fail (EIO), the file is held (EBUSY): no window where a second render is accepted, one video, no event after job.failed", async () => {
    const w = world();
    const eio = () => errnoError("EIO");
    const fs = faultyFs();
    fs.override({
      link: async (a, b) => (b.endsWith(".json") && !b.includes(".pending") ? Promise.reject(eio()) : NODE_COMMIT_FS.link(a, b)),
      rename: async (a, b) => (a.includes(".pending") && b.endsWith(".json") && !b.includes(".pending") ? Promise.reject(eio()) : NODE_COMMIT_FS.rename(a, b)),
      unlink: async (p) => (p.endsWith(".mp4") && !p.includes(".studio-part-") ? Promise.reject(errnoError("EBUSY")) : NODE_COMMIT_FS.unlink(p)),
    });
    const r = serviceRig(w, { size: 2, deps: { renderOverrides: { fs } } });
    const spec = specFor(w);

    const first = await r.service.render({ spec });
    await until(() => ["done", "failed"].includes(r.jobs.stateOf(first.jobId)?.status ?? ""), "the first job to end");
    const second = await r.service.render({ spec }).then(
      () => "accepted",
      (error: unknown) => (error instanceof EngineFailure ? error.error.code : "other"),
    );
    await r.queue.idle();
    await r.service.settled();

    expect(second).toBe("PHOTO_UNAVAILABLE");
    expect(w.library.photoStates(w.avatar.id).get(photoId(w, 0))?.usedIn).toEqual([first.videoId]);
    const events = r.stamped();
    const failedAt = events.findIndex((e) => e.type === "job.failed");
    const upsertAt = events.findIndex((e) => e.type === "video.changed" && e.payload.change === "upserted");
    if (failedAt >= 0) expect(upsertAt).toBeLessThan(failedAt); // nothing about that video after the failure
  });

  test("when settling drops the intent instead, the job ends FAILED and the photos are free: no record, no mark", async () => {
    const w = world();
    const fs = faultyFs();
    fs.override({ unlink: () => Promise.reject(errnoError("EBUSY")) });
    const inputs: Array<{ only: unknown; jobLive: boolean | undefined }> = [];
    const r = serviceRig(w, {
      deps: {
        renderOverrides: { fs, hooks: { reached: (step) => void (step === "intent-written" && (() => { throw boom(); })()) } },
        recover: {
          run: async (input) => {
            inputs.push({ only: input.only, jobLive: input.live?.hasJob("id-none") });
            return { ...EMPTY_REPORT, dropped: [{ videoId: "x", reason: "no-file" }] };
          },
        },
      },
    });

    const { jobId, videoId } = await r.service.render({ spec: specFor(w) });
    await r.queue.idle();

    expect(r.jobs.stateOf(jobId)?.status).toBe("failed");
    expect(inputs).toEqual([{ only: { videoIds: [videoId] }, jobLive: false }]);
    expect(r.queue.reservedPhotos(w.avatar.id).size).toBe(0);
    expect(w.library.photoStates(w.avatar.id).get(photoId(w, 0))?.usedIn).toEqual([]);
  });

  test("the settle does not see its own job as live (or it would defer its own intent), but sees the others", async () => {
    const w = world();
    const fs = faultyFs();
    fs.override({ unlink: () => Promise.reject(errnoError("EBUSY")) });
    let seen: { own: boolean; other: boolean } | undefined;
    const r = serviceRig(w, {
      deps: {
        renderOverrides: { fs, hooks: { reached: (step) => void (step === "intent-written" && (() => { throw boom(); })()) } },
        recover: {
          run: async (input) => {
            seen = { own: input.live?.hasJob(r.queue.states()[0]?.jobId ?? "") === true, other: input.live?.hasJob("job-other") === true };
            return EMPTY_REPORT;
          },
        },
      },
    });
    r.tracker.addJob("job-other", "video-other");
    await r.service.render({ spec: specFor(w) });
    await r.queue.idle();

    expect(seen).toEqual({ own: false, other: true });
  });

  test("it is bounded: a settle that never answers fails the job at the step deadline and is told to stop", async () => {
    const w = world();
    const fs = faultyFs();
    fs.override({ unlink: () => Promise.reject(errnoError("EBUSY")) });
    let signal: AbortSignal | undefined;
    const r = serviceRig(w, {
      deps: {
        renderOverrides: { fs, stepDeadlineMs: 50, hooks: { reached: (step) => void (step === "intent-written" && (() => { throw boom(); })()) } },
        recover: {
          run: (input) => {
            signal = input.signal;
            return new Promise<RecoveryReport>(() => undefined);
          },
        },
      },
    });

    const { jobId } = await r.service.render({ spec: specFor(w) });
    await r.queue.idle();

    expect(r.jobs.stateOf(jobId)?.status).toBe("failed");
    expect(signal?.aborted).toBe(true);
  });

  test("a settle cut by its bound leaves the photos HELD after job.failed: a re-render with them is refused (review round 1, M2)", async () => {
    const w = world();
    const fs = faultyFs();
    fs.override({ unlink: () => Promise.reject(errnoError("EBUSY")) });
    const r = serviceRig(w, {
      size: 2,
      deps: {
        renderOverrides: { fs, stepDeadlineMs: 50, hooks: { reached: (step) => void (step === "intent-written" && (() => { throw boom(); })()) } },
        recover: { run: () => new Promise<RecoveryReport>(() => undefined) },
      },
    });

    const { jobId } = await r.service.render({ spec: specFor(w) });
    await r.queue.idle();
    expect(r.jobs.stateOf(jobId)?.status).toBe("failed");

    expect(w.library.photoStates(w.avatar.id).get(photoId(w, 0))).toMatchObject({ reserved: true, usedIn: [] });
    const again = await r.service.render({ spec: specFor(w) }).then(
      () => "accepted",
      (error: unknown) => (error instanceof EngineFailure ? error.error.code : "other"),
    );
    expect(again).toBe("PHOTO_UNAVAILABLE");
  });

  test("scenario B: the commit failed after the rename on a refusing disk and the settle DEFERRED the intent: the job fails, a re-render with the same photos is refused, and the later adoption makes one video (review round 1)", async () => {
    const w = world();
    const fs = faultyFs();
    fs.override({ unlink: () => Promise.reject(errnoError("EBUSY")) });
    const r = serviceRig(w, {
      size: 2,
      deps: {
        renderOverrides: { fs, hooks: { reached: (step) => void (step === "renamed" && (() => { throw boom(); })()) } },
        // The settle cannot judge the export folder: recovery defers the intent.
        recover: { run: (input, recoverDeps) => recoverVideos({ ...input, exportRoot: null }, recoverDeps) },
      },
    });

    const { jobId, videoId } = await r.service.render({ spec: specFor(w) });
    await r.queue.idle();
    expect(r.jobs.stateOf(jobId)?.status).toBe("failed");

    const again = await r.service.render({ spec: specFor(w) }).then(
      () => "accepted",
      (error: unknown) => (error instanceof EngineFailure ? error.error.code : "other"),
    );
    expect(again).toBe("PHOTO_UNAVAILABLE");
    // The next open, with the export folder in view, adopts the file: its video is the only one that has the photo.
    const reopened = serviceRig(w, { library: w.library });
    reopened.service.libraryOpened(w.library);
    await reopened.service.settled();
    expect(w.library.photoStates(w.avatar.id).get(photoId(w, 0))).toMatchObject({ reserved: false, usedIn: [videoId] });
  });

  test("the usual failure, whose rollback removed everything, starts no recovery at all", async () => {
    const w = world();
    let runs = 0;
    const r = serviceRig(w, {
      deps: {
        renderOverrides: { verify: async () => ({ result: { ok: false, reasons: [{ code: "UUID_BOX", message: "m" }] }, sha256: null, bytes: 1 }) },
        recover: {
          run: async () => {
            runs++;
            return EMPTY_REPORT;
          },
        },
      },
    });

    await r.service.render({ spec: specFor(w) });
    await r.queue.idle();
    await r.service.settled();

    expect(runs).toBe(0);
  });
});

describe("an intent recovery deferred (stage 3 review 3-M3: one photo, one video)", () => {
  test("with the export folder absent at start, the intent's photos stay held all session: a new render with them is refused, and the intent is adopted later into ONE video", async () => {
    const w = world();
    const bytes = new Uint8Array(2048).fill(7);
    const crashed = sampleRecord(w, { bytes, videoId: "video-0000000a", jobId: "job-0000000a" });
    await writeIntent(NODE_COMMIT_FS, w.libraryRoot, crashed);
    mkdirSync(join(w.exportRoot, "Mia"), { recursive: true });
    writeFileSync(join(w.exportRoot, FINAL), bytes);
    const library = await w.reopen();
    const r = serviceRig(w, { library });

    // The start finds the export folder absent: the intent is deferred.
    r.service.startup(library, { ok: false, reason: "missing" });
    await r.service.settled();
    // The folder is back by the time the owner renders, and asks for the SAME photo.
    const error = await r.service.render({ spec: specFor(w) }).then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(EngineFailure);
    expect(error).toMatchObject({ error: { code: "PHOTO_UNAVAILABLE" } });
    // The next open settles the intent: its video is the only one that has the photo.
    r.service.libraryOpened(library);
    await r.service.settled();
    expect(library.photoStates(w.avatar.id).get(photoId(w, 0))).toMatchObject({ reserved: false, usedIn: [crashed.id] });
  });
});

describe("the hold of a pending intent does not wait on a disk that fails or hangs (review round 2, M2)", () => {
  const boom = (): Error => new Error("the disk broke after the intent");
  const refusing = () => {
    const fs = faultyFs();
    fs.override({ unlink: () => Promise.reject(errnoError("EBUSY")) });
    return fs;
  };
  const refused = (r: ReturnType<typeof serviceRig>, w: World): Promise<string> =>
    r.service.render({ spec: specFor(w) }).then(
      () => "accepted",
      (error: unknown) => (error instanceof EngineFailure ? error.error.code : "other"),
    );

  test.each([
    ["an lstat that fails (EIO)", () => Promise.reject(errnoError("EIO")), undefined],
    ["an lstat that never answers", () => new Promise<never>(() => undefined), 50],
  ] as const)("%s: the job fails and the photos stay held", async (_name, intentLstat, stepDeadlineMs) => {
    const w = world();
    const r = serviceRig(w, {
      size: 2,
      deps: { intentLstat, renderOverrides: { fs: refusing(), ...(stepDeadlineMs === undefined ? {} : { stepDeadlineMs }), hooks: { reached: (step) => void (step === "intent-written" && (() => { throw boom(); })()) } } },
    });

    const { jobId } = await r.service.render({ spec: specFor(w) });
    await r.queue.idle();

    expect(r.jobs.stateOf(jobId)?.status).toBe("failed");
    expect(w.library.photoStates(w.avatar.id).get(photoId(w, 0))?.reserved).toBe(true);
    expect(await refused(r, w)).toBe("PHOTO_UNAVAILABLE");
  });

  test("recovery that hangs on the export root at the start still holds the photos: the library is read before the root is asked (the start-up window)", async () => {
    const w = world();
    await writeIntent(NODE_COMMIT_FS, w.libraryRoot, sampleRecord(w, { videoId: "video-0000000a", jobId: "job-0000000a" }));
    const library = await w.reopen();
    const r = serviceRig(w, { library, deps: { checkExport: () => new Promise<never>(() => undefined) } });

    r.service.libraryOpened(library);
    await until(() => library.photoStates(w.avatar.id).get(photoId(w, 0))?.reserved === true, "the photos to be held");

    expect(library.eligibleUnusedPhotos(w.avatar.id).map((p) => p.id)).not.toContain(photoId(w, 0));
  });
});

describe("a cancel while the commit scans the numbers (review round 2, M1)", () => {
  test("the job ends cancelled, not failed with a library error", async () => {
    const w = world();
    let scanning: () => void = () => undefined;
    const reachedScan = new Promise<void>((resolve) => (scanning = resolve));
    const numberFs = {
      readdir: (): Promise<Array<{ name: string; isFile: boolean }>> => (scanning(), new Promise(() => undefined)),
      lstat: async () => ({ size: 0, isFile: true }),
      readFile: async () => "",
    };
    const r = serviceRig(w, { deps: { renderOverrides: { numberFs } } });

    const { jobId } = await r.service.render({ spec: specFor(w) });
    await reachedScan;
    r.service.cancel(jobId);
    await r.queue.idle();

    expect(r.jobs.stateOf(jobId)?.status).toBe("cancelled");
  });
});

describe("holds that a recovery made are announced (review round 1, L3)", () => {
  test("a deferred intent holds its avatar's photos: the avatar is announced so its eligibleUnusedCount refreshes", async () => {
    const w = world();
    await writeIntent(NODE_COMMIT_FS, w.libraryRoot, sampleRecord(w, { videoId: "video-0000000a", jobId: "job-0000000a" }));
    const library = await w.reopen();
    const r = serviceRig(w, { library });
    const before = library.eligibleUnusedCount(w.avatar.id);

    r.service.startup(library, { ok: false, reason: "missing" });
    await r.service.settled();

    expect(library.eligibleUnusedCount(w.avatar.id)).toBe(before - 1);
    expect(r.announced).toContain(w.avatar.id);
  });

  test("a hold that does not move the free count is announced too: the photo was already out of reach, but its state is «reserved» now (review round 2, N5)", async () => {
    const w = world();
    await w.library.setRejected(w.avatar.id, photoId(w, 0), true);
    await writeIntent(NODE_COMMIT_FS, w.libraryRoot, sampleRecord(w, { videoId: "video-0000000a", jobId: "job-0000000a" }));
    const library = await w.reopen();
    const r = serviceRig(w, { library });
    const before = library.eligibleUnusedCount(w.avatar.id);

    r.service.startup(library, { ok: false, reason: "missing" });
    await r.service.settled();

    expect(library.eligibleUnusedCount(w.avatar.id)).toBe(before);
    expect(r.announced).toContain(w.avatar.id);
  });

  test("a clean start announces nothing", async () => {
    const w = world();
    const r = serviceRig(w, { library: await w.reopen() });

    r.service.startup(w.library, { ok: true, root: w.exportRoot, rootId: w.rootId });
    await r.service.settled();

    expect(r.announced).toEqual([]);
  });
});

describe("startup", () => {
  test("sweeps render-tmp beside the recovery, leaving the folder of a job that is running", async () => {
    const w = world();
    mkdirSync(join(w.renderTmp, "job-leftover-1"));
    writeFileSync(join(w.renderTmp, "job-leftover-1", "clip-00.mkv"), "half a clip");
    mkdirSync(join(w.renderTmp, "job-live-0001"));
    writeFileSync(join(w.renderTmp, "stray.tmp"), "x");
    const r = serviceRig(w, { deps: { recover: { run: async () => EMPTY_REPORT } } });
    r.tracker.addJob("job-live-0001", "video-live-001");

    r.service.startup(w.library);
    await r.service.settled();

    expect(existsSync(join(w.renderTmp, "job-leftover-1"))).toBe(false);
    expect(existsSync(join(w.renderTmp, "stray.tmp"))).toBe(false);
    expect(existsSync(join(w.renderTmp, "job-live-0001"))).toBe(true);
  });

  test("recovers against the export check the start has just made, not against another one", async () => {
    const w = world();
    const seen: unknown[] = [];
    const r = serviceRig(w, {
      deps: {
        recover: {
          run: async (input) => {
            seen.push(input.exportRoot);
            return EMPTY_REPORT;
          },
        },
      },
    });

    r.service.startup(w.library, { ok: true, root: w.exportRoot, rootId: w.rootId });
    await r.service.settled();

    expect(seen).toEqual([{ root: w.exportRoot, rootId: w.rootId, caseInsensitive: false }]);
    expect(r.checks).toHaveLength(0); // no second look at the export folder in the background
  });

  test("sweeps even when no library could be opened, and recovers nothing", async () => {
    const w = world();
    writeFileSync(join(w.renderTmp, "stray.tmp"), "x");
    let recovered = 0;
    const r = serviceRig(w, {
      deps: {
        recover: {
          run: async () => {
            recovered++;
            return EMPTY_REPORT;
          },
        },
      },
    });

    r.service.startup(null);
    await r.service.settled();

    expect(existsSync(join(w.renderTmp, "stray.tmp"))).toBe(false);
    expect(recovered).toBe(0);
  });

  test("does nothing to render-tmp when no folder is configured", async () => {
    const w = world();
    const r = serviceRig(w, { deps: { renderTmpDir: undefined } });

    r.service.startup(null);
    await r.service.settled();

    expect(r.logs).toEqual([]);
  });
});

describe("a stale used index is read again in the background", () => {
  test("after a library opens: the flag clears once the records are read, and the avatar can be used again", async () => {
    const w = world();
    w.library.flagVideoIndexStale(w.avatar.id, "video-committed-1");
    expect(() => w.library.eligibleUnusedPhotos(w.avatar.id)).toThrow();
    const r = serviceRig(w, { deps: { recover: { run: async () => EMPTY_REPORT } } });

    r.service.libraryOpened(w.library);
    await r.service.settled();
    await until(() => w.library.videoIndexStale(w.avatar.id).length === 0, "the stale flag to clear");

    expect(w.library.eligibleUnusedPhotos(w.avatar.id).length).toBeGreaterThan(0);
  });

  test("the default schedule is 2 s, 10 s, 60 s, and the last delay REPEATS: the avatar is not left closed for the session", async () => {
    expect(DEFAULT_STALE_RETRY_DELAYS_MS).toEqual([2_000, 10_000, 60_000]);
    const w = world();
    w.library.flagVideoIndexStale(w.avatar.id, "video-committed-1");
    let reloads = 0;
    const library = withOverrides(w.library, {
      reloadVideoRecords: () => {
        reloads++;
        return reloads < 6 ? Promise.reject(new Error("EIO")) : w.library.reloadVideoRecords(w.avatar.id);
      },
    });
    const timers = new FakeTimers();
    // no `staleRetryDelaysMs`: the service's own default, on a clock the test moves
    const r = serviceRig(w, { library, deps: { staleRetryDelaysMs: undefined, timers, recover: { run: async () => EMPTY_REPORT } } });

    r.service.libraryOpened(library);
    await r.service.settled();
    expect(timers.delays).toEqual([2_000]);
    await timers.advance(2_000);
    expect(reloads).toBe(1);
    expect(timers.delays).toEqual([10_000]);
    await timers.advance(10_000);
    expect(timers.delays).toEqual([60_000]);
    await timers.advance(60_000);
    expect(timers.delays).toEqual([60_000]); // the last delay again, not the end of the chain
    await timers.advance(60_000);
    await timers.advance(60_000);
    await timers.advance(60_000);
    expect(reloads).toBe(6);
    expect(w.library.videoIndexStale(w.avatar.id)).toEqual([]);
    expect(timers.delays).toEqual([]); // read at last: the chain is over
  });

  test("one chain per avatar: a job ending while a chain is running starts no second one", async () => {
    const w = world();
    w.library.flagVideoIndexStale(w.avatar.id, "video-committed-1");
    const timers = new FakeTimers();
    const r = serviceRig(w, { deps: { timers, recover: { run: async () => EMPTY_REPORT } } });
    r.service.libraryOpened(w.library);
    await r.service.settled();

    await r.service.render({ spec: specFor(w) }).catch(() => undefined); // reads the index again on demand and goes through
    await r.queue.idle();

    expect(timers.delays.length).toBeLessThanOrEqual(1);
  });

  test("the chain never forks: a job ending while a retry is still reading starts no second chain, and no handle is lost", async () => {
    const w = world();
    w.library.flagVideoIndexStale(w.avatar.id, "video-committed-1");
    let failRead: (error: Error) => void = () => undefined;
    const library = withOverrides(w.library, {
      reloadVideoRecords: () =>
        new Promise<void>((_resolve, reject) => {
          failRead = reject;
        }),
    });
    const timers = new FakeTimers();
    const r = serviceRig(w, { library, deps: { staleRetryDelaysMs: undefined, timers, recover: { run: async () => EMPTY_REPORT } } });
    r.service.libraryOpened(library);
    await r.service.settled();
    await timers.advance(2_000); // the first retry is now reading, and has not answered

    const ref = { kind: "render" as const, jobId: "job-fork-0001", videoId: "video-fork-001", avatarId: w.avatar.id, montageId: null };
    r.jobs.queueRender(ref.jobId, { videoId: ref.videoId, avatarId: ref.avatarId, montageId: null }, 120);
    r.jobs.startRender(ref.jobId);
    const state = r.jobs.finishRender(ref.jobId, { status: "cancelled" });
    if (state === null) throw new Error("no state");
    r.service.onQueueEvent({ type: "ended", state });

    expect(timers.delays).toEqual([]); // no second chain beside the running one
    failRead(new Error("EIO"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(timers.delays).toEqual([10_000]); // exactly one next step
  });

  test("does not touch a library that is no longer the live one", async () => {
    const w = world();
    w.library.flagVideoIndexStale(w.avatar.id, "video-committed-1");
    let reloads = 0;
    const library = withOverrides(w.library, {
      reloadVideoRecords: () => {
        reloads++;
        return Promise.resolve();
      },
    });
    const timers = new FakeTimers();
    const r = serviceRig(w, { library, deps: { openLibrary: () => w.library, timers, recover: { run: async () => EMPTY_REPORT } } });

    r.service.libraryOpened(library);
    await r.service.settled();
    await timers.advance(120_000);

    expect(reloads).toBe(0);
  });

  test("a shutdown ends the chain: nothing is retried after it", async () => {
    const w = world();
    w.library.flagVideoIndexStale(w.avatar.id, "video-committed-1");
    const timers = new FakeTimers();
    let reloads = 0;
    const library = withOverrides(w.library, {
      reloadVideoRecords: () => {
        reloads++;
        return Promise.reject(new Error("EIO"));
      },
    });
    const r = serviceRig(w, { library, deps: { timers, recover: { run: async () => EMPTY_REPORT } } });
    r.service.libraryOpened(library);
    await r.service.settled();

    await r.service.shutdown(50);
    await timers.advance(300_000);

    expect(reloads).toBe(0);
    expect(timers.delays).toEqual([]);
  });

  test("after a commit whose index update failed: the job still ends done, the avatar is closed, and the background retry reopens it", async () => {
    const w = world();
    let reloads = 0;
    const library = withOverrides(w.library, {
      addVideoRecordToIndex: () => {
        throw new Error("index broke");
      },
      reloadVideoRecords: (avatarId: string) => {
        reloads++;
        return reloads === 1 ? Promise.reject(new Error("EIO")) : w.library.reloadVideoRecords(avatarId);
      },
    });
    const r = serviceRig(w, { library });

    const { jobId } = await r.service.render({ spec: specFor(w) });
    await r.queue.idle();

    expect(r.jobs.stateOf(jobId)?.status).toBe("done");
    expect(w.library.videoIndexStale(w.avatar.id)).toHaveLength(1);
    await until(() => w.library.videoIndexStale(w.avatar.id).length === 0, "the stale flag to clear");
    expect(w.library.photoStates(w.avatar.id).get(photoId(w, 0))?.usedIn).toHaveLength(1);
  });
});

describe("stopping the engine", () => {
  test("cancels a queued and a running render, waits for them, and says all ended", async () => {
    const w = world();
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const r = serviceRig(w, {
      deps: {
        renderOverrides: {
          runDeps: {
            run: (opts) =>
              new Promise<void>((_resolve, reject) => {
                started();
                opts.signal?.addEventListener("abort", () => reject(opts.signal?.reason), { once: true });
              }),
          },
        },
      },
    });
    const first = await r.service.render({ spec: specFor(w, 0) });
    const second = await r.service.render({ spec: specFor(w, 1) });
    await running;

    const outcome = await r.service.shutdown(2_000);

    expect(outcome).toEqual({ idle: true });
    expect(r.jobs.stateOf(first.jobId)?.status).toBe("cancelled");
    expect(r.jobs.stateOf(second.jobId)?.status).toBe("cancelled");
    expect(existsSync(join(w.exportRoot, "Mia", `.studio-part-${first.jobId}.mp4`))).toBe(false);
  });

  test("a commit already past its claim is allowed to finish: the video, its record and its used mark are complete", async () => {
    const w = world();
    let stopping: Promise<{ idle: boolean }> | undefined;
    const r = serviceRig(w, {
      deps: {
        renderOverrides: {
          hooks: {
            reached: (step) => {
              if (step === "name-claimed") stopping = r.service.shutdown(5_000); // the app quits right here
            },
          },
        },
      },
    });
    const { jobId } = await r.service.render({ spec: specFor(w) });
    await until(() => stopping !== undefined, "the commit to claim its name");

    const outcome = await stopping;
    await r.queue.idle();

    expect(outcome).toEqual({ idle: true });
    expect(r.jobs.stateOf(jobId)).toMatchObject({ status: "done", result: { relPath: FINAL } });
    expect(existsSync(join(w.exportRoot, FINAL))).toBe(true);
    expect(w.library.photoStates(w.avatar.id).get(photoId(w, 0))?.usedIn).toHaveLength(1);
  });

  test("is bounded: a job that never ends does not hold the stop for longer than the bound", async () => {
    const w = world();
    let ffmpegStarted = false;
    const r = serviceRig(w, {
      deps: {
        renderOverrides: {
          runDeps: {
            run: () => {
              ffmpegStarted = true;
              return new Promise<void>(() => undefined); // an ffmpeg that ignores its signal
            },
          },
        },
      },
    });
    await r.service.render({ spec: specFor(w) });
    await until(() => ffmpegStarted, "ffmpeg to start");
    const started = Date.now();

    const outcome = await r.service.shutdown(60);

    expect(outcome).toEqual({ idle: false });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("refuses a render from then on, and a render that was already inside its checks cannot slip in behind the stop", async () => {
    const w = world();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const r = serviceRig(w, {
      deps: {
        focus: () => ({
          fillMissingFocus: async (spec) => {
            await gate;
            return { spec, unresolved: [] };
          },
        }),
      },
    });
    const inside = r.service.render({ spec: specFor(w, 0) }).then(
      () => "queued",
      (error: unknown) => (error instanceof EngineFailure ? error.error.code : "other"),
    );
    await until(() => r.checks.length > 0, "the render to reach its checks");

    await r.service.shutdown(100);
    release();

    expect(await inside).toBe("INTERNAL");
    await expect(r.service.render({ spec: specFor(w, 1) })).rejects.toBeInstanceOf(EngineFailure);
    expect(r.queue.states()).toEqual([]);
  });
});
