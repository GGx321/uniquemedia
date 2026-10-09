import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { FREE_POLL_TIMER } from "./autopilot/freeSteps";
import { useEngineDir } from "./testing/engineHarness";
import { watchTimers } from "./testing/timerWatch";
import { draftOf, network, wiringKit } from "./testing/wiringKit";
import { within } from "./testing/within";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// Stage 4, S4.6w: the engine's shutdown ends the free steps' runs. A render that never reports its end (a hung ffmpeg, a queue that lost a job) leaves the free run polling for it, and its sleep
// is a timer that is not unref'd (a drain waits on it): in the utilityProcess it would keep the process alive after the engine said it was done.

setDefaultTimeout(60_000);

const dir = useEngineDir("studio-engine-autopilot-shutdown-");
const kit = wiringKit(dir);

describe("Engine.shutdown and the free steps", () => {
  test("a shutdown with a render that never ends leaves no poll timer of the free steps pending", async () => {
    const watch = watchTimers();
    try {
      const avatarId = await kit.seedAvatar(5);
      const hang = new Promise<void>(() => undefined);
      const started = await kit.boot(network(), { deps: { videos: { renderOverrides: { runDeps: { run: () => hang } } } } });
      const launch = await kit.startLaunch(started, draftOf([avatarId], { library: true, generate: false, videosPerAvatar: 1 }));
      await kit.waitFor(started, launch.launchId, "the render to be running", () => started.engine.renders.states().some((s) => s.kind === "render" && s.launchId === launch.launchId && s.status === "running"), 30_000);
      // The free run is waiting for a render that will not end: it sleeps, one poll at a time.
      expect(watch.pendingNamed([FREE_POLL_TIMER])).toBeGreaterThan(0);

      await within(started.engine.shutdown(50), 20_000, "Engine.shutdown");
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(watch.pendingNamed([FREE_POLL_TIMER])).toBe(0);
    } finally {
      watch.restore();
    }
  });
});
