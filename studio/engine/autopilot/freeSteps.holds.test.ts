import { describe, expect, test } from "bun:test";
import { autopilotTotalMs, videoSeed } from "../../shared/autopilot/spec";
import { estimateBytesUpper } from "../../shared/montage/estimate";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { until } from "../testing/engineHarness";
import { within } from "../testing/within";
import type { ExportGate, ExportGateAnswer } from "./exportGate";
import { failure, rig, settleFor, useRigCleanup, videosOf } from "./testing/freeRig";
import { A } from "./testing/launchFixtures";
useNativeGlobals();
useRigCleanup();

// S4.6c2 (plan §4.6 rows «EXPORT_UNAVAILABLE, not-enough-space», §8.1): the export folder or the disk cannot take a video. Renders wait (`freeHold { export }`), photos are not spent
// (nothing is marked `rendering`, nothing is submitted), the free assignment goes on, paid work is not touched, and the hold clears by itself when the folder answers again.
// A full disk is the same hold with `exportReason: "not-enough-space"` and the two figures: the contract has no hold of its own for it.

const REFUSED_MISSING: ExportGateAnswer = { ok: false, exportReason: "missing", neededBytes: null, freeBytes: null };
const REFUSED_FULL: ExportGateAnswer = { ok: false, exportReason: "not-enough-space", neededBytes: 9_000_000, freeBytes: 1_000_000 };

/** A gate the test turns: it answers `answer` and counts the questions and the sizes asked. */
function gate(answer: ExportGateAnswer = { ok: true }): { port: ExportGate; set(next: ExportGateAnswer): void; asked: number[] } {
  const state = { answer, asked: [] as number[] };
  return {
    port: async ({ requiredBytes }) => {
      state.asked.push(requiredBytes);
      return state.answer;
    },
    set: (next) => {
      state.answer = next;
    },
    asked: state.asked,
  };
}

