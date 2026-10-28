import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ATTEMPT_TIMEOUT_MS,
  childEnv,
  HEAVY_TEST_FILE,
  isBunCrashOnly,
  listTestFiles,
  loadFileTimes,
  MAX_ATTEMPTS,
  commandLineLength,
  DEFAULT_TEST_TIMEOUT_MS,
  parseFileTimes,
  runOnce,
  runShards,
  runWithCrashRetry,
  selectShard,
  selectTierShard,
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

  test("is false when a test failed, even if Bun also crashed afterwards", () => {
    expect(isBunCrashOnly(`(fail) the real face worker > two\n${CRASH}`)).toBe(false);
  });

});

// CI-5: on Windows the suite runs as parallel jobs, each running ONE shard of N (`--shard=I/N`). Every job computes the partition on
// its own, from the same sorted file list, so it only has to be deterministic; what must hold is that the N jobs together run every
// test file exactly once.

describe("running one shard of N", () => {
  const ROOT = join(import.meta.dir, "..", "..");
  const PLAN = [
    ["--randomize", "./a.test.ts"],
    ["--randomize", "./b.test.ts"],
    ["--randomize", "./c.test.ts"],
  ];

  // The proof that no file is skipped or run twice: for either table (Windows' and macOS's times), every job's selection of the real
  // ./studio tree together is exactly its blocking file list: every test file but the *.heavy.test.* ones, which the heavy tier runs.
  for (const platform of ["win32", "darwin"] as const) {
    for (const count of [3, 4, 5, 6, 8, 12]) {
      test(`the ${count} jobs' shards of the real ./studio tree, dealt by ${platform}'s times, together run every blocking test file exactly once`, async () => {
        const all = (await listTestFiles(["./studio"], ROOT)).filter((file) => !HEAVY_TEST_FILE.test(file));
        const plan = await shardedTestArgs(["./studio", "--randomize"], count, ROOT, await loadFileTimes(platform));
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
  }

  test("two independent computations of the partition (two jobs) agree", async () => {
    const times = await loadFileTimes("win32");
    expect(await shardedTestArgs(["./studio"], 12, ROOT, times)).toEqual(await shardedTestArgs(["./studio"], 12, ROOT, times));
  });

  // The measured times are what the balance is for: Windows' 12 shards ran from 115 to 601 s and macOS's 4 from 468 to 761 s when the
  // files were dealt round-robin by name. A table whose paths no longer match the tree's (a moved tree, a key format that drifted) would
  // quietly fall back to dealing by count: nine files in ten must be known.

  test("every *.heavy.test.* file of the real tree, which the blocking run leaves out, is in the heavy tier's run", async () => {
    const named = (await listTestFiles(["./studio"], ROOT)).filter((file) => HEAVY_TEST_FILE.test(file));
    const [heavyRun] = await tierTestArgs(["./studio"], "heavy", ROOT);
    for (const file of named) expect([file, heavyRun?.includes(file)]).toEqual([file, true]);
  });

  test("the heavy tier's 3 jobs' shards of the real ./studio tree together run every file of the heavy tier exactly once", async () => {
    const [whole] = await tierTestArgs(["./studio"], "heavy", ROOT);
    const files = (whole ?? []).filter((arg) => !arg.startsWith("-"));
    expect(files.length).toBeGreaterThan(0);
    const plan = await tierTestArgs(["./studio"], "heavy", ROOT, 3);
    const picked = [1, 2, 3].flatMap((index) => selectTierShard(plan, { index, of: 3 }).flatMap((args) => args.filter((arg) => !arg.startsWith("-"))));
    expect(new Set(picked).size).toBe(picked.length);
    expect([...picked].sort()).toEqual([...files].sort());
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

  test("shardedTestArgs leaves the *.heavy.test.* files out of the blocking run (the heavy tier runs them), whatever the case or extension", async () => {
    const root = await tree(["studio/a.test.ts", "studio/c.test.ts"]);
    await writeFile(join(root, "studio", "b.heavy.test.ts"), 'heavyTest("slow", () => {});');
    await writeFile(join(root, "studio", "d.HEAVY.spec.tsx"), 'describe("[heavy] all of it", () => { test("x", () => {}); });');
    expect(await shardedTestArgs(["./studio"], 2, root)).toEqual([["./studio/a.test.ts"], ["./studio/c.test.ts"]]);
  });

  test("a sweepTest counts as a heavy test: a *.heavy.test.* file made of sweeps is accepted, and the blocking run leaves it out", async () => {
    const root = await tree(["studio/a.test.ts", "studio/c.test.ts"]);
    await writeFile(join(root, "studio", "b.heavy.test.ts"), 'sweepTest("seeds", { push: 1, heavy: 2 }, () => {});');
    expect(await shardedTestArgs(["./studio"], 2, root)).toEqual([["./studio/a.test.ts"], ["./studio/c.test.ts"]]);
  });

  test("shardedTestArgs refuses a *.heavy.test.* file with a test outside the heavy tier, or with no heavy test at all: that test would run nowhere", async () => {
    for (const source of ['test("plain", () => {});', 'heavyTest("slow", () => {});\ntest("plain", () => {});', ""]) {
      const root = await tree(["studio/a.test.ts"]);
      await writeFile(join(root, "studio", "b.heavy.test.ts"), source);
      await expect(shardedTestArgs(["./studio"], 2, root)).rejects.toThrow(/b\.heavy\.test\.ts .*run nowhere/);
    }
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

  test("opens a file whose only marker is a sweepTest in the heavy run, and not in the perf run", async () => {
    const root = await treeWith({ "studio/a.test.ts": 'sweepTest("seeds", { push: 1, heavy: 2 }, () => {});', "studio/b.test.ts": 'test("plain", () => {});' });
    expect(await tierTestArgs(["./studio"], "heavy", root)).toEqual([["--test-name-pattern=\\[heavy\\]", "./studio/a.test.ts"]]);
    expect(await tierTestArgs(["./studio"], "perf", root)).toEqual([]);
  });

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

  // The heavy tier runs as a matrix (`--shard=I/N`, CI): its files are dealt by count, since the table measures the blocking run, not the tier.

});

describe("the Electron-Node steps' bounds", () => {
  const ROOT = join(import.meta.dir, "..", "..");

  // electronNodeTests.ts kills a suite past SUITE_TIMEOUT_MS and runs the suites one after another, so a step that
  // hangs in its last suite is still bounded by the runner itself only if the step's own limit is above all of them.

  // The shared contract's typecheck used to be two tests that each spawned tsc on studio/shared/tsconfig.json; it is a workflow step now (CI-4).

  // A tier run (STUDIO_TEST_TIER, studio/testing/tiers.ts) is one `bun test` process, or one shard of a matrix (the heavy tier): it may
  // crash and retry like a shard, so its step needs attempts x bound, and a tier job must set the variable for the steps that run it.

  // The perf tier never gates anything: its budgets are measurements (one read 786 ms of 800 on Windows).
  async function workflowJobs(): Promise<Record<string, Record<string, unknown>>> {
    const parsed: unknown = Bun.YAML.parse(await readFile(join(ROOT, ".github", "workflows", "studio.yml"), "utf8"));
    if (typeof parsed !== "object" || parsed === null || !("jobs" in parsed) || typeof parsed.jobs !== "object" || parsed.jobs === null) throw new Error("no jobs in the workflow");
    return Object.fromEntries(Object.entries(parsed.jobs).map(([name, job]) => [name, typeof job === "object" && job !== null ? Object.fromEntries(Object.entries(job)) : {}]));
  }

  // The bun suite runs as parallel jobs, one shard each: Windows (CI-5) and macOS (B0), and the heavy tier too. Nothing may go missing in
  // the move: `build` runs no bun suite, the blocking jobs run on build's trigger, and each job's matrix is exactly the shards 1..N of the
  // `--shard=I/N` its command line passes (together with realWorkerTests' own partition tests this is "every file once").

  // Owner decision 2026-10-05: the repo is public, so an installer uploaded as an artifact is downloadable by any logged-in GitHub user,
  // and the macOS ffmpeg-static build is GPL+nonfree. Nothing in the workflow (or in a local action it could call) may publish or
  // upload anything until a private distribution channel exists; these checks fail if a release job, an artifact transfer, a secret
  // or a write permission comes back.
  const PUBLISHERS = /actions\/upload-artifact|actions\/download-artifact|softprops\/action-gh-release/;

  // Every key and every string value of a parsed YAML document: what the runner would read, comments excluded.
  function yamlStrings(node: unknown, out: string[] = []): string[] {
    if (typeof node === "string") out.push(node);
    else if (Array.isArray(node)) for (const item of node) yamlStrings(item, out);
    else if (typeof node === "object" && node !== null) {
      for (const [key, value] of Object.entries(node)) {
        out.push(key);
        yamlStrings(value, out);
      }
    }
    return out;
  }

  // The files of every local action. A missing .github/actions is fine; any other scan error is not.
  async function localActionFiles(): Promise<{ file: string; text: string }[]> {
    const actionsDir = join(ROOT, ".github", "actions");
    let files: string[] = [];
    try {
      files = await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: actionsDir, onlyFiles: true }));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    return Promise.all(files.map(async (file) => ({ file, text: await readFile(join(actionsDir, file), "utf8") })));
  }

  test("nothing publishes: no release job, no artifact or release action in the workflow or in any local action", async () => {
    const workflow = await readFile(join(ROOT, ".github", "workflows", "studio.yml"), "utf8");
    const jobs = await workflowJobs();
    expect(jobs.release).toBeUndefined();
    expect(workflow).not.toMatch(PUBLISHERS);
    expect(workflow).not.toMatch(/\bgh\s+release\b/);
    // A local composite action is a way around the workflow text: scan every file under .github/actions too, for the same actions,
    // for `gh release`, and for anything artifact-shaped (upload-pages-artifact and the like).
    for (const { file, text } of await localActionFiles()) {
      expect([file, PUBLISHERS.test(text)]).toEqual([file, false]);
      expect([file, /\bgh\s+release\b/.test(text)]).toEqual([file, false]);
      expect([file, /artifact/i.test(text)]).toEqual([file, false]);
    }
    // No job needs an artifact another job would have to hand over.
    expect(Object.values(jobs).filter((job) => JSON.stringify(job.steps ?? []).includes("artifact"))).toEqual([]);
    // A job that `uses:` a reusable workflow is a way around the steps checked above: this workflow has none.
    expect(Object.entries(jobs).filter(([, job]) => job.uses !== undefined).map(([name]) => name)).toEqual([]);
  });

  test("no secret reaches the workflow, and the token is read-only everywhere", async () => {
    const workflow = await readFile(join(ROOT, ".github", "workflows", "studio.yml"), "utf8");
    const jobs = await workflowJobs();
    // No reference to the secrets context at all (`secrets.X`, `secrets['X']`, `toJSON(secrets)`, `secrets: inherit`): the workflow and its
    // local actions use none today, so any new one is a decision to review, not a drive-by. Parsed values and keys, so a comment may say it.
    const parsed: unknown = Bun.YAML.parse(workflow);
    expect(yamlStrings(parsed).filter((text) => /\bsecrets\b/i.test(text))).toEqual([]);
    for (const { file, text } of await localActionFiles()) {
      expect([file, yamlStrings(Bun.YAML.parse(text)).filter((value) => /\bsecrets\b/i.test(value))]).toEqual([file, []]);
    }
    if (typeof parsed !== "object" || parsed === null || !("permissions" in parsed)) throw new Error("no top-level permissions in the workflow");
    expect(parsed.permissions).toEqual({ contents: "read" });
    expect(Object.entries(jobs).filter(([, job]) => JSON.stringify(job.permissions ?? {}).includes("write")).map(([name]) => name)).toEqual([]);
  });

  test("no cache step holds node_modules or ffmpeg", async () => {
    for (const [name, job] of Object.entries(await workflowJobs())) {
      for (const step of (job.steps ?? []) as { uses?: string; with?: { path?: unknown } }[]) {
        if (step.uses?.startsWith("actions/cache")) expect([name, String(step.with?.path)]).toEqual([name, expect.not.stringMatching(/node_modules|ffmpeg/i)]);
      }
    }
  });

  test("the packaging never publishes: electron-builder runs with --publish never, no other --publish value exists, and the config has publish: null", async () => {
    const workflow = await readFile(join(ROOT, ".github", "workflows", "studio.yml"), "utf8");
    expect(workflow).toMatch(/bunx electron-builder --config electron-builder\.studio\.yml --publish never\r?$/m);
    // `-p` is electron-builder's short form of --publish: look at both, on the lines that run electron-builder.
    const values = workflow.split(/\r?\n/).filter((line) => line.includes("electron-builder")).flatMap((line) => [...line.matchAll(/(?<![\w-])(?:--publish|-p)[ =](\S+)/g)].map((m) => m[1]));
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) expect(value).toBe("never");
    const config = await readFile(join(ROOT, "electron-builder.studio.yml"), "utf8");
    expect(config).toMatch(/^publish: null\r?$/m);
  });

  // Nothing restored from a cache is executed: the one cache the workflow has holds the face models (hash-checked on every run), and a cache of
  // node_modules or of the ffmpeg binary is how an unchecked binary would come back.

  // ffmpeg-static's postinstall downloads its binary from GitHub on every install; one such download failed on main. Every job installs
  // through one composite action: a frozen install, one retry that first removes the package (a second plain `bun install` does not rerun
  // a failed postinstall), and a check that EXECUTES the binary (a presence check passes on a truncated download). No cache: nothing
  // restored from a cache is ever executed.

  // A push that touches only the local action changes how every job installs, so it must run this workflow (and its pins).

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

  test("three crashes in a row fail with the last exit code, after exactly three attempts", async () => {
    const run = playing([crash, crash, crash, ok]);
    expect(await runWithCrashRetry(run.attempt, quiet)).toBe(133);
    expect(run.calls.n).toBe(MAX_ATTEMPTS);
  });

});
