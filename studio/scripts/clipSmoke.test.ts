import { describe, expect, test } from "bun:test";
import { clipPostProblems } from "./clipSmoke";
import { useNativeGlobals } from "../testing/nativeGlobals";

useNativeGlobals();

// Stage 5, 5b.1, S5.V7: what the packaged smoke checks of a clip, as functions with no Electron in them. The smoke only has to call them with what its mock OpenRouter and the app reported; the engine
// itself is held against the same mock by clipSmoke.engine.test.ts.

const KLING = "kwaivgi/kling-v3.0-std";

describe("clipPostProblems: one POST per attempt id, never resent", () => {
  test("names a POST sent twice for one attempt: more requests than attempt ids", () => {
    const problems = clipPostProblems([{ model: KLING }, { model: KLING }], ["job-1:video#1"], [KLING]);
    expect(problems).toEqual(["2 POST /videos left for 1 attempt ids: a POST is sent once per attempt"]);
  });
});
