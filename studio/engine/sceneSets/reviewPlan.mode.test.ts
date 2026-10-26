import { describe, expect, test } from "bun:test";
import type { StoredSceneSet } from "../library/sceneSets";
import { sampleSet } from "../library/testing/sceneSetSample";
import { recordedWriteOf } from "./reviewPlan";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5a.4 (S5.BA5 round 2, money review L-1): what a review write is priced as, read off the record the write would leave. A record that is not found (it cannot be, a write's `begin`
// always records it) falls to the safe side: every scene for the model, in bold mode, never a price below the reserve the job could make.

const stored = (): StoredSceneSet => ({ schemaVersion: 1, revision: 1, createdAt: "2026-10-26T10:00:00.000Z", updatedAt: "2026-10-26T10:00:00.000Z", ...sampleSet({ count: 4 }) });

describe("recordedWriteOf", () => {
  test("a write the set does not record is priced as its every scene for the model, in bold mode", () => {
    expect(recordedWriteOf(stored(), 7, 3)).toEqual({ modelScenes: 3, mode: "bold" });
  });
});
