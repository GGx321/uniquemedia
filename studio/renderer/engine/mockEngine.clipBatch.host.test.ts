import { describe, expect, test } from "bun:test";
import { clipAlone } from "../../shared/engine/clipAlone";
import { REAL_CLIP_TIMINGS, SHORT_CLIP_TIMINGS } from "../../engine/clips/timings";
import { QUIT_LEAVE_LABEL, type QuitDialogSpec } from "../../main/autopilotHost";
import { ClipHost, clipBatchQuitDialog } from "../../main/clipHost";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { MOCK_CLIP_TIMINGS } from "./mockClips";
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

  test("a batch that ended is not asked about, and the mock counts nothing", async () => {
    const m = makeBatchMock(2);
    const { host, asked } = hostOver(m);
    const { jobIds } = await startBatch(m, m.photoIds);
    runUntilEnds(m, jobIds);
    expect(await host.confirmQuit()).toBe(true);
    expect(asked).toEqual([]);
    expect(m.engine.peekClips().quit).toEqual({ inFlight: 0, queued: 0 });
  });

  test("a member in its `preparing` counts with the queue, not with the clips in flight", async () => {
    const m = makeBatchMock(3);
    const { host, asked } = hostOver(m);
    const { jobIds } = await startBatch(m, m.photoIds);
    stepUntil(m, () => phasesOf(m.events, jobIds[1] ?? "").includes("preparing"), "member 2 preparing");
    await host.confirmQuit();
    // Member 1 is downloading (free), member 2 is preparing and member 3 is queued: two members are still to be made, none can bill.
    expect(m.engine.peekClips().quit).toEqual({ inFlight: 0, queued: 2 });
    expect(asked.at(-1)).toEqual(clipBatchQuitDialog(0, 2));
    expect(asked.at(-1)?.buttons).toContain(QUIT_LEAVE_LABEL);
    runUntilEnds(m, jobIds);
  });
});

describe("the timings", () => {
  test("the batch's two figures are the engine's in the real, short and demo sets", () => {
    expect([MOCK_CLIP_TIMINGS.real.aloneWaitMs, MOCK_CLIP_TIMINGS.real.rateLimitPauseMs]).toEqual([REAL_CLIP_TIMINGS.aloneWaitMs, REAL_CLIP_TIMINGS.rateLimitPauseMs]);
    expect([MOCK_CLIP_TIMINGS.short.aloneWaitMs, MOCK_CLIP_TIMINGS.short.rateLimitPauseMs]).toEqual([SHORT_CLIP_TIMINGS.aloneWaitMs, SHORT_CLIP_TIMINGS.rateLimitPauseMs]);
    expect(MOCK_CLIP_TIMINGS.demo.aloneWaitMs).toBe(REAL_CLIP_TIMINGS.aloneWaitMs / 20);
    expect(MOCK_CLIP_TIMINGS.demo.rateLimitPauseMs).toBe(REAL_CLIP_TIMINGS.rateLimitPauseMs / 20);
  });
});

describe("one alone rule", () => {
  test("the mock reads the engine's `clipAlone` itself: imported from shared/, never written out again", async () => {
    const source = await Bun.file(new URL("./mockClips.ts", import.meta.url)).text();
    expect(source).toContain(`import { clipAlone } from "../../shared/engine/clipAlone";`);
    // The rule's own words (the open reserves of other attempts, the live holds that are not a completed exact settle) live in the shared function alone.
    expect(source).not.toContain("closeOf(");
    expect(typeof clipAlone).toBe("function");
  });

  test("the question the batch asks for a member that has not reserved yet excludes nothing: foreign money is foreign money", () => {
    const ledger = { openReserves: () => [{ attemptId: "photo-run:slot-1#1" }], closeOf: () => undefined };
    const holds = { entries: () => new Map<string, number>(), isCompleted: () => false };
    expect(clipAlone({ ledger, holds, attemptId: "clip-0001:video#1", nowMs: 0 })).toBe(false);
  });
});
