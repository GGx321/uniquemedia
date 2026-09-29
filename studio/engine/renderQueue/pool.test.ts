import { describe, expect, test } from "bun:test";
import { PEAK_RSS_BYTES, renderPoolSize } from "./pool";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

const GIB = 1024 ** 3;

describe("renderPoolSize, «Авто»", () => {
  // SP1's five machine rows (plan, "Render pipeline").
  const rows: Array<[string, number, number, number]> = [
    ["the owner's Mac: 14 cores, 36 GiB", 14, 36 * GIB, 4],
    ["16 GiB with 8 cores", 8, 16 * GIB, 3],
    ["16 GiB with 4 cores", 4, 16 * GIB, 1],
    ["8 GiB with 8 cores", 8, 8 * GIB, 2],
    ["8 GiB with 4 cores", 4, 8 * GIB, 1],
  ];
  for (const [name, cores, totalMem, expected] of rows) {
    test(`gives ${expected} on ${name}`, () => {
      expect(renderPoolSize("auto", { cores, totalMem })).toBe(expected);
    });
  }

  test("peakRSS is 768 MiB", () => {
    expect(PEAK_RSS_BYTES).toBe(768 * 1024 * 1024);
  });

  test("never goes above 4, however many cores and however much memory", () => {
    expect(renderPoolSize("auto", { cores: 128, totalMem: 1024 * GIB })).toBe(4);
  });

  test("gives 1 for a tiny total memory", () => {
    expect(renderPoolSize("auto", { cores: 16, totalMem: 1 })).toBe(1);
    expect(renderPoolSize("auto", { cores: 16, totalMem: 0 })).toBe(1);
  });

  test("gives 1 for one core or none", () => {
    expect(renderPoolSize("auto", { cores: 1, totalMem: 64 * GIB })).toBe(1);
    expect(renderPoolSize("auto", { cores: 0, totalMem: 64 * GIB })).toBe(1);
  });

  test("gives 1 when the machine reports nothing usable", () => {
    expect(renderPoolSize("auto", { cores: Number.NaN, totalMem: Number.NaN })).toBe(1);
    expect(renderPoolSize("auto", { cores: -3, totalMem: -1 })).toBe(1);
    expect(renderPoolSize("auto", { cores: Number.POSITIVE_INFINITY, totalMem: Number.POSITIVE_INFINITY })).toBe(4);
  });

  test("steps up exactly when the memory term does: 2 x peakRSS x 4 of RAM buys the second job", () => {
    const need = (jobs: number): number => (jobs * PEAK_RSS_BYTES) / 0.25;
    expect(renderPoolSize("auto", { cores: 16, totalMem: need(2) - 1 })).toBe(1);
    expect(renderPoolSize("auto", { cores: 16, totalMem: need(2) })).toBe(2);
  });
});

describe("renderPoolSize, a fixed setting", () => {
  test("is the number the owner picked, whatever the machine", () => {
    expect(renderPoolSize(6, { cores: 2, totalMem: GIB })).toBe(6);
    expect(renderPoolSize(1, { cores: 64, totalMem: 128 * GIB })).toBe(1);
  });

  test("is never 0 or above 8, even for a value the contract would have refused", () => {
    expect(renderPoolSize(0, { cores: 8, totalMem: 16 * GIB })).toBe(1);
    expect(renderPoolSize(99, { cores: 8, totalMem: 16 * GIB })).toBe(8);
    expect(renderPoolSize(2.7, { cores: 8, totalMem: 16 * GIB })).toBe(2);
  });
});
