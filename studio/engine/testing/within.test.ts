import { describe, expect, test } from "bun:test";
import { within } from "./within";

describe("within: a promise a test awaits has a bound", () => {
  test("resolves with the value of a promise that settles in time", async () => {
    expect(await within(Promise.resolve(7), 1000, "a value")).toBe(7);
  });

  test("passes the rejection of the promise through unchanged", async () => {
    const boom = new Error("boom");
    await expect(within(Promise.reject(boom), 1000, "a failure")).rejects.toBe(boom);
  });

  test("rejects with the label and the bound when the promise never settles", async () => {
    const never = new Promise<void>(() => undefined);
    await expect(within(never, 25, "the drain")).rejects.toThrow("timed out after 25 ms waiting for the drain");
  });

  test("leaves no timer behind once the promise has settled", async () => {
    const real = globalThis.setTimeout;
    const live = new Set<unknown>();
    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      const id = real(fn, ms);
      live.add(id);
      return id;
    }) as unknown as typeof setTimeout;
    const realClear = globalThis.clearTimeout;
    globalThis.clearTimeout = ((id: Parameters<typeof clearTimeout>[0]) => {
      live.delete(id);
      realClear(id);
    }) as typeof clearTimeout;
    try {
      await within(Promise.resolve(), 60_000, "something quick");
      expect(live.size).toBe(0);
    } finally {
      globalThis.setTimeout = real;
      globalThis.clearTimeout = realClear;
    }
  });
});
