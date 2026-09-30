import { afterAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { useEngineDir } from "../testing/engineHarness";
import { GOLDEN } from "./testing/golden";
import { goldenSource } from "./testing/goldenFile";
import { play } from "./testing/play";
import { mockRig, realRig } from "./testing/rigs";
import { SCENARIOS } from "./testing/scenarios";
import { INTENTIONAL_DIFFERENCES, MASKED } from "./testing/transcript";
useNativeGlobals();

// Mock parity (Stage 3, 3d.1b): the same story played against the mock engine and against the real one, and the two
// transcripts (every command, every answer, every event, in order) must be equal line for line. `golden.ts` holds the
// transcript each scenario is bound to, so a change that moves BOTH engines the same way is still seen. What differs on
// purpose is in transcript.ts (`MASKED`, `INTENTIONAL_DIFFERENCES`) and nowhere else.
//
// PARITY_WRITE_GOLDEN=1 rewrites golden.ts from the transcripts (after requiring the two engines to agree): see golden.ts.

const dir = useEngineDir("studio-parity-");
const REAL_TIMEOUT_MS = 60_000;
const WRITE_GOLDEN = process.env.PARITY_WRITE_GOLDEN === "1";
const written: Record<string, string[]> = {};

afterAll(() => {
  if (WRITE_GOLDEN) writeFileSync(new URL("./testing/golden.ts", import.meta.url), goldenSource(written));
});

describe("mock and engine agree", () => {
  for (const scenario of SCENARIOS) {
    test(
      scenario.name,
      async () => {
        const mock = await play(mockRig(scenario.rig), scenario);
        const real = await play(await realRig(dir(), scenario.rig), scenario);

        expect(real).toEqual(mock);
        if (WRITE_GOLDEN) written[scenario.name] = mock;
        else expect(mock).toEqual(GOLDEN[scenario.name] ?? ["<no golden transcript>"]);
      },
      REAL_TIMEOUT_MS,
    );
  }
});

describe("the suite itself", () => {
  test("every scenario has a golden transcript and every golden transcript a scenario", () => {
    if (WRITE_GOLDEN) return;
    expect(Object.keys(GOLDEN).sort()).toEqual(SCENARIOS.map((s) => s.name).sort());
  });

  test("names the differences it allows: each masked field with its reason, and each rule", () => {
    expect(Object.keys(MASKED).sort()).toEqual(["bytes", "createdAt", "seed", "updatedAt"]);
    expect(Object.values(MASKED).every((reason) => reason.length > 20)).toBe(true);
    expect(INTENTIONAL_DIFFERENCES.length).toBeGreaterThanOrEqual(5);
  });
});