describe("the export folder goes away and comes back", () => {
  test("a folder that is missing holds the renders: the hold names why, and no render is submitted or marked", async () => {
    const g = gate(REFUSED_MISSING);
    const r = rig({ draft: { videosPerAvatar: 2 }, deps: { exportGate: g.port } });
    r.start();
    await until(() => r.launch.file().freeHold !== null, "the export hold", 4_000);
    expect(r.launch.file().freeHold).toMatchObject({ reason: "export", detail: { exportReason: "missing", neededBytes: null, freeBytes: null } });
    await settleFor(80);
    expect(r.videos.calls).toHaveLength(0);
    expect(videosOf(r.launch).map((v) => v.state)).toEqual(["assigned", "assigned"]);
  });

  test("the hold is written once, however many looks the wait takes", async () => {
    const g = gate(REFUSED_MISSING);
    const r = rig({ draft: { videosPerAvatar: 1 }, deps: { exportGate: g.port } });
    r.start();
    await until(() => r.launch.file().freeHold !== null, "the export hold", 4_000);
    await settleFor(40);
    const writes = r.launch.updates;
    await settleFor(150);
    expect(r.launch.updates).toBe(writes);
  });

  test("the hold clears and the videos render when the folder answers again (on a poke)", async () => {
    const g = gate(REFUSED_MISSING);
    const r = rig({ draft: { videosPerAvatar: 2 }, deps: { exportGate: g.port, idlePollMs: 60_000, recheckMs: 60_000 } });
    r.start();
    await until(() => r.launch.file().freeHold !== null, "the export hold", 4_000);
    g.set({ ok: true });
    r.steps.poke();
    await until(() => r.launch.finished(), "the launch to finish", 4_000);
    expect(r.launch.file().freeHold).toBeNull();
    expect(r.videos.calls).toHaveLength(2);
  });

  test("the hold clears by itself at the next look, with no poke", async () => {
    const g = gate(REFUSED_MISSING);
    const r = rig({ draft: { videosPerAvatar: 1 }, deps: { exportGate: g.port } });
    r.start();
    await until(() => r.launch.file().freeHold !== null, "the export hold", 4_000);
    g.set({ ok: true });
    await until(() => r.launch.finished(), "the launch to finish", 4_000);
    expect(r.launch.file().freeHold).toBeNull();
  });

  test("a reason that changes while the hold lasts rewrites the hold with the new reason", async () => {
    const g = gate(REFUSED_MISSING);
    const r = rig({ draft: { videosPerAvatar: 1 }, deps: { exportGate: g.port } });
    r.start();
    await until(() => r.launch.file().freeHold?.detail.exportReason === "missing", "the first reason", 4_000);
    g.set({ ok: false, exportReason: "not-writable", neededBytes: null, freeBytes: null });
    await until(() => r.launch.file().freeHold?.detail.exportReason === "not-writable", "the second reason", 4_000);
  });

  test("a hold left in the file by an earlier run is cleared at the first look when the folder is fine", async () => {
    const g = gate({ ok: true });
    const r = rig({
      draft: { videosPerAvatar: 1 },
      deps: { exportGate: g.port },
      file: (file) => ({ ...file, freeHold: { reason: "export", at: "2026-10-09T09:00:00.000Z", detail: { exportReason: "missing", neededBytes: null, freeBytes: null } } }),
    });
    r.start();
    await until(() => r.launch.finished(), "the launch to finish", 4_000);
    expect(r.launch.file().freeHold).toBeNull();
  });

  test("the free path goes on under the hold: photos are assigned and tracks chosen, only the render waits", async () => {
    const g = gate(REFUSED_MISSING);
    const r = rig({ draft: { videosPerAvatar: 2 }, deps: { exportGate: g.port } });
    r.start();
    await until(() => r.launch.file().freeHold !== null && videosOf(r.launch).every((v) => v.state === "assigned" && v.music !== undefined), "assigned with tracks under the hold", 4_000);
    expect(r.focusLog.length).toBe(0);
  });

  test("the engine's own EXPORT_UNAVAILABLE at the submit is the same hold, and the video goes back to assigned", async () => {
    const r = rig({ draft: { videosPerAvatar: 1 } });
    r.videos.failNext(failure({ code: "EXPORT_UNAVAILABLE", exportReason: "not-a-directory", detail: "the export folder is not a folder" }));
    // The hold is cleared again at the next successful render, so the test records what was set rather than polling for it.
    const holds: Array<string | null> = [];
    const setFreeHold = r.launch.ctx.setFreeHold;
    (r.launch.ctx as { setFreeHold: typeof setFreeHold }).setFreeHold = async (hold) => {
      holds.push(hold === null ? null : hold.detail.exportReason);
      return setFreeHold(hold);
    };
    r.start();
    await until(() => r.launch.finished(), "the launch to finish", 4_000);
    expect(holds).toEqual(["not-a-directory", null]);
    expect(r.launch.file().freeHold).toBeNull();
    expect(videosOf(r.launch)[0]?.state).toBe("done");
    expect(r.videos.calls).toHaveLength(2);
  });
});

describe("free disk below the floor", () => {
  test("the hold carries what the next video needs and what the disk has", async () => {
    const g = gate(REFUSED_FULL);
    const r = rig({ draft: { videosPerAvatar: 1 }, deps: { exportGate: g.port } });
    r.start();
    await until(() => r.launch.file().freeHold !== null, "the disk hold", 4_000);
    expect(r.launch.file().freeHold).toMatchObject({ reason: "export", detail: { exportReason: "not-enough-space", neededBytes: 9_000_000, freeBytes: 1_000_000 } });
    expect(r.videos.calls).toHaveLength(0);
  });

  test("the gate is asked for the upper estimate of the next video's length (plan §8.1)", async () => {
    const g = gate({ ok: true });
    const r = rig({ draft: { videosPerAvatar: 1 }, deps: { exportGate: g.port } });
    r.start();
    await until(() => r.launch.finished(), "the launch to finish", 4_000);
    const file = r.launch.file();
    const video = videosOf(r.launch)[0];
    const seed = videoSeed(file.draft.planSeed, A, video?.key ?? "");
    const totalMs = autopilotTotalMs(video?.shape ?? "single", video?.size ?? 1, seed);
    expect(g.asked[0]).toBe(estimateBytesUpper([{ durationMs: totalMs }]));
  });

  test("the hold clears when space is freed, and the video renders", async () => {
    const g = gate(REFUSED_FULL);
    const r = rig({ draft: { videosPerAvatar: 1 }, deps: { exportGate: g.port } });
    r.start();
    await until(() => r.launch.file().freeHold !== null, "the disk hold", 4_000);
    g.set({ ok: true });
    await until(() => r.launch.finished(), "the launch to finish", 4_000);
    expect(r.launch.file().freeHold).toBeNull();
    expect(videosOf(r.launch)[0]?.state).toBe("done");
  });

  test("the hold does not count as a failed render: the video is rendered once, on its first real try", async () => {
    const g = gate(REFUSED_FULL);
    const r = rig({ draft: { videosPerAvatar: 1 }, deps: { exportGate: g.port } });
    r.start();
    await until(() => r.launch.file().freeHold !== null, "the disk hold", 4_000);
    await settleFor(100);
    g.set({ ok: true });
    await until(() => r.launch.finished(), "the launch to finish", 4_000);
    expect(r.videos.calls).toHaveLength(1);
  });
});

