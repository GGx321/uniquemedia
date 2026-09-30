import { describe, expect, test } from "bun:test";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { useEngineDir } from "../testing/engineHarness";
import { GOLDEN } from "./testing/golden";
import { play } from "./testing/play";
import { mockRig, realRig } from "./testing/rigs";
import { SCENARIOS } from "./testing/scenarios";
import { INTENTIONAL_DIFFERENCES, MASKED } from "./testing/transcript";
useNativeGlobals();

// Mock parity (Stage 3, 3d.1b): the same story played against the mock engine and against the real one, and the two
// transcripts (every command, every answer, every event, in order) must be equal line for line. `golden.ts` holds the
// transcript each scenario is bound to, so a change that moves BOTH engines the same way is still seen. What differs on
// purpose is in transcript.ts (`MASKED`, `INTENTIONAL_DIFFERENCES`) and nowhere else.

const dir = useEngineDir("studio-parity-");
const REAL_TIMEOUT_MS = 60_000;

describe("mock and engine agree", () => {
  for (const scenario of SCENARIOS) {
    test(
      scenario.name,
      async () => {
        const mock = await play(mockRig(), scenario);
        const real = await play(await realRig(dir()), scenario);

        expect(real).toEqual(mock);
        expect(mock).toEqual(GOLDEN[scenario.name] ?? ["<no golden transcript>"]);
      },
      REAL_TIMEOUT_MS,
    );
  }
});

describe("the suite itself", () => {
  test("every scenario has a golden transcript and every golden transcript a scenario", () => {
    expect(Object.keys(GOLDEN).sort()).toEqual(SCENARIOS.map((s) => s.name).sort());
  });

  test("names the differences it allows: each masked field with its reason, and each rule", () => {
    expect(Object.keys(MASKED).sort()).toEqual(["bytes", "createdAt", "seed", "updatedAt"]);
    expect(Object.values(MASKED).every((reason) => reason.length > 20)).toBe(true);
    expect(INTENTIONAL_DIFFERENCES.length).toBeGreaterThanOrEqual(5);
  });
});
