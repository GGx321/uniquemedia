import { describe, expect, test } from "bun:test";
import { isBunCrashOnly } from "./realWorkerTests";

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
});
