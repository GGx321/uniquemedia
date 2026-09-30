import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useNativeGlobals } from "../testing/nativeGlobals";
import { buildSuite, electronNodeArgs, electronNodeEnv, NODE_TEST_SUITES, nodeTestSummaryProblem } from "./electronNodeTests";
useNativeGlobals();

const ROOT = join(import.meta.dir, "..", "..");
const scratch: string[] = [];
afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("the registered suites", () => {
  test("name test entries and worker sources that exist", () => {
    expect(NODE_TEST_SUITES.length).toBeGreaterThan(0);
    for (const suite of NODE_TEST_SUITES) {
      expect(existsSync(join(ROOT, suite.entry))).toBe(true);
      for (const source of Object.values(suite.workers)) expect(existsSync(join(ROOT, source))).toBe(true);
    }
  });

  test("keep their entries out of `bun test`, which would load node:test files and crash on the real workers", () => {
    for (const suite of NODE_TEST_SUITES) expect(suite.entry).toMatch(/\.node-test\.(?:ts|mts|tsx)$/);
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
  test("accepts a run with tests, all passed, none skipped", () => {
    expect(nodeTestSummaryProblem(REAL_RUN)).toBeUndefined();
  });

  test("accepts the summary in colour too", () => {
    expect(nodeTestSummaryProblem(REAL_RUN.replaceAll("ℹ", "\u001b[34mℹ\u001b[39m"))).toBeUndefined();
  });

  test("refuses a file that registers no test: node counts the file as the one test", () => {
    expect(nodeTestSummaryProblem(NO_TESTS)).toMatch(/registered no tests/);
  });

  test("refuses zero tests", () => {
    expect(nodeTestSummaryProblem(SUMMARY_TAIL({ tests: 0, suites: 0, pass: 0 }))).toMatch(/0 tests/);
  });

  test("refuses a `describe.skip` run, which reports zero tests and zero skipped", () => {
    expect(nodeTestSummaryProblem(DESCRIBE_SKIP)).toMatch(/SKIP/);
    expect(nodeTestSummaryProblem(SUMMARY_TAIL({ tests: 0, suites: 1, pass: 0 }))).toMatch(/0 tests/);
  });

  test("refuses a skipped test in the counts, even when no line is marked", () => {
    expect(nodeTestSummaryProblem(`✔ a (1ms)\n${SUMMARY_TAIL({ tests: 2, suites: 0, pass: 1, skipped: 1 })}`)).toMatch(/skipped 1 and/);
  });

  test("refuses a todo test", () => {
    expect(nodeTestSummaryProblem(WITH_TODO)).toMatch(/SKIP or TODO/);
    expect(nodeTestSummaryProblem(SUMMARY_TAIL({ tests: 2, suites: 0, pass: 1, todo: 1 }))).toMatch(/left 1 as todo/);
  });

  test("refuses a run with fewer tests than the suite's minimum, and accepts the minimum and more", () => {
    expect(nodeTestSummaryProblem(SUMMARY_TAIL({ tests: 9, suites: 1, pass: 9 }), 10)).toMatch(/9 tests, fewer than the 10/);
    expect(nodeTestSummaryProblem(SUMMARY_TAIL({ tests: 10, suites: 1, pass: 10 }), 10)).toBeUndefined();
    expect(nodeTestSummaryProblem(SUMMARY_TAIL({ tests: 12, suites: 1, pass: 12 }), 10)).toBeUndefined();
  });

  test("checks the minimum against the LAST `ℹ tests`", () => {
    const logged = "ℹ tests 99";
    expect(nodeTestSummaryProblem(`${logged}\n${SUMMARY_TAIL({ tests: 3, suites: 1, pass: 3 })}`, 10)).toMatch(/3 tests, fewer than the 10/);
  });

  test("every registered suite states a positive minimum", () => {
    for (const suite of NODE_TEST_SUITES) expect(suite.minTests).toBeGreaterThan(0);
    expect(Object.fromEntries(NODE_TEST_SUITES.map((suite) => [suite.name, suite.minTests]))).toEqual({ "text worker": 10, "face worker": 18 });
  });

  test("refuses fewer passes than tests (a cancelled test)", () => {
    expect(nodeTestSummaryProblem(SUMMARY_TAIL({ tests: 3, suites: 0, pass: 2 }))).toMatch(/2 tests passed of 3/);
  });

  test("refuses an output with no summary at all, so a change of reporter fails loudly", () => {
    expect(nodeTestSummaryProblem("ok 1 - a\n1..1\n")).toMatch(/no `ℹ tests N` summary/);
    expect(nodeTestSummaryProblem("")).toMatch(/no `ℹ tests N` summary/);
  });

  test("reads the LAST summary: a test that logs a line shaped like one cannot stand in for the run's", () => {
    const logged = ["ℹ tests 9", "ℹ pass 9", "ℹ skipped 0", "ℹ todo 0"].join("\n");
    expect(nodeTestSummaryProblem(`${logged}\n${REAL_RUN}`)).toBeUndefined();
    // A fake all-green line first, the real (failing) summary last: the real one decides.
    expect(nodeTestSummaryProblem(`${logged}\n${SUMMARY_TAIL({ tests: 3, suites: 0, pass: 2 })}`)).toMatch(/2 tests passed of 3/);
    expect(nodeTestSummaryProblem(`${logged}\n${SUMMARY_TAIL({ tests: 0, suites: 0, pass: 0 })}`)).toMatch(/0 tests/);
  });

  test("refuses a file that registers no test even when its path holds spaces", () => {
    const spaced = ["✔ /Users/some one/My Projects/tmp dir/none.mjs (89.3ms)", SUMMARY_TAIL({ tests: 1, suites: 0, pass: 1 })].join("\n");
    expect(nodeTestSummaryProblem(spaced)).toMatch(/registered no tests/);
    const windows = ["✔ C:\\Users\\some one\\AppData\\Local\\Temp\\none.mjs (89.3ms)", SUMMARY_TAIL({ tests: 1, suites: 0, pass: 1 })].join("\n");
    expect(nodeTestSummaryProblem(windows)).toMatch(/registered no tests/);
  });

  test("does not take a nested test whose title merely ends in a file name for a file with no tests", () => {
    expect(nodeTestSummaryProblem(REAL_RUN.replace("draws the string", "loads app.js"))).toBeUndefined();
  });

  test("does not take a test named 'tests 5' inside the output for the summary", () => {
    expect(nodeTestSummaryProblem("  ✔ ℹ tests 5 is a test name (1ms)")).toMatch(/no `ℹ tests N` summary/);
  });
});

describe("electronNodeEnv", () => {
  test("makes the Electron binary act as plain Node and says where the repo is", () => {
    const env = electronNodeEnv({ PATH: "/bin", HOME: "/h" }, "/repo");
    expect(env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(env.STUDIO_ROOT).toBe("/repo");
    expect(env.PATH).toBe("/bin");
  });

  test("drops NODE_OPTIONS, so a debugger or a loader of the caller cannot change the run", () => {
    expect(electronNodeEnv({ NODE_OPTIONS: "--inspect" }, "/repo").NODE_OPTIONS).toBeUndefined();
  });

  test("does not pass on undefined values", () => {
    const env = electronNodeEnv({ PATH: undefined }, "/repo");
    expect("PATH" in env).toBe(false);
  });
});

describe("electronNodeArgs", () => {
  test("runs node's own test runner on the bundle, with the spec reporter the summary check reads named explicitly", () => {
    expect(electronNodeArgs("/out/x.mjs")).toEqual(["--test", "--test-reporter=spec", "/out/x.mjs"]);
  });
});

describe("buildSuite", () => {
  test("bundles the test and each worker for Node, with no bun:* import left", async () => {
    const suite = NODE_TEST_SUITES[0];
    if (suite === undefined) throw new Error("no suite");
    const out = await mkdtemp(join(tmpdir(), "studio-node-tests-"));
    scratch.push(out);
    const bundle = await buildSuite(ROOT, suite, out);
    expect(existsSync(bundle)).toBe(true);
    const files = await readdir(out);
    for (const worker of Object.keys(suite.workers)) expect(files).toContain(worker);
    for (const file of files) expect(await readFile(join(out, file), "utf8")).not.toMatch(/from\s*["']bun:/);
  });

  test("names the bundle after the entry for a .mts or .tsx entry too", async () => {
    const out = await mkdtemp(join(tmpdir(), "studio-node-tests-"));
    scratch.push(out);
    const src = await mkdtemp(join(tmpdir(), "studio-node-entry-"));
    scratch.push(src);
    await Bun.write(join(src, "x.node-test.mts"), "export const answer: number = 42;\n");
    const bundle = await buildSuite(ROOT, { name: "x", entry: join(src, "x.node-test.mts"), minTests: 1, workers: {} }, out);
    expect(bundle).toBe(join(out, "x.node-test.mjs"));
    expect(existsSync(bundle)).toBe(true);
  });

  test("fails loudly when an entry does not exist", async () => {
    const out = await mkdtemp(join(tmpdir(), "studio-node-tests-"));
    scratch.push(out);
    await expect(buildSuite(ROOT, { name: "x", entry: "studio/nope.node-test.ts", minTests: 1, workers: {} }, out)).rejects.toThrow();
  });
});
