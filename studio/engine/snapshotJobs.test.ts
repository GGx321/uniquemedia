import { describe, expect, test } from "bun:test";
import { JobState } from "../shared/engine";
import { JobRegistry } from "./jobs";
import { validJobStates } from "./snapshotJobs";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// One job state that breaks the contract (a detail past 500 characters, say) must not make main refuse the whole `engine.snapshot` answer and send every
// window offline: the snapshot leaves that state out and logs that it did, without the state's content.

function registry(): JobRegistry {
  const jobs = new JobRegistry();
  jobs.startCandidates("job-00000001", "draft-00000001", 4);
  jobs.startCandidates("job-00000002", "draft-00000002", 4);
  jobs.startCandidates("job-00000003", "draft-00000003", 4);
  jobs.finish("job-00000002", { status: "failed", error: { code: "INTERNAL", detail: "SECRET ".repeat(100) } });
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

  test("the registry really holds a state that breaks the contract (the premise)", () => {
    expect(registry().states().filter((state) => !JobState.safeParse(state).success)).toHaveLength(1);
  });

  test("leaves out a state that breaks the contract and keeps its neighbours", () => {
    const kept = validJobStates(registry().states(), () => undefined);

    expect(kept.map((s) => s.jobId)).toEqual(["job-00000001", "job-00000003"]);
    expect(kept.every((state) => JobState.safeParse(state).success)).toBe(true);
  });

  test("says that it left states out, how many, and none of their content", () => {
    const lines: string[] = [];

    validJobStates(registry().states(), (line) => lines.push(line));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("1 job state");
    expect(lines[0]).not.toContain("SECRET");
  });
});
