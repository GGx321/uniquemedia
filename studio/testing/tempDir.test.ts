import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tempDirFor, type TempDirHooks } from "./tempDir";

/** Hooks the test drives by hand, so the helper is exercised without a runner underneath it. */
function manualHooks(): { hooks: TempDirHooks; before(): Promise<void>; after(): Promise<void> } {
  const befores: Array<() => Promise<void>> = [];
  const afters: Array<() => Promise<void>> = [];
  return {
    hooks: { beforeEach: (run) => befores.push(run), afterEach: (run) => afters.push(run) },
    before: async () => {
      for (const run of befores) await run();
    },
    after: async () => {
      for (const run of afters) await run();
    },
  };
}

describe("tempDirFor", () => {
  test("a fresh folder per run of the hooks, removed after with what was written in it", async () => {
    const h = manualHooks();
    const dir = tempDirFor(h.hooks, "studio-tempdir-test-");
    await h.before();
    const first = dir();
    await writeFile(join(first, "a.txt"), "a");
    expect(existsSync(first)).toBe(true);
    expect(first).toContain("studio-tempdir-test-");

    await h.after();
    expect(existsSync(first)).toBe(false);

    await h.before();
    expect(dir()).not.toBe(first);
    await h.after();
  });

  test("tracked work settles before the folder goes: a slow setup still finds its folder, and a failed one does not block the cleanup", async () => {
    const h = manualHooks();
    const dir = tempDirFor(h.hooks, "studio-tempdir-test-");
    await h.before();
    const folder = dir();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const outcome: { wrote: "yes" | "no" | "pending" } = { wrote: "pending" };
    const slow = dir.track(
      gate.then(async () => {
        await writeFile(join(folder, "late.txt"), "late").then(
          () => (outcome.wrote = "yes"),
          () => (outcome.wrote = "no"),
        );
      }),
    );
    dir.track(Promise.reject(new Error("a setup that failed"))).catch(() => undefined);

    const cleaning = h.after();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(existsSync(folder)).toBe(true); // still there: the setup has not settled
    release();
    await slow;
    await cleaning;

    expect(outcome.wrote).toBe("yes");
    expect(existsSync(folder)).toBe(false);
  });

  test("track hands the promise back unchanged", async () => {
    const h = manualHooks();
    const dir = tempDirFor(h.hooks, "studio-tempdir-test-");
    await h.before();
    const work = Promise.resolve(42);
    expect(dir.track(work)).toBe(work);
    expect(await work).toBe(42);
    await h.after();
  });
});
