import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, rename, rm, unlink as fsUnlink, writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { JobProgress, JobResult, JobState, MediaSummary, type EngineError, type PickedFileIdentity, type UnsequencedEvent } from "../../shared/engine";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { tempDirFor } from "../../testing/tempDir";
import { JobRegistry } from "../jobs";
import { PNG_1X1 } from "../library/testing/sampleData";
import { SimulatedCrash, treatSimulatedCrash } from "../library/testing/mediaCrash";
import { pickedIdentityOf } from "./identity";
import type { OpenRegularOps } from "../library/openRegular";
import type { MediaImporter, MediaImportCall } from "./imports";
import { MediaService, type MediaServiceDeps } from "./service";
useNativeGlobals();

// 3f.1b: the import job. `media.import` validates the open and starts a job; the copy of up to 2 GiB, the importer and the record all run
// INSIDE the job, with byte progress and a cancel that works at every phase and leaves nothing behind.

// Every rig's service is stopped after its test, BEFORE the temp dir is removed (hooks run in the order they are registered): a test
// that timed out leaves a job holding a staged file, and on Windows the folder cannot be removed under an open handle. `stop` is bounded
// (`stopWaitMs`), so a hung importer costs seconds, not the shard.
const rigs: MediaService[] = [];
afterEach(async () => {
  const opened = rigs.splice(0);
  await Promise.all(opened.map((service) => service.stop()));
});

const tmp = tempDirFor({ beforeEach, afterEach }, "studio-media-service-");
const libraryRoot = (): string => join(tmp(), "library");
const mediaDir = (): string => join(libraryRoot(), "media");
const stagingDir = (): string => join(mediaDir(), ".staging");
const pickedDir = (): string => join(tmp(), "picked");

beforeEach(async () => {
  await mkdir(libraryRoot(), { recursive: true });
  await mkdir(pickedDir(), { recursive: true });
});

const jpeg = (size = 200): Buffer<ArrayBuffer> => {
  const buffer = Buffer.alloc(size, 9);
  buffer.set([0xff, 0xd8, 0xff, 0xe0]);
  return buffer;
};
const PHOTO_FACTS = { width: 100, height: 200, durationMs: null, sourceFps: null, hdrToSdr: false, loopFrames: null, delayFrames: null } as const;

let counter = 0;
async function picked(name: string, bytes: Buffer): Promise<{ path: string; expected: PickedFileIdentity }> {
  const path = join(pickedDir(), name);
  await writeFile(path, bytes);
  return { path, expected: pickedIdentityOf(await lstat(path, { bigint: true })) };
}
async function callFor(name: string, bytes: Buffer, pick: MediaImportCall["pick"] = "photo"): Promise<MediaImportCall> {
  const file = await picked(name, bytes);
  return { pick, path: file.path, name, expected: file.expected };
}

interface Rig {
  service: MediaService;
  jobs: JobRegistry;
  events: UnsequencedEvent[];
  holds: { now: number; max: number };
  closeAll(): Promise<void>;
}

function rig(extra: Partial<MediaServiceDeps> = {}): Rig {
  const jobs = new JobRegistry();
  const events: UnsequencedEvent[] = [];
  const holds = { now: 0, max: 0 };
  const service = new MediaService({
    jobs,
    emit: (event) => events.push(event),
    withLibrary: async (work) => {
      holds.now++;
      holds.max = Math.max(holds.max, holds.now);
      try {
        return await work({ root: libraryRoot() });
      } finally {
        holds.now--;
      }
    },
    newId: () => `id-${String(++counter).padStart(8, "0")}`,
    now: () => new Date("2026-10-04T10:00:00.000Z"),
    importers: { photo: async () => ({ ok: true, facts: PHOTO_FACTS }) },
    log: () => undefined,
    ...extra,
  });
  rigs.push(service);
  return { service, jobs, events, holds, closeAll: () => service.stop() };
}

const staged = async (): Promise<string[]> => (await readdir(stagingDir()).catch(() => [])).sort();
const stored = async (): Promise<string[]> => (await readdir(mediaDir()).catch(() => [])).filter((n) => n !== ".staging").sort();
const types = (events: UnsequencedEvent[]): string[] => events.map((e) => e.type);

async function started(r: Rig, call: MediaImportCall, signal?: AbortSignal): Promise<string> {
  const result = await r.service.import(call, signal);
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result.jobId;
}

/** An output file whose write number `afterWrites` waits for `release`: a copy held half way. */
function gatedOut(afterWrites: number): { openOut: (path: string) => Promise<FileHandle>; reached: Promise<void>; release: () => void } {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reachedNow: () => void = () => undefined;
  const reached = new Promise<void>((resolve) => {
    reachedNow = resolve;
  });
  let writes = 0;
  return {
    reached,
    release,
    openOut: async (path) => {
      const handle = await open(path, "wx");
      return new Proxy(handle, {
        get(target, prop) {
          if (prop === "write") {
            return async (buffer: Buffer, offset: number, length: number) => {
              if (++writes === afterWrites) {
                reachedNow();
                await gate;
              }
              return target.write(buffer, offset, length);
            };
          }
          const value: unknown = Reflect.get(target, prop);
          return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        },
      }) as FileHandle;
    },
  };
}

function failedWith(r: Rig, jobId: string): EngineError | undefined {
  return r.jobs.stateOf(jobId)?.error;
}

describe("starting an import", () => {
  test("a refused file is answered with its reason, starts no job, stages nothing and tells no event", async () => {
    const r = rig();
    const bad = [
      await callFor("script.jpg", Buffer.from("#!/bin/sh\nrm -rf ~\n")),
      await callFor("empty.jpg", Buffer.alloc(0)),
      { ...(await callFor("gone.jpg", jpeg())), path: join(pickedDir(), "nothing.jpg") },
      await callFor("clip.mp4", jpeg(), "video"),
    ];
    const reasons: string[] = [];
    for (const call of bad) {
      const result = await r.service.import(call);
      reasons.push(result.ok ? "ok" : result.reason);
    }
    expect(reasons).toEqual(["format", "empty", "not-a-file", "format"]);
    expect(r.jobs.states()).toEqual([]);
    expect(r.events).toEqual([]);
    expect(await staged()).toEqual([]);
  });

  test("a kind with no importer is refused as not-yet-supported before a byte is copied", async () => {
    const r = rig({ importers: {} });
    const result = await r.service.import(await callFor("a.jpg", jpeg()));
    expect(result).toMatchObject({ ok: false, reason: "not-yet-supported" });
    expect(await staged()).toEqual([]);
  });

  test("a file replaced after main looked at it is refused as changed", async () => {
    const r = rig();
    const file = await picked("a.jpg", jpeg());
    const other = await picked("b.jpg", jpeg(300));
    const result = await r.service.import({ pick: "photo", path: file.path, name: "a.jpg", expected: other.expected });
    expect(result).toMatchObject({ ok: false, reason: "changed" });
  });

  test("a call that was cancelled while the file was being opened starts no job", async () => {
    const r = rig();
    const controller = new AbortController();
    controller.abort();
    expect(await r.service.import(await callFor("a.jpg", jpeg()), controller.signal)).toMatchObject({ ok: false, reason: "cancelled" });
    expect(r.jobs.states()).toEqual([]);
  });

  test("an accepted file answers a job id at once: the copy has not been made yet", async () => {
    const gate = gatedOut(1);
    const r = rig({ staging: { chunkBytes: 16, fs: { openOut: gate.openOut } } });
    const jobId = await started(r, await callFor("a.jpg", jpeg(200)));
    expect(r.jobs.stateOf(jobId)).toMatchObject({ kind: "import", status: "running", mediaKind: "photo", name: "a.jpg", mediaId: null, total: 200 });
    await gate.reached;
    expect(await stored()).toEqual([]);
    gate.release();
    await r.service.settled();
    expect(r.jobs.stateOf(jobId)).toMatchObject({ status: "done" });
  });

  test("the library is held for the job, not only for the call: a switch must wait while the copy runs", async () => {
    const gate = gatedOut(1);
    const r = rig({ staging: { chunkBytes: 16, fs: { openOut: gate.openOut } } });
    const jobId = await started(r, await callFor("a.jpg", jpeg(200)));
    await gate.reached;
    // The call's own hold is over, and the job's is the registry's count that the engine reads as busy.
    expect(r.holds.now).toBe(0);
    expect(r.jobs.activeImports()).toBe(1);
    gate.release();
    await r.service.settled();
    expect(r.jobs.activeImports()).toBe(0);
    expect(r.jobs.stateOf(jobId)?.status).toBe("done");
  });
});

