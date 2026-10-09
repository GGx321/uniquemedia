import { describe, expect, test } from "bun:test";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { until } from "../testing/engineHarness";
import type { ExportGate, ExportGateAnswer } from "./exportGate";
import { failure, rig, settleFor, useRigCleanup, videosOf } from "./testing/freeRig";
useNativeGlobals();
useRigCleanup();

// S4.6r (plan §4.6, «RENDER_FAILED / timeout»): a render that ends without a video gets ONE free retry with the same assignment, then the video is dropped and its photos are free. The count
// lives in the launch file (`renderRetries`), so a restart does not grant another. A render that failed because the export folder went away is NOT a failed render: the launch holds
// (`freeHold { export }`), the retry is not used, and the video is submitted again when the folder answers.

const EXPORT_MISSING = { code: "EXPORT_UNAVAILABLE", exportReason: "missing" } as const;
const REFUSED: ExportGateAnswer = { ok: false, exportReason: "missing", neededBytes: null, freeBytes: null };

function gate(answer: ExportGateAnswer = { ok: true }): { port: ExportGate; set(next: ExportGateAnswer): void } {
  const state = { answer };
  return { port: async () => state.answer, set: (next) => void (state.answer = next) };
}

/** The job the nth call made (1-based), once it exists. */
const jobOf = (r: ReturnType<typeof rig>, n: number) => [...r.videos.jobs.values()][n - 1];

describe("a failed render gets one free retry", () => {
  test("a job that failed is submitted again with the same spec, and the video then finishes", async () => {
    const r = rig({ auto: false, draft: { videosPerAvatar: 1 } });
    r.start();
    await until(() => r.videos.calls.length === 1, "the first render");
    r.videos.finish(jobOf(r, 1)?.jobId ?? "", "failed");
    await until(() => r.videos.calls.length === 2, "the retry");
    expect(r.videos.calls[1]?.spec).toEqual(r.videos.calls[0]?.spec);
    expect(r.videos.calls[1]?.provenance.launchVideoKey).toBe(r.videos.calls[0]?.provenance.launchVideoKey);
    r.videos.finish(jobOf(r, 2)?.jobId ?? "", "done");
    await until(() => r.launch.finished(), "the launch to finish");
    expect(videosOf(r.launch)[0]?.state).toBe("done");
  });

  test("the retry is counted in the launch file and logged once, and nothing is dropped or logged as dropped", async () => {
    const r = rig({ auto: false, draft: { videosPerAvatar: 1 } });
    r.start();
    await until(() => r.videos.calls.length === 1, "the first render");
    r.videos.finish(jobOf(r, 1)?.jobId ?? "", "failed");
    await until(() => r.videos.calls.length === 2, "the retry");
    expect(r.launch.file().renderRetries).toEqual({ "0-1": 1 });
    expect(r.launch.logs.filter((l) => l.kind === "render-retry")).toHaveLength(1);
    expect(r.launch.logs.some((l) => l.kind === "render-dropped")).toBe(false);
    expect(videosOf(r.launch)[0]?.state).toBe("rendering");
  });

  test("a second failure drops the video as render-failed with one drop line, and the launch still ends", async () => {
    const r = rig({ auto: false, draft: { videosPerAvatar: 1 } });
    r.start();
    await until(() => r.videos.calls.length === 1, "the first render");
    r.videos.finish(jobOf(r, 1)?.jobId ?? "", "failed");
    await until(() => r.videos.calls.length === 2, "the retry");
    r.videos.finish(jobOf(r, 2)?.jobId ?? "", "failed");
    await until(() => r.launch.finished(), "the launch to finish");
    expect(videosOf(r.launch)[0]).toMatchObject({ state: "dropped", dropReason: "render-failed" });
    expect(r.videos.calls).toHaveLength(2);
    expect(r.launch.logs.filter((l) => l.kind === "render-retry")).toHaveLength(1);
    expect(r.launch.logs.filter((l) => l.kind === "render-dropped")).toHaveLength(1);
  });

  test("a job that ended `done` but left no record is a failed render too: one retry, then the drop", async () => {
    const r = rig({ auto: false, draft: { videosPerAvatar: 1 } });
    r.start();
    await until(() => r.videos.calls.length === 1, "the first render");
    r.videos.finish(jobOf(r, 1)?.jobId ?? "", "done", { commit: false });
    await until(() => r.videos.calls.length === 2, "the retry");
    r.videos.finish(jobOf(r, 2)?.jobId ?? "", "done", { commit: false });
    await until(() => r.launch.finished(), "the launch to finish");
    expect(videosOf(r.launch)[0]).toMatchObject({ state: "dropped", dropReason: "render-failed" });
  });

  test("a restart does not grant another retry: a video whose retry is already counted is dropped by its next failure", async () => {
    const r = rig({
      auto: false,
      draft: { videosPerAvatar: 1 },
      file: (file) => ({ ...file, renderRetries: { "0-1": 1 } }),
    });
    r.start();
    await until(() => r.videos.calls.length === 1, "the render");
    r.videos.finish(jobOf(r, 1)?.jobId ?? "", "failed");
    await until(() => r.launch.finished(), "the launch to finish");
    expect(r.videos.calls).toHaveLength(1);
    expect(videosOf(r.launch)[0]).toMatchObject({ state: "dropped", dropReason: "render-failed" });
  });

  test("the retries of two videos are counted apart", async () => {
    const r = rig({ auto: false, draft: { videosPerAvatar: 2 } });
    r.start();
    await until(() => r.videos.calls.length === 2, "both renders");
    r.videos.finish(jobOf(r, 1)?.jobId ?? "", "failed");
    await until(() => r.videos.calls.length === 3, "the first video's retry");
    r.videos.finish(jobOf(r, 2)?.jobId ?? "", "done");
    r.videos.finish(jobOf(r, 3)?.jobId ?? "", "done");
    await until(() => r.launch.finished(), "the launch to finish");
    expect(r.launch.file().renderRetries).toEqual({ "0-1": 1 });
    expect(videosOf(r.launch).map((v) => v.state)).toEqual(["done", "done"]);
  });
});

