import { describe, expect, test } from "bun:test";
import { LAUNCH_SLICE_MAX_PHOTOS, type MonthFit } from "../engine/autopilot";
import { budgetHoldCleared, budgetHoldDetail, drawAllocationLeft, launchCommittedMicros, monthFit, monthRoomMicros, SLICE_MAX_PHOTOS, sliceSize, withinLaunchCeiling, type LaunchScopeMoney } from "./money";

// Stage 4, S4.2 (plan §4.3, §4.4, amendments §18; invariants A2 and A21): the month's room, the fit, the slice size and the budget hold's threshold, as pure
// functions over integer micro-dollars.

const PHOTO = 210_000;

describe("monthRoomMicros", () => {
  test("is the budget less spent, open, held and the unspent cap of every live scope", () => {
    const room = monthRoomMicros({
      budgetMicros: 10_000_000,
      spentMicros: 1_000_000,
      openMicros: 200_000,
      heldMicros: 50_000,
      liveScopes: [
        { capMicros: 5_000_000, committedMicros: 1_000_000 },
        { capMicros: 300_000, committedMicros: 0 },
      ],
    });
    expect(room).toEqual({ budgetMicros: 10_000_000, committedMicros: 1_000_000 + 200_000 + 50_000 + 4_000_000 + 300_000, freeMicros: 10_000_000 - 5_550_000 });
  });

  test("a live scope that has spent its whole cap, or more, holds back nothing", () => {
    const room = monthRoomMicros({
      budgetMicros: 1_000_000,
      spentMicros: 0,
      openMicros: 0,
      heldMicros: 0,
      liveScopes: [
        { capMicros: 500_000, committedMicros: 500_000 },
        { capMicros: 500_000, committedMicros: 600_000 },
      ],
    });
    expect(room.committedMicros).toBe(0);
    expect(room.freeMicros).toBe(1_000_000);
  });

  test("with nothing running the room is the budget less what is spent", () => {
    expect(monthRoomMicros({ budgetMicros: 10_000_000, spentMicros: 4_000_000, openMicros: 0, heldMicros: 0, liveScopes: [] }).freeMicros).toBe(6_000_000);
  });

  test("the room is never below zero when more is committed than the budget", () => {
    const room = monthRoomMicros({ budgetMicros: 1_000_000, spentMicros: 900_000, openMicros: 0, heldMicros: 0, liveScopes: [{ capMicros: 500_000, committedMicros: 0 }] });
    expect(room.freeMicros).toBe(0);
    expect(room.committedMicros).toBe(1_400_000);
  });

  test("a zero budget has no room", () => {
    expect(monthRoomMicros({ budgetMicros: 0, spentMicros: 0, openMicros: 0, heldMicros: 0, liveScopes: [] }).freeMicros).toBe(0);
  });

  test.each([-1, 1.5, Number.NaN])("a figure of %p is refused", (bad) => {
    expect(() => monthRoomMicros({ budgetMicros: bad, spentMicros: 0, openMicros: 0, heldMicros: 0, liveScopes: [] })).toThrow(TypeError);
  });
});

describe("monthFit", () => {
  const E = 6_340_000;
  const W = 19_200_000;

  const cases: [number, MonthFit][] = [
    [W, "fits"],
    [W + 1, "fits"],
    [W - 1, "fits-expected"],
    [E, "fits-expected"],
    [E - 1, "short"],
    [0, "short"],
  ];
  test.each(cases)("a room of %i is %s", (free, fit) => {
    expect(monthFit(free, E, W)).toBe(fit);
  });

  test("a free launch (E = W = 0) fits in an empty room", () => {
    expect(monthFit(0, 0, 0)).toBe("fits");
  });

  test("an expected cost above the worst case is a bug and is refused", () => {
    expect(() => monthFit(10, 20, 10)).toThrow(RangeError);
  });
});

