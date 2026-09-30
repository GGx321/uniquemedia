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
  runOnce,
  runShards,
  runWithCrashRetry,
  shardedTestArgs,
  WINDOWS_COMMAND_LINE_LIMIT,
  shardFiles,
  testTarget,
  WORKER_TEARDOWN_CRASHES,
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

describe("the Electron-Node steps' bounds", () => {
  const ROOT = join(import.meta.dir, "..", "..");

  // electronNodeTests.ts kills a suite past SUITE_TIMEOUT_MS and runs the suites one after another, so a step that
  // hangs in its last suite is still bounded by the runner itself only if the step's own limit is above all of them.
  test("every workflow step that runs the suites has a timeout-minutes above suites x the suite bound, and the script exists", async () => {
    const scripts = scriptsOf(JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")));
    expect(scripts["test:studio:electron-node"]).toContain("electronNodeTests.ts");
    const workflow = await readFile(join(ROOT, ".github", "workflows", "studio.yml"), "utf8");
    const steps = [...workflow.matchAll(/run: bun run test:studio:electron-node\r?\n\s+timeout-minutes: (\d+)/g)];
    expect(steps).toHaveLength(2); // the build job and the canary
    for (const step of steps) expect(Number(step[1])).toBeGreaterThan((NODE_TEST_SUITES.length * SUITE_TIMEOUT_MS) / 60_000);
  });
});

describe("the workflow's concurrency rule", () => {
  const ROOT = join(import.meta.dir, "..", "..");

  // A branch run that a newer one supersedes is cancelled. A main push or a tag run never is, and never shares a
  // group with another run: GitHub drops an older PENDING run of a shared group even with cancel-in-progress off.
  test("cancels only non-main, non-tag refs, and gives main and tag runs a group of their own", async () => {
    const workflow = await readFile(join(ROOT, ".github", "workflows", "studio.yml"), "utf8");
    const block = /^concurrency:\r?\n((?:[ \t]+.*\r?\n)+)/m.exec(workflow)?.[1] ?? "";
    const group = /^\s+group: (.*)$/m.exec(block)?.[1] ?? "";
    const cancel = /^\s+cancel-in-progress: (.*)$/m.exec(block)?.[1] ?? "";
    expect(group).toContain("github.workflow");
    expect(group).toContain("github.ref");
    expect(group).toContain("github.run_id");
    expect(group).toContain("refs/heads/main");
    expect(group).toContain("refs/tags/");
    expect(cancel).toContain("github.ref != 'refs/heads/main'");
    expect(cancel).toContain("!startsWith(github.ref, 'refs/tags/')");
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
