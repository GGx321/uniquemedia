import { test, expect } from "bun:test";
import { sampleDeviceProfile } from "./deviceProfile";

const NOW = 1780000000000; // same fixed reference time as deviceProfile.test.ts

/** Every model string `sampleDeviceProfile` can draw. Kept local so a silent
 *  edit to the MODELS table shows up here as a missing camera entry. */
const ALL_MODELS = [
  "iPhone 11", "iPhone 11 Pro", "iPhone 11 Pro Max",
  "iPhone 12 mini", "iPhone 12", "iPhone 12 Pro", "iPhone 12 Pro Max",
  "iPhone 13 mini", "iPhone 13", "iPhone 13 Pro", "iPhone 13 Pro Max",
  "iPhone 14", "iPhone 14 Plus", "iPhone 14 Pro", "iPhone 14 Pro Max",
  "iPhone 15", "iPhone 15 Plus", "iPhone 15 Pro", "iPhone 15 Pro Max",
  "iPhone 16", "iPhone 16 Plus", "iPhone 16 Pro", "iPhone 16 Pro Max",
  "iPhone 17", "iPhone 17 Pro", "iPhone 17 Pro Max",
];

/** Seeds enough to cover every model in the table. */
const MANY_SEEDS = Array.from({ length: 400 }, (_, i) => i);

test("the video-facing fields are unchanged by the camera addition", () => {
  // Pinned before the camera/exposure fields existed. The photo slice must add
  // to the profile without shifting a single draw the video path already ships.
  const p = sampleDeviceProfile(42, NOW);
  expect(p.make).toBe("Apple");
  expect(p.model).toBe("iPhone 15");
  expect(p.software).toBe("26.2");
  expect(p.creationLocal).toBe("2026-04-27T09:14:57-0700");
  expect(p.creationUtc).toBe("2026-04-27T16:14:57.000000Z");
  expect(p.gpsISO6709).toBe("+39.7392-104.9903+000.000/");
  expect(p.lat).toBe(39.7392);
  expect(p.lon).toBe(-104.9903);
});

test("camera and exposure are deterministic for the same seed", () => {
  const a = sampleDeviceProfile(11, NOW);
  const b = sampleDeviceProfile(11, NOW);
  // Asserting the keys first: `toEqual(undefined, undefined)` would otherwise
  // pass while the fields do not exist at all.
  expect(Object.keys(a.camera).sort()).toEqual([
    "fNumber", "focal35", "focalMm", "lensModel",
  ]);
  expect(Object.keys(a.exposure).sort()).toEqual(["exposureTimeSec", "isoSpeed"]);
  expect(a.camera).toEqual(b.camera);
  expect(a.exposure).toEqual(b.exposure);
});

test("every drawable model yields a camera entry with finite numbers", () => {
  const seen = new Set<string>();
  for (const seed of MANY_SEEDS) {
    const p = sampleDeviceProfile(seed, NOW);
    seen.add(p.model);
    expect(Number.isFinite(p.camera.focalMm)).toBe(true);
    expect(Number.isFinite(p.camera.focal35)).toBe(true);
    expect(Number.isFinite(p.camera.fNumber)).toBe(true);
    expect(p.camera.focalMm).toBeGreaterThan(0);
  }
  // The sweep must actually have exercised the whole table, or the assertions
  // above prove nothing about the models it missed.
  expect([...seen].sort()).toEqual([...ALL_MODELS].sort());
});

test("lensModel follows the verified iPhone back-camera pattern", () => {
  for (const seed of MANY_SEEDS) {
    const p = sampleDeviceProfile(seed, NOW);
    expect(p.camera.lensModel).toMatch(
      /^iPhone [\w .]+ back (dual wide|triple) camera \d+(\.\d+)?mm f\/\d(\.\d+)?$/
    );
  }
});

test("lensModel embeds its own model, focal length and aperture", () => {
  const p = sampleDeviceProfile(3, NOW); // iPhone 15 Pro Max
  expect(p.model).toBe("iPhone 15 Pro Max");
  expect(p.camera.lensModel).toBe(
    "iPhone 15 Pro Max back triple camera 6.765mm f/1.78"
  );
});

test("a two-lens iPhone reports dual wide and a three-lens one reports triple", () => {
  for (const seed of MANY_SEEDS) {
    const p = sampleDeviceProfile(seed, NOW);
    // Every Pro/Pro Max is three-lens; so is the 11 Pro line. Everything else
    // in the 11..17 range that this generator draws is two-lens.
    const expected = p.model.includes("Pro") ? "triple" : "dual wide";
    expect(p.camera.lensModel).toContain(` back ${expected} camera `);
  }
});

