import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { looksLikeAStackTrace } from "./stackTrace";

describe("looksLikeAStackTrace", () => {
  test("flags real stderr from an uncaught exception thrown at the top level of a child process", () => {
    // Real output, not a fabricated string: what bun itself prints for an
    // unhandled throw, the exact shape the production smoke check must catch
    // if the remote-debugging refusal ever regresses into a crash.
    const result = spawnSync("bun", ["-e", 'throw new Error("stack-trace-test-boom")'], { encoding: "utf8" });
    expect(result.stderr).toContain("stack-trace-test-boom");
    expect(looksLikeAStackTrace(result.stderr)).toBe(true);
  });

  // The packaged app's main process is Node (Electron), so its crash output is
  // what the production smoke really reads.
  test.skipIf(Bun.which("node") === null)("flags real stderr from an uncaught exception in node", () => {
    const result = spawnSync("node", ["-e", 'throw new Error("stack-trace-test-boom")'], { encoding: "utf8" });
    expect(result.stderr).toContain("stack-trace-test-boom");
    expect(looksLikeAStackTrace(result.stderr)).toBe(true);
  });

  test("flags a trace whose only frame is a bare location, with no function name in parentheses", () => {
    // Newer bun prints just the user frame for a top-level throw.
    const bunTopLevel = 'error: boom\n      at /home/runner/work/app/[eval]:1:11\n\nBun v1.3.13 (Linux x64)\n';
    const nodeTopLevel = "[eval]:1\nthrow new Error(\"boom\")\n^\n\nError: boom\n    at [eval]:1:7\n";
    expect(looksLikeAStackTrace(bunTopLevel)).toBe(true);
    expect(looksLikeAStackTrace(nodeTopLevel)).toBe(true);
  });

  test("flags a Windows frame", () => {
    expect(looksLikeAStackTrace("Error: boom\n    at Object.<anonymous> (C:\\app\\resources\\app.asar\\main.js:12:5)\n")).toBe(true);
    expect(looksLikeAStackTrace("Error: boom\r\n    at C:\\app\\resources\\app.asar\\main.js:12:5\r\n")).toBe(true);
  });

  test("does not flag the clean one-line refusal message", () => {
    const clean = "studio: ignoring --remote-debugging-port/--remote-debugging-pipe/--remote-debugging-address (production build)\n";
    expect(looksLikeAStackTrace(clean)).toBe(false);
  });

  test("does not flag other clean, single-line console output", () => {
    expect(looksLikeAStackTrace("Studio engine smoke test — production check, the package\n")).toBe(false);
  });

  test("does not flag prose that merely contains the word at", () => {
    expect(looksLikeAStackTrace("studio: the engine is at 3:05 of its warm-up\n  at the start of the run\n")).toBe(false);
  });
});
