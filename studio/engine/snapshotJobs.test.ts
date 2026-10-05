import { describe, expect, test } from "bun:test";
import { JobState } from "../shared/engine";
import { JobRegistry } from "./jobs";
import { validJobStates } from "./snapshotJobs";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// One job state that breaks the contract must not make main refuse the whole `engine.snapshot` answer and send every window offline. A state whose fault is
// a detail past 500 characters or a `done` past its `total` is repaired (clipped, clamped), so even a running paid job stays visible; any other is left out.
// The log says which job and which fields, never what they held, and says it once per job.

function states(): JobState[] {
  const jobs = new JobRegistry();
  jobs.startCandidates("job-00000001", "draft-00000001", 4);
  jobs.startCandidates("job-00000002", "draft-00000002", 4);
  jobs.startCandidates("job-00000003", "draft-00000003", 4);
  jobs.startCandidates("job-00000004", "draft-00000004", 4);
  jobs.finish("job-00000002", { status: "failed", error: { code: "INTERNAL", detail: "SECRET ".repeat(100) } });
  return jobs.states().map((state) => {
    // Job 3 reports more than its total; job 4 is running with an error, which only a failed job has (nothing to repair there).
    if (state.jobId === "job-00000003") return { ...state, done: 9 };
    if (state.jobId === "job-00000004") return { ...state, error: { code: "INTERNAL" as const } };
    return state;
  });
}

describe("validJobStates", () => {
  test("keeps every state that fits the contract, in order, and logs nothing", () => {
    const jobs = new JobRegistry();
    jobs.startCandidates("job-00000001", "draft-00000001", 4);
    jobs.startCandidates("job-00000002", "draft-00000002", 4);
    const lines: string[] = [];

    const kept = validJobStates(jobs.states(), (line) => lines.push(line));

    expect(kept.map((s) => s.jobId)).toEqual(["job-00000001", "job-00000002"]);
    expect(lines).toEqual([]);
  });

  test("the premise: three of the four states break the contract", () => {
    expect(states().filter((state) => !JobState.safeParse(state).success)).toHaveLength(3);
  });

  test("clips an over-long detail and keeps the job", () => {
    const repaired = validJobStates(states(), () => undefined).find((s) => s.jobId === "job-00000002");

    expect(repaired).toMatchObject({ status: "failed", error: { code: "INTERNAL" } });
    expect(repaired?.error?.detail?.length).toBe(500);
  });

  test("clamps a running job's done to its total and keeps it: a paid job never vanishes from a window", () => {
    const repaired = validJobStates(states(), () => undefined).find((s) => s.jobId === "job-00000003");

    expect(repaired).toMatchObject({ status: "running", done: 4, total: 4 });
  });

  test("leaves out a state it cannot repair and keeps its neighbours, every kept state valid", () => {
    const kept = validJobStates(states(), () => undefined);

    expect(kept.map((s) => s.jobId)).toEqual(["job-00000001", "job-00000002", "job-00000003"]);
    expect(kept.every((state) => JobState.safeParse(state).success)).toBe(true);
  });

  test("logs the job id, kind, status and the failing field paths of each, and none of their content", () => {
    const lines: string[] = [];

    validJobStates(states(), (line) => lines.push(line));

    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("job-00000002");
    expect(lines[0]).toContain("avatar.candidates");
    expect(lines[0]).toContain("failed");
    expect(lines[0]).toContain("error.detail");
    expect(lines[0]).toContain("repaired");
    expect(lines[1]).toContain("job-00000003");
    expect(lines[1]).toContain("repaired");
    expect(lines[2]).toContain("job-00000004");
    expect(lines[2]).toContain("dropped");
    expect(lines.join("\n")).not.toContain("SECRET");
  });

  test("says it once per job when the same reported set is passed for every snapshot", () => {
    const lines: string[] = [];
    const reported = new Set<string>();

    validJobStates(states(), (line) => lines.push(line), reported);
    validJobStates(states(), (line) => lines.push(line), reported);
    validJobStates(states(), (line) => lines.push(line), reported);

    expect(lines).toHaveLength(3);
  });
});

describe("JobRegistry.progress", () => {
  test("never records more done than a paid job's total", () => {
    const jobs = new JobRegistry();
    jobs.startCandidates("job-00000001", "draft-00000001", 4);

    const payload = jobs.progress("job-00000001", 9);

    expect(payload).toMatchObject({ done: 4, total: 4 });
    expect(jobs.states()[0]).toMatchObject({ done: 4 });
    expect(JobState.safeParse(jobs.states()[0]).success).toBe(true);
  });
});
