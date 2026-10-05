import { describe, expect, test } from "bun:test";
import { JobState } from "../shared/engine";
import { JobRegistry } from "./jobs";
import { validJobStates } from "./snapshotJobs";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// One job state that breaks the contract must not make main refuse the whole `engine.snapshot` answer and send every window offline. A state whose only
// fault is a detail past 500 characters (the one live way to get here) is repaired by clipping it; any other is left out. The log says which job and which
// fields, never what they held.

/** Three jobs: a valid one, a failed one whose detail is too long (repairable), and one whose progress is past its total (not repairable). */
function registry(): JobRegistry {
  const jobs = new JobRegistry();
  jobs.startCandidates("job-00000001", "draft-00000001", 4);
  jobs.startCandidates("job-00000002", "draft-00000002", 4);
  jobs.startCandidates("job-00000003", "draft-00000003", 4);
  jobs.finish("job-00000002", { status: "failed", error: { code: "INTERNAL", detail: "SECRET ".repeat(100) } });
  jobs.progress("job-00000003", 9);
  return jobs;
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

  test("the registry really holds states that break the contract (the premise)", () => {
    expect(registry().states().filter((state) => !JobState.safeParse(state).success)).toHaveLength(2);
  });

  test("clips an over-long detail and keeps the job: a failed job stays visible to every window", () => {
    const kept = validJobStates(registry().states(), () => undefined);

    const repaired = kept.find((s) => s.jobId === "job-00000002");
    expect(repaired).toMatchObject({ status: "failed", error: { code: "INTERNAL" } });
    expect(repaired?.error?.detail?.length).toBe(500);
  });

  test("leaves out a state it cannot repair and keeps its neighbours, every kept state valid", () => {
    const kept = validJobStates(registry().states(), () => undefined);

    expect(kept.map((s) => s.jobId)).toEqual(["job-00000001", "job-00000002"]);
    expect(kept.every((state) => JobState.safeParse(state).success)).toBe(true);
  });

  test("logs the job id, kind, status and the failing field paths of each, and none of their content", () => {
    const lines: string[] = [];

    validJobStates(registry().states(), (line) => lines.push(line));

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("job-00000002");
    expect(lines[0]).toContain("avatar.candidates");
    expect(lines[0]).toContain("failed");
    expect(lines[0]).toContain("error.detail");
    expect(lines[0]).toContain("repaired");
    expect(lines[1]).toContain("job-00000003");
    expect(lines[1]).toContain("running");
    expect(lines[1]).toContain("dropped");
    expect(lines.join("\n")).not.toContain("SECRET");
  });
});
