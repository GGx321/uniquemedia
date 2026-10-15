import { describe, expect, test } from "bun:test";
import { MockEngine, mockEngineClient } from "../../engine/mockEngine";
import { ManualScheduler } from "../../engine/scheduler";
import { EngineStore } from "../../engine/store";
import { CLOSED_BATCHES_KEY, clipDismissals, clipListStateOf, closeBatch, closedBatches, dismissClipJob, MAX_CLOSED_BATCHES, MAX_DISMISSED_CLIP_JOBS } from "./clipsContext";

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

describe("the batch headers the owner closed (5b.2, S5.WB4b review L10: a per-viewer convenience, kept on this machine)", () => {
  const memory = (): { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void; raw: Map<string, string> } => {
    const raw = new Map<string, string>();
    return { raw, getItem: (key) => raw.get(key) ?? null, setItem: (key, value) => void raw.set(key, value) };
  };
  const broken = { getItem: (): string | null => { throw new Error("denied"); }, setItem: (): void => { throw new Error("denied"); } };

  test("a closed batch stays closed for the next window on this machine", () => {
    const storage = memory();
    closeBatch(storage, "batch-0000001");
    expect(closedBatches(storage).has("batch-0000001")).toBe(true);
    expect(closedBatches(storage).has("batch-0000002")).toBe(false);
  });

  test("only the newest closed batches are kept", () => {
    const storage = memory();
    for (let i = 0; i <= MAX_CLOSED_BATCHES; i++) closeBatch(storage, `batch-${i}`);
    expect(closedBatches(storage).size).toBe(MAX_CLOSED_BATCHES);
    expect(closedBatches(storage).has("batch-0")).toBe(false);
    expect(closedBatches(storage).has(`batch-${MAX_CLOSED_BATCHES}`)).toBe(true);
  });

  test("a storage that refuses, or holds something else, closes nothing and throws nothing", () => {
    expect(() => closeBatch(broken, "batch-0000001")).not.toThrow();
    expect(closedBatches(broken).size).toBe(0);
    const storage = memory();
    storage.raw.set(CLOSED_BATCHES_KEY, "{not json");
    expect(closedBatches(storage).size).toBe(0);
    storage.raw.set(CLOSED_BATCHES_KEY, JSON.stringify(["batch-1", 7, null, { a: 1 }]));
    expect([...closedBatches(storage)]).toEqual(["batch-1"]);
    expect(closedBatches(null).size).toBe(0);
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
