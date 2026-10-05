import { describe, expect, test } from "bun:test";
import { Snapshot, type JobState } from "../shared/engine";
import { JobRegistry } from "./jobs";
import { command, ok, startEngine, useEngineDir } from "./testing/engineHarness";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// `engine.snapshot` is validated before it is sent: a job state that breaks the contract is repaired or left out, so main never answers the whole snapshot with
// «the engine sent a response that breaks the contract» and no window goes offline for one bad job.

const dir = useEngineDir("studio-engine-snapshot-jobs-");

/** A registry that also lists a running job carrying an error, which no repair can mend. */
class RegistryWithABadJob extends JobRegistry {
  override states(): JobState[] {
    const [first] = super.states();
    return first === undefined ? [] : [...super.states(), { ...first, jobId: "job-00000009", error: { code: "INTERNAL" } }];
  }
}

describe("engine.snapshot with a job state that breaks the contract", () => {
  test("answers a snapshot that fits the contract: the long detail clipped, the unrepairable job left out", async () => {
    const jobs = new RegistryWithABadJob();
    jobs.startCandidates("job-00000001", "draft-00000001", 4);
    jobs.startCandidates("job-00000002", "draft-00000002", 4);
    jobs.finish("job-00000002", { status: "failed", error: { code: "INTERNAL", detail: "x".repeat(900) } });
    const { engine } = await startEngine(dir(), { deps: { jobs } });

    const answer = ok(await engine.handle(command("engine.snapshot")));

    const snapshot = Snapshot.parse(answer.result);
    expect(snapshot.jobs.map((job) => job.jobId)).toEqual(["job-00000001", "job-00000002"]);
  });
});
