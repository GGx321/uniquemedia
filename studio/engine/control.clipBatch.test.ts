import { describe, expect, test } from "bun:test";
import { CLIP_PLAN_READ_PARALLEL, CLIP_PLAN_READ_TIMEOUT_MS, COMMAND_DEADLINE_MS } from "./control";
import { PRICE_FETCH_TIMEOUT_MS } from "./money/prices";
import { LIVE_LIBRARY_IDENTITY_TIMEOUT_MS } from "./videos/timeouts";
import { MAX_BATCH_CLIPS } from "../shared/engine/clips";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// Stage 5, 5b.2, S5.WB1 (plan s5b2 §5.2.1, r2 change L4): a batch reads its photos' run plans four at a time, so its deadline counts ⌈N / 4⌉ plan reads, not N. `clips.createBatch` adds one second per item.
// The 30 s slack is the engine's own (control.ts keeps it private; clips.create's test spells it out the same way).

describe("COMMAND_DEADLINE_MS for the batch commands", () => {
  const PARALLEL_READS = Math.ceil(MAX_BATCH_CLIPS / CLIP_PLAN_READ_PARALLEL);
  const base = PRICE_FETCH_TIMEOUT_MS + LIVE_LIBRARY_IDENTITY_TIMEOUT_MS;

  test("the plan reads run four at a time", () => {
    expect(CLIP_PLAN_READ_PARALLEL).toBe(4);
  });

  test("clips.batchOptions waits for a price load, the library's identity, ⌈20 / 4⌉ plan reads and the slack", () => {
    expect(COMMAND_DEADLINE_MS["clips.batchOptions"]).toBe(base + PARALLEL_READS * CLIP_PLAN_READ_TIMEOUT_MS + 30_000);
  });

  test("the deadline counts the parallel reads: below twenty serial ones, above four rounds", () => {
    const deadline = COMMAND_DEADLINE_MS["clips.batchOptions"] ?? 0;
    expect(deadline).toBeLessThan(base + MAX_BATCH_CLIPS * CLIP_PLAN_READ_TIMEOUT_MS);
    expect(deadline).toBeGreaterThan(base + (PARALLEL_READS - 1) * CLIP_PLAN_READ_TIMEOUT_MS + 30_000);
  });

  test("clips.createBatch is the same plus one second per item, for twenty items", () => {
    expect(COMMAND_DEADLINE_MS["clips.createBatch"]).toBe((COMMAND_DEADLINE_MS["clips.batchOptions"] ?? 0) + MAX_BATCH_CLIPS * 1_000);
  });

  test("clips.createBatch outwaits clips.create, so a batch start is never given up on before a single clip's", () => {
    expect(COMMAND_DEADLINE_MS["clips.createBatch"] ?? 0).toBeGreaterThan(COMMAND_DEADLINE_MS["clips.create"] ?? Infinity);
  });

  test("clips.cancelBatch only cancels queued members, for free, and keeps main's default", () => {
    expect(COMMAND_DEADLINE_MS["clips.cancelBatch"]).toBeUndefined();
  });
});
