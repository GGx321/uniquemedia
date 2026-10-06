import { describe, expect, test } from "bun:test";
import { JobState } from "../shared/engine";
import { JobRegistry } from "./jobs";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// CS.4a: a scene set's writer job in the registry: it is listed in the snapshot with its set and avatar, counts SCENES, ends with the number it wrote and the
// number it left, and makes its avatar busy like any other job (a delete, a run start and a library switch all look at it).

const SET = "set-00000001";
const AVATAR = "avatar-00000001";
const JOB = "job-00000001";

function valid(states: unknown[]): void {
  for (const state of states) expect(JobState.safeParse(state).success).toBe(true);
}

describe("JobRegistry: scenes jobs", () => {
  test("a started scenes job is listed as running with its set and avatar, nothing written yet", () => {
    const jobs = new JobRegistry();
    jobs.startScenes(JOB, { sceneSetId: SET, avatarId: AVATAR, total: 30 });

    expect(jobs.states()).toEqual([{ kind: "scenes", jobId: JOB, sceneSetId: SET, avatarId: AVATAR, status: "running", done: 0, total: 30 }]);
    valid(jobs.states());
  });

  test("progress counts the scenes written and gives the event's payload, never past the total", () => {
    const jobs = new JobRegistry();
    jobs.startScenes(JOB, { sceneSetId: SET, avatarId: AVATAR, total: 30 });

    expect(jobs.progress(JOB, 25)).toEqual({ kind: "scenes", jobId: JOB, sceneSetId: SET, avatarId: AVATAR, done: 25, total: 30 });
    expect(jobs.progress(JOB, 99)).toMatchObject({ done: 30 });
  });

  test("a done job carries what it wrote and what it left", () => {
    const jobs = new JobRegistry();
    jobs.startScenes(JOB, { sceneSetId: SET, avatarId: AVATAR, total: 30 });
    jobs.progress(JOB, 5);

    const state = jobs.finishScenes(JOB, { status: "done", written: 5, unwritten: 25 });

    expect(state).toEqual({ kind: "scenes", jobId: JOB, sceneSetId: SET, avatarId: AVATAR, status: "done", done: 5, total: 30, result: { kind: "scenes", sceneSetId: SET, avatarId: AVATAR, written: 5, unwritten: 25 } });
    valid(jobs.states());
  });

  test("a failed job keeps how far it got and says why", () => {
    const jobs = new JobRegistry();
    jobs.startScenes(JOB, { sceneSetId: SET, avatarId: AVATAR, total: 30 });
    jobs.progress(JOB, 25);

    const state = jobs.finishScenes(JOB, { status: "failed", error: { code: "RATE_LIMITED" } });

    expect(state).toMatchObject({ status: "failed", done: 25, total: 30, error: { code: "RATE_LIMITED" } });
    valid(jobs.states());
  });

  test("a cancelled job keeps how far it got", () => {
    const jobs = new JobRegistry();
    jobs.startScenes(JOB, { sceneSetId: SET, avatarId: AVATAR, total: 30 });
    jobs.progress(JOB, 25);

    expect(jobs.finishScenes(JOB, { status: "cancelled" })).toMatchObject({ status: "cancelled", done: 25 });
  });

  test("a job that already ended cannot end again, and a job of another kind is not a scenes job", () => {
    const jobs = new JobRegistry();
    jobs.startScenes(JOB, { sceneSetId: SET, avatarId: AVATAR, total: 3 });
    jobs.finishScenes(JOB, { status: "cancelled" });
    expect(jobs.finishScenes(JOB, { status: "done", written: 3, unwritten: 0 })).toBeNull();

    jobs.startRun("job-00000002", { runId: "run-00000001", avatarId: AVATAR, total: 3, done: 0 });
    expect(jobs.finishScenes("job-00000002", { status: "cancelled" })).toBeNull();
  });

  test("the running job of a set is found by the set, and none once it ended", () => {
    const jobs = new JobRegistry();
    expect(jobs.runningJobOfSet(SET)).toBeNull();
    jobs.startScenes(JOB, { sceneSetId: SET, avatarId: AVATAR, total: 3 });
    expect(jobs.runningJobOfSet(SET)).toBe(JOB);
    expect(jobs.runningJobOfSet("set-00000002")).toBeNull();
    jobs.finishScenes(JOB, { status: "cancelled" });
    expect(jobs.runningJobOfSet(SET)).toBeNull();
  });

  test("a running scenes job makes its avatar live, so the avatar is not deleted under it", () => {
    const jobs = new JobRegistry();
    jobs.startScenes(JOB, { sceneSetId: SET, avatarId: AVATAR, total: 3 });
    expect(jobs.hasLiveJobFor(AVATAR)).toBe(true);
    jobs.finishScenes(JOB, { status: "cancelled" });
    expect(jobs.hasLiveJobFor(AVATAR)).toBe(false);
  });

  test("a cancel aborts the job's signal", () => {
    const jobs = new JobRegistry();
    const signal = jobs.startScenes(JOB, { sceneSetId: SET, avatarId: AVATAR, total: 3 });
    expect(signal.aborted).toBe(false);
    expect(jobs.cancel(JOB)).toBe(true);
    expect(signal.aborted).toBe(true);
  });

  test("an ended job of a deleted avatar is forgotten with it", () => {
    const jobs = new JobRegistry();
    jobs.startScenes(JOB, { sceneSetId: SET, avatarId: AVATAR, total: 3 });
    jobs.finishScenes(JOB, { status: "cancelled" });
    jobs.forgetFinishedFor(AVATAR);
    expect(jobs.states()).toEqual([]);
  });
});
