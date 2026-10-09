import { describe, expect, test } from "bun:test";
import type { BudgetHoldDetail, MonthRoom } from "../../shared/autopilot/money";
import type { Estimate } from "../../shared/engine";
import type { StoredSceneSet } from "../library/sceneSets";
import { sampleSet } from "../library/testing/sceneSetSample";
import type { LaunchFile } from "./launchFile";
import type { PaidPort } from "./paidPort";
import { createPaidSteps } from "./paidSteps";
import { composeSteps } from "./stepsComposer";
import { A, B } from "./testing/launchFixtures";
import { rig, settleFor, useRigCleanup } from "./testing/freeRig";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Stage 4, S4.6b1 (fix round 2): the paid steps and the free steps behind the composer, over one launch file. The bug this pins: the composer's field-ownership filter rolled back a
// free-owned row's phase, so the free part's tidy kept "changing" a file that never changed (301 writes in 400 ms, the phase stuck at «planned»).

useRigCleanup();

const LAUNCH = "launch-fixture-0001";

/** The engine, as far as one approved, fully drawn set needs it: nothing is composed, drawn or started. */
function drawnPort(set: StoredSceneSet, runId: string): PaidPort {
  const refuse = (name: string): never => {
    throw new Error(`unexpected call: ${name}`);
  };
  return {
    library: { sceneSets: { get: async () => set, list: async () => ({ sets: [set], unreadable: 0 }) } },
    budget: null,
    composeLaunchSet: async () => refuse("composeLaunchSet"),
    composeEstimate: async (): Promise<Estimate> => refuse("composeEstimate"),
    writeLaunchScenes: async () => refuse("writeLaunchScenes"),
    writeEstimate: async (): Promise<Estimate> => refuse("writeEstimate"),
    approveLaunchSet: async () => refuse("approveLaunchSet"),
    drawLaunchSlice: async () => refuse("drawLaunchSlice"),
    startLaunchSlice: async () => refuse("startLaunchSlice"),
    sliceStatuses: async () => new Map([[runId, { finished: true as const, committedMicros: 1 }]]),
    photoWorstMicros: async () => refuse("photoWorstMicros"),
    monthRoom: (): MonthRoom | null => null,
    resumeSliceHold: async (): Promise<BudgetHoldDetail> => refuse("resumeSliceHold"),
    admitted: () => true,
    sliceOutcome: async () => null,
    softStopScenes: () => false,
    softStopRun: () => false,
    whenSceneSetIdle: async () => undefined,
    unlinkLaunchSet: async () => ({ phase: "awaiting" as const }),
  };
}

describe("composeSteps(paid, free) over one launch", () => {
  test("a library avatar and a generating avatar both end «done», with a bounded number of writes and exactly one finish", async () => {
    const r = rig({
      draft: { avatarIds: [A, B], generate: true },
      file: (file) => ({
        ...file,
        avatars: file.avatars.map((row) =>
          row.generation === null
            ? row
            : // The generating avatar's photos are already drawn and its videos rendered: only the paid path's last step (montage) and the joint finish are left.
              { ...row, phase: "drawing" as const, videos: row.videos.map((v, i) => ({ ...v, state: "done" as const, videoId: `video-0000000${i + 1}` })) },
        ),
      }),
    });
    const generating = r.launch.file().avatars.find((row) => row.generation !== null);
    if (generating?.generation === undefined || generating.generation === null) throw new Error("the fixture has no generating avatar");
    const { sceneSetId, setRunId } = generating.generation;
    const base = sampleSet({ sceneSetId, runId: setRunId, avatarId: generating.avatarId, count: 3, written: 3 });
    const set = { ...base, schemaVersion: 1, createdAt: "2026-10-09T10:00:00.000Z", updatedAt: "2026-10-09T10:00:00.000Z", revision: 1, launchId: LAUNCH, launchDraw: { launchId: LAUNCH, sceneIds: [1, 2, 3], slices: [{ runId: setRunId, sceneIds: [1, 2, 3], capMicros: 1 }] } } as unknown as StoredSceneSet;
    const paid = createPaidSteps({ port: () => drawnPort(set, setRunId), retryMs: 2, warn: () => undefined });
    const composed = composeSteps(paid, r.steps, { warn: () => undefined, retryMs: 5 });
    let finishes = 0;
    const finish = r.launch.ctx.finish;
    r.launch.ctx.finish = async () => {
      finishes += 1;
      return finish();
    };
    composed.begin(r.launch.ctx);
    const deadline = Date.now() + 3_000;
    while (!r.launch.finished() && Date.now() < deadline) await settleFor(5);
    await composed.settled();
    await settleFor(40);
    expect(r.launch.finished()).toBe(true);
    expect(finishes).toBe(1);
    const final: LaunchFile = r.launch.file();
    expect(final.avatars.map((row) => row.phase)).toEqual(["done", "done"]);
    expect(r.launch.updates).toBeLessThanOrEqual(20);
  });
});
