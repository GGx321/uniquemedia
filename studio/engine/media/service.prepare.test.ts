import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { JobProgress, type PickedFileIdentity, type UnsequencedEvent } from "../../shared/engine";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { tempDirFor } from "../../testing/tempDir";
import { JobRegistry } from "../jobs";
import { pickedIdentityOf } from "./identity";
import type { MediaImporter, MediaImportCall, MediaImportRequest } from "./imports";
import { MediaService } from "./service";
useNativeGlobals();

// 3f.6: what the import JOB does with the progress an importer reports. The importer is handed a reporter (`request.prepare`); the job turns it into
// the `prepare` stage of the job's progress: its own total from zero, a percent at a time, never full before the record is stored, and nothing at all
// from an importer that is late (the job is over) or early (it has not said how much there is).

const tmp = tempDirFor({ beforeEach, afterEach }, "studio-media-prepare-");
const libraryRoot = (): string => join(tmp(), "library");
const pickedDir = (): string => join(tmp(), "picked");

const rigs: MediaService[] = [];
afterEach(async () => {
  await Promise.all(rigs.splice(0).map((service) => service.stop()));
});
beforeEach(async () => {
  await mkdir(libraryRoot(), { recursive: true });
  await mkdir(pickedDir(), { recursive: true });
});

const FACTS = { width: 100, height: 200, durationMs: null, sourceFps: null, hdrToSdr: false, loopFrames: null, delayFrames: null } as const;
let counter = 0;

async function callFor(): Promise<MediaImportCall> {
  const path = join(pickedDir(), "a.jpg");
  const bytes = Buffer.alloc(200, 9);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  await writeFile(path, bytes);
  const expected: PickedFileIdentity = pickedIdentityOf(await lstat(path, { bigint: true }));
  return { pick: "photo", path, name: "a.jpg", expected };
}

function rig(importer: MediaImporter): { service: MediaService; jobs: JobRegistry; events: UnsequencedEvent[] } {
  const jobs = new JobRegistry();
  const events: UnsequencedEvent[] = [];
  const service = new MediaService({
    jobs,
    emit: (event) => events.push(event),
    withLibrary: (work) => work({ root: libraryRoot() }),
    newId: () => `id-${String(++counter).padStart(8, "0")}`,
    now: () => new Date("2026-10-04T10:00:00.000Z"),
    importers: { photo: importer },
    log: () => undefined,
  });
  rigs.push(service);
  return { service, jobs, events };
}

async function run(importer: MediaImporter): Promise<{ jobId: string; progress: JobProgress[]; r: ReturnType<typeof rig> }> {
  const r = rig(importer);
  const result = await r.service.import(await callFor());
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  await r.service.settled();
  return { jobId: result.jobId, progress: progressOf(r.events), r };
}

function progressOf(events: UnsequencedEvent[]): JobProgress[] {
  return events.flatMap((e) => (e.type === "job.progress" ? [JobProgress.parse(e.payload)] : []));
}
const importOnly = (progress: JobProgress[]): Extract<JobProgress, { kind: "import" }>[] => progress.flatMap((p) => (p.kind === "import" ? [p] : []));
const preparing = (progress: JobProgress[]): Extract<JobProgress, { kind: "import" }>[] => importOnly(progress).filter((p) => p.stage === "prepare");

/** An importer that does `work` with its reporter, then answers a photo's facts. */
const reporting =
  (work: (prepare: NonNullable<MediaImportRequest["prepare"]>, request: MediaImportRequest) => void | Promise<void>): MediaImporter =>
  async (request) => {
    if (request.prepare === undefined) throw new Error("the job gave the importer no reporter");
    await work(request.prepare, request);
    return { ok: true, facts: FACTS };
  };

