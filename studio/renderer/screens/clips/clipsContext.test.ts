import { describe, expect, test } from "bun:test";
import { MockEngine, mockEngineClient } from "../../engine/mockEngine";
import { ManualScheduler } from "../../engine/scheduler";
import { EngineStore } from "../../engine/store";
import { clipDismissals, dismissClipJob, MAX_DISMISSED_CLIP_JOBS } from "./clipsContext";

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
