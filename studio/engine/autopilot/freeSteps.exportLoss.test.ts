import { describe, expect, test } from "bun:test";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { until } from "../testing/engineHarness";
import type { ExportGate, ExportGateAnswer } from "./exportGate";
import { rig, stopAfterTest, useRigCleanup, videosOf } from "./testing/freeRig";
useNativeGlobals();
useRigCleanup();

// S4.6r fix round 1: what a render's end says about the export folder is checked against the folder's own check. A job that ended EXPORT_UNAVAILABLE (or any failure) while the folder is gone
// waits on the folder; one that ended EXPORT_UNAVAILABLE while the folder answers (a subfolder taken by a file, a commit past its deadline) is a failed render: one retry, then the drop, so the
// launch cannot resubmit the same video for ever. A render the owner cancelled is dropped, not retried.

const EXPORT_MISSING = { code: "EXPORT_UNAVAILABLE", exportReason: "missing" } as const;
const REFUSED: ExportGateAnswer = { ok: false, exportReason: "missing", neededBytes: null, freeBytes: null };

function gate(answer: ExportGateAnswer = { ok: true }): { port: ExportGate; set(next: ExportGateAnswer): void } {
  const state = { answer };
  return { port: async () => state.answer, set: (next) => void (state.answer = next) };
}

const jobOf = (r: ReturnType<typeof rig>, n: number) => [...r.videos.jobs.values()][n - 1];

/** Ends every job the steps submit with `error`, as soon as it exists. */
function failEveryJob(r: ReturnType<typeof rig>, error: { code: string; exportReason?: "missing" | "not-writable" }): void {
  const ended = new Set<string>();
  const timer = setInterval(() => {
    for (const job of r.videos.jobs.values()) {
      if (ended.has(job.jobId)) continue;
      ended.add(job.jobId);
      r.videos.finish(job.jobId, "failed", { error });
    }
  }, 1);
  stopAfterTest(async () => clearInterval(timer));
}

describe("a render the owner cancelled is not resubmitted", () => {
  test("a cancelled job drops its video as render-failed at once: no retry, no second submit", async () => {
    const r = rig({ auto: false, draft: { videosPerAvatar: 1 } });
    r.start();
    await until(() => r.videos.calls.length === 1, "the render");
    r.videos.finish(jobOf(r, 1)?.jobId ?? "", "cancelled");
    await until(() => r.launch.finished(), "the launch to finish");
    expect(videosOf(r.launch)[0]).toMatchObject({ state: "dropped", dropReason: "render-failed" });
    expect(r.videos.calls).toHaveLength(1);
    expect(r.launch.file().renderRetries).toBeUndefined();
    expect(r.launch.logs.some((l) => l.kind === "render-retry")).toBe(false);
    expect(r.launch.logs.filter((l) => l.kind === "render-dropped")).toHaveLength(1);
  });
});

describe("an EXPORT_UNAVAILABLE that the folder's own check does not confirm is a failed render", () => {
  test("the gate says the folder is fine while the job keeps failing EXPORT_UNAVAILABLE: one retry, then the drop, and the submits are bounded", async () => {
    const r = rig({ auto: false, draft: { videosPerAvatar: 1 }, deps: { exportGate: gate().port } });
    failEveryJob(r, EXPORT_MISSING);
    r.start();
    await until(() => r.launch.finished(), "the launch to finish");
    expect(videosOf(r.launch)[0]).toMatchObject({ state: "dropped", dropReason: "render-failed" });
    expect(r.videos.calls).toHaveLength(2);
    expect(r.launch.file().renderRetries).toEqual({ "0-1": 1 });
    expect(r.launch.logs.filter((l) => l.kind === "render-retry")).toHaveLength(1);
    expect(r.launch.logs.filter((l) => l.kind === "render-dropped")).toHaveLength(1);
  });

  test("with no gate to ask, consecutive losses of the folder are bounded too: the submits stop and the video is dropped", async () => {
    const r = rig({ auto: false, draft: { videosPerAvatar: 1 } });
    failEveryJob(r, EXPORT_MISSING);
    r.start();
    await until(() => r.launch.finished(), "the launch to finish");
    expect(videosOf(r.launch)[0]).toMatchObject({ state: "dropped", dropReason: "render-failed" });
    expect(r.videos.calls.length).toBeLessThanOrEqual(4);
  });

  test("a gate that throws at the end of the job is «unknown»: the folder holds, no retry is used, and nothing is dropped", async () => {
    let throwing = false;
    const port: ExportGate = async () => {
      if (throwing) throw new Error("the volume did not answer");
      return { ok: true };
    };
    const r = rig({ auto: false, draft: { videosPerAvatar: 1 }, deps: { exportGate: port } });
    r.start();
    await until(() => r.videos.calls.length === 1, "the first render");
    throwing = true;
    r.videos.finish(jobOf(r, 1)?.jobId ?? "", "failed", { error: { code: "RENDER_FAILED" } });
    // The video is submitted again (the submit pass's own gate error means «the engine checks»), with no retry used and no drop.
    await until(() => r.videos.calls.length === 2, "the video submitted again", 4_000);
    expect(r.launch.file().renderRetries).toBeUndefined();
    expect(r.launch.logs.some((l) => l.kind === "render-retry" || l.kind === "render-dropped")).toBe(false);
    throwing = false;
    r.videos.finish(jobOf(r, 2)?.jobId ?? "", "done");
    await until(() => r.launch.finished(), "the launch to finish");
    expect(videosOf(r.launch)[0]?.state).toBe("done");
  });

  test("the folder's own check refusing at the end of the job is a hold, whatever the job said: a RENDER_FAILED while the folder is gone waits on the folder and spends no retry", async () => {
    const g = gate();
    const r = rig({ auto: false, draft: { videosPerAvatar: 1 }, deps: { exportGate: g.port } });
    r.start();
    await until(() => r.videos.calls.length === 1, "the first render");
    g.set(REFUSED);
    r.videos.finish(jobOf(r, 1)?.jobId ?? "", "failed", { error: { code: "RENDER_FAILED" } });
    await until(() => r.launch.file().freeHold !== null, "the export hold", 4_000);
    expect(r.launch.file().renderRetries).toBeUndefined();
    expect(videosOf(r.launch)[0]?.state).toBe("assigned");
    g.set({ ok: true });
    r.steps.poke();
    await until(() => r.videos.calls.length === 2, "the new render", 4_000);
    r.videos.finish(jobOf(r, 2)?.jobId ?? "", "done");
    await until(() => r.launch.finished(), "the launch to finish");
    expect(videosOf(r.launch)[0]?.state).toBe("done");
  });
});
