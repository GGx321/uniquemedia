import { describe, expect, test } from "bun:test";
import { MockEngine, mockEngineClient } from "../../engine/mockEngine";
import { ManualScheduler } from "../../engine/scheduler";
import { EngineStore } from "../../engine/store";
import { clipDismissals, clipListStateOf, dismissClipJob, MAX_DISMISSED_CLIP_JOBS } from "./clipsContext";

const storeOf = (): EngineStore => new EngineStore(mockEngineClient(new MockEngine({ scheduler: new ManualScheduler(), latencyMs: 0 })));

describe("the put-away clip job tiles", () => {
  test("a dismissed job stays dismissed for the store's life, and another store knows nothing of it", () => {
    const store = storeOf();
    dismissClipJob(store, "job-1");
    expect(clipDismissals(store).has("job-1")).toBe(true);
    expect(clipDismissals(storeOf()).has("job-1")).toBe(false);
  });

  test("the oldest dismissals are forgotten past the bound, the newest kept", () => {
    const store = storeOf();
    for (let i = 0; i <= MAX_DISMISSED_CLIP_JOBS; i++) dismissClipJob(store, `job-${i}`);
    expect(clipDismissals(store).size).toBe(MAX_DISMISSED_CLIP_JOBS);
    expect(clipDismissals(store).has("job-0")).toBe(false);
    expect(clipDismissals(store).has(`job-${MAX_DISMISSED_CLIP_JOBS}`)).toBe(true);
  });
});

describe("the clip list the window keeps (5b.2, S5.WB2c)", () => {
  const summary = {
    batchId: "batch-00000001",
    avatarId: "avatar-aaaa-0001",
    size: 1,
    createdAt: "2026-10-15T10:00:00.000Z",
    members: [{ batchIndex: 1, outcome: "ready" as const, costMicros: 420_000, costKind: "billed" as const, clipIds: ["clip-0000001"] }],
    endedAt: "2026-10-15T10:02:00.000Z",
    cost: { micros: 420_000, kind: "billed" as const },
  };

  test("keeps the engine's batch summaries beside the clips, as the engine sent them", () => {
    const asked = new Set(["job-1"]);
    const state = clipListStateOf({ clips: [], batches: [summary] }, asked);
    expect(state.batches).toEqual([summary]);
    expect(state.clips).toEqual([]);
    expect(state.readEnded).toBe(asked);
    expect(state.error).toBeNull();
  });

  test("an answer without batches is an avatar with none: an empty list, never a guess", () => {
    expect(clipListStateOf({ clips: [] }, new Set()).batches).toEqual([]);
  });
});
