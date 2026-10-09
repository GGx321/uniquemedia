import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { ledgerLines, ok, useEngineDir } from "./testing/engineHarness";
import { draftOf, LAUNCH_MS, network, wiringKit } from "./testing/wiringKit";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// Stage 4, S4.6w (plan §25): the autopilot's steps are the engine's DEFAULT. A launch started on a real engine, with nothing injected into `launchSteps`, goes through the paid steps (a fake
// OpenRouter, so nothing reaches the network), the free steps (fixture photos, a stored track, REAL ffmpeg renders) and ends `done` with its videos on disk. On the old default (`IDLE_STEPS`)
// none of these launches would ever leave its first step.

setDefaultTimeout(LAUNCH_MS + 40_000);

const dir = useEngineDir("studio-engine-autopilot-wiring-");
const kit = wiringKit(dir);

describe("the autopilot's steps are the engine's default (S4.6w)", () => {
  test(
    "a library-only launch ends done with its videos on disk, and spends nothing: no request, no ledger line",
    async () => {
      const net = network();
      const avatarId = await kit.seedAvatar(10);
      const started = await kit.boot(net);
      // The plan seed is fixed: with the avatar `wire-0001` it gives two slides of 5 photos (6 to 7 s, which every stored excerpt can carry). A random seed could plan a slide of 7, which no
      // excerpt (6 to 8 s) fits, and the video would rightly wait for a longer track.
      const launch = await kit.startLaunch(started, draftOf([avatarId], { library: true, generate: false, planSeed: 7 }));
      const view = await kit.waitFor(started, launch.launchId, "the library-only launch to be done", (v) => v.status === "done");
      expect(view.spentMicros).toBe(0);
      expect(net.paidCalls()).toEqual([]);
      expect(ledgerLines(dir())).toEqual([]);
      const listed = await kit.getLaunch(started, launch.launchId);
      expect(listed.videos.map((v) => [v.state, v.dropReason])).toEqual([
        ["done", null],
        ["done", null],
      ]);
      kit.expectVideosOnDisk(await kit.videosOf(started, avatarId), 2);
      expect(listed.videos.every((v) => v.track !== null && v.track.title.length > 0)).toBe(true);
    },
    LAUNCH_MS + 30_000,
  );

  test(
    "a generating launch with the review off composes, draws, renders and ends done with its videos on disk",
    async () => {
      const net = network();
      const avatarId = await kit.seedAvatar(0);
      const started = await kit.boot(net);
      const launch = await kit.startLaunch(started, draftOf([avatarId]));
      const view = await kit.waitFor(started, launch.launchId, "the generating launch to be done", (v) => v.status === "done");
      expect(net.writerCalls().length).toBeGreaterThan(0);
      expect(net.imageCalls()).toHaveLength(10);
      expect(view.spentMicros).toBeGreaterThan(0);
      expect(view.spentMicros).toBeLessThanOrEqual(view.plannedWorstMicros);
      expect(started.engine.budget?.ledger.openReserves()).toEqual([]);
      kit.expectVideosOnDisk(await kit.videosOf(started, avatarId), 2);
    },
    LAUNCH_MS + 30_000,
  );

  test(
    "with the review on the launch waits in awaiting-review and draws nothing until «Продолжить запуск», which brings it to done",
    async () => {
      const net = network();
      const avatarId = await kit.seedAvatar(0);
      const started = await kit.boot(net);
      const launch = await kit.startLaunch(started, draftOf([avatarId], { sceneReview: true }));
      const waiting = await kit.waitFor(started, launch.launchId, "the avatar to wait for the review", (v) => v.avatars[0]?.phase === "awaiting-review");
      expect(net.imageCalls()).toEqual([]);
      const row = waiting.avatars[0];
      if (row?.sceneSetId == null || row.setRevision == null) throw new Error("the waiting avatar names no set");
      const answer = ok(await kit.call(started, "autopilot.continueAfterReview", { launchId: launch.launchId, avatarId, sceneSetId: row.sceneSetId, revision: row.setRevision }));
      expect(answer.type === "autopilot.continueAfterReview" && answer.result.draw).toBe("started");
      await kit.waitFor(started, launch.launchId, "the reviewed launch to be done", (v) => v.status === "done");
      expect(net.imageCalls()).toHaveLength(10);
      kit.expectVideosOnDisk(await kit.videosOf(started, avatarId), 2);
    },
    LAUNCH_MS + 30_000,
  );
});
