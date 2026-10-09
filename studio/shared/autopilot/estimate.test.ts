import { describe, expect, test } from "bun:test";
import { allocateLaunch, composeWorstMicros, launchEstimate, MAX_GENERATED_PER_AVATAR, type LaunchUnitPrices } from "./estimate";

// Stage 4, S4.2 (plan §4.2, §4.3, invariant A18): the launch estimate is linear in the counts and shared by the engine and the mock. These tests use fixed
// unit prices (the plan's worked example: an attempt at $0.07, three attempts per photo, a writer ceiling of $0.0375); the engine's own tie to
// `composeEstimate` and `runEstimateFromScenes` is pinned in engine/autopilot/prices.test.ts.

/** A writer that costs 450 µ$ per scene. */
const WRITER_TYPICAL = Array.from({ length: MAX_GENERATED_PER_AVATAR + 1 }, (_, n) => n * 450);

const UNIT: LaunchUnitPrices = {
  photoWorstMicros: 210_000,
  photoExpectedMicros: 70_000,
  writerCeilingMicros: 37_500,
  writerChunkSlots: 25,
  writerMaxAttempts: 2,
  writerTypicalMicros: WRITER_TYPICAL,
  prices: "live",
  pricesAsOf: "2026-10-09",
};

describe("composeWorstMicros", () => {
  test.each([
    [0, 0],
    [1, 75_000],
    [25, 75_000],
    [26, 150_000],
    [50, 150_000],
    [90, 300_000],
    [100, 300_000],
  ])("%i scenes cost %i µ$ at worst: chunks of 25, each asked twice at the ceiling", (n, expected) => {
    expect(composeWorstMicros(UNIT, n)).toBe(expected);
  });
});

describe("launchEstimate", () => {
  test("the worked example: 90 new photos for one avatar is 19 200 000 µ$ at worst", () => {
    const estimate = launchEstimate([{ avatarId: "mia", photos: 90 }], UNIT);
    expect(estimate.worstMicros).toBe(19_200_000);
    expect(estimate.avatars[0]).toMatchObject({ composeWorstMicros: 300_000, drawWorstMicros: 18_900_000 });
  });

  test("the worked example: the expected cost is about $6.34 (90 photos at $0.07 and a cheap writer)", () => {
    const estimate = launchEstimate([{ avatarId: "mia", photos: 90 }], UNIT);
    expect(estimate.expectedMicros).toBe(90 * 70_000 + 90 * 450);
    expect(estimate.expectedMicros).toBeGreaterThan(6_335_000);
    expect(estimate.expectedMicros).toBeLessThan(6_345_000);
  });

  test("the totals are the sums over the avatars, and each avatar's figure is its compose plus its draw", () => {
    const estimate = launchEstimate(
      [
        { avatarId: "a", photos: 10 },
        { avatarId: "b", photos: 30 },
      ],
      UNIT,
    );
    for (const a of estimate.avatars) {
      expect(a.worstMicros).toBe(a.composeWorstMicros + a.drawWorstMicros);
      expect(a.expectedMicros).toBe(a.composeExpectedMicros + a.drawExpectedMicros);
    }
    expect(estimate.worstMicros).toBe(estimate.avatars.reduce((sum, a) => sum + a.worstMicros, 0));
    expect(estimate.expectedMicros).toBe(estimate.avatars.reduce((sum, a) => sum + a.expectedMicros, 0));
  });

  test("an avatar that needs no new photo costs nothing and has no compose", () => {
    const estimate = launchEstimate([{ avatarId: "a", photos: 0 }], UNIT);
    expect(estimate).toMatchObject({ worstMicros: 0, expectedMicros: 0 });
    expect(estimate.avatars[0]).toMatchObject({ composeWorstMicros: 0, drawWorstMicros: 0 });
  });

  test("no avatars is a free launch", () => {
    expect(launchEstimate([], UNIT)).toMatchObject({ worstMicros: 0, expectedMicros: 0, avatars: [] });
  });

  test("the most one avatar can need (100 photos) is priced; 101 is refused", () => {
    expect(launchEstimate([{ avatarId: "a", photos: 100 }], UNIT).worstMicros).toBe(100 * 210_000 + 300_000);
    expect(() => launchEstimate([{ avatarId: "a", photos: 101 }], UNIT)).toThrow(RangeError);
  });

  test.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("a count of %p is refused", (photos) => {
    expect(() => launchEstimate([{ avatarId: "a", photos }], UNIT)).toThrow(RangeError);
  });

  test("the expected cost never exceeds the worst case", () => {
    for (let n = 0; n <= 100; n++) {
      const e = launchEstimate([{ avatarId: "a", photos: n }], UNIT);
      expect(e.expectedMicros).toBeLessThanOrEqual(e.worstMicros);
    }
  });

  test("the price source and date travel with the figures", () => {
    const estimate = launchEstimate([{ avatarId: "a", photos: 1 }], { ...UNIT, prices: "fallback", pricesAsOf: "2026-09-24" });
    expect(estimate).toMatchObject({ prices: "fallback", pricesAsOf: "2026-09-24" });
  });

  test("a unit price table too short for the largest count is refused, never read out of range", () => {
    expect(() => launchEstimate([{ avatarId: "a", photos: 50 }], { ...UNIT, writerTypicalMicros: [0, 450] })).toThrow(RangeError);
  });
});

describe("allocateLaunch", () => {
  const estimate = launchEstimate(
    [
      { avatarId: "a", photos: 40 },
      { avatarId: "b", photos: 0 },
      { avatarId: "c", photos: 7 },
    ],
    UNIT,
  );

  test("each avatar gets exactly its compose worst case and its draw worst case; the sum is W′", () => {
    const result = allocateLaunch(estimate, estimate.worstMicros);
    if (!result.ok) throw new Error("expected an allocation");
    expect(result.avatars).toEqual([
      { avatarId: "a", composeMicros: 150_000, drawMicros: 40 * 210_000 },
      { avatarId: "b", composeMicros: 0, drawMicros: 0 },
      { avatarId: "c", composeMicros: 75_000, drawMicros: 7 * 210_000 },
    ]);
    expect(result.plannedWorstMicros).toBe(estimate.worstMicros);
  });

  test("the sum allocated never exceeds the accepted amount, whatever it is above W′", () => {
    for (const extra of [0, 1, 1_000_000]) {
      const result = allocateLaunch(estimate, estimate.worstMicros + extra);
      if (!result.ok) throw new Error("expected an allocation");
      const sum = result.avatars.reduce((total, a) => total + a.composeMicros + a.drawMicros, 0);
      expect(sum).toBeLessThanOrEqual(estimate.worstMicros + extra);
      expect(sum).toBe(result.plannedWorstMicros);
    }
  });

  test("an accepted amount one micro-dollar below W′ is PRICE_CHANGED: caps are never raised", () => {
    const result = allocateLaunch(estimate, estimate.worstMicros - 1);
    expect(result).toEqual({ ok: false, reason: "PRICE_CHANGED", plannedWorstMicros: estimate.worstMicros, acceptedMicros: estimate.worstMicros - 1 });
  });

  test("an accepted amount of exactly W′ is allowed", () => {
    expect(allocateLaunch(estimate, estimate.worstMicros).ok).toBe(true);
  });

  test("a free launch is allowed with nothing accepted", () => {
    expect(allocateLaunch(launchEstimate([], UNIT), 0)).toEqual({ ok: true, avatars: [], plannedWorstMicros: 0 });
  });
});
