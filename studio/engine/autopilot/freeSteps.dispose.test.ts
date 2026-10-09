import { describe, expect, test } from "bun:test";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { until } from "../testing/engineHarness";
import { within } from "../testing/within";
import type { RenderLife } from "./freeSteps";
import { rig, settleFor, useRigCleanup, videosOf } from "./testing/freeRig";
useNativeGlobals();
useRigCleanup();

// S4.6w: `FreeSteps.dispose()` is what the engine's shutdown calls. A render that never reports its end leaves the run polling for it for ever, on a timer that is not unref'd (a drain waits on
// it); dispose ends every run, whatever it still has in flight, and the run's loop with it.

/** A rig whose renders never end, with a count of how often the steps asked where one stands. */
function hungRig() {
  let looks = 0;
  let lifeOf: (jobId: string) => RenderLife = () => "gone";
  const r = rig({
    draft: { videosPerAvatar: 1 },
    auto: false,
    deps: {
      renderLife: (jobId) => {
        looks += 1;
        return lifeOf(jobId);
      },
    },
  });
  lifeOf = r.videos.lifeOf;
  return { r, looks: () => looks };
}

describe("FreeSteps.dispose", () => {
  test("ends the loop of a run that waits on a render that never ends: nobody asks where the render stands any more", async () => {
    const { r, looks } = hungRig();
    r.start();
    await until(() => r.videos.unfinished() === 1, "a render to be in flight");
    await until(() => looks() > 3, "the run to be polling");

    r.steps.dispose();
    await settleFor(30);
    const after = looks();
    await settleFor(60);

    expect(looks()).toBe(after);
  });

  test("reports nothing in flight once disposed, so the core's drain has nothing to wait for", async () => {
    const { r } = hungRig();
    r.start();
    await until(() => r.videos.unfinished() === 1, "a render to be in flight");
    expect(r.steps.inFlight().renders).toBe(1);

    r.steps.dispose();

    expect(r.steps.inFlight().renders).toBe(0);
  });

  test("lets a drain that was waiting on the render end", async () => {
    const { r } = hungRig();
    r.start();
    await until(() => r.videos.unfinished() === 1, "a render to be in flight");
    const drained = r.steps.drain();

    r.steps.dispose();

    await within(drained, 4_000, "the drain after dispose");
  });

  test("starts nothing afterwards: a begin of a disposed set of steps submits no render", async () => {
    const r = rig({ draft: { videosPerAvatar: 1 }, auto: false });
    r.steps.dispose();
    r.start();
    await settleFor(80);
    expect(r.videos.calls).toHaveLength(0);
    expect(videosOf(r.launch)[0]?.state).toBe("planned");
  });

  test("is safe to call twice, and with nothing begun", () => {
    const r = rig({ auto: false });
    r.steps.dispose();
    r.steps.dispose();
    expect(r.steps.inFlight()).toEqual({ requests: 0, renders: 0 });
  });
});
