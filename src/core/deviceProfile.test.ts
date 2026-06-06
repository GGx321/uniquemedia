import { test, expect } from "bun:test";
import { sampleDeviceProfile } from "./deviceProfile";

const NOW = 1780000000000; // fixed reference time

test("deterministic for same seed and now", () => {
  expect(sampleDeviceProfile(42, NOW)).toEqual(sampleDeviceProfile(42, NOW));
});

test("different seeds vary", () => {
  const profiles = new Set<string>();
  for (let s = 0; s < 30; s++) profiles.add(JSON.stringify(sampleDeviceProfile(s, NOW)));
  expect(profiles.size).toBeGreaterThan(1);
});

test("model is a known iPhone 11..17 family, Apple, iOS 26", () => {
  for (let s = 0; s < 40; s++) {
    const p = sampleDeviceProfile(s, NOW);
    expect(p.make).toBe("Apple");
    expect(p.model).toMatch(/^iPhone 1[1-7]( (mini|Plus|Pro|Pro Max))?$/);
    expect(p.software).toMatch(/^26\./);
  }
});

test("creationLocal has tz offset; creationUtc is Z and in the past", () => {
  const p = sampleDeviceProfile(7, NOW);
  expect(p.creationLocal).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{4}$/);
  expect(p.creationUtc).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000000Z$/);
  expect(Date.parse(p.creationUtc)).toBeLessThan(NOW);
});

test("gpsISO6709 is signed fixed-width format", () => {
  const p = sampleDeviceProfile(3, NOW);
  expect(p.gpsISO6709).toMatch(/^[+-]\d{2}\.\d{4}[+-]\d{3}\.\d{4}[+-]\d{3}\.\d{3}\/$/);
});
