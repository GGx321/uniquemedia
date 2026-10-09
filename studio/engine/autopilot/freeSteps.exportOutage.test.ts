import { describe, expect, test } from "bun:test";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { until } from "../testing/engineHarness";
import type { ExportGate, ExportGateAnswer } from "./exportGate";
import { failure } from "./testing/freeHarness";
import { A } from "./testing/launchFixtures";
import { MUSIC, patchVideo, rig, useRigCleanup, videosOf } from "./testing/freeRig";
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
 * Two renders in flight (the jobs from index `from` of the job list), then one outage: the first end is handled while the folder is gone, the second after it is back. Returns once both videos were
 * submitted again (the folder answers, so nothing holds them): whichever way the second end was read, the video goes back to the queue, so this wait does not depend on the answer under test.
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

describe("an outage seen only by the engine's own refusal at a later submit", () => {
  test("a render in flight that fails in the same outage spends no retry once the folder is back", async () => {
    const g = gate();
    // The gate answers once per pass, so the second submit of the pass is checked by the engine alone: it refuses that one.
    const seen = { submits: 0 };
    const later: { real?: ReturnType<typeof rig>["videos"]["videos"] } = {};
    const videos: ReturnType<typeof rig>["videos"]["videos"] = {
      renderInternal: async (input) => {
        seen.submits += 1;
        if (seen.submits === 2) throw failure({ code: "EXPORT_UNAVAILABLE", exportReason: "missing", detail: "gone" });
        if (later.real === undefined) throw new Error("the fake video service is not wired");
        return later.real.renderInternal(input);
      },
      settled: async () => later.real?.settled(),
    };
    const r = rig({ auto: false, draft: { videosPerAvatar: 2 }, deps: { exportGate: g.port, videos } });
    later.real = r.videos.videos;
    r.start();
    await until(() => seen.submits >= 3, "the refused submit and the submit after it", 4_000);
    r.videos.finish(jobIds(r)[0] ?? "", "failed", FAILED);
    await until(() => seen.submits >= 4, "the failed video submitted again", 4_000);
    expect(r.launch.file().renderRetries).toBeUndefined();
  });
});

describe("only a refusal of the check opens an epoch, a loss never does", () => {
  test("after one outage, two renders failing genuinely in turns are each retried once and then dropped, with bounded submits", async () => {
    const g = gate();
    // The third submit (the first video, sent again after the outage) is held inside the service until the test lets it go: the second video's loss is read AFTER that render took its epoch, which is
    // the moment a loss that moved the epoch would make the render's own, genuine failure read as a loss too.
    const hold: { reached: boolean; release: () => void; real?: ReturnType<typeof rig>["videos"]["videos"] } = { reached: false, release: () => undefined };
    const latch = new Promise<void>((resolve) => void (hold.release = resolve));
    const seen = { submits: 0 };
    const videos: ReturnType<typeof rig>["videos"]["videos"] = {
      renderInternal: async (input) => {
        seen.submits += 1;
        if (seen.submits === 3) {
          hold.reached = true;
          await latch;
        }
        if (hold.real === undefined) throw new Error("the fake video service is not wired");
        return hold.real.renderInternal(input);
      },
      settled: async () => hold.real?.settled(),
    };
    const r = rig({ auto: false, draft: { videosPerAvatar: 2 }, deps: { exportGate: g.port, videos } });
    hold.real = r.videos.videos;
    r.start();
    await until(() => r.videos.calls.length >= 2, "both renders submitted", 4_000);
    g.set(REFUSED);
    r.videos.finish(jobIds(r)[0] ?? "", "failed", FAILED);
    await until(() => r.launch.file().freeHold !== null, "the export hold", 4_000);
    g.set({ ok: true });
    await until(() => hold.reached, "the first video's new submit", 4_000);
    r.videos.finish(jobIds(r)[1] ?? "", "failed", FAILED);
    hold.release();
    const signature = (): string => `${r.videos.calls.length}:${videosOf(r.launch).map((v) => v.state).join(",")}`;
    for (let turn = 0; turn < 12 && !r.launch.finished(); turn += 1) {
      const live = [...r.videos.jobs.values()].find((job) => job.life === "running");
      if (live === undefined) {
        await until(() => r.launch.finished() || [...r.videos.jobs.values()].some((job) => job.life === "running"), "a render to fail or the launch to finish", 4_000);
        continue;
      }
      const before = signature();
      r.videos.finish(live.jobId, "failed", FAILED);
      await until(() => signature() !== before, "the failed render to be handled", 4_000);
    }
    expect(r.launch.finished()).toBe(true);
    expect(videosOf(r.launch).map((v) => [v.state, v.dropReason])).toEqual([
      ["dropped", "render-failed"],
      ["dropped", "render-failed"],
    ]);
    expect(r.videos.calls).toHaveLength(6);
  });
});

describe("a render the steps took back after a restart", () => {
  const adopted = (g: ReturnType<typeof gate>) => {
    const r = rig({
      draft: { videosPerAvatar: 2 },
      file: (file) => patchVideo(file, "0-1", { state: "rendering", photoIds: ["photo-held-0001"], videoId: "video-0000beef", music: MUSIC, previousStickerId: null }),
      auto: false,
      deps: { exportGate: g.port },
    });
    return { r, job: r.videos.plant("0-1", "video-0000beef", A) };
  };

  test("fails after a refusal that came after the adoption: an export loss, no retry spent", async () => {
    const g = gate();
    g.set(REFUSED);
    const { r, job } = adopted(g);
    r.start();
    await until(() => r.steps.inFlight().renders === 1 && r.launch.file().freeHold !== null, "the adoption and the refusal", 4_000);
    g.set({ ok: true });
    r.videos.finish(job.jobId, "failed", FAILED);
    await until(() => r.videos.calls.some((call) => call.provenance.launchVideoKey === "0-1"), "the video submitted again", 4_000);
    expect(r.launch.file().renderRetries).toBeUndefined();
  });

  test("fails with no refusal at all: an ordinary failed render, one retry", async () => {
    const g = gate();
    const { r, job } = adopted(g);
    r.start();
    await until(() => r.steps.inFlight().renders >= 1, "the adoption", 4_000);
    r.videos.finish(job.jobId, "failed", FAILED);
    await until(() => r.launch.file().renderRetries !== undefined, "the retry", 4_000);
    expect(r.launch.file().renderRetries).toEqual({ "0-1": 1 });
  });
});