describe("sliceSize", () => {
  const base = { scenesLeft: 90, drawLeftMicros: 90 * PHOTO, roomMicros: 100_000_000, photoWorstMicros: PHOTO };

  test("is at most 25 photos", () => {
    expect(sliceSize(base)).toEqual({ photos: LAUNCH_SLICE_MAX_PHOTOS, capMicros: 25 * PHOTO, blockedBy: null });
  });

  test("is the scenes left when fewer than 25 remain", () => {
    expect(sliceSize({ ...base, scenesLeft: 15 })).toMatchObject({ photos: 15, capMicros: 15 * PHOTO });
  });

  test("shrinks to the draw allocation left", () => {
    expect(sliceSize({ ...base, drawLeftMicros: 10 * PHOTO + (PHOTO - 1) }).photos).toBe(10);
  });

  test("shrinks to the room", () => {
    expect(sliceSize({ ...base, roomMicros: 7 * PHOTO + (PHOTO - 1) }).photos).toBe(7);
  });

  test("a room of exactly k photos' worst case gives k; one micro-dollar less gives k - 1", () => {
    expect(sliceSize({ ...base, roomMicros: 7 * PHOTO }).photos).toBe(7);
    expect(sliceSize({ ...base, roomMicros: 7 * PHOTO - 1 }).photos).toBe(6);
  });

  test("an allocation of exactly k photos gives k; one micro-dollar less gives k - 1", () => {
    expect(sliceSize({ ...base, drawLeftMicros: 12 * PHOTO }).photos).toBe(12);
    expect(sliceSize({ ...base, drawLeftMicros: 12 * PHOTO - 1 }).photos).toBe(11);
  });

  test("no room is a zero slice blocked by the room", () => {
    expect(sliceSize({ ...base, roomMicros: 0 })).toEqual({ photos: 0, capMicros: 0, blockedBy: "room" });
  });

  test("a room below one photo's worst case is a zero slice blocked by the room", () => {
    expect(sliceSize({ ...base, roomMicros: PHOTO - 1 })).toMatchObject({ photos: 0, blockedBy: "room" });
  });

  test("an allocation left below one photo is a zero slice blocked by the allocation (the price rose)", () => {
    expect(sliceSize({ ...base, drawLeftMicros: PHOTO - 1 })).toMatchObject({ photos: 0, blockedBy: "allocation" });
  });

  test("when both are short the allocation is named: the price is the cause the owner can act on", () => {
    expect(sliceSize({ ...base, drawLeftMicros: 0, roomMicros: 0 }).blockedBy).toBe("allocation");
  });

  test("nothing left to draw is a zero slice with nothing to wait for", () => {
    expect(sliceSize({ ...base, scenesLeft: 0 })).toEqual({ photos: 0, capMicros: 0, blockedBy: "nothing-left" });
  });

  test("a price rise of 10 % shrinks a slice sized for the old price to the largest that fits", () => {
    const allocation = 25 * PHOTO;
    const risen = Math.ceil(PHOTO * 1.1);
    const slice = sliceSize({ ...base, drawLeftMicros: allocation, photoWorstMicros: risen });
    expect(slice.photos).toBe(Math.floor(allocation / risen));
    expect(slice.photos).toBeLessThan(25);
    expect(slice.capMicros).toBeLessThanOrEqual(allocation);
  });

  test("a price fall of 10 % gives a smaller cap for the same slice; the leftover is not spent", () => {
    const fallen = Math.floor(PHOTO * 0.9);
    const slice = sliceSize({ ...base, photoWorstMicros: fallen });
    expect(slice.photos).toBe(25);
    expect(slice.capMicros).toBe(25 * fallen);
    expect(slice.capMicros).toBeLessThan(25 * PHOTO);
  });

  test("the plan's worked example: slice 1 of 25 fits a room of about $9.96 with a cap of $5.25", () => {
    expect(sliceSize({ ...base, roomMicros: 9_960_000 })).toMatchObject({ photos: 25, capMicros: 5_250_000 });
  });

  test("the plan's worked example: slice 4 of 15 fits a room of about $4.8 with a cap of $3.15", () => {
    expect(sliceSize({ ...base, scenesLeft: 15, drawLeftMicros: 15 * PHOTO, roomMicros: 4_800_000 })).toMatchObject({ photos: 15, capMicros: 3_150_000 });
  });

  test("a free photo (price 0) is limited by the scenes and 25 only", () => {
    expect(sliceSize({ ...base, photoWorstMicros: 0, roomMicros: 0, drawLeftMicros: 0 })).toEqual({ photos: 25, capMicros: 0, blockedBy: null });
  });

  test("one scene left and room for it makes a slice of one", () => {
    expect(sliceSize({ ...base, scenesLeft: 1, roomMicros: PHOTO })).toMatchObject({ photos: 1, capMicros: PHOTO });
  });

  test.each([-1, 1.5])("a figure of %p is refused", (bad) => {
    expect(() => sliceSize({ ...base, roomMicros: bad })).toThrow(TypeError);
  });
});

