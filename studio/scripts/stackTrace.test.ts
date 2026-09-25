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

  test("does not flag the clean one-line refusal message", () => {
    const clean = "studio: ignoring --remote-debugging-port/--remote-debugging-pipe/--remote-debugging-address (production build)\n";
    expect(looksLikeAStackTrace(clean)).toBe(false);
  });

  test("does not flag other clean, single-line console output", () => {
    expect(looksLikeAStackTrace("Studio engine smoke test — production check, the package\n")).toBe(false);
  });
});
