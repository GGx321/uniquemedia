import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ATTEMPT_TIMEOUT_MS,
  childEnv,
  isBunCrashOnly,
  listTestFiles,
  MAX_ATTEMPTS,
  commandLineLength,
  DEFAULT_TEST_TIMEOUT_MS,
  runOnce,
  runShards,
  runWithCrashRetry,
  selectShard,
  shardedTestArgs,
  WINDOWS_COMMAND_LINE_LIMIT,
  shardFiles,
  SLOW_TEST_WARNING_MS,
  slowTests,
  slowTestWarnings,
  testTarget,
  tierRunMatchedNothing,
  tierTestArgs,
  WORKER_TEARDOWN_CRASHES,
  withDefaultTimeout,
} from "./realWorkerTests";
import { useNativeGlobals } from "../testing/nativeGlobals";
import { NODE_TEST_SUITES, SUITE_TIMEOUT_MS } from "./electronNodeTests";
useNativeGlobals();

/** The `scripts` of a package.json, read without a cast: anything that is not an object of strings throws. */
function scriptsOf(pkg: unknown): Record<string, string> {
  if (typeof pkg !== "object" || pkg === null || !("scripts" in pkg)) throw new Error("package.json has no scripts");
  const { scripts } = pkg;
  if (typeof scripts !== "object" || scripts === null) throw new Error("package.json scripts is not an object");
  const result: Record<string, string> = {};
  for (const [name, command] of Object.entries(scripts)) {
    if (typeof command !== "string") throw new Error(`package.json script ${name} is not a string`);
    result[name] = command;
  }
  return result;
}

// The suite runs through studio/scripts/realWorkerTests.ts because Bun itself
// segfaults in a few percent of runs while it tears down a worker running WASM.
// The runner retries ONLY on that crash signature, and never when a test
// actually failed — a real failure must never be retried into a pass.

const CRASH = [
  "bun test v1.3.12",
  "(pass) the real face worker > one",
  "panic: Segmentation fault at address 0x18",
  "oh no: Bun has crashed. This indicates a bug in Bun, not your code.",
].join("\n");

describe("isBunCrashOnly", () => {
  test("is true for a Bun crash with no failed test", () => {
    expect(isBunCrashOnly(CRASH)).toBe(true);
  });

  test("is true when only the segfault line is present", () => {
    expect(isBunCrashOnly("panic: Segmentation fault at address 0x8")).toBe(true);
  });

  test("is false when a test failed, even if Bun also crashed afterwards", () => {
    expect(isBunCrashOnly(`(fail) the real face worker > two\n${CRASH}`)).toBe(false);
  });

  test("is false for a plain test failure", () => {
    expect(isBunCrashOnly("(fail) the real face worker > two\n 1 pass\n 1 fail")).toBe(false);
  });

  test("is false for a clean run", () => {
    expect(isBunCrashOnly(" 8 pass\n 0 fail\nRan 8 tests across 1 file.")).toBe(false);
  });

  test("is false for an unrelated non-zero exit (a timeout, a missing file)", () => {
    expect(isBunCrashOnly("error: Cannot find module './nope'")).toBe(false);
  });

  test("is false when a `N fail` summary line with N above zero sits next to a crash, whatever the marker looked like", () => {
    expect(isBunCrashOnly(`${CRASH}\n 7 pass\n 1 fail`)).toBe(false);
  });

  test("is true when the summary says `0 fail` next to a crash", () => {
    expect(isBunCrashOnly(`${CRASH}\n 8 pass\n 0 fail`)).toBe(true);
  });

  test("is false for a coloured failure (FORCE_COLOR: a red cross, not the literal `(fail)`) followed by a crash", () => {
    const coloured = ["\u001b[31m✗\u001b[0m the real face worker > two", " \u001b[32m7 pass\u001b[0m", " \u001b[31m1 fail\u001b[0m", CRASH].join("\n");
    expect(isBunCrashOnly(coloured)).toBe(false);
  });

  test("is false for a coloured cross alone, without any summary line", () => {
    expect(isBunCrashOnly(`\u001b[31m✗\u001b[0m the real face worker > two\n${CRASH}`)).toBe(false);
  });

  test("is true for a coloured crash with a coloured `0 fail` summary", () => {
    expect(isBunCrashOnly(`${CRASH}\n \u001b[32m8 pass\u001b[0m\n \u001b[2m0 fail\u001b[0m`)).toBe(true);
  });
});

describe("childEnv", () => {
  test("turns colour off and drops FORCE_COLOR, so the failure marker stays the literal text the detector reads", () => {
    const env = childEnv({ FORCE_COLOR: "1", PATH: "/usr/bin" });
    expect(env.NO_COLOR).toBe("1");
    expect("FORCE_COLOR" in env).toBe(false);
  });

  test("keeps the rest of the environment", () => {
    const env = childEnv({ PATH: "/usr/bin" });
    expect(env.PATH).toBe("/usr/bin");
  });
});

describe("isBunCrashOnly reads a load error as a failure", () => {
  const LOAD_ERROR = ["# Unhandled error between tests", "-------------------------------", "SyntaxError: Export named 'x' not found"].join("\n");

  test("is false when Bun printed an unhandled error between tests, even with no `(fail)` line, before it crashed", () => {
    expect(isBunCrashOnly(`${LOAD_ERROR}\n${CRASH}`)).toBe(false);
  });

  test("is false for a summary that counts errors above zero next to a crash", () => {
    expect(isBunCrashOnly(`${CRASH}\n 8 pass\n 0 fail\n 1 error`)).toBe(false);
    expect(isBunCrashOnly(`${CRASH}\n 8 pass\n 0 fail\n 3 errors`)).toBe(false);
  });

  test("is true when the summary counts zero errors", () => {
    expect(isBunCrashOnly(`${CRASH}\n 8 pass\n 0 fail\n 0 errors`)).toBe(true);
  });
});

