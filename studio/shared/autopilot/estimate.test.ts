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

// 5a.2 (S5.6c2, plan s5a2 §5.6, I5.30): an avatar's compose is priced from its split and the coverage of its custom categories. A built-in category and a
// covered custom one are written by the code template, so only the slots of an uncovered custom category (`writerChunksWorst`) are writer requests.
// A need without a split keeps the old arithmetic: every photo can go to the model.
describe("a launch priced from the avatar's split and covers", () => {
  const OPEN = "cat-open-fixture" as const;
  const COVERED = "cat-covered-fixture" as const;
  const covers = (ref: string): boolean => ref === COVERED;
  const priced: LaunchUnitPrices = { ...UNIT, covers };
  const need = (avatarId: string, split: { ref: "home" | typeof OPEN | typeof COVERED; count: number }[]) => ({ avatarId, photos: split.reduce((s, e) => s + e.count, 0), split });

  test("a built-in avatar's compose costs nothing, and so does its writer's expected cost", () => {
    const [mia] = launchEstimate([need("mia", [{ ref: "home", count: 40 }])], priced).avatars;
    expect(mia).toMatchObject({ composeWorstMicros: 0, composeExpectedMicros: 0, drawWorstMicros: 40 * 210_000 });
  });

  test("a covered custom category costs nothing either", () => {
    const [mia] = launchEstimate([need("mia", [{ ref: COVERED, count: 60 }])], priced).avatars;
    expect(mia).toMatchObject({ composeWorstMicros: 0, composeExpectedMicros: 0 });
  });

  test("Home 50 plus an uncovered custom 50: 3 chunks × 2 attempts × the ceiling", () => {
    const [mia] = launchEstimate([need("mia", [{ ref: "home", count: 50 }, { ref: OPEN, count: 50 }])], priced).avatars;
    expect(mia?.composeWorstMicros).toBe(3 * 2 * 37_500);
  });

  test("the expected writer cost follows the uncovered category's scenes only", () => {
    const [mia] = launchEstimate([need("mia", [{ ref: "home", count: 50 }, { ref: OPEN, count: 30 }])], priced).avatars;
    expect(mia?.composeExpectedMicros).toBe(30 * 450);
  });

  test("with no covers at all (the unit lists none) every custom category is uncovered, the safe side", () => {
    const [mia] = launchEstimate([need("mia", [{ ref: COVERED, count: 20 }])], UNIT).avatars;
    expect(mia?.composeWorstMicros).toBe(2 * 37_500);
  });

  test("each avatar is priced from its own split", () => {
    const estimate = launchEstimate([need("a", [{ ref: "home", count: 25 }]), need("b", [{ ref: OPEN, count: 25 }])], priced);
    expect(estimate.avatars.map((a) => a.composeWorstMicros)).toEqual([0, 75_000]);
    expect(estimate.worstMicros).toBe(50 * 210_000 + 75_000);
  });

  test("composeWorstMicros takes the same split", () => {
    expect(composeWorstMicros(priced, 100, [{ ref: "home", count: 50 }, { ref: OPEN, count: 50 }])).toBe(225_000);
    expect(composeWorstMicros(priced, 100)).toBe(300_000);
  });

  test("a split that does not add up to the photos is refused", () => {
    expect(() => launchEstimate([{ avatarId: "a", photos: 10, split: [{ ref: OPEN, count: 9 }] }], priced)).toThrow(RangeError);
  });

  test("the expected cost never exceeds the worst case, over every count of an uncovered category", () => {
    for (let n = 1; n <= 100; n++) {
      const e = launchEstimate([need("a", [{ ref: OPEN, count: n }])], priced);
      expect(e.expectedMicros).toBeLessThanOrEqual(e.worstMicros);
    }
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

// 5a.4 (S5.BA5 round 2, money review L-7): a unit whose table by requests (`writerTypicalByRequests`) lacks the entry a need asks for says which one: the requests and the scenes.
describe("a writer price table without the entry a need asks for", () => {
  test("names the requests and the scenes it was asked for", () => {
    const short: LaunchUnitPrices = { ...UNIT, writerTypicalByRequests: [[0]] };
    expect(() => launchEstimate([{ avatarId: "mia", photos: 30 }], short)).toThrow("the writer's price table has no entry for 2 requests carrying 30 scenes");
  });
});
