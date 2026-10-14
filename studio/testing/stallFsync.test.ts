import { describe, expect, test } from "bun:test";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stallNthFsync, stallNextFsync } from "./stallFsync";

async function timedSync(path: string): Promise<number> {
  const handle = await open(path, "w");
  const started = performance.now();
  await handle.sync();
  await handle.close();
  return performance.now() - started;
}

describe("stallNthFsync", () => {
  test("delays only the nth sync and counts every call", async () => {
    const dir = await mkdtemp(join(tmpdir(), "stall-fsync-"));
    const stall = await stallNthFsync({ nth: 2, ms: 120 });
    try {
      const first = await timedSync(join(dir, "a"));
      const second = await timedSync(join(dir, "b"));
      const third = await timedSync(join(dir, "c"));
      expect(first).toBeLessThan(100);
      expect(second).toBeGreaterThanOrEqual(110);
      expect(third).toBeLessThan(100);
      expect(stall.calls()).toBe(3);
      expect(stall.stalled()).toBe(true);
    } finally {
      stall.restore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("restore puts the original sync back: later calls are not counted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "stall-fsync-"));
    const stall = await stallNthFsync({ nth: 1, ms: 0 });
    stall.restore();
    try {
      await timedSync(join(dir, "a"));
      expect(stall.calls()).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects an nth that is not a positive integer", async () => {
    await expect(stallNthFsync({ nth: 0, ms: 1 })).rejects.toThrow("nth must be a positive integer");
  });
});

describe("stallNextFsync", () => {
  test("lets every sync before arm() through and stalls the first one after it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "stall-fsync-"));
    const stall = await stallNextFsync({ ms: 120 });
    try {
      const before = await timedSync(join(dir, "a"));
      expect(stall.stalled()).toBe(false);
      stall.arm();
      const armed = await timedSync(join(dir, "b"));
      const after = await timedSync(join(dir, "c"));
      expect(before).toBeLessThan(100);
      expect(armed).toBeGreaterThanOrEqual(110);
      expect(after).toBeLessThan(100);
      expect(stall.stalled()).toBe(true);
    } finally {
      stall.restore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("never stalls when arm() is not called", async () => {
    const dir = await mkdtemp(join(tmpdir(), "stall-fsync-"));
    const stall = await stallNextFsync({ ms: 120 });
    try {
      expect(await timedSync(join(dir, "a"))).toBeLessThan(100);
      expect(stall.stalled()).toBe(false);
    } finally {
      stall.restore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reports when the stalled sync was released, after the stall's length", async () => {
    const dir = await mkdtemp(join(tmpdir(), "stall-fsync-"));
    const stall = await stallNextFsync({ ms: 120 });
    try {
      expect(stall.releasedAt()).toBeNull();
      const armedAt = performance.now();
      stall.arm();
      await timedSync(join(dir, "a"));
      const released = stall.releasedAt();
      expect(released).not.toBeNull();
      expect((released ?? 0) - armedAt).toBeGreaterThanOrEqual(110);
    } finally {
      stall.restore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects a negative stall length", async () => {
    await expect(stallNextFsync({ ms: -1 })).rejects.toThrow("ms must be a non-negative number");
  });
});