describe("isBunCrashOnly with a set of known crash signatures", () => {
  const AT_18 = "panic: Segmentation fault at address 0x18\noh no: Bun has crashed.";
  const AT_HIGH = "panic: Segmentation fault at address 0xFFFFFFFFFFFFFFF8\noh no: Bun has crashed.";
  const OTHER = "panic: Segmentation fault at address 0x7FFF1234\noh no: Bun has crashed.";

  test("the worker-teardown set accepts the segfault at 0x18", () => {
    expect(isBunCrashOnly(AT_18, WORKER_TEARDOWN_CRASHES)).toBe(true);
  });

  test("the worker-teardown set accepts the segfault at 0xFFFFFFFFFFFFFFF8", () => {
    expect(isBunCrashOnly(AT_HIGH, WORKER_TEARDOWN_CRASHES)).toBe(true);
  });

  // Windows: Bun dies tearing down a terminated wasm worker with "mprotect failed: 487" (ERROR_INVALID_ADDRESS from
  // VirtualProtect) and exit code 3, no panic line at all. The CI run of 2026-09-29 failed on it with no retry.
  test("the worker-teardown set accepts Windows' mprotect failure, which prints no panic line", () => {
    expect(isBunCrashOnly("(pass) a real test\nmprotect failed: 487\n", WORKER_TEARDOWN_CRASHES)).toBe(true);
    expect(isBunCrashOnly("mprotect failed: 487\r\n", WORKER_TEARDOWN_CRASHES)).toBe(true);
  });

  test("any-crash mode counts the mprotect failure as a crash too", () => {
    expect(isBunCrashOnly("mprotect failed: 487")).toBe(true);
  });

  test("an mprotect failure after a failed test is still a failure", () => {
    expect(isBunCrashOnly("(fail) a > b\nmprotect failed: 487", WORKER_TEARDOWN_CRASHES)).toBe(false);
  });

  test("a line that merely mentions mprotect is not the crash", () => {
    expect(isBunCrashOnly("we said mprotect failed: 487 in a log message", WORKER_TEARDOWN_CRASHES)).toBe(false);
  });

  test("the worker-teardown set refuses any other crash", () => {
    expect(isBunCrashOnly(OTHER, WORKER_TEARDOWN_CRASHES)).toBe(false);
    expect(isBunCrashOnly("panic: index out of bounds", WORKER_TEARDOWN_CRASHES)).toBe(false);
  });

  test("an address that only starts like a known one is not that address", () => {
    expect(isBunCrashOnly("panic: Segmentation fault at address 0x180", WORKER_TEARDOWN_CRASHES)).toBe(false);
  });

  test("a known crash after a failed test is still a failure", () => {
    expect(isBunCrashOnly(`(fail) a > b\n${AT_18}`, WORKER_TEARDOWN_CRASHES)).toBe(false);
  });

  test("without a set, any Bun crash counts", () => {
    expect(isBunCrashOnly(OTHER)).toBe(true);
  });
});

describe("testTarget", () => {
  test("with no arguments is refused: the real face worker tests are no longer a bun run (electronNodeTests.ts runs them)", () => {
    expect(() => testTarget([])).toThrow(/usage/);
  });

  test("--suite runs exactly the bun test arguments after it, any crash retried", () => {
    expect(testTarget(["--suite", "./studio", "--randomize"])).toEqual({ testArgs: ["./studio", "--randomize"], knownCrashesOnly: false, shards: 1 });
  });

  test("--known-crashes-only before --suite narrows the retry to the worker-teardown crashes", () => {
    expect(testTarget(["--known-crashes-only", "--suite", "./studio"])).toEqual({ testArgs: ["./studio"], knownCrashesOnly: true, shards: 1 });
  });

  test("an argument that is not a mode is refused, not silently turned into a different run", () => {
    expect(() => testTarget(["--bail"])).toThrow(/usage/);
    expect(() => testTarget(["./studio"])).toThrow(/usage/);
  });

  test("--suite with nothing after it is refused", () => {
    expect(() => testTarget(["--suite"])).toThrow(/usage/);
  });

  test("--known-crashes-only without --suite is refused", () => {
    expect(() => testTarget(["--known-crashes-only"])).toThrow(/usage/);
  });

  test("--known-crashes-only among the bun test arguments after --suite is refused: it would be handed to bun, not read here", () => {
    expect(() => testTarget(["--suite", "./studio", "--known-crashes-only"])).toThrow(/usage/);
    expect(() => testTarget(["--known-crashes-only", "--suite", "./studio", "--known-crashes-only"])).toThrow(/usage/);
  });
});

describe("testTarget with --shards", () => {
  test("--shards=N before --suite splits the suite, in either order with --known-crashes-only", () => {
    expect(testTarget(["--shards=3", "--suite", "./studio", "--randomize"])).toEqual({ testArgs: ["./studio", "--randomize"], knownCrashesOnly: false, shards: 3 });
    expect(testTarget(["--known-crashes-only", "--shards=3", "--suite", "./studio"])).toEqual({ testArgs: ["./studio"], knownCrashesOnly: true, shards: 3 });
    expect(testTarget(["--shards=3", "--known-crashes-only", "--suite", "./studio"])).toEqual({ testArgs: ["./studio"], knownCrashesOnly: true, shards: 3 });
  });

  test("a shard count that is not a whole number from 1 to 99 is refused", () => {
    for (const bad of ["--shards=0", "--shards=", "--shards=x", "--shards=-1", "--shards=2.5", "--shards=100", "--shards"]) {
      expect(() => testTarget([bad, "--suite", "./studio"])).toThrow(/usage/);
    }
  });

  test("--shards without --suite is refused", () => {
    expect(() => testTarget(["--shards=3"])).toThrow(/usage/);
  });

  test("a second --shards, or one after --suite (bun would receive it), is refused", () => {
    expect(() => testTarget(["--shards=2", "--shards=3", "--suite", "./studio"])).toThrow(/usage/);
    expect(() => testTarget(["--suite", "./studio", "--shards=3"])).toThrow(/usage/);
  });
});

// CI-5: on Windows the suite runs as parallel jobs, each running ONE shard of N (`--shard=I/N`). Every job computes the partition on
// its own, from the same sorted file list, so it only has to be deterministic; what must hold is that the N jobs together run every
// test file exactly once.
describe("testTarget with --shard=I/N", () => {
  test("--shard=I/N before --suite selects shard I of N, in either order with --known-crashes-only", () => {
    expect(testTarget(["--shard=2/4", "--suite", "./studio"])).toEqual({ testArgs: ["./studio"], knownCrashesOnly: false, shards: 4, shard: { index: 2, of: 4 } });
    expect(testTarget(["--known-crashes-only", "--shard=1/3", "--suite", "./studio", "--randomize"])).toEqual({ testArgs: ["./studio", "--randomize"], knownCrashesOnly: true, shards: 3, shard: { index: 1, of: 3 } });
    expect(testTarget(["--shard=3/3", "--known-crashes-only", "--suite", "./studio"])).toEqual({ testArgs: ["./studio"], knownCrashesOnly: true, shards: 3, shard: { index: 3, of: 3 } });
  });

  test("an index outside 1..N, a count outside 1..99 and anything that is not I/N are refused", () => {
    for (const bad of ["--shard=0/4", "--shard=5/4", "--shard=1/0", "--shard=1/100", "--shard=1", "--shard=/4", "--shard=a/b", "--shard=1/4/4", "--shard=-1/4", "--shard=1.5/4", "--shard"]) {
      expect(() => testTarget([bad, "--suite", "./studio"])).toThrow(/usage/);
    }
  });

  test("--shard and --shards together, a second --shard, or one after --suite (bun would receive it) is refused", () => {
    expect(() => testTarget(["--shards=4", "--shard=1/4", "--suite", "./studio"])).toThrow(/usage/);
    expect(() => testTarget(["--shard=1/4", "--shards=4", "--suite", "./studio"])).toThrow(/usage/);
    expect(() => testTarget(["--shard=1/4", "--shard=2/4", "--suite", "./studio"])).toThrow(/usage/);
    expect(() => testTarget(["--suite", "./studio", "--shard=1/4"])).toThrow(/usage/);
  });

  test("--shard without --suite is refused", () => {
    expect(() => testTarget(["--shard=1/4"])).toThrow(/usage/);
  });
});

