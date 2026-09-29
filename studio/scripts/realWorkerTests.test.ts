import { describe, expect, test } from "bun:test";
import { childEnv, isBunCrashOnly, MAX_ATTEMPTS, REAL_WORKER_TEST_FILE, runOnce, runWithCrashRetry, testTarget, WORKER_TEARDOWN_CRASHES } from "./realWorkerTests";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// T7c: the real-worker test file runs alone (studio/scripts/realWorkerTests.ts)
// because Bun itself segfaults in roughly 2% of runs while it tears down a
// worker running WASM. The runner retries ONLY on that crash signature, and
// never when a test actually failed — a real failure must never be retried
// into a pass.

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

  test("keeps the rest of the environment and enables the real-worker tests", () => {
    const env = childEnv({ PATH: "/usr/bin" });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.STUDIO_REAL_WORKER_TESTS).toBe("1");
  });

  test("for the main suite leaves the real-worker tests off, even when the parent had them on, so the gated file keeps skipping itself", () => {
    const env = childEnv({ PATH: "/usr/bin", STUDIO_REAL_WORKER_TESTS: "1" }, { realWorker: false });
    expect("STUDIO_REAL_WORKER_TESTS" in env).toBe(false);
    expect(env.NO_COLOR).toBe("1");
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
  test("with no arguments runs the real-worker file with the real-worker tests on", () => {
    expect(testTarget([])).toEqual({ testArgs: [REAL_WORKER_TEST_FILE], realWorker: true, knownCrashesOnly: false });
  });

  test("--suite runs exactly the bun test arguments after it, real-worker tests off, any crash retried", () => {
    expect(testTarget(["--suite", "./studio", "--randomize"])).toEqual({ testArgs: ["./studio", "--randomize"], realWorker: false, knownCrashesOnly: false });
  });

  test("--known-crashes-only before --suite narrows the retry to the worker-teardown crashes", () => {
    expect(testTarget(["--known-crashes-only", "--suite", "./studio"])).toEqual({ testArgs: ["./studio"], realWorker: false, knownCrashesOnly: true });
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

  test("a retry limited to known crashes does not retry an unknown one", async () => {
    let n = 0;
    const unknown = { exitCode: 133, output: "panic: Segmentation fault at address 0x7FFF1234\noh no: Bun has crashed." };
    const code = await runWithCrashRetry(async () => (n++, unknown), { signatures: WORKER_TEARDOWN_CRASHES });
    expect(code).toBe(133);
    expect(n).toBe(1);
  });

  test("a retry limited to known crashes retries a known one", async () => {
    let n = 0;
    const known = { exitCode: 133, output: "panic: Segmentation fault at address 0x18\noh no: Bun has crashed." };
    const code = await runWithCrashRetry(async () => (n++ === 0 ? known : { exitCode: 0, output: "" }), { signatures: WORKER_TEARDOWN_CRASHES });
    expect(code).toBe(0);
    expect(n).toBe(2);
  });
});

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
    expect(await runWithCrashRetry(run.attempt)).toBe(0);
    expect(run.calls.n).toBe(1);
  });

  test("a real failure fails at once and is never retried into a pass", async () => {
    const run = playing([failure, ok]);
    expect(await runWithCrashRetry(run.attempt)).toBe(1);
    expect(run.calls.n).toBe(1);
  });

  test("a Bun crash with no failed test is retried, and a clean second run passes", async () => {
    const run = playing([crash, ok]);
    expect(await runWithCrashRetry(run.attempt)).toBe(0);
    expect(run.calls.n).toBe(2);
  });

  test("a crash that follows a failed test is not retried", async () => {
    const run = playing([{ exitCode: 133, output: `${failure.output}\n${CRASH}` }, ok]);
    expect(await runWithCrashRetry(run.attempt)).toBe(133);
    expect(run.calls.n).toBe(1);
  });

  test("a real failure on the retry fails there, without a third attempt", async () => {
    const run = playing([crash, failure, ok]);
    expect(await runWithCrashRetry(run.attempt)).toBe(1);
    expect(run.calls.n).toBe(2);
  });

  test("three crashes in a row fail with the last exit code, after exactly three attempts", async () => {
    const run = playing([crash, crash, crash, ok]);
    expect(await runWithCrashRetry(run.attempt)).toBe(133);
    expect(run.calls.n).toBe(MAX_ATTEMPTS);
  });

  test("an attempt that ran out of time fails at once even if its output looks like a crash", async () => {
    const run = playing([{ ...crash, timedOut: true }, ok]);
    expect(await runWithCrashRetry(run.attempt)).not.toBe(0);
    expect(run.calls.n).toBe(1);
  });

  test("a non-zero exit with no output at all is not a known crash and is not retried", async () => {
    const run = playing([{ exitCode: 2, output: "" }, ok]);
    expect(await runWithCrashRetry(run.attempt)).toBe(2);
    expect(run.calls.n).toBe(1);
  });

  test("says so on each retry", async () => {
    const lines: string[] = [];
    await runWithCrashRetry(playing([crash, crash, ok]).attempt, { warn: (line) => lines.push(line) });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("attempt 1 of 3");
    expect(lines[1]).toContain("attempt 2 of 3");
  });
});
