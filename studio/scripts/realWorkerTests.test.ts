import { describe, expect, test } from "bun:test";
import { childEnv, isBunCrashOnly, MAX_ATTEMPTS, REAL_WORKER_TEST_FILE, runWithCrashRetry, testTarget } from "./realWorkerTests";
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

describe("testTarget", () => {
  test("with no arguments runs the real-worker file with the real-worker tests on", () => {
    expect(testTarget([])).toEqual({ testArgs: [REAL_WORKER_TEST_FILE], realWorker: true });
  });

  test("with arguments runs exactly those bun test arguments, real-worker tests off", () => {
    expect(testTarget(["./studio", "--randomize"])).toEqual({ testArgs: ["./studio", "--randomize"], realWorker: false });
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