describe("running one shard of N", () => {
  const ROOT = join(import.meta.dir, "..", "..");
  const PLAN = [
    ["--randomize", "./a.test.ts"],
    ["--randomize", "./b.test.ts"],
    ["--randomize", "./c.test.ts"],
  ];

  test("selectShard keeps only that shard's arguments, and refuses a shard the plan does not have (fewer files than shards)", () => {
    expect(selectShard(PLAN, { index: 2, of: 3 })).toEqual([["--randomize", "./b.test.ts"]]);
    expect(selectShard(PLAN, { index: 3, of: 3 })).toEqual([["--randomize", "./c.test.ts"]]);
    expect(() => selectShard(PLAN, { index: 4, of: 4 })).toThrow(/shard 4 of 4 has no test files/);
  });

  test("a numbered single shard is announced and reported as its own number, not as `the run`", async () => {
    const lines: string[] = [];
    const ran: string[] = [];
    const code = await runShards(
      [["./b.test.ts"]],
      async (_args, label) => {
        ran.push(label);
        return { code: 1, hung: false };
      },
      (line) => lines.push(line),
      { first: 2, of: 4 },
    );
    expect(code).toBe(1);
    expect(ran).toEqual(["shard 2 of 4"]);
    expect(lines).toContain("\n== shard 2 of 4: 1 test files ==");
    const at = lines.findIndex((l) => l.startsWith("::error::") && l.includes("shard 2 of 4 failed"));
    expect(at).toBeGreaterThanOrEqual(0);
    expect(lines[at + 1]).toContain("./b.test.ts");
  });

  // The proof that no file is skipped or run twice: every job's selection, for the real ./studio tree, together is exactly the file list.
  for (const count of [3, 4, 5]) {
    test(`the ${count} jobs' shards of the real ./studio tree together run every test file exactly once`, async () => {
      const all = await listTestFiles(["./studio"], ROOT);
      const plan = await shardedTestArgs(["./studio", "--randomize"], count, ROOT);
      const picked: string[] = [];
      for (let index = 1; index <= count; index++) {
        const [args] = selectShard(plan, { index, of: count });
        const files = (args ?? []).filter((arg) => !arg.startsWith("-"));
        expect(files.length).toBeGreaterThan(0);
        picked.push(...files);
      }
      expect(new Set(picked).size).toBe(picked.length);
      expect([...picked].sort()).toEqual(all);
    });
  }

  test("two independent computations of the partition (two jobs) agree", async () => {
    expect(await shardedTestArgs(["./studio"], 4, ROOT)).toEqual(await shardedTestArgs(["./studio"], 4, ROOT));
  });
});

describe("sharding the suite", () => {
  const scratch: string[] = [];
  afterEach(async () => {
    for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  async function tree(files: readonly string[]): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "studio-shards-"));
    scratch.push(root);
    for (const file of files) {
      await mkdir(join(root, file, ".."), { recursive: true });
      await writeFile(join(root, file), "");
    }
    return root;
  }

  test("listTestFiles finds what bun test would run, sorted, as ./ paths, and not node_modules or node-test files", async () => {
    const root = await tree([
      "studio/b/two.test.ts",
      "studio/a/one.test.tsx",
      "studio/a/one.spec.ts",
      "studio/a/snake_test.ts",
      "studio/a/snake_spec.js",
      "studio/a/helper.ts",
      "studio/a/x.real.node-test.ts",
      "studio/a/notatest.ts",
      "studio/node_modules/dep/dep.test.ts",
    ]);
    expect(await listTestFiles(["studio"], root)).toEqual([
      "./studio/a/one.spec.ts",
      "./studio/a/one.test.tsx",
      "./studio/a/snake_spec.js",
      "./studio/a/snake_test.ts",
      "./studio/b/two.test.ts",
    ]);
  });

  test("listTestFiles reads dot-files, skips dot-directories and nested node_modules, and matches the name in any case", async () => {
    const root = await tree([
      "studio/.hidden.test.ts",
      "studio/.cache/inside.test.ts",
      "studio/a/.git/x.spec.ts",
      "studio/a/node_modules/dep/y.test.ts",
      "studio/a/Upper.TEST.TS",
      "studio/a/mod.test.mts",
      "studio/a/common.spec.cjs",
      "studio/a/test.ts",
      "studio/a/attest.ts",
      "studio/a/contest.tsx",
    ]);
    expect(await listTestFiles(["studio"], root)).toEqual(["./studio/.hidden.test.ts", "./studio/a/Upper.TEST.TS", "./studio/a/common.spec.cjs", "./studio/a/mod.test.mts"]);
  });

  test("listTestFiles takes a file path as it is, and joins paths without repeating a file", async () => {
    const root = await tree(["studio/a/one.test.ts", "studio/b/two.test.ts"]);
    expect(await listTestFiles(["studio/a", "studio/a/one.test.ts", "studio/b"], root)).toEqual(["./studio/a/one.test.ts", "./studio/b/two.test.ts"]);
  });

  test("listTestFiles refuses a missing path and a tree with no test files, so sharding never quietly runs nothing", async () => {
    const root = await tree(["studio/a/helper.ts"]);
    await expect(listTestFiles(["nope"], root)).rejects.toThrow(/no such test path/);
    await expect(listTestFiles(["studio"], root)).rejects.toThrow(/no test files/);
  });

  test("shardFiles puts every file in exactly one group, spreads neighbours apart, and leaves no group empty", () => {
    const files = Array.from({ length: 10 }, (_, i) => `f${i}`);
    const groups = shardFiles(files, 3);
    expect(groups).toEqual([
      ["f0", "f3", "f6", "f9"],
      ["f1", "f4", "f7"],
      ["f2", "f5", "f8"],
    ]);
    expect(groups.flat().sort()).toEqual([...files].sort());
    expect(shardFiles(["a", "b"], 5)).toEqual([["a"], ["b"]]);
  });

  test("shardedTestArgs with one shard hands the arguments over unchanged, with no file search", async () => {
    expect(await shardedTestArgs(["./studio", "--randomize"], 1, "/nowhere")).toEqual([["./studio", "--randomize"]]);
  });

  test("shardedTestArgs gives every shard the flags and its own files, and together the shards cover the suite", async () => {
    const root = await tree(["studio/a.test.ts", "studio/b.test.ts", "studio/c.test.ts", "studio/d.test.ts"]);
    const plan = await shardedTestArgs(["./studio", "--randomize", "--timeout=90000"], 2, root);
    expect(plan).toEqual([
      ["--randomize", "--timeout=90000", "./studio/a.test.ts", "./studio/c.test.ts"],
      ["--randomize", "--timeout=90000", "./studio/b.test.ts", "./studio/d.test.ts"],
    ]);
  });

  test("shardedTestArgs refuses a shard whose command line would pass Windows' limit, naming the shard", async () => {
    const long = "x".repeat(200);
    const files = Array.from({ length: 400 }, (_, i) => `studio/${long}/f${String(i).padStart(3, "0")}.test.ts`);
    const root = await tree(files);
    await expect(shardedTestArgs(["./studio"], 2, root)).rejects.toThrow(/shard 1 of 2 .*over Windows' limit/);
    // The same files in enough shards fit.
    const plan = await shardedTestArgs(["./studio"], 8, root);
    for (const args of plan) expect(commandLineLength(args)).toBeLessThanOrEqual(WINDOWS_COMMAND_LINE_LIMIT);
  });

  test("shardedTestArgs refuses a flag value in its own argument: it would be read as a missing path", async () => {
    const root = await tree(["studio/a.test.ts"]);
    await expect(shardedTestArgs(["./studio", "--timeout", "90000"], 2, root)).rejects.toThrow(/no such test path/);
  });
});