describe("fix round 1: a stuck folder, figures that arrive late, «Стоп»", () => {
  test("M3: a gate that never answers does not hang the pause: the drain still resolves", async () => {
    const r = rig({ draft: { videosPerAvatar: 1 }, deps: { exportGate: () => new Promise<ExportGateAnswer>(() => undefined) } });
    r.start();
    await settleFor(60);
    r.launch.pause();
    await within(r.steps.drain(), 2_000, "the drain behind a gate that never answers");
    expect(r.videos.calls).toHaveLength(0);
    expect(videosOf(r.launch)[0]?.state).toBe("assigned");
  });

  test("L3: a hold written without figures is rewritten when the same reason arrives with them", async () => {
    const g = gate({ ok: false, exportReason: "not-enough-space", neededBytes: null, freeBytes: null });
    const r = rig({ draft: { videosPerAvatar: 1 }, deps: { exportGate: g.port } });
    r.start();
    await until(() => r.launch.file().freeHold !== null, "the hold", 4_000);
    g.set(REFUSED_FULL);
    await until(() => r.launch.file().freeHold?.detail.neededBytes === 9_000_000, "the figures", 4_000);
  });

  test("L4: «Стоп» clears the export hold", async () => {
    const g = gate(REFUSED_MISSING);
    const r = rig({ draft: { videosPerAvatar: 1 }, deps: { exportGate: g.port } });
    r.start();
    await until(() => r.launch.file().freeHold !== null, "the hold", 4_000);
    await within(r.steps.release(r.launch.ctx), 4_000, "the release");
    expect(r.launch.file().freeHold).toBeNull();
  });
});

describe("the gate is asked only when it matters", () => {
  test("no question while no video is ready to render (they wait for music)", async () => {
    const g = gate({ ok: true });
    const r = rig({ draft: { videosPerAvatar: 2 }, deps: { exportGate: g.port, chooseMusic: async () => ({ kind: "waiting", reason: "no-candidate" }) } });
    r.start();
    await until(() => videosOf(r.launch).every((v) => v.state === "waiting-music"), "both videos to wait", 4_000);
    await settleFor(80);
    expect(g.asked).toHaveLength(0);
  });

  test("a gate that throws is no refusal: the render goes to the engine", async () => {
    const r = rig({
      draft: { videosPerAvatar: 1 },
      deps: {
        exportGate: async () => {
          throw new Error("the probe broke");
        },
      },
    });
    r.start();
    await until(() => r.launch.finished(), "the launch to finish", 4_000);
    expect(r.videos.calls).toHaveLength(1);
  });

  test("a hold set while the launch pauses does not break the pause or the resume", async () => {
    const g = gate(REFUSED_MISSING);
    const r = rig({ draft: { videosPerAvatar: 1 }, deps: { exportGate: g.port } });
    r.start();
    await until(() => r.launch.file().freeHold !== null, "the export hold", 4_000);
    r.launch.pause();
    await within(r.steps.drain(), 4_000, "the drain");
    r.launch.settlePause();
    g.set({ ok: true });
    r.launch.resume();
    r.start();
    await until(() => r.launch.finished(), "the launch to finish", 4_000);
    expect(r.launch.file().freeHold).toBeNull();
  });
});