describe("the draw allocation left and the launch's ceiling (A2)", () => {
  test("is the allocation less what finished slices committed and what live slices may still commit", () => {
    const left = drawAllocationLeft(10_000_000, [
      { state: "finished", committedMicros: 1_200_000 },
      { state: "finished", committedMicros: 1_500_000 },
      { state: "live", capMicros: 3_150_000 },
    ]);
    expect(left).toBe(10_000_000 - 1_200_000 - 1_500_000 - 3_150_000);
  });

  test("a finished slice's slack is reused: it spent less than its cap, and the difference is allocated again", () => {
    const cap = 25 * PHOTO;
    const draw = 50 * PHOTO;
    const whileLive = drawAllocationLeft(draw, [{ state: "live", capMicros: cap }]);
    const afterFinish = drawAllocationLeft(draw, [{ state: "finished", committedMicros: 8 * PHOTO }]);
    expect(whileLive).toBe(25 * PHOTO);
    expect(afterFinish).toBe(42 * PHOTO);
  });

  test("the sum of finished slices' committed and live slices' caps never exceeds the draw allocation when each slice is sized to what is left", () => {
    const draw = 90 * PHOTO;
    const scopes: LaunchScopeMoney[] = [];
    let scenesLeft = 90;
    let seed = 12345;
    const next = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648);
    while (scenesLeft > 0) {
      const slice = sliceSize({ scenesLeft, drawLeftMicros: drawAllocationLeft(draw, scopes), roomMicros: 100_000_000, photoWorstMicros: PHOTO });
      expect(slice.photos).toBeGreaterThan(0);
      scopes.push({ state: "live", capMicros: slice.capMicros });
      expect(launchCommittedMicros(scopes)).toBeLessThanOrEqual(draw);
      // the slice ends having spent between nothing and its cap
      scopes[scopes.length - 1] = { state: "finished", committedMicros: next() % (slice.capMicros + 1) };
      scenesLeft -= slice.photos;
    }
    expect(launchCommittedMicros(scopes)).toBeLessThanOrEqual(draw);
  });

  test("the allocation left is never below zero", () => {
    expect(drawAllocationLeft(100, [{ state: "live", capMicros: 150 }])).toBe(0);
  });

  test("launchCommittedMicros sums a finished scope's committed and a live scope's cap", () => {
    expect(
      launchCommittedMicros([
        { state: "finished", committedMicros: 5 },
        { state: "live", capMicros: 7 },
      ]),
    ).toBe(12);
    expect(launchCommittedMicros([])).toBe(0);
  });

  test("withinLaunchCeiling is true at W′ and false at W′ + 1 micro-dollar over", () => {
    const scopes: LaunchScopeMoney[] = [
      { state: "finished", committedMicros: 600 },
      { state: "live", capMicros: 400 },
    ];
    expect(withinLaunchCeiling(scopes, 1_000)).toBe(true);
    expect(withinLaunchCeiling(scopes, 999)).toBe(false);
  });

  test("a «Дописать» is a new scope next to the compose's: the compose's committed and the new write both count", () => {
    const scopes: LaunchScopeMoney[] = [
      { state: "finished", committedMicros: 40_000 },
      { state: "live", capMicros: 35_000 },
    ];
    expect(withinLaunchCeiling(scopes, 75_000)).toBe(true);
    expect(withinLaunchCeiling([...scopes, { state: "live", capMicros: 1 }], 75_000)).toBe(false);
  });
});

describe("budgetHoldDetail (plan §18: one threshold, needMicros)", () => {
  test("a new slice needs the room for one photo's worst case", () => {
    expect(budgetHoldDetail({ kind: "new-slice", freeMicros: 100_000, photoWorstMicros: PHOTO })).toEqual({ kind: "new-slice", freeMicros: 100_000, needMicros: PHOTO });
  });

  test("a resumed slice needs the room for the rest of the slice already started", () => {
    expect(budgetHoldDetail({ kind: "resume-slice", freeMicros: 100_000, photoWorstMicros: PHOTO, resumeRemainingWorstMicros: 5_250_000 })).toEqual({
      kind: "resume-slice",
      freeMicros: 100_000,
      needMicros: 5_250_000,
    });
  });

  test("a resumed slice without its remaining worst case is a programming error", () => {
    expect(() => budgetHoldDetail({ kind: "resume-slice", freeMicros: 0, photoWorstMicros: PHOTO })).toThrow(TypeError);
  });

  test("the hold is cleared when the room reaches the need exactly, not one micro-dollar earlier", () => {
    const hold = budgetHoldDetail({ kind: "new-slice", freeMicros: 0, photoWorstMicros: PHOTO });
    expect(budgetHoldCleared(hold, PHOTO - 1)).toBe(false);
    expect(budgetHoldCleared(hold, PHOTO)).toBe(true);
  });

  test("a resumed slice's hold is cleared at the remaining worst case, which is far above one photo", () => {
    const hold = budgetHoldDetail({ kind: "resume-slice", freeMicros: 300_000, photoWorstMicros: PHOTO, resumeRemainingWorstMicros: 5_250_000 });
    expect(budgetHoldCleared(hold, 5_249_999)).toBe(false);
    expect(budgetHoldCleared(hold, 5_250_000)).toBe(true);
  });
});

test("the slice limit mirrors the contract's", () => {
  expect(SLICE_MAX_PHOTOS).toBe(LAUNCH_SLICE_MAX_PHOTOS);
});