describe("the prepare stage of an import job", () => {
  test("begins after the copy, at zero of the importer's total, with what the probe judged", async () => {
    const { progress } = await run(reporting((prepare) => prepare.begin(900, { hdrToSdr: true, fromFps: 60 })));
    const events = importOnly(progress);
    const first = events.findIndex((p) => p.stage === "prepare");

    expect(events[first]).toMatchObject({ stage: "prepare", done: 0, total: 900, prepare: { hdrToSdr: true, fromFps: 60 } });
    // Everything before it is the copy (no stage), and the copy was whole when it ended.
    expect(events.slice(0, first).every((p) => p.stage === undefined)).toBe(true);
    expect(events[first - 1]).toMatchObject({ done: 200, total: 200 });
  });

  test("reports in the importer's units, a percent at a time, strictly forward", async () => {
    const { progress } = await run(
      reporting((prepare) => {
        prepare.begin(900);
        for (let done = 1; done < 900; done++) prepare.report(done);
      }),
    );
    const steps = preparing(progress);
    expect(steps.length).toBeGreaterThan(50);
    // One announcement per percent at most (the begin at 0 and then 1 to 99), so a three-minute video does not send 5400 events.
    expect(steps.length).toBeLessThanOrEqual(100);
    const dones = steps.map((p) => p.done);
    expect(dones.every((done, i) => i === 0 || done > (dones[i - 1] ?? 0))).toBe(true);
    expect(steps.every((p) => p.total === 900)).toBe(true);
  });

  test("never announces a full prepare: the last unit belongs to the end of the job", async () => {
    const { progress } = await run(
      reporting((prepare) => {
        prepare.begin(10);
        prepare.report(10);
        prepare.report(1000);
      }),
    );
    expect(preparing(progress).every((p) => p.done < p.total)).toBe(true);
  });

  test("the job still ends done, with the record", async () => {
    const { jobId, r } = await run(reporting((prepare) => prepare.begin(4)));
    expect(r.jobs.stateOf(jobId)).toMatchObject({ status: "done", stage: "prepare", done: 4, total: 4 });
    expect(r.events.map((e) => e.type)).toContain("media.changed");
  });

  test("a snapshot taken during the prepare shows the stage, the units and the probe's facts", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let paused: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => {
      paused = resolve;
    });
    const r = rig(
      reporting(async (prepare) => {
        prepare.begin(600, { hdrToSdr: false, fromFps: 24 });
        prepare.report(300);
        paused();
        await gate;
      }),
    );
    const result = await r.service.import(await callFor());
    if (!result.ok) throw new Error("refused");
    await reached;
    expect(r.jobs.stateOf(result.jobId)).toMatchObject({ status: "running", stage: "prepare", done: 300, total: 600, prepare: { hdrToSdr: false, fromFps: 24 } });
    release();
    await r.service.settled();
  });

  test("a report before the importer has said how much there is changes nothing", async () => {
    const { progress } = await run(reporting((prepare) => prepare.report(5)));
    expect(preparing(progress)).toEqual([]);
    expect(importOnly(progress).every((p) => p.done <= p.total)).toBe(true);
  });

  test("the stage begins once: a second begin is ignored", async () => {
    const { progress } = await run(
      reporting((prepare) => {
        prepare.begin(900);
        prepare.begin(50);
      }),
    );
    expect(new Set(preparing(progress).map((p) => p.total))).toEqual(new Set([900]));
  });

  test("a total that is not a positive count begins nothing: the job stays in its copy", async () => {
    const { progress } = await run(
      reporting((prepare) => {
        prepare.begin(0);
        prepare.begin(Number.NaN);
        prepare.report(3);
      }),
    );
    expect(preparing(progress)).toEqual([]);
  });

  test("an importer that never reports leaves the job as it was: a copy, and done", async () => {
    const { jobId, progress, r } = await run(async () => ({ ok: true, facts: FACTS }));
    expect(preparing(progress)).toEqual([]);
    expect(r.jobs.stateOf(jobId)).toMatchObject({ status: "done" });
    expect(r.jobs.stateOf(jobId)).not.toHaveProperty("stage");
  });

  test("an importer that is late says nothing: a report after the job ended is dropped", async () => {
    let kept: NonNullable<MediaImportRequest["prepare"]> | undefined;
    const { r } = await run(
      reporting((prepare) => {
        kept = prepare;
        prepare.begin(900);
      }),
    );
    const before = r.events.length;
    kept?.report(500);
    kept?.begin(70);
    expect(r.events.length).toBe(before);
  });

  test("a report after the cancel is dropped", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let paused: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => {
      paused = resolve;
    });
    const r = rig(
      reporting(async (prepare, request) => {
        prepare.begin(900);
        paused();
        await gate;
        prepare.report(800);
        void request;
      }),
    );
    const result = await r.service.import(await callFor());
    if (!result.ok) throw new Error("refused");
    await reached;
    r.service.cancel(result.jobId);
    const before = r.events.length;
    release();
    await r.service.settled();
    expect(progressOf(r.events.slice(before))).toEqual([]);
    expect(r.jobs.stateOf(result.jobId)).toMatchObject({ status: "cancelled", done: 0 });
  });

  test("every progress it sends fits the contract and no stage goes back to the copy", async () => {
    const { progress } = await run(
      reporting((prepare) => {
        prepare.begin(120, { hdrToSdr: true, fromFps: null });
        for (let done = 0; done < 120; done += 7) prepare.report(done);
      }),
    );
    const stages = importOnly(progress).map((p) => p.stage ?? "copy");
    const firstPrepare = stages.indexOf("prepare");
    expect(stages.slice(firstPrepare).every((s) => s === "prepare")).toBe(true);
  });
});
