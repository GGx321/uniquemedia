import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { useNativeGlobals } from "../testing/nativeGlobals";
import type { EngineDeps } from "./engine";
import { useEngineDir } from "./testing/engineHarness";
import { draftOf, LAUNCH_MS, network, wiringKit } from "./testing/wiringKit";
import { acceptingVerify } from "./videos/testing/kit";
import { writingRun } from "./videos/testing/serviceKit";
import { within } from "./testing/within";
useNativeGlobals();

// Stage 4, S4.6r (plan §4.6, §32): a render that fails because the export folder went away is not a failed render. The REAL engine (default steps, real queue, commit and recovery; ffmpeg replaced
// by a run that writes its output at once) renders a library-only launch; the export folder is renamed away while a render is running, the launch shows the export hold and drops nothing,
// the folder comes back, and every video finishes.

setDefaultTimeout(LAUNCH_MS + 40_000);

// Registered BEFORE `useEngineDir`: the engine is shut down before its folder is removed.
const running: Array<Awaited<ReturnType<ReturnType<typeof wiringKit>["boot"]>>> = [];
afterEach(async () => {
  for (const started of running.splice(0)) await within(started.engine.shutdown(50), 30_000, "the shutdown at the end of a test").catch(() => undefined);
});
const dir = useEngineDir("studio-engine-render-faults-");
const kit = wiringKit(dir);

type RunOptions = Parameters<typeof writingRun>[0];

/**
 * A render seam whose first TWO renders (the first ffmpeg call while the folder is there) also rename the export folder away, as a drive that is unmounted or a folder the owner moved while a render runs. Twice, so that a video which had
 * used a free retry for the first loss would be dropped by the second: only a loss that is NOT a failed render gets through both.
 */
function vanishingFolder(): { deps: Partial<EngineDeps>; away: () => string; bringBack: () => void; vanished: () => boolean; losses: () => number } {
  const state = { calls: 0, gone: false, losses: 0 };
  const awayPath = (): string => join(dir(), "export-away");
  const run = async (opts: RunOptions): Promise<void> => {
    state.calls += 1;
    if (state.losses < 2 && !state.gone && existsSync(kit.exportDir())) {
      renameSync(kit.exportDir(), awayPath());
      state.gone = true;
      state.losses += 1;
    }
    // The output of pass 1 is in the render's own temp folder, not in the export folder: the render goes on until it looks at the folder again.
    await writingRun(opts);
  };
  return {
    deps: { videos: { renderOverrides: { verify: acceptingVerify, runDeps: { run, measure: async () => -5.7 } } } },
    away: awayPath,
    bringBack: () => {
      renameSync(awayPath(), kit.exportDir());
      state.gone = false;
    },
    vanished: () => state.gone,
    losses: () => state.losses,
  };
}

/** Resolves once no video of the launch is `rendering`: every failed render has been read as a loss and its video is back in the queue. */
async function classified(started: Awaited<ReturnType<typeof kit.boot>>, launchId: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const listed = await kit.getLaunch(started, launchId);
    if (listed.videos.every((video) => video.state !== "rendering")) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("an export folder that vanishes mid-render (S4.6r)", () => {
  test(
    "holds the launch on the folder without dropping a video, again and again, and every video finishes once the folder is back",
    async () => {
      const net = network();
      const avatarId = await kit.seedAvatar(10);
      const folder = vanishingFolder();
      const started = await kit.boot(net, { deps: folder.deps });
      running.push(started);
      const launch = await kit.startLaunch(started, draftOf([avatarId], { library: true, generate: false, planSeed: 7 }));

      for (const loss of [1, 2]) {
        const held = await kit.waitFor(started, launch.launchId, `the export hold of loss ${loss}`, (v) => folder.losses() === loss && folder.vanished() && v.freeHold !== null);
        expect(held.freeHold?.reason).toBe("export");
        expect(held.status).toBe("running");
        const whileHeld = await kit.getLaunch(started, launch.launchId);
        expect(whileHeld.videos.filter((v) => v.state === "dropped")).toEqual([]);
        // Every render that was running has been classified (none is still `rendering`) before the folder is back; the product holds without this wait too (freeSteps.exportOutage.test.ts), it only keeps this test about one thing.
        await within(classified(started, launch.launchId), 30_000, `every render of loss ${loss} to be classified`);
        folder.bringBack();
      }

      await kit.waitFor(started, launch.launchId, "the launch to be done", (v) => v.status === "done");
      const listed = await kit.getLaunch(started, launch.launchId);
      expect(listed.videos.map((v) => [v.state, v.dropReason])).toEqual([
        ["done", null],
        ["done", null],
      ]);
      expect(listed.launch.freeHold).toBeNull();
      expect(existsSync(folder.away())).toBe(false);
      kit.expectVideosOnDisk(await kit.videosOf(started, avatarId), 2);
    },
    LAUNCH_MS + 30_000,
  );
});
