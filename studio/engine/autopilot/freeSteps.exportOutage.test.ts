import { describe, expect, test } from "bun:test";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { until } from "../testing/engineHarness";
import type { ExportGate, ExportGateAnswer } from "./exportGate";
import { rig, useRigCleanup, videosOf } from "./testing/freeRig";
useNativeGlobals();
useRigCleanup();

// S4.6r fix round 2: a render whose life overlapped an export outage is an export loss, whatever the folder's check says when its end is handled. Two renders fail together when a drive drops; the
// folder can be back before the second end is classified, and that end must not read as an ordinary failure (a spent retry, and on a second outage a drop).

const REFUSED: ExportGateAnswer = { ok: false, exportReason: "missing", neededBytes: null, freeBytes: null };
const FAILED = { error: { code: "RENDER_FAILED" } } as const;

function gate(): { port: ExportGate; set(next: ExportGateAnswer): void } {
  const state: { answer: ExportGateAnswer } = { answer: { ok: true } };
  return { port: async () => state.answer, set: (next) => void (state.answer = next) };
}

const jobIds = (r: ReturnType<typeof rig>): string[] => [...r.videos.jobs.values()].map((job) => job.jobId);

/**
 * Two renders in flight (the jobs from `from`), then one outage: the first end is handled while the folder is gone, the second after it is back. Returns once both videos were submitted again
 * (the folder answers, so nothing holds them) — whichever way the second end was read, the video goes back to the queue, so this wait does not depend on the answer under test.
 */
async function outageSplitBetweenTwoEnds(r: ReturnType<typeof rig>, g: ReturnType<typeof gate>, from: number): Promise<void> {
  await until(() => r.videos.calls.length >= from + 2, "both renders submitted");
  const [first, second] = jobIds(r).slice(from, from + 2);
  g.set(REFUSED);
  r.videos.finish(first ?? "", "failed", FAILED);
  await until(() => r.launch.file().freeHold !== null, "the export hold", 4_000);
  await until(() => videosOf(r.launch).filter((v) => v.state === "assigned").length === 1, "the first video back to assigned", 4_000);
  g.set({ ok: true });
  r.videos.finish(second ?? "", "failed", FAILED);
  await until(() => r.videos.calls.length >= from + 4, "both videos submitted again", 4_000);
}

describe("a render that overlapped an export outage is an export loss", () => {
  test("the second of two failed renders spends no retry when the folder is back before its end is handled", async () => {
    const g = gate();
    const r = rig({ auto: false, draft: { videosPerAvatar: 2 }, deps: { exportGate: g.port } });
    r.start();
    await outageSplitBetweenTwoEnds(r, g, 0);
    expect(r.launch.file().renderRetries).toBeUndefined();
    expect(r.launch.logs.some((l) => l.kind === "render-retry" || l.kind === "render-dropped")).toBe(false);
  });

  test("a second outage does not drop the video whose end is handled after the folder is back", async () => {
    const g = gate();
    const r = rig({ auto: false, draft: { videosPerAvatar: 2 }, deps: { exportGate: g.port } });
    r.start();
    await outageSplitBetweenTwoEnds(r, g, 0);
    await outageSplitBetweenTwoEnds(r, g, 2);
    expect(videosOf(r.launch).some((v) => v.state === "dropped")).toBe(false);
    expect(r.launch.file().renderRetries).toBeUndefined();
  });

  test("a render that failed with the folder fine for its whole life still gets one retry and then the drop", async () => {
    const g = gate();
    const r = rig({ auto: false, draft: { videosPerAvatar: 1 }, deps: { exportGate: g.port } });
    r.start();
    await until(() => r.videos.calls.length === 1, "the first render");
    r.videos.finish(jobIds(r)[0] ?? "", "failed", FAILED);
    await until(() => r.videos.calls.length === 2, "the retry", 4_000);
    r.videos.finish(jobIds(r)[1] ?? "", "failed", FAILED);
    await until(() => r.launch.finished(), "the launch to finish");
    expect(videosOf(r.launch)[0]).toMatchObject({ state: "dropped", dropReason: "render-failed" });
    expect(r.launch.file().renderRetries).toEqual({ "0-1": 1 });
  });

  test("a render submitted after the outage ended is not an export loss: a later failure with the folder fine is a failed render", async () => {
    const g = gate();
    const r = rig({ auto: false, draft: { videosPerAvatar: 1 }, deps: { exportGate: g.port } });
    r.start();
    await until(() => r.videos.calls.length === 1, "the first render");
    g.set(REFUSED);
    r.videos.finish(jobIds(r)[0] ?? "", "failed", FAILED);
    await until(() => r.launch.file().freeHold !== null, "the export hold", 4_000);
    g.set({ ok: true });
    r.steps.poke();
    await until(() => r.videos.calls.length === 2, "the new render", 4_000);
    r.videos.finish(jobIds(r)[1] ?? "", "failed", FAILED);
    await until(() => r.videos.calls.length === 3, "the retry", 4_000);
    expect(r.launch.file().renderRetries).toEqual({ "0-1": 1 });
  });
});