test("the 48MP Pro-tier main lens reports the current-iOS 6.765mm at 24mm equivalent", () => {
  for (const seed of MANY_SEEDS) {
    const p = sampleDeviceProfile(seed, NOW);
    if (!/^iPhone 1[4-7] Pro/.test(p.model)) continue;
    expect(p.camera.focalMm).toBe(6.765);
    expect(p.camera.focal35).toBe(24);
    expect(p.camera.fNumber).toBe(1.78);
  }
});

/**
 * UNVERIFIED — and pinned here saying so.
 *
 * `deviceProfile.ts` marks the main-lens focal length of the iPhone 15, 15 Plus
 * and base 17 as inferred from the iPhone 16 pattern, never read off a real
 * capture. The measured member of that shared constant is the 16, and that is
 * the only model the table below asserts a number for. This test states the
 * inference and nothing more: that the other three currently follow the 16.
 *
 * It is NOT evidence that 5.96mm is what those phones write. If a real capture
 * ever disagrees, correct `deviceProfile.ts` AND this test from that capture —
 * do not "correct" the source to agree with a test that was never authoritative.
 */
test("the 15 / 15 Plus / base 17 focal length follows the iPhone 16 by inference, not by measurement", () => {
  const focalByModel = new Map<string, number>();
  for (const seed of MANY_SEEDS) {
    const p = sampleDeviceProfile(seed, NOW);
    focalByModel.set(p.model, p.camera.focalMm);
  }
  const measured = focalByModel.get("iPhone 16");
  expect(measured).toBe(5.96);
  for (const inferred of ["iPhone 15", "iPhone 15 Plus", "iPhone 17"]) {
    expect(focalByModel.get(inferred)).toBe(measured);
  }
});

// Only the iPhone 16 entry below stands for the 5.96mm constant, and it is the
// one model of the four sharing it that was read off a real capture — see the
// test above for the other three.
test("pre-48MP models keep their own focal lengths at 26mm equivalent", () => {
  const expectations: Record<string, { focalMm: number; fNumber: number }> = {
    "iPhone 11": { focalMm: 4.25, fNumber: 1.8 },
    "iPhone 11 Pro Max": { focalMm: 4.25, fNumber: 1.8 },
    "iPhone 12": { focalMm: 4.2, fNumber: 1.6 },
    "iPhone 12 Pro Max": { focalMm: 5.1, fNumber: 1.6 },
    "iPhone 13": { focalMm: 5.1, fNumber: 1.6 },
    "iPhone 13 Pro": { focalMm: 5.7, fNumber: 1.5 },
    "iPhone 14 Plus": { focalMm: 5.7, fNumber: 1.5 },
    "iPhone 16": { focalMm: 5.96, fNumber: 1.6 },
  };
  const checked = new Set<string>();
  for (const seed of MANY_SEEDS) {
    const p = sampleDeviceProfile(seed, NOW);
    const want = expectations[p.model];
    if (!want) continue;
    checked.add(p.model);
    expect(p.camera.focalMm).toBe(want.focalMm);
    expect(p.camera.fNumber).toBe(want.fNumber);
    expect(p.camera.focal35).toBe(26);
  }
  expect(checked.size).toBe(Object.keys(expectations).length);
});

test("ISO stays inside the daylight handheld range 20..64", () => {
  for (const seed of MANY_SEEDS) {
    const { isoSpeed } = sampleDeviceProfile(seed, NOW).exposure;
    expect(Number.isInteger(isoSpeed)).toBe(true);
    expect(isoSpeed).toBeGreaterThanOrEqual(20);
    expect(isoSpeed).toBeLessThanOrEqual(64);
  }
});

test("exposure time stays inside 1/2000..1/120 second", () => {
  for (const seed of MANY_SEEDS) {
    const { exposureTimeSec } = sampleDeviceProfile(seed, NOW).exposure;
    expect(exposureTimeSec).toBeGreaterThanOrEqual(1 / 2000);
    expect(exposureTimeSec).toBeLessThanOrEqual(1 / 120);
  }
});

test("exposure draws actually vary across seeds", () => {
  const isos = new Set<number>();
  const times = new Set<number>();
  for (const seed of MANY_SEEDS) {
    const { isoSpeed, exposureTimeSec } = sampleDeviceProfile(seed, NOW).exposure;
    isos.add(isoSpeed);
    times.add(exposureTimeSec);
  }
  expect(isos.size).toBeGreaterThan(5);
  expect(times.size).toBeGreaterThan(50);
});