describe("a render that failed because the export folder went away is not a failed render", () => {
  test("a job that ended EXPORT_UNAVAILABLE puts the video back, holds the renders, and spends no retry", async () => {
    const g = gate();
    const r = rig({ auto: false, draft: { videosPerAvatar: 1 }, deps: { exportGate: g.port } });
    r.start();
    await until(() => r.videos.calls.length === 1, "the first render");
    // The folder is gone by the time the job reports its end.
    g.set(REFUSED);
    r.videos.finish(jobOf(r, 1)?.jobId ?? "", "failed", { error: EXPORT_MISSING });
    await until(() => r.launch.file().freeHold !== null, "the export hold", 4_000);
    expect(r.launch.file().freeHold).toMatchObject({ reason: "export", detail: { exportReason: "missing" } });
    expect(videosOf(r.launch)[0]).toMatchObject({ state: "assigned", videoId: null });
    expect(r.launch.file().renderRetries).toBeUndefined();
    expect(r.launch.logs.some((l) => l.kind === "render-retry" || l.kind === "render-dropped")).toBe(false);
    await settleFor(60);
    expect(r.videos.calls).toHaveLength(1);
  });

  test("the video is submitted again when the folder is back, and it finishes with none dropped", async () => {
    const g = gate();
    const r = rig({ auto: false, draft: { videosPerAvatar: 1 }, deps: { exportGate: g.port } });
    r.start();
    await until(() => r.videos.calls.length === 1, "the first render");
    g.set(REFUSED);
    r.videos.finish(jobOf(r, 1)?.jobId ?? "", "failed", { error: EXPORT_MISSING });
    await until(() => r.launch.file().freeHold !== null, "the export hold", 4_000);
    g.set({ ok: true });
    r.steps.poke();
    await until(() => r.videos.calls.length === 2, "the new render", 4_000);
    r.videos.finish(jobOf(r, 2)?.jobId ?? "", "done");
    await until(() => r.launch.finished(), "the launch to finish");
    expect(videosOf(r.launch)[0]?.state).toBe("done");
    expect(r.launch.file().freeHold).toBeNull();
  });

  test("with no gate, the engine's own refusal of the new submit keeps the hold until the folder answers", async () => {
    const r = rig({ auto: false, draft: { videosPerAvatar: 1 } });
    r.start();
    await until(() => r.videos.calls.length === 1, "the first render");
    // What the file says at the instant the engine refuses the new submit (read there: a later look could find the hold already cleared by the submit that follows).
    const atRefusal: { hold: string | null; state: string | null } = { hold: null, state: null };
    r.videos.failNext(() => {
      atRefusal.hold = r.launch.file().freeHold?.detail.exportReason ?? null;
      atRefusal.state = videosOf(r.launch)[0]?.state ?? null;
      return failure({ code: "EXPORT_UNAVAILABLE", exportReason: "missing", detail: "gone" });
    });
    r.videos.finish(jobOf(r, 1)?.jobId ?? "", "failed", { error: EXPORT_MISSING });
    await until(() => r.videos.calls.length >= 3, "the submit the folder takes", 4_000);
    // The video was put back and the hold stood when the refused submit came: nothing was dropped or retried for the lost folder.
    expect(atRefusal).toEqual({ hold: "missing", state: "rendering" });
    expect(r.launch.file().renderRetries).toBeUndefined();
    r.videos.finish(jobOf(r, 2)?.jobId ?? "", "done");
    await until(() => r.launch.finished(), "the launch to finish");
    expect(videosOf(r.launch)[0]?.state).toBe("done");
    expect(r.launch.file().freeHold).toBeNull();
  });

  test("a render that failed for another reason on the same launch still uses its retry", async () => {
    const r = rig({ auto: false, draft: { videosPerAvatar: 1 } });
    r.start();
    await until(() => r.videos.calls.length === 1, "the first render");
    r.videos.finish(jobOf(r, 1)?.jobId ?? "", "failed", { error: { code: "INTERNAL" } });
    await until(() => r.videos.calls.length === 2, "the retry");
    expect(r.launch.file().renderRetries).toEqual({ "0-1": 1 });
  });
});
