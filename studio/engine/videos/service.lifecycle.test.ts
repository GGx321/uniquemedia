import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { EngineFailure } from "../engineFailure";
import type { MontageDraft } from "../../shared/engine/montage";
import { NODE_COMMIT_FS } from "./commitFs";
import { commitIntent, writeIntent } from "./intents";
import type { RecoveryReport } from "./recovery";
import type { VideoRecord } from "./record";
import { FINAL, sampleRecord, specOf, useWorld, type World } from "./testing/kit";
import { serviceRig, until, withOverrides } from "./testing/serviceKit";
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
    r.service.libraryOpened(w.library);
    await r.service.settled();

    expect(attempt).toBe(2);
    expect(r.logs.join("\n")).toContain("EIO");
    expect(r.logs.join("\n")).not.toContain(w.exportRoot);
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

  test("gives up after its delays when the records cannot be read, leaving the flag for the next open", async () => {
    const w = world();
    w.library.flagVideoIndexStale(w.avatar.id, "video-committed-1");
    let reloads = 0;
    const library = withOverrides(w.library, {
      reloadVideoRecords: () => {
        reloads++;
        return Promise.reject(new Error("EIO"));
      },
    });
    const r = serviceRig(w, { library, deps: { recover: { run: async () => EMPTY_REPORT } } });

    r.service.libraryOpened(library);
    await r.service.settled();
    await until(() => reloads >= 3, "the retries");
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(reloads).toBe(3);
    expect(w.library.videoIndexStale(w.avatar.id)).toEqual(["video-committed-1"]);
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
    const r = serviceRig(w, { library, deps: { openLibrary: () => w.library, recover: { run: async () => EMPTY_REPORT } } });

    r.service.libraryOpened(library);
    await r.service.settled();
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(reloads).toBe(0);
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