describe("tierRunMatchedNothing", () => {
  test("reads bun's answer to a name pattern that selects no test (the quarantine run while the list is empty)", () => {
    expect(tierRunMatchedNothing('bun test v1.3.12\n\nerror: regex "\\[quarantine\\]" matched 0 tests. Searched 1 file (skipping 17 tests) [176.00ms]\n')).toBe(true);
  });

  test("is false for any other output, a failure included", () => {
    expect(tierRunMatchedNothing("(fail) a > b [1ms]\n 1 fail\n")).toBe(false);
    expect(tierRunMatchedNothing(" 3 pass\n 0 fail\n")).toBe(false);
  });
});

describe("tierTestArgs (STUDIO_TEST_TIER)", () => {
  const scratch: string[] = [];
  afterEach(async () => {
    for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  async function treeWith(files: Record<string, string>): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "studio-tier-"));
    scratch.push(root);
    for (const [path, source] of Object.entries(files)) {
      await mkdir(join(root, path, ".."), { recursive: true });
      await writeFile(join(root, path), source);
    }
    return root;
  }

  test("is one process holding the flags, the tier's name pattern and only the files that carry a marker of the tier", async () => {
    const root = await treeWith({
      "studio/a.test.ts": 'heavyTest("slow", () => {});',
      "studio/b.test.ts": 'test("plain", () => {});',
      "studio/c.test.ts": 'test("[heavy] by hand", () => {});',
      "studio/d.test.ts": 'perfTest("fast", () => {});',
    });
    expect(await tierTestArgs(["./studio", "--randomize"], "heavy", root)).toEqual([["--randomize", "--test-name-pattern=\\[heavy\\]", "./studio/a.test.ts", "./studio/c.test.ts"]]);
    expect(await tierTestArgs(["./studio"], "perf", root)).toEqual([["--test-name-pattern=\\[perf\\]", "./studio/d.test.ts"]]);
  });

  test("selects a file by a call of the tier's helper, not by a string that merely mentions one", async () => {
    const root = await treeWith({
      "studio/real.test.ts": 'quarantinedTest("x", "a flaky one", () => {});',
      "studio/fixture.test.ts": 'const source = \'quarantinedTest("x", "n", () => {})\'; // inQuarantineRun("x")\ntest("plain", () => {});',
    });
    expect(await tierTestArgs(["./studio"], "quarantine", root)).toEqual([["--test-name-pattern=\\[quarantine\\]", "./studio/real.test.ts"]]);
  });

  test("keeps a name pattern the caller gave", async () => {
    const root = await treeWith({ "studio/a.test.ts": 'heavyTest("slow", () => {});' });
    expect(await tierTestArgs(["./studio", "--test-name-pattern=slow"], "heavy", root)).toEqual([["--test-name-pattern=slow", "./studio/a.test.ts"]]);
  });

  test("is an empty plan when no file carries the tier (the quarantine list is empty most of the time)", async () => {
    const root = await treeWith({ "studio/a.test.ts": 'test("plain", () => {});' });
    expect(await tierTestArgs(["./studio"], "quarantine", root)).toEqual([]);
  });

  test("still refuses a path that does not exist, so a tier run never quietly runs nothing", async () => {
    const root = await treeWith({ "studio/a.test.ts": "" });
    await expect(tierTestArgs(["./nope"], "perf", root)).rejects.toThrow(/no such test path/);
  });
});

