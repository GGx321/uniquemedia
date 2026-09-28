import { describe, expect, test } from "bun:test";
import { JobState, type FailedCandidateSlot } from "../shared/engine";
import { JobRegistry } from "./jobs";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

const DRAFT = "draft-00000001";

function valid(states: unknown[]): void {
  for (const state of states) expect(JobState.safeParse(state).success).toBe(true);
}

describe("JobRegistry", () => {
  test("a started candidates job is listed as running, nothing done yet", () => {
    const jobs = new JobRegistry();
    jobs.startCandidates("job-00000001", DRAFT, 4);

    expect(jobs.states()).toEqual([{ kind: "avatar.candidates", jobId: "job-00000001", avatarId: DRAFT, status: "running", done: 0, total: 4 }]);
    valid(jobs.states());
  });

  test("progress sets how many slots are done and gives the event's payload", () => {
    const jobs = new JobRegistry();
    jobs.startCandidates("job-00000001", DRAFT, 4);

    expect(jobs.progress("job-00000001", 2)).toEqual({ jobId: "job-00000001", avatarId: DRAFT, done: 2, total: 4 });
    expect(jobs.states()).toMatchObject([{ status: "running", done: 2 }]);
    expect(jobs.progress("job-00000404", 1)).toBeNull();
  });

  test("a done job carries its result: the candidates of its draft, the slots that gave none, and how many of them the age check rejected", () => {
    const jobs = new JobRegistry();
    jobs.startCandidates("job-00000001", DRAFT, 4);
    jobs.progress("job-00000001", 4);

    const failedSlots: FailedCandidateSlot[] = [
      { slot: 3, reason: "age-rejected" },
      { slot: 4, reason: "failed", error: { code: "TIMEOUT" }, reserveLeftOpen: true },
    ];
    const state = jobs.finish("job-00000001", { status: "done", photoIds: ["photo-00000001", "photo-00000002"], failedSlots });

    const expected: JobState = {
      kind: "avatar.candidates",
      jobId: "job-00000001",
      avatarId: DRAFT,
      status: "done",
      done: 4,
      total: 4,
      result: {
        kind: "avatar.candidates",
        avatarId: DRAFT,
        candidates: [
          { avatarId: DRAFT, photoId: "photo-00000001" },
          { avatarId: DRAFT, photoId: "photo-00000002" },
        ],
        rejectedByAgeCheck: 1,
        failedSlots,
      },
    };
    expect(state).toEqual(expected);
    expect(jobs.states()).toEqual([expected]);
    valid(jobs.states());
  });

  test("a failed job carries its error; a cancelled one only its status", () => {
    const jobs = new JobRegistry();
    jobs.startCandidates("job-00000001", DRAFT, 4);
    jobs.startCandidates("job-00000002", "draft-00000002", 4);
    jobs.progress("job-00000002", 1);

    jobs.finish("job-00000001", { status: "failed", error: { code: "NETWORK", detail: "fetch failed" } });
    jobs.finish("job-00000002", { status: "cancelled" });

    expect(jobs.states()).toEqual([
      { kind: "avatar.candidates", jobId: "job-00000001", avatarId: DRAFT, status: "failed", done: 0, total: 4, error: { code: "NETWORK", detail: "fetch failed" } },
      { kind: "avatar.candidates", jobId: "job-00000002", avatarId: "draft-00000002", status: "cancelled", done: 1, total: 4 },
    ]);
    valid(jobs.states());
  });

  test("cancel aborts a running job's signal; an unknown job is false; a finished job stays as it ended", () => {
    const jobs = new JobRegistry();
    const signal = jobs.startCandidates("job-00000001", DRAFT, 4);

    expect(jobs.cancel("job-00000001")).toBe(true);
    expect(signal.aborted).toBe(true);
    expect(jobs.cancel("job-00000404")).toBe(false);

    jobs.startCandidates("job-00000002", DRAFT, 4);
    jobs.finish("job-00000002", { status: "done", photoIds: [], failedSlots: [1, 2, 3, 4].map((slot) => ({ slot, reason: "age-rejected" as const })) });
    expect(jobs.cancel("job-00000002")).toBe(true);
    expect(jobs.states()[1]).toMatchObject({ jobId: "job-00000002", status: "done" });
  });

  test("keeps every running job and the latest finished ones, dropping the oldest finished first", () => {
    const jobs = new JobRegistry({ keepFinished: 2 });
    for (const n of [1, 2, 3, 4]) jobs.startCandidates(`job-0000000${n}`, DRAFT, 4);
    for (const n of [1, 2, 3]) jobs.finish(`job-0000000${n}`, { status: "cancelled" });

    expect(jobs.states().map((j) => j.jobId)).toEqual(["job-00000002", "job-00000003", "job-00000004"]);
    expect(jobs.cancel("job-00000001")).toBe(false);
  });

  test("a job id is never registered twice", () => {
    const jobs = new JobRegistry();
    jobs.startCandidates("job-00000001", DRAFT, 4);

    expect(() => jobs.startCandidates("job-00000001", DRAFT, 4)).toThrow("job-00000001");
  });
});