describe("a finished import", () => {
  test("stores the file and its record, and the job is done with the record", async () => {
    const r = rig();
    const bytes = jpeg(300);
    const jobId = await started(r, await callFor("holiday.jpg", bytes));
    await r.service.settled();

    const state = r.jobs.stateOf(jobId);
    expect(state).toMatchObject({ kind: "import", status: "done", done: 300, total: 300 });
    if (state?.kind !== "import" || state.result === undefined) throw new Error("no result");
    const media = state.result.media;
    expect(MediaSummary.safeParse(media).success).toBe(true);
    expect(media).toMatchObject({ kind: "photo", name: "holiday.jpg", bytes: 300, width: 100, height: 200 });
    expect(state.mediaId).toBe(media.mediaId);
    expect(await stored()).toEqual([`${media.mediaId}.jpg`, `${media.mediaId}.json`]);
    expect(await readFile(join(mediaDir(), `${media.mediaId}.jpg`))).toEqual(bytes);
    expect(await staged()).toEqual([]);
    expect(JobState.safeParse(state).success).toBe(true);
  });

  test("tells the window in order: progress, the stored record, then done", async () => {
    const r = rig();
    await started(r, await callFor("a.jpg", jpeg(300)));
    await r.service.settled();
    const order = types(r.events);
    expect(order[0]).toBe("job.progress");
    expect(order.at(-2)).toBe("media.changed");
    expect(order.at(-1)).toBe("job.done");
    const changed = r.events.find((e) => e.type === "media.changed");
    expect(changed?.payload).toMatchObject({ change: "upserted", media: { name: "a.jpg" } });
    const done = r.events.at(-1);
    expect(done?.type === "job.done" && JobResult.safeParse(done.payload.result).success).toBe(true);
  });

  test("counts bytes copied: each percent once, never back, ending at the size", async () => {
    const r = rig({ staging: { chunkBytes: 1 } });
    await started(r, await callFor("a.jpg", jpeg(500)));
    await r.service.settled();
    const progress = r.events.flatMap((e) => (e.type === "job.progress" ? [e.payload] : []));
    expect(progress.every((p) => JobProgress.safeParse(p).success)).toBe(true);
    const dones = progress.map((p) => p.done);
    expect(dones).toEqual([...dones].sort((a, b) => a - b));
    expect(new Set(dones).size).toBe(dones.length);
    expect(dones.at(-1)).toBe(500);
    expect(progress.length).toBeLessThanOrEqual(102);
  });

  test("no event, state or error carries a path", async () => {
    const r = rig({ importers: { photo: async () => ({ ok: false, reason: "too-large" }) } });
    await started(r, await callFor("a.jpg", jpeg()));
    await r.service.settled();
    const text = JSON.stringify([r.events, r.jobs.states()]);
    expect(text.includes(tmp())).toBe(false);
    expect(text.includes(pickedDir())).toBe(false);
  });

  test("the importer is handed the STAGED copy, the display name and a signal, never the picked path", async () => {
    const seen: { path: string; name: string; kind: string; format: string; hasSignal: boolean; content: Buffer }[] = [];
    const importer: MediaImporter = async ({ staged: handle, name, signal }) => {
      seen.push({ path: handle.path, name, kind: handle.kind, format: handle.format, hasSignal: signal instanceof AbortSignal, content: await readFile(handle.path) });
      return { ok: true, facts: PHOTO_FACTS };
    };
    const r = rig({ importers: { photo: importer } });
    const call = await callFor("holiday.jpg", jpeg(300));
    await started(r, call);
    await r.service.settled();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.path.startsWith(stagingDir())).toBe(true);
    expect(seen[0]?.path).not.toBe(call.path);
    expect(seen[0]).toMatchObject({ name: "holiday.jpg", kind: "photo", format: "jpeg", hasSignal: true });
    expect(seen[0]?.content).toEqual(jpeg(300));
  });

  test("a file the importer made is what is stored; the staged copy and the work file are gone", async () => {
    const importer: MediaImporter = async ({ workFile }) => {
      const work = await workFile();
      await writeFile(work.path, PNG_1X1);
      return { ok: true, facts: PHOTO_FACTS, output: { file: work, format: "png" } };
    };
    const r = rig({ importers: { photo: importer } });
    const jobId = await started(r, await callFor("a.jpg", jpeg(300)));
    await r.service.settled();
    const state = r.jobs.stateOf(jobId);
    if (state?.kind !== "import" || state.result === undefined) throw new Error(`not done: ${JSON.stringify(state)}`);
    const id = state.result.media.mediaId;
    expect(await stored()).toEqual([`${id}.json`, `${id}.png`]);
    expect(await readFile(join(mediaDir(), `${id}.png`))).toEqual(Buffer.from(PNG_1X1));
    expect(state.result.media.bytes).toBe(PNG_1X1.length);
    expect(await staged()).toEqual([]);
  });

  test("an id already taken at the moment of the record is retried with the next one", async () => {
    const queue = ["media-00000007", "media-00000008"];
    const r = rig({ newMediaId: () => queue.shift() ?? "media-00000099" });
    await mkdir(mediaDir(), { recursive: true });
    await writeFile(join(mediaDir(), "media-00000007.json"), "{}");
    const jobId = await started(r, await callFor("a.jpg", jpeg(300)));
    await r.service.settled();
    expect(r.jobs.stateOf(jobId)).toMatchObject({ status: "done", mediaId: "media-00000008" });
    expect(await readFile(join(mediaDir(), "media-00000007.json"), "utf8")).toBe("{}");
  });

  test("ids that are always taken end the job as failed after three tries, and the staged copy is removed", async () => {
    const r = rig({ newMediaId: () => "media-00000007" });
    await mkdir(mediaDir(), { recursive: true });
    await writeFile(join(mediaDir(), "media-00000007.json"), "{}");
    const jobId = await started(r, await callFor("a.jpg", jpeg(300)));
    await r.service.settled();
    expect(failedWith(r, jobId)).toMatchObject({ code: "MEDIA_UNSUPPORTED", mediaReason: "failed" });
    expect(await staged()).toEqual([]);
    expect(await readFile(join(mediaDir(), "media-00000007.json"), "utf8")).toBe("{}");
  });

  test("the copy does not start before the library's crash windows are settled", async () => {
    await mkdir(stagingDir(), { recursive: true });
    await writeFile(join(stagingDir(), "old-00000001.media"), "left by a crash");
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const r = rig({
      staging: {
        fs: {
          unlink: async (path) => {
            await gate;
            await rm(path);
          },
          platform: "linux",
        },
      },
    });
    let answered = false;
    const pending = r.service.import(await callFor("a.jpg", jpeg(300))).then((result) => {
      answered = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(answered).toBe(false);
    release();
    expect((await pending).ok).toBe(true);
    await r.service.settled();
  });
});

describe("a refusal or a failure of the job leaves nothing", () => {
  test("an importer that turns the file away: the job fails with MEDIA_UNSUPPORTED and its reason, no record, no staged copy, no media.changed", async () => {
    const r = rig({ importers: { photo: async () => ({ ok: false, reason: "too-large" }) } });
    const jobId = await started(r, await callFor("a.jpg", jpeg()));
    await r.service.settled();
    expect(r.jobs.stateOf(jobId)).toMatchObject({ status: "failed", mediaId: null });
    expect(failedWith(r, jobId)).toMatchObject({ code: "MEDIA_UNSUPPORTED", mediaReason: "too-large" });
    expect(await stored()).toEqual([]);
    expect(await staged()).toEqual([]);
    expect(types(r.events)).not.toContain("media.changed");
    expect(types(r.events).at(-1)).toBe("job.failed");
  });

  test("an importer that throws: failed with the reason `failed`, a message without any path, nothing left", async () => {
    const r = rig({
      importers: {
        photo: async ({ staged: handle }) => {
          throw new Error(`could not decode ${handle.path}`);
        },
      },
    });
    const jobId = await started(r, await callFor("a.jpg", jpeg()));
    await r.service.settled();
    expect(failedWith(r, jobId)).toMatchObject({ code: "MEDIA_UNSUPPORTED", mediaReason: "failed" });
    expect(JSON.stringify(r.events).includes(tmp())).toBe(false);
    expect(await staged()).toEqual([]);
    expect(await stored()).toEqual([]);
  });

  test("an importer that throws after it made an output: the work file is released too", async () => {
    const r = rig({
      importers: {
        photo: async ({ workFile }) => {
          const work = await workFile();
          await writeFile(work.path, "half an output");
          throw new Error("crash");
        },
      },
    });
    await started(r, await callFor("a.jpg", jpeg()));
    await r.service.settled();
    expect(await staged()).toEqual([]);
  });

  test("facts that do not fit the kind: failed, and nothing is stored or left", async () => {
    const r = rig({ importers: { photo: async () => ({ ok: true, facts: { ...PHOTO_FACTS, width: null } }) } });
    const jobId = await started(r, await callFor("a.jpg", jpeg()));
    await r.service.settled();
    expect(failedWith(r, jobId)).toMatchObject({ code: "MEDIA_UNSUPPORTED", mediaReason: "failed" });
    expect(await stored()).toEqual([]);
    expect(await staged()).toEqual([]);
  });

  test("a disk that will not take the stored file: failed as unreadable, nothing stored, nothing left staged", async () => {
    const r = rig({
      records: {
        fs: {
          rename: async () => {
            throw Object.assign(new Error("input/output error"), { code: "EIO" });
          },
          platform: "linux",
        },
      },
    });
    const jobId = await started(r, await callFor("a.jpg", jpeg(300)));
    await r.service.settled();
    expect(failedWith(r, jobId)).toMatchObject({ code: "MEDIA_UNSUPPORTED", mediaReason: "unreadable" });
    expect(await stored()).toEqual([]);
    expect(await staged()).toEqual([]);
    expect(JSON.stringify(r.events).includes(tmp())).toBe(false);
  });

  test("a disk that fills up while the record is saved: failed as no-space, nothing stored, nothing left staged", async () => {
    const r = rig({
      records: {
        hooks: {
          beforeRecordRename: () => {
            throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
          },
        },
      },
    });
    const jobId = await started(r, await callFor("a.jpg", jpeg(300)));
    await r.service.settled();
    expect(failedWith(r, jobId)).toMatchObject({ code: "MEDIA_UNSUPPORTED", mediaReason: "no-space" });
    expect(await stored()).toEqual([]);
    expect(await staged()).toEqual([]);
  });

  test("a disk with no room for the copy: failed with no-space before a byte is written", async () => {
    const r = rig({ staging: { freeBytes: async () => 10, freeMarginBytes: 5 } });
    const jobId = await started(r, await callFor("a.jpg", jpeg(500)));
    await r.service.settled();
    expect(failedWith(r, jobId)).toMatchObject({ code: "MEDIA_UNSUPPORTED", mediaReason: "no-space" });
    expect(await staged()).toEqual([]);
  });

  test("a file that grows while it is copied: failed as changed, the copy is removed", async () => {
    const call = await callFor("a.jpg", jpeg(200));
    const gate = gatedOut(2);
    const r = rig({ staging: { chunkBytes: 16, fs: { openOut: gate.openOut } } });
    const jobId = await started(r, call);
    await gate.reached;
    appendFileSync(call.path, Buffer.alloc(5000, 1));
    gate.release();
    await r.service.settled();
    expect(failedWith(r, jobId)).toMatchObject({ code: "MEDIA_UNSUPPORTED", mediaReason: "changed" });
    expect(await staged()).toEqual([]);
    expect(await stored()).toEqual([]);
  });
});

describe("a cancel works in every phase and leaves nothing behind", () => {
  test("during the copy: the .part is removed, no record, the hold is released, and the job says cancelled", async () => {
    const gate = gatedOut(3);
    const r = rig({ staging: { chunkBytes: 16, fs: { openOut: gate.openOut } } });
    const jobId = await started(r, await callFor("a.jpg", jpeg(400)));
    await gate.reached;
    expect(r.service.cancel(jobId)).toBe(true);
    gate.release();
    await r.service.settled();

    expect(r.jobs.stateOf(jobId)).toMatchObject({ status: "cancelled", mediaId: null });
    expect(await staged()).toEqual([]);
    expect(await stored()).toEqual([]);
    expect(r.jobs.activeImports()).toBe(0);
    expect(r.holds.now).toBe(0);
    expect(types(r.events).at(-1)).toBe("job.cancelled");
    expect(types(r.events)).not.toContain("media.changed");
  });

  test("after the copy and before the importer: the importer is never called, the staged copy is removed", async () => {
    let calls = 0;
    let cancelNow: () => void = () => undefined;
    const r = rig({
      importers: {
        photo: async () => {
          calls++;
          return { ok: true, facts: PHOTO_FACTS };
        },
      },
      staging: {
        // The cancel lands at the very last step of the copy, the rename that puts the staged copy in its place.
        fs: {
          rename: async (from, to) => {
            cancelNow();
            const { rename } = await import("node:fs/promises");
            await rename(from, to);
          },
        },
      },
    });
    const jobId = await started(r, await callFor("a.jpg", jpeg(300)));
    cancelNow = () => void r.service.cancel(jobId);
    await r.service.settled();
    expect(calls).toBe(0);
    expect(r.jobs.stateOf(jobId)).toMatchObject({ status: "cancelled" });
    expect(await staged()).toEqual([]);
    expect(await stored()).toEqual([]);
  });

  test("during the importer: it is told through its signal, and a stored result it still returns is thrown away", async () => {
    let sawAbort = false;
    let entered: () => void = () => undefined;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const r = rig({
      importers: {
        photo: async ({ signal, workFile }) => {
          entered();
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
          sawAbort = true;
          // A misbehaving importer: it ignores the cancel and answers a finished file.
          const work = await workFile();
          await writeFile(work.path, "an output made after the cancel");
          return { ok: true, facts: PHOTO_FACTS, output: { file: work, format: "png" } };
        },
      },
    });
    const jobId = await started(r, await callFor("a.jpg", jpeg(300)));
    await inside;
    r.service.cancel(jobId);
    await r.service.settled();
    expect(sawAbort).toBe(true);
    expect(r.jobs.stateOf(jobId)).toMatchObject({ status: "cancelled", mediaId: null });
    expect(await staged()).toEqual([]);
    expect(await stored()).toEqual([]);
    expect(types(r.events)).not.toContain("media.changed");
  });

  test("an importer that refuses after the cancel is cancelled, not failed: the owner stopped it, the file was not at fault", async () => {
    let entered: () => void = () => undefined;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const r = rig({
      importers: {
        photo: async ({ signal }) => {
          entered();
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
          return { ok: false, reason: "too-large" };
        },
      },
    });
    const jobId = await started(r, await callFor("a.jpg", jpeg(300)));
    await inside;
    r.service.cancel(jobId);
    await r.service.settled();
    expect(r.jobs.stateOf(jobId)).toMatchObject({ status: "cancelled" });
    expect(types(r.events).at(-1)).toBe("job.cancelled");
  });

  test("an importer that stops because it was cancelled and says so is cancelled too", async () => {
    const r = rig({ importers: { photo: async () => ({ ok: false, reason: "cancelled" }) } });
    const jobId = await started(r, await callFor("a.jpg", jpeg(300)));
    await r.service.settled();
    expect(r.jobs.stateOf(jobId)).toMatchObject({ status: "cancelled" });
  });

  test("at the record: the stored file is taken back out, no record, no media.changed", async () => {
    const controller = { cancel: () => undefined as unknown };
    const r = rig({
      records: {
        hooks: {
          afterFileStored: () => {
            controller.cancel();
          },
        },
      },
    });
    const jobId = await started(r, await callFor("a.jpg", jpeg(300)));
    controller.cancel = () => r.service.cancel(jobId);
    await r.service.settled();
    expect(r.jobs.stateOf(jobId)).toMatchObject({ status: "cancelled", mediaId: null });
    expect(await stored()).toEqual([]);
    expect(await staged()).toEqual([]);
    expect(types(r.events)).not.toContain("media.changed");
  });

  test("a cancel after the job ended changes nothing", async () => {
    const r = rig();
    const jobId = await started(r, await callFor("a.jpg", jpeg(300)));
    await r.service.settled();
    expect(r.service.cancel(jobId)).toBe(true);
    expect(r.jobs.stateOf(jobId)).toMatchObject({ status: "done" });
  });

  test("a job id that is not an import is not cancelled, and an unknown one is refused", () => {
    const r = rig();
    r.jobs.startCandidates("job-00000009", "avatar-00000001", 4);
    expect(r.service.cancel("job-00000009")).toBe(false);
    expect(r.service.cancel("job-00000404")).toBe(false);
    expect(r.jobs.stateOf("job-00000009")).toMatchObject({ status: "running" });
  });
});

describe("imports run one after another", () => {
  test("the second copy does not start before the first import ends", async () => {
    let release: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const order: string[] = [];
    let first = true;
    const r = rig({
      importers: {
        photo: async ({ name }) => {
          order.push(`start ${name}`);
          if (first) {
            first = false;
            await hold;
          }
          order.push(`end ${name}`);
          return { ok: true, facts: PHOTO_FACTS };
        },
      },
    });
    await started(r, await callFor("one.jpg", jpeg(200)));
    await started(r, await callFor("two.jpg", jpeg(210)));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(order).toEqual(["start one.jpg"]);
    release();
    await r.service.settled();
    expect(order).toEqual(["start one.jpg", "end one.jpg", "start two.jpg", "end two.jpg"]);
  });

  test("a job that is waiting its turn is cancelled at once, copies nothing, and the one running goes on", async () => {
    let release: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    const r = rig({
      importers: {
        photo: async () => {
          if (first) {
            first = false;
            await hold;
          }
          return { ok: true, facts: PHOTO_FACTS };
        },
      },
    });
    const running = await started(r, await callFor("one.jpg", jpeg(200)));
    const waiting = await started(r, await callFor("two.jpg", jpeg(210)));
    r.service.cancel(waiting);
    await waitFor(() => r.jobs.stateOf(waiting)?.status === "cancelled");
    expect(r.jobs.stateOf(waiting)).toMatchObject({ status: "cancelled", done: 0 });
    release();
    await r.service.settled();
    expect(r.jobs.stateOf(running)).toMatchObject({ status: "done" });
    expect((await stored()).filter((n) => n.endsWith(".json"))).toHaveLength(1);
  });
});

describe("stopping the engine", () => {
  test("every running import is cancelled and has cleaned up when stop returns", async () => {
    const gate = gatedOut(2);
    const r = rig({ staging: { chunkBytes: 16, fs: { openOut: gate.openOut } } });
    const jobId = await started(r, await callFor("a.jpg", jpeg(400)));
    await gate.reached;
    const stopping = r.service.stop();
    gate.release();
    await stopping;
    expect(r.jobs.stateOf(jobId)).toMatchObject({ status: "cancelled" });
    expect(await staged()).toEqual([]);
    expect(r.jobs.activeImports()).toBe(0);
  });

  test("after stop no new import is taken", async () => {
    const r = rig();
    await r.service.stop();
    expect(await r.service.import(await callFor("a.jpg", jpeg()))).toMatchObject({ ok: false, reason: "cancelled" });
  });
});

describe("a restart settles what a crash left, and cleans up rather than resumes", () => {
  test("a crash at the record leaves a file and a temp that the next life removes; nothing is listed", async () => {
    const crashing = rig({ records: { hooks: { treatAsCrash: treatSimulatedCrash, beforeRecordRename: () => { throw new SimulatedCrash(); } } } });
    const jobId = await started(crashing, await callFor("a.jpg", jpeg(300)));
    await crashing.service.settled();
    expect(crashing.jobs.stateOf(jobId)).toMatchObject({ status: "failed" });
    expect((await stored()).some((n) => n.endsWith(".jpg"))).toBe(true);

    const next = rig();
    next.service.libraryOpened({ root: libraryRoot() });
    await next.service.settled();
    expect(await stored()).toEqual([]);
    expect(await staged()).toEqual([]);
    expect(await next.service.list()).toEqual({ media: [], total: 0 });
  });

  test("a copy a crash left half done is removed at the next open, even when the next life makes the same staging id", async () => {
    await mkdir(stagingDir(), { recursive: true });
    await writeFile(join(stagingDir(), ".id-00000001.part"), "half a copy from the life before");
    await writeFile(join(stagingDir(), "id-00000001.media"), "a whole copy from the life before");
    const queue = ["id-00000001", "id-00000002", "id-00000003", "id-00000004"];
    const next = rig({ newId: () => queue.shift() ?? `id-${String(++counter).padStart(8, "0")}` });
    next.service.libraryOpened({ root: libraryRoot() });
    const jobId = await started(next, await callFor("a.jpg", jpeg(300)));
    await next.service.settled();
    const state = next.jobs.stateOf(jobId);
    expect(state).toMatchObject({ status: "done" });
    expect(await staged()).toEqual([]);
    const listed = await next.service.list();
    expect(listed.total).toBe(1);
  });

  test("the records of an earlier life are listed after the open", async () => {
    const first = rig();
    await started(first, await callFor("a.jpg", jpeg(300)));
    await first.service.settled();
    const next = rig();
    next.service.libraryOpened({ root: libraryRoot() });
    await next.service.settled();
    expect((await next.service.list()).media.map((m) => m.name)).toEqual(["a.jpg"]);
  });

  test("the cleanup at an open never removes a copy a running import still owns", async () => {
    const gate = gatedOut(2);
    const r = rig({ staging: { chunkBytes: 16, fs: { openOut: gate.openOut } } });
    const jobId = await started(r, await callFor("a.jpg", jpeg(400)));
    await gate.reached;
    r.service.libraryOpened({ root: libraryRoot() });
    await new Promise((resolve) => setTimeout(resolve, 30));
    gate.release();
    await r.service.settled();
    expect(r.jobs.stateOf(jobId)).toMatchObject({ status: "done" });
  });
});

describe("the records through the service", () => {
  test("list answers newest first with a kind filter, delete removes the file and the record and tells the window", async () => {
    const r = rig();
    await started(r, await callFor("a.jpg", jpeg(300)));
    await started(r, await callFor("b.jpg", jpeg(310)));
    await r.service.settled();
    const listed = await r.service.list("photo");
    expect(listed.media.map((m) => m.name)).toEqual(["b.jpg", "a.jpg"]);
    expect((await r.service.list("video")).total).toBe(0);

    const target = listed.media[0];
    if (target === undefined) throw new Error("nothing listed");
    r.events.length = 0;
    expect(await r.service.delete(target.mediaId)).toBe("deleted");
    expect((await r.service.list()).media.map((m) => m.name)).toEqual(["a.jpg"]);
    expect(await stored()).toHaveLength(2);
    expect(r.events).toHaveLength(1);
    expect(r.events[0]?.type === "media.changed" && r.events[0].payload).toEqual({ change: "removed", mediaId: target.mediaId });
  });

  test("lookup says whether the library holds a media, of the kind that is asked for, and where the engine reads it", async () => {
    const r = rig();
    await started(r, await callFor("a.jpg", jpeg(300)));
    await r.service.settled();
    const [media] = (await r.service.list()).media;
    if (media === undefined) throw new Error("nothing stored");

    const found = await r.service.lookup(media.mediaId);
    expect(found?.summary).toEqual(media);
    expect(found?.path).toBe(join(mediaDir(), `${media.mediaId}.jpg`));
    expect(found).toMatchObject({ format: "jpeg", bytes: 300 });
    expect(found?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await r.service.lookup(media.mediaId, "photo")).toBeDefined();
    expect(await r.service.lookup(media.mediaId, "video")).toBeUndefined();
    expect(await r.service.lookup("media-00000404")).toBeUndefined();
  });

  test("lookup of a media that was deleted is nothing", async () => {
    const r = rig();
    await started(r, await callFor("a.jpg", jpeg(300)));
    await r.service.settled();
    const [media] = (await r.service.list()).media;
    await r.service.delete(media?.mediaId ?? "");
    expect(await r.service.lookup(media?.mediaId ?? "")).toBeUndefined();
  });

  test("deleting an id the library does not hold is false and tells nothing", async () => {
    const r = rig();
    expect(await r.service.delete("media-00000404")).toBe("not-found");
    expect(r.events).toEqual([]);
  });

  test("deleting touches nothing outside media/", async () => {
    const r = rig();
    const victim = join(tmp(), "victim.txt");
    await writeFile(victim, "the owner's data");
    await writeFile(join(libraryRoot(), "library.json"), "{}");
    await started(r, await callFor("a.jpg", jpeg(300)));
    await r.service.settled();
    const listed = await r.service.list();
    await r.service.delete(listed.media[0]?.mediaId ?? "");
    expect(await readFile(victim, "utf8")).toBe("the owner's data");
    expect(await readdir(libraryRoot())).toEqual(["library.json", "media"]);
    await rm(victim);
  });
});

// ---------- the 3f.1b review: what an importer, a delete and a full queue may do to a job ----------

const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

/** Waits until `check` holds, in turns of 10 ms and for at most 5 s: a phase a job reaches on its own, not a time the test guesses. */
async function waitFor(check: () => boolean): Promise<void> {
  for (let turn = 0; turn < 500 && !check(); turn++) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(check()).toBe(true);
}

describe("a delete between the commit and the job's end (L-1, probe P2)", () => {
  test("the window is told upserted, then removed, never the other way round: no ghost tile", async () => {
    const reached = deferred();
    const gate = deferred();
    let armed = true;
    const r = rig({
      staging: {
        fs: {
          unlink: async (path) => {
            // The staged copy's dispose after a commit that moved it away: the job is still running here.
            if (armed && path.endsWith(".media")) {
              armed = false;
              reached.resolve();
              await gate.promise;
            }
            await fsUnlink(path);
          },
        },
      },
    });
    const jobId = await started(r, await callFor("a.jpg", jpeg(300)));
    await reached.promise;
    const [media] = (await r.service.list()).media;
    expect(await r.service.delete(media?.mediaId ?? "")).toBe("deleted");
    gate.resolve();
    await r.service.settled();
    const changes = r.events.flatMap((e) => (e.type === "media.changed" ? [e.payload.change] : []));
    expect(changes).toEqual(["upserted", "removed"]);
    expect(r.jobs.stateOf(jobId)).toMatchObject({ status: "done" });
  });
});

describe("delete asks the reserved provider and takes the media out of the index in one synchronous step (L9 of the Stage 3 review)", () => {
  test("a lookup that is already in flight when the provider is asked does not find the media afterwards: no await sits between the check and the removal", async () => {
    let admitted = false;
    let pending: Promise<unknown> = Promise.resolve();
    const r: Rig = rig({
      reservedMedia: (id) => {
        // A render's lookup begins at this very moment, and its admission (`onFound`) runs the first time it can: a step after the provider answers.
        pending = r.service.lookup(id, undefined, () => {
          admitted = true;
        });
        return false;
      },
    });
    const jobId = await started(r, await callFor("a.jpg", jpeg(300)));
    await r.service.settled();
    const result = r.jobs.stateOf(jobId)?.result;
    const mediaId = result?.kind === "import" ? result.mediaId : undefined;
    if (mediaId === undefined || mediaId === null) throw new Error("the import did not store a media");
    expect(await r.service.delete(mediaId)).toBe("deleted");
    await pending;
    expect(admitted).toBe(false);
  });
});

describe("a media that a queued or running render uses (M-3)", () => {
  test("is not deleted while the provider says it is reserved: the answer is in-use, nothing is removed or told", async () => {
    const reserved = new Set<string>();
    const r = rig({ reservedMedia: (id) => reserved.has(id) });
    await started(r, await callFor("a.jpg", jpeg(300)));
    await r.service.settled();
    const [media] = (await r.service.list()).media;
    const id = media?.mediaId ?? "";
    reserved.add(id);
    r.events.length = 0;
    expect(await r.service.delete(id)).toBe("in-use");
    expect((await r.service.list()).total).toBe(1);
    expect(await stored()).toHaveLength(2);
    expect(r.events).toEqual([]);
  });

  test("is deleted as soon as the render is over", async () => {
    const reserved = new Set<string>();
    const r = rig({ reservedMedia: (id) => reserved.has(id) });
    await started(r, await callFor("a.jpg", jpeg(300)));
    await r.service.settled();
    const id = (await r.service.list()).media[0]?.mediaId ?? "";
    reserved.add(id);
    expect(await r.service.delete(id)).toBe("in-use");
    reserved.delete(id);
    expect(await r.service.delete(id)).toBe("deleted");
  });

  test("an id the library does not hold is not-found even when the provider says it is reserved", async () => {
    const r = rig({ reservedMedia: () => true });
    expect(await r.service.delete("media-00000404")).toBe("not-found");
  });

  test("with no provider nothing is reserved", async () => {
    const r = rig();
    await started(r, await callFor("a.jpg", jpeg(300)));
    await r.service.settled();
    expect(await r.service.delete((await r.service.list()).media[0]?.mediaId ?? "")).toBe("deleted");
  });
});

describe("an importer that ignores its signal (M-4)", () => {
  test("is given a grace window after the cancel; then its answer is dropped, the job is cancelled and the turn is released", async () => {
    const reached = deferred();
    const r = rig({
      importerGraceMs: 30,
      importers: {
        photo: async ({ name }) => {
          // The job that hangs is chosen by its file, not by who calls first: the cancel may land before a slow copy reaches its importer.
          if (name === "a.jpg") {
            reached.resolve();
            // Never settles, and never looks at its signal.
            return new Promise(() => undefined);
          }
          return { ok: true, facts: PHOTO_FACTS };
        },
      },
    });
    const hung = await started(r, await callFor("a.jpg", jpeg(300)));
    const next = await started(r, await callFor("b.jpg", jpeg(310)));
    await reached.promise;
    r.service.cancel(hung);
    await r.service.settled();
    expect(r.jobs.stateOf(hung)).toMatchObject({ status: "cancelled" });
    expect(r.jobs.stateOf(next)).toMatchObject({ status: "done" });
    expect(await staged()).toEqual([]);
    expect(r.jobs.activeImports()).toBe(0);
  });

  test("one that answers within the grace window is still thrown away: the cancel stands", async () => {
    const reached = deferred();
    const r = rig({
      importerGraceMs: 500,
      importers: {
        photo: async ({ signal }) => {
          reached.resolve();
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
          await new Promise((resolve) => setTimeout(resolve, 20));
          return { ok: true, facts: PHOTO_FACTS };
        },
      },
    });
    const jobId = await started(r, await callFor("a.jpg", jpeg(300)));
    await reached.promise;
    r.service.cancel(jobId);
    await r.service.settled();
    expect(r.jobs.stateOf(jobId)).toMatchObject({ status: "cancelled" });
    expect(await stored()).toEqual([]);
  });

  test("an importer that is still in its time is not cut short: no cancel, no grace", async () => {
    const r = rig({
      importerGraceMs: 10,
      importers: {
        photo: async () => {
          await new Promise((resolve) => setTimeout(resolve, 60));
          return { ok: true, facts: PHOTO_FACTS };
        },
      },
    });
    const jobId = await started(r, await callFor("a.jpg", jpeg(300)));
    await r.service.settled();
    expect(r.jobs.stateOf(jobId)).toMatchObject({ status: "done" });
  });
});

describe("stopping with a job that will not stop (L-6)", () => {
  test("stop returns within its bound even when an importer ignores its signal for good", async () => {
    const reached = deferred();
    const r = rig({
      importerGraceMs: 60_000,
      stopWaitMs: 60,
      importers: {
        photo: () => {
          reached.resolve();
          return new Promise(() => undefined);
        },
      },
    });
    await started(r, await callFor("a.jpg", jpeg(300)));
    await reached.promise;
    const began = Date.now();
    await r.service.stop();
    expect(Date.now() - began).toBeLessThan(5_000);
  });
});

describe("opening a file waits for the library's recovery, but not past a cancel (L-5)", () => {
  test("a call cancelled while the recovery is still running answers cancelled and starts no job", async () => {
    await mkdir(stagingDir(), { recursive: true });
    await writeFile(join(stagingDir(), "old-00000001.media"), "left by a crash");
    const never = deferred();
    const recovering = deferred();
    const r = rig({
      staging: {
        fs: {
          unlink: async (path) => {
            recovering.resolve();
            await never.promise;
            await fsUnlink(path);
          },
          platform: "linux",
        },
      },
    });
    const controller = new AbortController();
    const pending = r.service.import(await callFor("a.jpg", jpeg(300)), controller.signal);
    await recovering.promise;
    controller.abort();
    expect(await pending).toMatchObject({ ok: false, reason: "cancelled" });
    expect(r.jobs.states()).toEqual([]);
    never.resolve();
    await r.service.settled();
  });
});

describe("the turn is released whatever the cleanup does (L-7)", () => {
  test("a staged copy whose disposal throws still frees the turn: the next import runs", async () => {
    let first = true;
    const r = rig({
      importers: {
        photo: async ({ staged: handle }) => {
          if (first) {
            first = false;
            (handle as { dispose: () => Promise<void> }).dispose = async () => {
              throw new Error("the disk is gone");
            };
          }
          return { ok: true, facts: PHOTO_FACTS };
        },
      },
    });
    const a = await started(r, await callFor("a.jpg", jpeg(300)));
    const b = await started(r, await callFor("b.jpg", jpeg(310)));
    await r.service.settled();
    expect(["done", "failed"]).toContain(String(r.jobs.stateOf(a)?.status));
    expect(r.jobs.stateOf(b)).toMatchObject({ status: "done" });
    expect(r.jobs.activeImports()).toBe(0);
  });
});

describe("the container an importer says its file is (L-9)", () => {
  const output =
    (format: "png" | "jpeg"): MediaImporter =>
    async ({ workFile }) => {
      const work = await workFile();
      await writeFile(work.path, jpeg(64));
      return { ok: true, facts: PHOTO_FACTS, output: { file: work, format } };
    };

  test("is checked against the file's own first bytes: a JPEG declared as a PNG is a failed job and nothing is stored", async () => {
    const r = rig({ importers: { photo: output("png") } });
    const jobId = await started(r, await callFor("a.jpg", jpeg(300)));
    await r.service.settled();
    expect(failedWith(r, jobId)).toMatchObject({ code: "MEDIA_UNSUPPORTED", mediaReason: "failed" });
    expect(await stored()).toEqual([]);
    expect(await staged()).toEqual([]);
  });

  test("a file that is what it says is stored", async () => {
    const r = rig({ importers: { photo: output("jpeg") } });
    const jobId = await started(r, await callFor("a.jpg", jpeg(300)));
    await r.service.settled();
    expect(r.jobs.stateOf(jobId)).toMatchObject({ status: "done" });
  });
});

describe("a job that cannot be registered (L-10)", () => {
  test("closes the file it opened and answers failed", async () => {
    let closes = 0;
    const ops: OpenRegularOps = {
      lstat: (p) => lstat(p, { bigint: true }),
      open: async (p, flags) => {
        const handle = await open(p, flags);
        return new Proxy(handle, {
          get(target, prop) {
            if (prop === "close") {
              return async () => {
                closes++;
                return target.close();
              };
            }
            const value: unknown = Reflect.get(target, prop);
            return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
          },
        }) as FileHandle;
      },
    };
    // The same job id twice: the second registration throws.
    const r = rig({ newId: () => "job-00000001", staging: { ops } });
    const first = await r.service.import(await callFor("a.jpg", jpeg(300)));
    expect(first.ok).toBe(true);
    await r.service.settled();
    const before = closes;
    const second = await r.service.import(await callFor("b.jpg", jpeg(310)));
    expect(second).toMatchObject({ ok: false, reason: "failed" });
    expect(closes).toBe(before + 1);
  });
});

describe("what an unexpected failure logs (L-12)", () => {
  test("the disk's code and the job, never the message that may name a path", async () => {
    const lines: string[] = [];
    const r = rig({
      log: (line) => lines.push(line),
      emit: (event) => {
        if (event.type === "media.changed") throw Object.assign(new Error(`cannot write ${tmp()}/secret`), { code: "EIO" });
      },
    });
    await started(r, await callFor("a.jpg", jpeg(300)));
    await r.service.settled();
    expect(lines.some((line) => line.includes("EIO"))).toBe(true);
    expect(lines.join("\n").includes(tmp())).toBe(false);
  });
});

describe("the owner's file is let go after the copy (L2 of the Stage 3 review)", () => {
  /** The real open, with a `close` that is counted: how many handles the service opened, and how many it has let go. */
  function countingOps(): { ops: OpenRegularOps; open: () => number } {
    let held = 0;
    return {
      open: () => held,
      ops: {
        lstat: (path) => lstat(path, { bigint: true }),
        open: async (path, flags) => {
          const handle = await open(path, flags);
          held++;
          let closed = false;
          return new Proxy(handle, {
            get(target, prop) {
              if (prop === "close") {
                return async () => {
                  if (closed) return;
                  closed = true;
                  held--;
                  await target.close();
                };
              }
              const value: unknown = Reflect.get(target, prop);
              return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
            },
          }) as FileHandle;
        },
      },
    };
  }

  test("by the time the importer runs, the picked file is no longer held open", async () => {
    const counting = countingOps();
    const heldDuringImport: number[] = [];
    const r = rig({
      staging: { ops: counting.ops },
      importers: {
        photo: async () => {
          heldDuringImport.push(counting.open());
          return { ok: true, facts: PHOTO_FACTS };
        },
      },
    });
    await started(r, await callFor("a.jpg", jpeg(300)));
    await r.service.settled();
    expect(heldDuringImport).toEqual([0]);
  });

  test("a file that is turned away after it was opened is let go too", async () => {
    const counting = countingOps();
    const r = rig({ staging: { ops: counting.ops, freeBytes: async () => 10, freeMarginBytes: 5 } });
    await started(r, await callFor("a.jpg", jpeg(500)));
    await r.service.settled();
    expect(counting.open()).toBe(0);
  });

  test("a job that is still waiting for its turn holds its file, and lets it go once it has been copied", async () => {
    const counting = countingOps();
    const gate = deferred();
    let calls = 0;
    const r = rig({
      staging: { ops: counting.ops },
      importers: {
        photo: async () => {
          if (++calls === 1) await gate.promise;
          return { ok: true, facts: PHOTO_FACTS };
        },
      },
    });
    await started(r, await callFor("a.jpg", jpeg(300)));
    await started(r, await callFor("b.jpg", jpeg(310)));
    // A has copied and is inside its importer; B waits for the turn with its file open.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(counting.open()).toBe(1);
    gate.resolve();
    await r.service.settled();
    expect(counting.open()).toBe(0);
  });
});

describe("a library's recovery can be stopped (review round 5)", () => {
  /** A library with a record whose file is only in the quarantine, so that opening it hashes a copy. */
  async function libraryNeedingAHash(): Promise<void> {
    const { MediaRecords } = await import("../library/mediaRecords");
    const store = new MediaRecords({ root: libraryRoot(), newId: () => "media-00000001", now: () => new Date("2026-10-04T10:00:00.000Z"), warn: () => undefined });
    await mkdir(stagingDir(), { recursive: true });
    const stagedPath = join(stagingDir(), "staged-00000001.media");
    await writeFile(stagedPath, jpeg(300));
    await store.commit({ sourcePath: stagedPath, kind: "photo", format: "jpeg", name: "a.jpg", facts: PHOTO_FACTS });
    const folder = join(libraryRoot(), "quarantine", "2026-10-04T10-00-00-000Z", "media");
    await mkdir(folder, { recursive: true });
    await rename(join(mediaDir(), "media-00000001.jpg"), join(folder, "media-00000001.jpg"));
  }

  test("stopping the service stops the hashing a library's recovery is in, and the recovery ends", async () => {
    await libraryNeedingAHash();
    let seen: AbortSignal | undefined;
    const r = rig({
      stopWaitMs: 2000,
      records: {
        fs: {
          hash: (_path, signal) => {
            seen = signal;
            return new Promise<string>((_resolve, reject) => signal?.addEventListener("abort", () => reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError", code: "ABORT_ERR" })), { once: true }));
          },
        },
      },
    });
    r.service.libraryOpened({ root: libraryRoot() });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(seen).toBeDefined();
    await r.service.stop();
    expect(seen?.aborted).toBe(true);
    await r.service.settled();
  });

  test("the recovery of a re-opened library starts only after the one it replaced has ended: two never read the quarantine at once", async () => {
    await libraryNeedingAHash();
    const events: string[] = [];
    let calls = 0;
    const r = rig({
      records: {
        fs: {
          hash: (_path, signal) => {
            const n = ++calls;
            events.push(`start ${n}`);
            if (n > 1) return Promise.resolve("0".repeat(64));
            return new Promise<string>((_resolve, reject) =>
              signal?.addEventListener(
                "abort",
                () => {
                  // The old recovery takes a moment to let go of its read.
                  setTimeout(() => {
                    events.push("end 1");
                    reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError", code: "ABORT_ERR" }));
                  }, 40);
                },
                { once: true },
              ),
            );
          },
        },
      },
    });
    r.service.libraryOpened({ root: libraryRoot() });
    // The first recovery must be hashing before the re-open: a phase it reaches on its own, not a time the test guesses.
    await waitFor(() => events.includes("start 1"));
    r.service.libraryOpened({ root: libraryRoot() });
    await r.service.settled();
    expect(events).toEqual(["start 1", "end 1", "start 2"]);
  });

  test("a library opened after the service stopped gets a recovery that is already stopped: nothing is hashed", async () => {
    await libraryNeedingAHash();
    let hashed = 0;
    const r = rig({ records: { fs: { hash: async () => (hashed++, "x") } } });
    await r.service.stop();
    r.service.libraryOpened({ root: libraryRoot() });
    await r.service.settled();
    expect(hashed).toBe(0);
  });

  test("a library that is opened again replaces the recovery of the old one, and the old one is stopped", async () => {
    await libraryNeedingAHash();
    const seen: AbortSignal[] = [];
    const r = rig({
      records: {
        fs: {
          hash: (_path, signal) => {
            if (signal !== undefined) seen.push(signal);
            return new Promise<string>((_resolve, reject) => signal?.addEventListener("abort", () => reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError", code: "ABORT_ERR" })), { once: true }));
          },
        },
      },
    });
    r.service.libraryOpened({ root: libraryRoot() });
    await new Promise((resolve) => setTimeout(resolve, 50));
    r.service.libraryOpened({ root: libraryRoot() });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(seen[0]?.aborted).toBe(true);
    await r.service.stop();
  });
});

describe("an event that cannot be sent never jams the queue (L1 of the Stage 3 review)", () => {
  const broken = (): Error => Object.assign(new Error("the event log is full"), { code: "EIO" });
  const within = async <T,>(work: Promise<T>, ms = 2000): Promise<T | "timed out"> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"timed out">((resolve) => {
      timer = setTimeout(() => resolve("timed out"), ms);
    });
    try {
      return await Promise.race([work, late]);
    } finally {
      clearTimeout(timer);
    }
  };

  test("the announcement of a started import fails: the import still starts, runs and ends, and the library is free again", async () => {
    const r = rig({
      emit: (event) => {
        if (event.type === "job.progress") throw broken();
      },
    });
    const ids: string[] = [];
    for (const name of ["a.jpg", "b.jpg", "c.jpg"]) {
      ids.push(await started(r, await callFor(name, jpeg(300 + ids.length))));
      expect(await within(r.service.settled())).not.toBe("timed out");
    }
    for (const id of ids) expect(r.jobs.stateOf(id)).toMatchObject({ status: "done" });
    expect(r.jobs.activeImports()).toBe(0);
  });

  test("the announcement of a waiting import turning to running fails: it still runs, and the next import gets its turn", async () => {
    const gate = deferred();
    const importer: MediaImporter = async () => {
      await gate.promise;
      return { ok: true, facts: PHOTO_FACTS };
    };
    let waiting: string | undefined;
    const r = rig({
      importers: { photo: importer },
      emit: (event) => {
        if (event.type === "job.progress" && event.payload.kind === "import" && event.payload.jobId === waiting && event.payload.queued !== true) throw broken();
      },
    });
    const a = await started(r, await callFor("a.jpg", jpeg(300)));
    const b = await started(r, await callFor("b.jpg", jpeg(310)));
    waiting = b;
    const c = await started(r, await callFor("c.jpg", jpeg(320)));
    gate.resolve();
    expect(await within(r.service.settled())).not.toBe("timed out");
    for (const id of [a, b, c]) expect(r.jobs.stateOf(id)).toMatchObject({ status: "done" });
    expect(r.jobs.activeImports()).toBe(0);
  });

  /** Polls until `done` holds, so that a promise nobody awaits (a job's own run) is judged by what it did, not by what `settled` swallowed. */
  async function until(done: () => boolean, ms = 2000): Promise<boolean> {
    for (const start = Date.now(); Date.now() - start < ms; ) {
      if (done()) return true;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return done();
  }

  test("the event that ends a job fails: it is logged, the job is over all the same, and the next one runs", async () => {
    const lines: string[] = [];
    const r = rig({
      log: (line) => lines.push(line),
      emit: (event) => {
        if (event.type === "job.done") throw broken();
      },
    });
    const a = await started(r, await callFor("a.jpg", jpeg(300)));
    expect(await until(() => r.jobs.stateOf(a)?.status === "done" && r.jobs.activeImports() === 0)).toBe(true);
    // The throw was caught where it was thrown: it is in the log, and it did not end the job's own run in a rejection.
    expect(lines.some((line) => line.includes("an event could not be sent (job.done"))).toBe(true);
    const b = await started(r, await callFor("b.jpg", jpeg(310)));
    expect(await until(() => r.jobs.stateOf(b)?.status === "done" && r.jobs.activeImports() === 0)).toBe(true);
  });

  test("a job.done that cannot be sent once is sent again built from the stored media itself, and no job.failed follows it", async () => {
    let refused = false;
    const r: Rig = rig({
      emit: (event) => {
        if (event.type === "job.done" && !refused) {
          refused = true;
          throw broken();
        }
        r.events.push(event);
      },
    });
    const a = await started(r, await callFor("a.jpg", jpeg(300)));
    expect(await until(() => r.jobs.stateOf(a)?.status === "done")).toBe(true);
    const done = r.events.filter((event) => event.type === "job.done" && event.payload.jobId === a);
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ payload: { result: { kind: "import", media: { kind: "photo" } } } });
    expect(r.events.filter((event) => event.type === "job.failed")).toHaveLength(0);
  });

  test("a terminal event that cannot be sent is replaced by a minimal job.failed, so the window does not stay on «running»", async () => {
    const r = rig({
      emit: (event) => {
        if (event.type === "job.done" && event.payload.jobId !== undefined) throw broken();
        r.events.push(event);
      },
    });
    const a = await started(r, await callFor("a.jpg", jpeg(300)));
    expect(await until(() => r.jobs.stateOf(a)?.status === "done")).toBe(true);
    const told = r.events.filter((event) => event.type === "job.failed" && event.payload.jobId === a);
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ payload: { error: { code: "MEDIA_UNSUPPORTED", mediaReason: "failed" } } });
  });
});

describe("a full queue (the review's queue items)", () => {
  /** An importer every job waits in until `release`. */
  function held(): { importer: MediaImporter; release: () => void } {
    const gate = deferred();
    return {
      release: gate.resolve,
      importer: async () => {
        await gate.promise;
        return { ok: true, facts: PHOTO_FACTS };
      },
    };
  }

  test("a job that waits for its turn is queued, and runs when its turn comes, announced each time", async () => {
    const h = held();
    const r = rig({ importers: { photo: h.importer } });
    const a = await started(r, await callFor("a.jpg", jpeg(300)));
    const b = await started(r, await callFor("b.jpg", jpeg(310)));
    expect(r.jobs.stateOf(b)).toMatchObject({ status: "queued" });
    const announced = r.events.flatMap((e) => (e.type === "job.progress" && e.payload.kind === "import" && e.payload.jobId === b ? [e.payload] : []));
    expect(announced).toHaveLength(1);
    expect(announced[0]).toMatchObject({ queued: true, done: 0 });
    h.release();
    await r.service.settled();
    expect(r.jobs.stateOf(a)).toMatchObject({ status: "done" });
    expect(r.jobs.stateOf(b)).toMatchObject({ status: "done" });
    const second = r.events.flatMap((e) => (e.type === "job.progress" && e.payload.kind === "import" && e.payload.jobId === b && e.payload.done === 0 ? [e.payload.queued === true] : []));
    expect(second).toEqual([true, false]);
  });

  test("a queued job is cancelled from its queue at once, and counts as active until then", async () => {
    const h = held();
    const r = rig({ importers: { photo: h.importer } });
    await started(r, await callFor("a.jpg", jpeg(300)));
    const b = await started(r, await callFor("b.jpg", jpeg(310)));
    expect(r.jobs.activeImports()).toBe(2);
    r.service.cancel(b);
    await waitFor(() => r.jobs.stateOf(b)?.status === "cancelled");
    expect(r.jobs.stateOf(b)).toMatchObject({ status: "cancelled" });
    expect(r.jobs.activeImports()).toBe(1);
    h.release();
    await r.service.settled();
  });

  test("beyond the cap a file is refused too-many before it is held open, and the jobs already taken go on", async () => {
    const h = held();
    const r = rig({ maxPendingImports: 3, importers: { photo: h.importer } });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push(await started(r, await callFor(`p${i}.jpg`, jpeg(300 + i))));
    const over = await r.service.import(await callFor("over.jpg", jpeg(400)));
    expect(over).toMatchObject({ ok: false, reason: "too-many" });
    expect(r.jobs.activeImports()).toBe(3);
    h.release();
    await r.service.settled();
    for (const id of ids) expect(r.jobs.stateOf(id)).toMatchObject({ status: "done" });
    // The queue has room again.
    expect((await r.service.import(await callFor("again.jpg", jpeg(410)))).ok).toBe(true);
    await r.service.settled();
  });

  test("the default cap is 40", async () => {
    const h = held();
    const r = rig({ importers: { photo: h.importer } });
    for (let i = 0; i < 40; i++) await started(r, await callFor(`q${i}.jpg`, jpeg(200 + i)));
    expect(await r.service.import(await callFor("q40.jpg", jpeg(300)))).toMatchObject({ ok: false, reason: "too-many" });
    h.release();
    await r.service.stop();
  }, 60_000);
});

describe("a render that reserves a media while it is being deleted (fix round 3, M1)", () => {
  test("finds nothing: a lookup made once the delete has started does not see the media, so no render can take it", async () => {
    const reached = deferred();
    const gate = deferred();
    let armed = false;
    const r = rig({
      records: {
        fs: {
          unlink: async (path) => {
            if (armed && path.endsWith(".json")) {
              reached.resolve();
              await gate.promise;
            }
            await fsUnlink(path);
          },
          platform: "linux",
        },
      },
    });
    await started(r, await callFor("a.jpg", jpeg(300)));
    await r.service.settled();
    const id = (await r.service.list()).media[0]?.mediaId ?? "";
    armed = true;
    const deleting = r.service.delete(id);
    await reached.promise;
    expect(await r.service.lookup(id)).toBeUndefined();
    gate.resolve();
    expect(await deleting).toBe("deleted");
  });

  test("a media the provider reserves at the moment of the delete is refused, and a lookup still finds it afterwards", async () => {
    const reserved = new Set<string>();
    const r = rig({ reservedMedia: (id) => reserved.has(id) });
    await started(r, await callFor("a.jpg", jpeg(300)));
    await r.service.settled();
    const id = (await r.service.list()).media[0]?.mediaId ?? "";
    reserved.add(id);
    expect(await r.service.delete(id)).toBe("in-use");
    expect(await r.service.lookup(id)).toBeDefined();
  });
});

describe("a hung importer's late work file (fix round 3, M2)", () => {
  test("after the job ended, workFile throws: nothing is created that no cleanup would ever take", async () => {
    const late = deferred();
    const reached = deferred();
    let lateOutcome = "not tried";
    const r = rig({
      importerGraceMs: 20,
      importers: {
        photo: async ({ workFile }) => {
          reached.resolve();
          // Ignores the cancel; wakes up long after the job was dropped and asks for a file to write a mezzanine in.
          await late.promise;
          try {
            const work = await workFile();
            await writeFile(work.path, "a mezzanine nobody wants");
            lateOutcome = "got a file";
          } catch {
            lateOutcome = "refused";
          }
          return { ok: true, facts: PHOTO_FACTS };
        },
      },
    });
    const hung = await started(r, await callFor("a.jpg", jpeg(300)));
    await reached.promise;
    r.service.cancel(hung);
    await r.service.settled();
    expect(r.jobs.stateOf(hung)).toMatchObject({ status: "cancelled" });
    late.resolve();
    // Waits for the late importer's own answer, not for a fixed time: its work-file call is disk work (slow on a loaded Windows runner).
    for (let turn = 0; turn < 500 && lateOutcome === "not tried"; turn++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(lateOutcome).toBe("refused");
    expect(await staged()).toEqual([]);
  });

  test("a work file asked for while the job runs is still given, and released when the job ends", async () => {
    let path = "";
    const r = rig({
      importers: {
        photo: async ({ workFile }) => {
          const work = await workFile();
          path = work.path;
          await writeFile(work.path, "scratch");
          return { ok: false, reason: "too-large" };
        },
      },
    });
    await started(r, await callFor("a.jpg", jpeg(300)));
    await r.service.settled();
    expect(path).not.toBe("");
    expect(await staged()).toEqual([]);
  });
});