describe("the bounds", () => {
  const ROOT = join(import.meta.dir, "..", "..");

  // Windows CI takes 7.5 to over 10 minutes for the whole suite. One of three shards is a third of that, and a shard
  // that takes more than the bound is hung. A hang must still end: the bound is finite and the step's limit covers every retry.
  test("a shard's bound is finite and at least twice a third of the slowest whole suite seen on Windows (10 minutes)", () => {
    expect(ATTEMPT_TIMEOUT_MS).toBeGreaterThanOrEqual((2 * 10 * 60 * 1000) / 3);
    expect(ATTEMPT_TIMEOUT_MS).toBeLessThanOrEqual(30 * 60 * 1000);
  });

  test("each workflow step that runs the sharded suite has a timeout-minutes above shards x attempts x bound, and every suite script shards", async () => {
    const scripts = scriptsOf(JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")));
    const workflow = await readFile(join(ROOT, ".github", "workflows", "studio.yml"), "utf8");
    for (const name of ["test:studio:suite", "test:studio:suite:canary"]) {
      const shards = Number(/--shards=(\d+)/.exec(scripts[name] ?? "")?.[1]);
      expect(shards).toBeGreaterThan(1);
      const step = new RegExp(`run: bun run ${name} .*\\r?\\n\\s+timeout-minutes: (\\d+)`).exec(workflow);
      expect(step).not.toBeNull();
      expect(Number(step?.[1])).toBeGreaterThan((shards * MAX_ATTEMPTS * ATTEMPT_TIMEOUT_MS) / 60_000);
    }
  });
});

describe("the per-test timeout", () => {
  const ROOT = join(import.meta.dir, "..", "..");

  test("is added to every shard's arguments, ahead of the files, unless the caller gave one", () => {
    expect(withDefaultTimeout(["--randomize", "./a.test.ts"])).toEqual([`--timeout=${DEFAULT_TEST_TIMEOUT_MS}`, "--randomize", "./a.test.ts"]);
    expect(withDefaultTimeout(["--timeout=90000", "./a.test.ts"])).toEqual(["--timeout=90000", "./a.test.ts"]);
    expect(withDefaultTimeout(["--timeout", "./a.test.ts"])).toEqual(["--timeout", "./a.test.ts"]);
  });

  // Windows CI failed a different default-timeout test in every run at 5.2 to 6.0 s; bun ignores bunfig's `timeout`.
  test("is well above the 5 s default that slow Windows runs hit, and below the shard bound", () => {
    expect(DEFAULT_TEST_TIMEOUT_MS).toBeGreaterThanOrEqual(20_000);
    expect(DEFAULT_TEST_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
    expect(DEFAULT_TEST_TIMEOUT_MS).toBeLessThan(ATTEMPT_TIMEOUT_MS);
  });

  test("really applies: a test that outlasts the flag fails on it, and one within it passes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "studio-timeout-"));
    try {
      const file = join(dir, "slow.test.ts");
      await writeFile(file, 'import { test } from "bun:test";\ntest("slow", async () => { await Bun.sleep(1500); });\n');
      const run = (timeout: number) => runOnce({ command: [process.execPath, "--no-env-file", "test", `--timeout=${timeout}`, file], env: childEnv(process.env), timeoutMs: 60_000, graceMs: 300, echo: false });
      expect((await run(500)).exitCode).not.toBe(0);
      expect((await run(10_000)).exitCode).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the suite scripts leave the flag to the runner, so no script overrides it", async () => {
    const scripts = scriptsOf(JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")));
    for (const name of ["test:studio:suite", "test:studio:suite:canary"]) expect(scripts[name]).not.toContain("--timeout");
  });
});

describe("the Electron-Node steps' bounds", () => {
  const ROOT = join(import.meta.dir, "..", "..");

  // electronNodeTests.ts kills a suite past SUITE_TIMEOUT_MS and runs the suites one after another, so a step that
  // hangs in its last suite is still bounded by the runner itself only if the step's own limit is above all of them.
  test("every workflow step that runs the suites has a timeout-minutes above suites x the suite bound, and the script exists", async () => {
    const scripts = scriptsOf(JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")));
    expect(scripts["test:studio:electron-node"]).toContain("electronNodeTests.ts");
    const workflow = await readFile(join(ROOT, ".github", "workflows", "studio.yml"), "utf8");
    const steps = [...workflow.matchAll(/run: bun run test:studio:electron-node\r?\n\s+timeout-minutes: (\d+)/g)];
    expect(steps).toHaveLength(4); // the build job, the canary (scheduled), and the perf and quarantine tier runs (CI-4)
    for (const step of steps) expect(Number(step[1])).toBeGreaterThan((NODE_TEST_SUITES.length * SUITE_TIMEOUT_MS) / 60_000);
  });

  // The shared contract's typecheck used to be two tests that each spawned tsc on studio/shared/tsconfig.json; it is a workflow step now (CI-4).
  test("the build and the canary jobs typecheck studio/shared/tsconfig.json, the tsconfig the removed purity tests ran", async () => {
    const workflow = await readFile(join(ROOT, ".github", "workflows", "studio.yml"), "utf8");
    expect([...workflow.matchAll(/^ {6}- run: bunx tsc --noEmit -p studio\/shared\/tsconfig\.json\r?$/gm)]).toHaveLength(2);
    expect(await readFile(join(ROOT, "studio", "shared", "tsconfig.json"), "utf8")).toContain('"types": []');
  });

  // A tier run (STUDIO_TEST_TIER, studio/testing/tiers.ts) is one `bun test` process: it may crash and retry like a shard, so its step
  // needs attempts x bound, and a tier job must set the variable for the steps that run it.
  test("every workflow step that runs a tier's bun tests has a timeout-minutes above attempts x bound, in a job that sets STUDIO_TEST_TIER", async () => {
    const workflow = await readFile(join(ROOT, ".github", "workflows", "studio.yml"), "utf8");
    const jobs = workflow.split(/^ {2}(?=[\w-]+:\r?\n)/m).filter((block) => /STUDIO_TEST_TIER: \w+/.test(block));
    expect(jobs.map((job) => /STUDIO_TEST_TIER: (\w+)/.exec(job)?.[1]).sort()).toEqual(["heavy", "perf", "quarantine"]);
    for (const job of jobs) {
      const step = /run: bun run test:studio:suite \.\/studio\r?\n\s+timeout-minutes: (\d+)/.exec(job);
      expect(step).not.toBeNull();
      expect(Number(step?.[1])).toBeGreaterThan((MAX_ATTEMPTS * ATTEMPT_TIMEOUT_MS) / 60_000);
    }
    // The canary runs the heavy tier on `bun latest` with the tier on the command line; its step has the same bound.
    const inline = [...workflow.matchAll(/run: STUDIO_TEST_TIER=(\w+) bun run test:studio:suite \.\/studio\r?\n\s+timeout-minutes: (\d+)/g)];
    expect(inline.map((m) => m[1])).toEqual(["heavy"]);
    for (const m of inline) expect(Number(m[2])).toBeGreaterThan((MAX_ATTEMPTS * ATTEMPT_TIMEOUT_MS) / 60_000);
  });

  // The perf tier never gates anything: its budgets are measurements (one read 786 ms of 800 on Windows).
  async function workflowJobs(): Promise<Record<string, Record<string, unknown>>> {
    const parsed: unknown = Bun.YAML.parse(await readFile(join(ROOT, ".github", "workflows", "studio.yml"), "utf8"));
    if (typeof parsed !== "object" || parsed === null || !("jobs" in parsed) || typeof parsed.jobs !== "object" || parsed.jobs === null) throw new Error("no jobs in the workflow");
    return Object.fromEntries(Object.entries(parsed.jobs).map(([name, job]) => [name, typeof job === "object" && job !== null ? Object.fromEntries(Object.entries(job)) : {}]));
  }

  // CI-5: Windows runs the bun suite as parallel jobs, one shard each. Nothing may go missing in the move: macOS keeps its three
  // sequential shards in `build`, Windows' `build` leg skips that step, and the matrix of `test-windows` is exactly the shards 1..N of
  // the `--shard=I/N` its command line passes (together with realWorkerTests' own partition tests this is "every file once").
  test("the Windows suite job runs shards 1..N of N, one per matrix entry, bounded, on the same trigger as build; the build job skips the bun suite on Windows only", async () => {
    const jobs = await workflowJobs();
    const workflow = await readFile(join(ROOT, ".github", "workflows", "studio.yml"), "utf8");
    const job = jobs["test-windows"];
    expect(job).toBeDefined();
    expect(job?.if).toBe(jobs.build?.if);
    expect(job?.["runs-on"]).toBe("windows-latest");
    const matrix = (job?.strategy as { "fail-fast"?: unknown; matrix?: { shard?: unknown } } | undefined) ?? {};
    expect(matrix["fail-fast"]).toBe(false);
    const shards = matrix.matrix?.shard;
    if (!Array.isArray(shards)) throw new Error("test-windows has no shard matrix");
    const command = /run: bun run test:studio:suite:shard --shard=\$\{\{ matrix\.shard \}\}\/(\d+) --suite \.\/studio\r?\n\s+timeout-minutes: (\d+)/.exec(workflow);
    expect(command).not.toBeNull();
    const count = Number(command?.[1]);
    expect(count).toBeGreaterThan(1);
    expect(shards).toEqual(Array.from({ length: count }, (_, i) => i + 1));
    expect(String(job?.name)).toContain(`/${count})`);
    // One shard per job: its step covers every attempt of one shard, not of all of them.
    expect(Number(command?.[2])).toBeGreaterThan((MAX_ATTEMPTS * ATTEMPT_TIMEOUT_MS) / 60_000);
    // The job itself is bounded too, above the suite step's own limit, so a hung install cannot hold a job for GitHub's 360 minutes.
    expect(Number(job?.["timeout-minutes"])).toBeGreaterThan(Number(command?.[2]));
    expect(Number(job?.["timeout-minutes"])).toBeLessThanOrEqual(120);
    // The same suite, the same models: the jobs hold the steps a shard needs.
    const steps = (job?.steps ?? []) as { run?: string; uses?: string }[];
    expect(steps.some((step) => step.run === "bun install")).toBe(true);
    expect(steps.some((step) => step.run === "bun run models:face")).toBe(true);
    // The one place the bun suite is skipped is the Windows leg of build; macOS still runs it there, whole.
    const suite = ((jobs.build?.steps ?? []) as { run?: string; if?: string }[]).filter((step) => step.run === "bun run test:studio:suite ./studio");
    expect(suite).toHaveLength(1);
    expect(suite[0]?.if).toBe("runner.os != 'Windows'");
    // The package script behind the job is the same runner with the shard flag only, so it cannot drift from the suite's own flags.
    const scripts = scriptsOf(JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")));
    expect(scripts["test:studio:suite:shard"]).toBe("bun studio/scripts/realWorkerTests.ts");
    expect(scripts["test:studio:suite"]).toBe(`bun studio/scripts/realWorkerTests.ts --shards=3 --suite`);
  });

  // Owner decision 2026-10-05: the repo is public, so an installer uploaded as an artifact is downloadable by any logged-in GitHub user,
  // and the macOS ffmpeg-static build is GPL+nonfree. Nothing in the workflow (or in a local action it could call) may publish or
  // upload anything until a private distribution channel exists; these checks fail if a release job, an artifact transfer, a secret
  // or a write permission comes back.
  const PUBLISHERS = /actions\/upload-artifact|actions\/download-artifact|softprops\/action-gh-release/;

  test("nothing publishes: no release job, no artifact or release action in the workflow or in any local action", async () => {
    const workflow = await readFile(join(ROOT, ".github", "workflows", "studio.yml"), "utf8");
    const jobs = await workflowJobs();
    expect(jobs.release).toBeUndefined();
    expect(workflow).not.toMatch(PUBLISHERS);
    expect(workflow).not.toMatch(/\bgh\s+release\b/);
    // A local composite action is a way around the workflow text: scan every file under .github/actions too.
    const actionsDir = join(ROOT, ".github", "actions");
    const localFiles = await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: actionsDir, onlyFiles: true })).catch(() => []);
    for (const file of localFiles) {
      const text = await readFile(join(actionsDir, file), "utf8");
      expect([file, PUBLISHERS.test(text)]).toEqual([file, false]);
      expect([file, /\bgh\s+release\b/.test(text)]).toEqual([file, false]);
    }
    // No job needs an artifact another job would have to hand over.
    expect(Object.values(jobs).filter((job) => JSON.stringify(job.steps ?? []).includes("artifact"))).toEqual([]);
  });

  test("no secret reaches the workflow, and the token is read-only everywhere", async () => {
    const workflow = await readFile(join(ROOT, ".github", "workflows", "studio.yml"), "utf8");
    const jobs = await workflowJobs();
    // No `secrets.X` expression at all: the workflow uses none today, so any new one is a decision to review, not a drive-by.
    expect(workflow).not.toMatch(/\bsecrets\./);
    const parsed: unknown = Bun.YAML.parse(workflow);
    if (typeof parsed !== "object" || parsed === null || !("permissions" in parsed)) throw new Error("no top-level permissions in the workflow");
    expect(parsed.permissions).toEqual({ contents: "read" });
    expect(Object.entries(jobs).filter(([, job]) => JSON.stringify(job.permissions ?? {}).includes("write")).map(([name]) => name)).toEqual([]);
  });

  test("the packaging never publishes: electron-builder runs with --publish never, no other --publish value exists, and the config has publish: null", async () => {
    const workflow = await readFile(join(ROOT, ".github", "workflows", "studio.yml"), "utf8");
    expect(workflow).toMatch(/bunx electron-builder --config electron-builder\.studio\.yml --publish never\r?$/m);
    const values = [...workflow.matchAll(/--publish[ =](\S+)/g)].map((m) => m[1]);
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) expect(value).toBe("never");
    const config = await readFile(join(ROOT, "electron-builder.studio.yml"), "utf8");
    expect(config).toMatch(/^publish: null\r?$/m);
  });

  test("the tag trigger stays, as verification, and says why nothing is released", async () => {
    const workflow = await readFile(join(ROOT, ".github", "workflows", "studio.yml"), "utf8");
    expect(workflow).toMatch(/- "studio-v\*"/);
    expect(workflow).toContain("Studio releases are disabled while the repo is public; see owner decision 2026-10-05");
  });

  test("the perf job never gates a run: continue-on-error is true on every trigger, tags included; the heavy job blocks on tags and the schedule", async () => {
    const jobs = await workflowJobs();
    expect(jobs.perf?.["continue-on-error"]).toBe(true);
    expect(String(jobs.perf?.if)).toContain("startsWith(github.ref, 'refs/tags/')");
    expect(String(jobs.heavy?.if)).toContain("startsWith(github.ref, 'refs/tags/')");
    expect(String(jobs.heavy?.["continue-on-error"])).toContain("!startsWith(github.ref, 'refs/tags/')");
  });
});

describe("the workflow's concurrency rule", () => {
  const ROOT = join(import.meta.dir, "..", "..");

  // A branch run that a newer one supersedes is cancelled. A main push or a tag run never is, and never shares a
  // group with another run: GitHub drops an older PENDING run of a shared group even with cancel-in-progress off.
  test("cancels only non-main, non-tag refs, and gives main and tag runs a group of their own", async () => {
    const workflow = await readFile(join(ROOT, ".github", "workflows", "studio.yml"), "utf8");
    const block = /^concurrency:\r?\n((?:[ \t]+.*\r?\n)+)/m.exec(workflow)?.[1] ?? "";
    const group = /^\s+group: (.*?)\r?$/m.exec(block)?.[1];
    const cancel = /^\s+cancel-in-progress: (.*?)\r?$/m.exec(block)?.[1];
    // The exact expressions, not fragments of them: a reworded condition that keeps the same words can invert the rule.
    // A branch run's group also names the dispatch tier, so a default run and a scheduled run of one branch do not cancel each other (CI-4).
    expect(group).toBe("${{ github.workflow }}-${{ (github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/tags/')) && github.run_id || format('{0}-{1}', github.ref, inputs.tier) }}");
    expect(cancel).toBe("${{ github.ref != 'refs/heads/main' && !startsWith(github.ref, 'refs/tags/') }}");
  });
});

describe("runShards", () => {
  const PLAN = [
    ["--randomize", "./a.test.ts", "./d.test.ts"],
    ["--randomize", "./b.test.ts"],
    ["--randomize", "./c.test.ts"],
  ];
  const pass = { code: 0, hung: false };

  /** A shard runner that plays these outcomes in order and records which shards it ran. */
  function playing(outcomes: { code: number; hung: boolean }[]) {
    const ran: string[] = [];
    return {
      ran,
      runShard: async (_args: readonly string[], label: string) => {
        ran.push(label);
        return outcomes[ran.length - 1] ?? pass;
      },
    };
  }

  test("runs every shard and returns 0 when all pass", async () => {
    const run = playing([pass, pass, pass]);
    expect(await runShards(PLAN, run.runShard, () => undefined)).toBe(0);
    expect(run.ran).toEqual(["shard 1 of 3", "shard 2 of 3", "shard 3 of 3"]);
  });

  test("an ordinary failure runs the remaining shards, returns the first failing shard's code, and lists the failing shard's files", async () => {
    const lines: string[] = [];
    const run = playing([pass, { code: 1, hung: false }, { code: 133, hung: false }]);
    expect(await runShards(PLAN, run.runShard, (line) => lines.push(line))).toBe(1);
    expect(run.ran).toHaveLength(3);
    const at = lines.findIndex((l) => l.startsWith("::error::") && l.includes("shard 2 of 3 failed"));
    expect(at).toBeGreaterThanOrEqual(0);
    expect(lines[at + 1]).toContain("./b.test.ts");
    expect(lines.filter((l) => l.includes("./a.test.ts"))).toHaveLength(0);
  });

  test("a shard that timed out skips the remaining shards, with an ::error::, and fails the run", async () => {
    const lines: string[] = [];
    const run = playing([{ code: 1, hung: true }, pass, pass]);
    expect(await runShards(PLAN, run.runShard, (line) => lines.push(line))).toBe(1);
    expect(run.ran).toEqual(["shard 1 of 3"]);
    expect(lines.some((l) => l.startsWith("::error::") && l.includes("remaining 2 shards will not run"))).toBe(true);
    expect(lines.filter((l) => l.includes("./a.test.ts") || l.includes("./d.test.ts"))).toHaveLength(2);
  });

  test("a timeout in the last shard has nothing left to skip", async () => {
    const lines: string[] = [];
    const run = playing([pass, pass, { code: 1, hung: true }]);
    expect(await runShards(PLAN, run.runShard, (line) => lines.push(line))).toBe(1);
    expect(run.ran).toHaveLength(3);
    expect(lines.some((l) => l.includes("will not run"))).toBe(false);
  });

  test("a single run has no shard banner, and is labelled `the run`", async () => {
    const lines: string[] = [];
    const run = playing([{ code: 2, hung: false }]);
    expect(await runShards([["./studio"]], run.runShard, (line) => lines.push(line))).toBe(2);
    expect(run.ran).toEqual(["the run"]);
    expect(lines.some((l) => l.includes("=="))).toBe(false);
  });
});

describe("runOnce", () => {
  const HUNG = [process.execPath, "-e", "setInterval(() => {}, 1e6)"];

  test("kills a hung child, reports it timed out, and returns", async () => {
    const started = Date.now();
    const result = await runOnce({ command: HUNG, env: process.env, timeoutMs: 300, graceMs: 300, echo: false });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("a grandchild that keeps the pipe open cannot pin the attempt after the child is killed", async () => {
    const holder = [
      process.execPath,
      "-e",
      // The grandchild inherits stdout and outlives its parent, but ends by itself in 6 s so the test leaves nothing behind.
      `Bun.spawn([process.execPath, "-e", "setTimeout(() => process.exit(0), 6000)"], { stdout: "inherit" }); setInterval(() => {}, 1e6)`,
    ];
    const started = Date.now();
    const result = await runOnce({ command: holder, env: process.env, timeoutMs: 500, graceMs: 300, echo: false });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  test("collects the output of a child that finishes on its own", async () => {
    const result = await runOnce({ command: [process.execPath, "-e", "console.log('hello'); process.exit(3)"], env: process.env, timeoutMs: 10_000, graceMs: 300, echo: false });
    expect(result).toMatchObject({ exitCode: 3, timedOut: false });
    expect(result.output).toContain("hello");
  });

  test("keeps stdout and stderr apart, so a partial stdout line cannot glue onto a `(fail)` line", async () => {
    const script = "process.stdout.write('partial'); await new Promise((r) => setTimeout(r, 150)); process.stderr.write('(fail) a > b\\n'); process.exit(1)";
    const result = await runOnce({ command: [process.execPath, "-e", script], env: process.env, timeoutMs: 10_000, graceMs: 300, echo: false });
    expect(result.output).toMatch(/^\(fail\) a > b$/m);
    expect(isBunCrashOnly(`${result.output}\n${CRASH}`)).toBe(false);
  });
});

describe("retry warnings", () => {
  test("every retry is announced as a ::warning:: annotation with the attempt number", async () => {
    const lines: string[] = [];
    const crash = { exitCode: 133, output: `${CRASH}\n` };
    let n = 0;
    await runWithCrashRetry(async () => (n++ < 2 ? crash : { exitCode: 0, output: "" }), { warn: (line) => lines.push(line) });
    expect(lines.filter((l) => l.startsWith("::warning::"))).toHaveLength(2);
    expect(lines[0]).toContain("attempt 1 of 3");
  });

  test("the warning names the shard when the run has a label", async () => {
    const lines: string[] = [];
    let n = 0;
    await runWithCrashRetry(async () => (n++ < 1 ? { exitCode: 133, output: `${CRASH}\n` } : { exitCode: 0, output: "" }), { warn: (line) => lines.push(line), label: "shard 2 of 3" });
    expect(lines[0]).toContain("shard 2 of 3: Bun crashed");
  });

  test("a retry limited to known crashes does not retry an unknown one", async () => {
    let n = 0;
    const unknown = { exitCode: 133, output: "panic: Segmentation fault at address 0x7FFF1234\noh no: Bun has crashed." };
    const code = await runWithCrashRetry(async () => (n++, unknown), { signatures: WORKER_TEARDOWN_CRASHES, warn: () => undefined });
    expect(code).toBe(133);
    expect(n).toBe(1);
  });

  test("a retry limited to known crashes retries a known one", async () => {
    let n = 0;
    const known = { exitCode: 133, output: "panic: Segmentation fault at address 0x18\noh no: Bun has crashed." };
    const code = await runWithCrashRetry(async () => (n++ === 0 ? known : { exitCode: 0, output: "" }), { signatures: WORKER_TEARDOWN_CRASHES, warn: () => undefined });
    expect(code).toBe(0);
    expect(n).toBe(2);
  });
});

/** Retries announce themselves on stdout as `::warning::` annotations; a test must not raise one in the real run's log. */
const quiet = { warn: () => undefined };

describe("runWithCrashRetry", () => {
  const ok = { exitCode: 0, output: " 8 pass\n 0 fail" };
  const crash = { exitCode: 133, output: `${CRASH}\n` };
  const failure = { exitCode: 1, output: "(fail) something > broke\n 7 pass\n 1 fail" };

  /** An attempt runner that plays these results in order and counts its calls. */
  function playing(results: { exitCode: number; output: string; timedOut?: boolean }[]) {
    const calls = { n: 0 };
    return {
      calls,
      attempt: async () => {
        const next = results[calls.n++];
        if (next === undefined) throw new Error("more attempts than the script allows");
        return next;
      },
    };
  }

  test("a clean first run passes with one attempt", async () => {
    const run = playing([ok]);
    expect(await runWithCrashRetry(run.attempt, quiet)).toBe(0);
    expect(run.calls.n).toBe(1);
  });

  test("a real failure fails at once and is never retried into a pass", async () => {
    const run = playing([failure, ok]);
    expect(await runWithCrashRetry(run.attempt, quiet)).toBe(1);
    expect(run.calls.n).toBe(1);
  });

  test("a Bun crash with no failed test is retried, and a clean second run passes", async () => {
    const run = playing([crash, ok]);
    expect(await runWithCrashRetry(run.attempt, quiet)).toBe(0);
    expect(run.calls.n).toBe(2);
  });

  test("a crash that follows a failed test is not retried", async () => {
    const run = playing([{ exitCode: 133, output: `${failure.output}\n${CRASH}` }, ok]);
    expect(await runWithCrashRetry(run.attempt, quiet)).toBe(133);
    expect(run.calls.n).toBe(1);
  });

  test("a real failure on the retry fails there, without a third attempt", async () => {
    const run = playing([crash, failure, ok]);
    expect(await runWithCrashRetry(run.attempt, quiet)).toBe(1);
    expect(run.calls.n).toBe(2);
  });

  test("three crashes in a row fail with the last exit code, after exactly three attempts", async () => {
    const run = playing([crash, crash, crash, ok]);
    expect(await runWithCrashRetry(run.attempt, quiet)).toBe(133);
    expect(run.calls.n).toBe(MAX_ATTEMPTS);
  });

  test("an attempt that ran out of time fails at once even if its output looks like a crash", async () => {
    const run = playing([{ ...crash, timedOut: true }, ok]);
    expect(await runWithCrashRetry(run.attempt, quiet)).not.toBe(0);
    expect(run.calls.n).toBe(1);
  });

  test("a non-zero exit with no output at all is not a known crash and is not retried", async () => {
    const run = playing([{ exitCode: 2, output: "" }, ok]);
    expect(await runWithCrashRetry(run.attempt, quiet)).toBe(2);
    expect(run.calls.n).toBe(1);
  });

  test("says so on each retry", async () => {
    const lines: string[] = [];
    await runWithCrashRetry(playing([crash, crash, ok]).attempt, { warn: (line) => lines.push(line) });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("attempt 1 of 3");
    expect(lines[1]).toContain("attempt 2 of 3");
  });

  test("by default the warning goes to stdout, where a GitHub annotation is read, not to stderr", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const log = console.log;
    const warn = console.warn;
    console.log = (...args: unknown[]) => void out.push(args.join(" "));
    console.warn = (...args: unknown[]) => void err.push(args.join(" "));
    try {
      await runWithCrashRetry(playing([crash, ok]).attempt);
    } finally {
      console.log = log;
      console.warn = warn;
    }
    expect(out.filter((l) => l.startsWith("::warning::"))).toHaveLength(1);
    expect(err).toEqual([]);
  });
});

describe("slow test warnings", () => {
  const REPORT = [
    "bun test v1.3.12 (700fc117)",
    "",
    "studio/engine/a.test.ts:",
    "(pass) fast one [12.00ms]",
    "(pass) exactly at the limit [5000.00ms]",
    "(pass) just under the limit [4999.99ms]",
    "(pass) a stalled one [7.25s]",
    "",
    "studio/engine/b.test.ts:",
    "(fail) a slow failure [6100.00ms]",
    "(pass) a slow one in seconds [12.5s]",
    "",
    " 5 pass",
    "Ran 5 tests across 2 files. [30.00s]",
  ].join("\n");

  test("the limit is 5 s", () => {
    expect(SLOW_TEST_WARNING_MS).toBe(5_000);
  });

  test("finds every test at or over the limit, slowest first, with the file above it (a test just under is not slow)", () => {
    expect(slowTests(REPORT)).toEqual([
      { file: "studio/engine/b.test.ts", name: "a slow one in seconds", ms: 12_500 },
      { file: "studio/engine/a.test.ts", name: "a stalled one", ms: 7_250 },
      { file: "studio/engine/b.test.ts", name: "a slow failure", ms: 6_100 },
      { file: "studio/engine/a.test.ts", name: "exactly at the limit", ms: 5_000 },
    ]);
  });

  test("reads a file header under GitHub Actions' group marker, colours and CRLF lines", () => {
    const output = "::group::studio\\engine\\w.test.ts:\r\n\u001b[32m(pass)\u001b[0m x [9.00s]\r\n";
    expect(slowTests(output)).toEqual([{ file: "studio\\engine\\w.test.ts", name: "x", ms: 9_000 }]);
  });

  test("a test name that contains brackets and a time is read whole", () => {
    expect(slowTests("(pass) a > b [1.00s] then [8.00s]")).toEqual([{ file: undefined, name: "a > b [1.00s] then", ms: 8_000 }]);
  });

  test("no slow test, no output, no warning", () => {
    expect(slowTests("(pass) x [4.00s]")).toEqual([]);
    expect(slowTests("")).toEqual([]);
    expect(slowTestWarnings([])).toEqual([]);
  });

  test("a warning names the shard, the time, the file and the test, and a name cannot break the annotation", () => {
    const [line, ...rest] = slowTestWarnings([{ file: "studio/x.test.ts", name: "50% done\nsecond line", ms: 7_250 }], "shard 2 of 3");
    expect(rest).toEqual([]);
    expect(line).toBe("::warning::realWorkerTests: shard 2 of 3: slow test, 7.3 s (over 5 s): studio/x.test.ts > 50%25 done%0Asecond line");
  });

  test("past ten slow tests the rest are counted in one line", () => {
    const many = Array.from({ length: 13 }, (_unused, i) => ({ file: undefined, name: `t${i}`, ms: 6_000 + i }));
    const lines = slowTestWarnings(many);
    expect(lines).toHaveLength(11);
    expect(lines[10]).toBe("::warning::realWorkerTests: 3 more slow tests not listed");
  });
});