// T6: a photo run's jobs. A resume is a new job of the same run, so a run
// job starts with the slots its run already finished counted as done.
describe("JobRegistry: photo run jobs", () => {
  const RUN = "run-00000001";
  const AVATAR = "avatar-0001";

  test("a started run job is listed as running with its run and its avatar, counting the slots earlier jobs finished", () => {
    const jobs = new JobRegistry();
    jobs.startRun("job-00000001", { runId: RUN, avatarId: AVATAR, total: 20, done: 3 });

    expect(jobs.states()).toEqual([{ kind: "run", jobId: "job-00000001", runId: RUN, avatarId: AVATAR, status: "running", done: 3, total: 20 }]);
    valid(jobs.states());
  });

  test("progress of a run job carries its avatar, like a candidates job's", () => {
    const jobs = new JobRegistry();
    jobs.startRun("job-00000001", { runId: RUN, avatarId: AVATAR, total: 20, done: 0 });

    expect(jobs.progress("job-00000001", 4)).toEqual({ jobId: "job-00000001", avatarId: AVATAR, done: 4, total: 20 });
  });

  test("a done run job carries its result: the run's photos and how many slots have none", () => {
    const jobs = new JobRegistry();
    jobs.startRun("job-00000001", { runId: RUN, avatarId: AVATAR, total: 3, done: 0 });
    jobs.progress("job-00000001", 3);

    const state = jobs.finishRun("job-00000001", { status: "done", photoIds: ["photo-00000001", "photo-00000002"], failedSlots: 1 });

    expect(state).toEqual({
      kind: "run",
      jobId: "job-00000001",
      runId: RUN,
      avatarId: AVATAR,
      status: "done",
      done: 3,
      total: 3,
      result: { kind: "run", runId: RUN, avatarId: AVATAR, photoIds: ["photo-00000001", "photo-00000002"], failedSlots: 1 },
    });
    valid([state]);
  });

  test("a failed run job carries its error; a cancelled one neither error nor result", () => {
    const jobs = new JobRegistry();
    jobs.startRun("job-00000001", { runId: RUN, avatarId: AVATAR, total: 3, done: 1 });
    jobs.startRun("job-00000002", { runId: "run-00000002", avatarId: AVATAR, total: 3, done: 0 });

    expect(jobs.finishRun("job-00000001", { status: "failed", error: { code: "RUN_CAP_EXCEEDED" } })).toMatchObject({ status: "failed", error: { code: "RUN_CAP_EXCEEDED" } });
    expect(jobs.finishRun("job-00000002", { status: "cancelled" })).toMatchObject({ status: "cancelled" });
    valid(jobs.states());
  });

  test("runningJobOf names the run's running job, and nothing once it ended", () => {
    const jobs = new JobRegistry();
    jobs.startRun("job-00000001", { runId: RUN, avatarId: AVATAR, total: 3, done: 0 });
    expect(jobs.runningJobOf(RUN)).toBe("job-00000001");
    expect(jobs.runningJobOf("run-00000404")).toBeNull();

    jobs.finishRun("job-00000001", { status: "cancelled" });
    expect(jobs.runningJobOf(RUN)).toBeNull();
  });

  test("cancel aborts a run job's signal", () => {
    const jobs = new JobRegistry();
    const signal = jobs.startRun("job-00000001", { runId: RUN, avatarId: AVATAR, total: 3, done: 0 });
    expect(jobs.cancel("job-00000001")).toBe(true);
    expect(signal.aborted).toBe(true);
  });

  test("a job is finished only by its own kind's finish", () => {
    const jobs = new JobRegistry();
    jobs.startRun("job-00000001", { runId: RUN, avatarId: AVATAR, total: 3, done: 0 });
    jobs.startCandidates("job-00000002", DRAFT, 4);

    expect(jobs.finish("job-00000001", { status: "cancelled" })).toBeNull();
    expect(jobs.finishRun("job-00000002", { status: "cancelled" })).toBeNull();
    expect(jobs.states().map((j) => j.status)).toEqual(["running", "running"]);
  });
});
