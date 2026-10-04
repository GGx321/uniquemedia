import { describe, expect, test } from "bun:test";
import { until as harnessUntil } from "../../testing/engineHarness";
import { until } from "./serviceKit";

// serviceKit used to keep its own copy of `until` with a 5 s ceiling, and missed the raise to 15 s that the harness's got for slow
// Windows runners; it is the harness's function now, so the two cannot drift again.
describe("serviceKit's until", () => {
  test("is the engine harness's until, with its 15 s ceiling", () => {
    expect(until).toBe(harnessUntil);
  });

  test("a condition that already holds returns at once, not after the ceiling", async () => {
    const started = Date.now();
    await until(() => true, "nothing");
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("a condition that becomes true after a moment returns shortly after it, and one that never does names what it waited for", async () => {
    let ready = false;
    setTimeout(() => {
      ready = true;
    }, 30);
    const started = Date.now();
    await until(() => ready, "the flag");
    expect(Date.now() - started).toBeLessThan(2_000);
    await expect(until(() => false, "the never", 50)).rejects.toThrow("timed out waiting for the never");
  });
});
