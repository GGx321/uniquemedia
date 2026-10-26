import { describe, expect, test } from "bun:test";
import { categoryLabelOf } from "../scenes/categories";
import { plannedWriterConfig } from "./writerPhase";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5a.4 (S5.BA5 round 2, money review L-2): the planned writer's `impliedNudity` (the avatar's origin: the coverage the bold reader appends and the plain sentence ends with) is a
// REQUIRED argument, so a path that has not decided the origin does not compile. Checked by `typecheck:studio`: an `@ts-expect-error` over a line that compiles is itself an error.

describe("plannedWriterConfig", () => {
  test("names the avatar's origin, required", () => {
    // @ts-expect-error the origin is required: a caller with none to hand says false (an avatar read as imported)
    const silent = plannedWriterConfig(categoryLabelOf([]));
    expect(silent.call).toEqual(plannedWriterConfig(categoryLabelOf([]), false).call);
  });
});
