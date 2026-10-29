import { describe, expect, test } from "bun:test";
import { type QuitDialogSpec } from "../../main/autopilotHost";
import { ClipHost, clipBatchQuitDialog } from "../../main/clipHost";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { makeBatchMock, phasesOf, runUntilEnds, startBatch, stepUntil } from "./mockEngine.clipBatch.testkit";
useNativeGlobals();

// Stage 5, 5b.2, S5.WB3: where the mock is held to the engine's own code, not to a number copied from it. The quit counts of 45b are main's `ClipHost` fed with the mock's own events; the timings are the engine's
// two new figures in every set; and the alone-wait reads the engine's `clipAlone` itself (one rule, imported, never copied).

describe("the quit question (45b), the engine's host fed with the mock's events", () => {
  function hostOver(m: ReturnType<typeof makeBatchMock>) {
    const asked: QuitDialogSpec[] = [];
    const host = new ClipHost({
      blocker: { start: () => 1, stop: () => undefined },
      dialog: {
        ask: async (spec) => {
          asked.push(spec);
          return 0;
        },
      },
    });
    m.client.subscribe((event) => host.observe(event));
    return { host, asked };
  }

  test("asks what the mock counts: the clips in flight and the members still queued", async () => {
    const m = makeBatchMock(4);
    const { host, asked } = hostOver(m);
    const { jobIds } = await startBatch(m, m.photoIds);

    // Only the queue: nothing was sent, nothing can bill.
    await host.confirmQuit();
    expect(m.engine.peekClips().quit).toEqual({ inFlight: 0, queued: 4 });
    expect(asked.at(-1)).toEqual(clipBatchQuitDialog(0, 4));

    stepUntil(m, () => phasesOf(m.events, jobIds[0] ?? "").includes("rendering"), "member 1 rendering");
    await host.confirmQuit();
    expect(m.engine.peekClips().quit).toEqual({ inFlight: 1, queued: 3 });
    expect(asked.at(-1)).toEqual(clipBatchQuitDialog(1, 3));
    runUntilEnds(m, jobIds);
  });

});

