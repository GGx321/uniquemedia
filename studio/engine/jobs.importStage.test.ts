import { describe, expect, test } from "bun:test";
import { JobProgress, JobState } from "../shared/engine";
import { JobRegistry } from "./jobs";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// 3f.6: an import's `done / total` count bytes while the file is copied (the `copy` stage, which carries no `stage` field) and then the
// importer's own units (the `prepare` stage). The move is one step: `total` is replaced and `done` is back at zero.

const VIDEO = { mediaKind: "video", name: "walk.mov" } as const;
const ID = "job-00000001";

function started(): JobRegistry {
  const jobs = new JobRegistry();
  jobs.startImport(ID, VIDEO, 5000);
  jobs.progress(ID, 5000);
  return jobs;
}

describe("JobRegistry, the prepare stage of an import", () => {
  test("beginning it announces zero of the importer's total, in the prepare stage, with what the probe judged", () => {
    const jobs = started();
    const payload = jobs.beginImportPrepare(ID, 900, { hdrToSdr: true, fromFps: 60 });

    expect(payload).toEqual({ kind: "import", jobId: ID, ...VIDEO, mediaId: null, done: 0, total: 900, stage: "prepare", prepare: { hdrToSdr: true, fromFps: 60 } });
    expect(JobProgress.safeParse(payload).success).toBe(true);
  });

  test("a stage with nothing judged (a photo's) carries no prepare facts", () => {
    const jobs = new JobRegistry();
    jobs.startImport(ID, { mediaKind: "photo", name: "a.jpg" }, 100);
    expect(jobs.beginImportPrepare(ID, 3)).toEqual({ kind: "import", jobId: ID, mediaKind: "photo", name: "a.jpg", mediaId: null, done: 0, total: 3, stage: "prepare" });
  });

  test("the copy's progress carries no stage: a copy is what an absent stage means", () => {
    const jobs = new JobRegistry();
    jobs.startImport(ID, VIDEO, 5000);
    expect(jobs.progress(ID, 100)).toEqual({ kind: "import", jobId: ID, ...VIDEO, mediaId: null, done: 100, total: 5000 });
  });

  test("progress in the prepare stage counts the importer's units and keeps the stage and the facts", () => {
    const jobs = started();
    jobs.beginImportPrepare(ID, 900, { hdrToSdr: false, fromFps: null });

    expect(jobs.progress(ID, 300)).toEqual({ kind: "import", jobId: ID, ...VIDEO, mediaId: null, done: 300, total: 900, stage: "prepare", prepare: { hdrToSdr: false, fromFps: null } });
  });

  test("never goes back within the prepare stage", () => {
    const jobs = started();
    jobs.beginImportPrepare(ID, 900);
    jobs.progress(ID, 600);
    expect(jobs.progress(ID, 100)).toMatchObject({ done: 600 });
  });

  test("never reaches the total before the record is stored: the last unit belongs to the end of the job", () => {
    const jobs = started();
    jobs.beginImportPrepare(ID, 900);
    expect(jobs.progress(ID, 900)).toMatchObject({ done: 899, total: 900 });
    expect(jobs.progress(ID, 5000)).toMatchObject({ done: 899 });
  });

  test("a prepare of one unit stays at zero until the job ends", () => {
    const jobs = started();
    jobs.beginImportPrepare(ID, 1);
    expect(jobs.progress(ID, 1)).toMatchObject({ done: 0, total: 1 });
  });

  test("a count that is not a number changes nothing", () => {
    const jobs = started();
    jobs.beginImportPrepare(ID, 900);
    jobs.progress(ID, 10);
    expect(jobs.progress(ID, Number.NaN)).toMatchObject({ done: 10 });
  });

  test("the state a snapshot shows is in the prepare stage, whole and valid", () => {
    const jobs = started();
    jobs.beginImportPrepare(ID, 900, { hdrToSdr: true, fromFps: 24 });
    jobs.progress(ID, 450);

    expect(jobs.stateOf(ID)).toEqual({ kind: "import", jobId: ID, ...VIDEO, mediaId: null, status: "running", done: 450, total: 900, stage: "prepare", prepare: { hdrToSdr: true, fromFps: 24 } });
    expect(JobState.safeParse(jobs.stateOf(ID)).success).toBe(true);
  });

  test("a failed job ends in the stage it was in, with how far the prepare got", () => {
    const failing = started();
    failing.beginImportPrepare(ID, 900, { hdrToSdr: true, fromFps: null });
    failing.progress(ID, 450);
    expect(failing.finishImport(ID, { status: "failed", error: { code: "MEDIA_UNSUPPORTED", mediaReason: "failed" } })).toMatchObject({ stage: "prepare", done: 450, total: 900, prepare: { hdrToSdr: true, fromFps: null } });
    expect(JobState.safeParse(failing.stateOf(ID)).success).toBe(true);
  });

  test("a done job is a full count of its prepare's total", () => {
    const jobs = started();
    jobs.beginImportPrepare(ID, 900);
    jobs.progress(ID, 450);
    const media = { mediaId: "media-00000001", kind: "video", name: "walk.mov", bytes: 1000, createdAt: "2026-10-04T10:00:00.000Z", width: 100, height: 200, durationMs: 30_000, sourceFps: 30, hdrToSdr: false, loopFrames: null, delayFrames: null } as const;
    const state = jobs.finishImport(ID, { status: "done", result: { kind: "import", mediaId: media.mediaId, media } });
    expect(state).toMatchObject({ status: "done", stage: "prepare", done: 900, total: 900 });
    expect(JobState.safeParse(state).success).toBe(true);
  });

  test("the stage begins once, and only for a running import: a second begin, a queued job, another kind of job and an unknown one change nothing", () => {
    const jobs = started();
    expect(jobs.beginImportPrepare(ID, 900)).not.toBeNull();
    expect(jobs.beginImportPrepare(ID, 50)).toBeNull();
    expect(jobs.stateOf(ID)).toMatchObject({ total: 900 });

    jobs.startImport("job-00000002", VIDEO, 10, { queued: true });
    expect(jobs.beginImportPrepare("job-00000002", 5)).toBeNull();
    jobs.startCandidates("job-00000003", "avatar-00000001", 4);
    expect(jobs.beginImportPrepare("job-00000003", 5)).toBeNull();
    expect(jobs.beginImportPrepare("job-00000404", 5)).toBeNull();
  });

  test("a total that is not a positive count is no stage: the job stays in its copy", () => {
    const jobs = started();
    for (const total of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(jobs.beginImportPrepare(ID, total)).toBeNull();
    expect(jobs.stateOf(ID)).toMatchObject({ done: 5000, total: 5000 });
    expect(jobs.stateOf(ID)).not.toHaveProperty("stage");
  });

  test("a job that ended has no stage to begin", () => {
    const jobs = started();
    jobs.finishImport(ID, { status: "cancelled" });
    expect(jobs.beginImportPrepare(ID, 900)).toBeNull();
  });
});
