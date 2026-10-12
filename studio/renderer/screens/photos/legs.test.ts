import { describe, expect, test } from "bun:test";
import { legsCountOf } from "../../../shared/scenes/level";
import { NBSP } from "../../lib/format";
import { cardLegsLine, hasBuiltIn, legsCaption, legsFrames, LEGS_OPTIONS } from "./legs";

// S5.8b (plan s5a2 §7, I5.29; mockups 33 and 34 of .omc/stage5/design): «Ножки» on the window's side — the chips, the count of legs frames the caption
// quotes (the planner's own rule over the planner's own split), and why the chips are off with no built-in category on.

const PARIS = "cat-0a1b2c3d4e5f";
const BAKERIES = "cat-ffffffffffff";
const WHAT = "ножки и стопы крупно; лицо может не попасть в кадр, сходство на таких кадрах только отмечается.";

describe("the chips (mockup 33)", () => {
  test("are «Нет · Немного 15 % · Много 30 %», the shares the contract takes", () => {
    expect(LEGS_OPTIONS.map((o) => o.value)).toEqual([0, 15, 30]);
    expect(LEGS_OPTIONS.map((o) => (o.share === null ? o.label : `${o.label} ${o.share}`))).toEqual(["Нет", `Немного 15${NBSP}%`, `Много 30${NBSP}%`]);
  });
});

describe("how many frames are legs (I5.29)", () => {
  test("20 photos over the five built-ins: 3 at «Немного», 6 at «Много», none at «Нет»", () => {
    const five = ["home", "shoot", "travel", "glam", "fit"] as const;
    expect(legsFrames(15, 20, five)).toBe(3);
    expect(legsFrames(30, 20, five)).toBe(6);
    expect(legsFrames(0, 20, five)).toBe(0);
  });

  test("counts only the built-in photos of the split; a custom category draws none", () => {
    // 20 over «Дом» and a custom category: 10 built-in photos, round-half-up(1.5) = 2 and round-half-up(3) = 3.
    expect(legsFrames(15, 20, ["home", PARIS])).toBe(2);
    expect(legsFrames(30, 20, ["home", PARIS])).toBe(3);
    expect(legsFrames(30, 20, [PARIS, BAKERIES])).toBe(0);
  });

  test("is the planner's own rule at its cap: 30 % of 25 built-in photos is 7, not 8", () => {
    expect(legsFrames(30, 25, ["home"])).toBe(legsCountOf(30, 25, 25));
    expect(legsFrames(30, 25, ["home"])).toBe(7);
  });

  test("nothing to draw draws none: no photo, or no category", () => {
    expect(legsFrames(30, 0, ["home"])).toBe(0);
    expect(legsFrames(30, 20, [])).toBe(0);
  });

  test("a built-in is any of the five; the owner's own are not", () => {
    expect(hasBuiltIn(["home"])).toBe(true);
    expect(hasBuiltIn([PARIS, "fit"])).toBe(true);
    expect(hasBuiltIn([PARIS, BAKERIES])).toBe(false);
    expect(hasBuiltIn([])).toBe(false);
  });
});

describe("the card's caption (mockups 33, 34#card)", () => {
  test("«3 из 20 кадров — ножки и стопы крупно; …», in the form «из N кадра» after 21", () => {
    expect(legsCaption(3, 20)).toBe(`3 из 20${NBSP}кадров — ${WHAT}`);
    expect(legsCaption(6, 21)).toBe(`6 из 21${NBSP}кадра — ${WHAT}`);
  });

  test("with a pick and a built-in, the count of legs frames", () => {
    expect(cardLegsLine(15, 20, ["home", "shoot", "travel", "glam", "fit"])).toEqual({ text: `3 из 20${NBSP}кадров — ${WHAT}`, why: false });
  });

  test("«Нет», or an empty set, says nothing", () => {
    expect(cardLegsLine(0, 20, ["home"])).toBeNull();
    expect(cardLegsLine(15, 0, ["home"])).toBeNull();
  });

  test("with no built-in category on, says why the chips are off, whatever the pick", () => {
    const why = { text: "Ножки — только во встроенных категориях", why: true };
    expect(cardLegsLine(15, 20, [PARIS])).toEqual(why);
    expect(cardLegsLine(0, 20, [PARIS, BAKERIES])).toEqual(why);
    expect(cardLegsLine(30, 20, [])).toEqual(why);
  });
});
