import { describe, expect, test } from "bun:test";
import { JobState, type FailedCandidateSlot } from "../shared/engine";
import { JobRegistry } from "./jobs";

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

    expect(jobs.progress("job-00000001", 2)).toEqual({ jobId: "job-00000001", done: 2, total: 4 });
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
