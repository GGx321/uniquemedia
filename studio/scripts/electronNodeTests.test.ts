import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { useNativeGlobals } from "../testing/nativeGlobals";
import { NODE_TEST_SUITES, nodeTestSummaryProblem } from "./electronNodeTests";
useNativeGlobals();

const ROOT = join(import.meta.dir, "..", "..");

describe("the registered suites", () => {
  test("name test entries and worker sources that exist", () => {
    expect(NODE_TEST_SUITES.length).toBeGreaterThan(0);
    for (const suite of NODE_TEST_SUITES) {
      expect(existsSync(join(ROOT, suite.entry))).toBe(true);
      for (const source of Object.values(suite.workers)) expect(existsSync(join(ROOT, source))).toBe(true);
    }
  });
});

describe("every *.node-test.ts file is registered", () => {
  test("the suites are exactly the node-test files under studio/, so a new one cannot sit there unrun", async () => {
    const onDisk: string[] = [];
    for await (const file of new Bun.Glob("studio/**/*.node-test.{ts,mts,tsx}").scan({ cwd: ROOT, onlyFiles: true })) {
      if (!file.split(/[\\/]/).includes("node_modules")) onDisk.push(file.split("\\").join("/"));
    }
    expect(onDisk.sort()).toEqual(NODE_TEST_SUITES.map((suite) => suite.entry).sort());
  });
});

// The output of `ELECTRON_RUN_AS_NODE=1 electron --test <file>` (Electron 43), recorded from real runs.
const SUMMARY_TAIL = (counts: { tests: number; suites: number; pass: number; skipped?: number; todo?: number }): string =>
  [`ℹ tests ${counts.tests}`, `ℹ suites ${counts.suites}`, `ℹ pass ${counts.pass}`, "ℹ fail 0", "ℹ cancelled 0", `ℹ skipped ${counts.skipped ?? 0}`, `ℹ todo ${counts.todo ?? 0}`, "ℹ duration_ms 86.01"].join("\n");
const REAL_RUN = ["▶ the real worker under Electron's Node", "  ✔ draws the string (80.3ms)", "  ✔ measures (40.9ms)", "✔ the real worker under Electron's Node (1846.2ms)", SUMMARY_TAIL({ tests: 2, suites: 1, pass: 2 })].join("\n");
const NO_TESTS = ["✔ /tmp/none.mjs (89.3ms)", SUMMARY_TAIL({ tests: 1, suites: 0, pass: 1 })].join("\n");
const DESCRIBE_SKIP = ["﹣ s (0.33ms) # SKIP", SUMMARY_TAIL({ tests: 0, suites: 1, pass: 0 })].join("\n");
const WITH_TODO = ["▶ s", "  ✔ a (0.6ms)", "  ✔ b (0.06ms) # TODO", "✔ s (1.2ms)", SUMMARY_TAIL({ tests: 2, suites: 1, pass: 1, todo: 1 })].join("\n");

describe("nodeTestSummaryProblem: `electron --test` exits 0 for runs that tested nothing", () => {

  test("refuses a run with fewer tests than the suite's minimum, and accepts the minimum and more", () => {
    expect(nodeTestSummaryProblem(SUMMARY_TAIL({ tests: 9, suites: 1, pass: 9 }), 10)).toMatch(/9 tests, fewer than the 10/);
    expect(nodeTestSummaryProblem(SUMMARY_TAIL({ tests: 10, suites: 1, pass: 10 }), 10)).toBeUndefined();
    expect(nodeTestSummaryProblem(SUMMARY_TAIL({ tests: 12, suites: 1, pass: 12 }), 10)).toBeUndefined();
  });

  test("every registered suite states a positive minimum", () => {
    for (const suite of NODE_TEST_SUITES) expect(suite.minTests).toBeGreaterThan(0);
    // CI-4 moved the deadline headroom out of the text worker's blocking count and added a plain "the worst shadow caption renders" test (10 -> 10);
    // the event-loop gap tests stay blocking, with a wide criterion, and also run in the perf tier with the tight one.
    expect(Object.fromEntries(NODE_TEST_SUITES.map((suite) => [suite.name, suite.minTests]))).toEqual({ "text worker": 10, "face worker": 18, "caption rules": 64, "caption worker": 8, "export name claim": 8 });
  });

  test("the perf tier's counts: what each suite runs when STUDIO_TEST_TIER=perf", () => {
    expect(Object.fromEntries(NODE_TEST_SUITES.filter((suite) => suite.tierTests?.perf !== undefined).map((suite) => [suite.name, suite.tierTests?.perf]))).toEqual({
      "text worker": 3,
      "face worker": 1,
      "caption rules": 9,
      "caption worker": 1,
    });
  });
});
