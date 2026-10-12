import { describe, expect, test } from "bun:test";
import { hasLegs } from "../../../engine/scenes/legs";
import { POOLS } from "../../../engine/scenes/pools";
import { SceneCategory } from "../../../shared/engine";
import { legsCountOf } from "../../../shared/scenes/level";
import { NBSP } from "../../lib/format";
import { cardLegsLine, hasBuiltIn, launchLegsRow, legsCaption, legsFrames, LEGS_KEY_PREFIX, LEGS_OPTIONS, readLegs, writeLegs } from "./legs";

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

  // The window lets «Ножки» run on any built-in (`hasBuiltIn`), and the engine deals a legs slot from a pool only if `hasLegs` says so: the two must agree for all five.
  test("every built-in category's pool can deal a legs slot, so the window never offers «Ножки» the engine cannot draw", () => {
    const POOL_OF = { home: "home", travel: "travel", shoot: "photoshoot", glam: "glamour", fit: "fitness" } as const satisfies Record<SceneCategory, keyof typeof POOLS>;
    for (const ref of SceneCategory.options) {
      expect(hasBuiltIn([ref]), ref).toBe(true);
      expect(hasLegs(POOLS[POOL_OF[ref]]), ref).toBe(true);
    }
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

  test("a pick that rounds to no legs frame says so in words, never «0 из 5 кадров»", () => {
    const FEW = { text: "Ножки — слишком мало кадров во встроенных категориях", why: true };
    // 5 photos over «Дом» and two own categories: 2 built-in photos, round-half-up(0.3) = 0.
    expect(legsFrames(15, 5, ["home", PARIS, BAKERIES])).toBe(0);
    expect(cardLegsLine(15, 5, ["home", PARIS, BAKERIES])).toEqual(FEW);
    // One off the limit: 4 built-in photos hold one frame at 15 %.
    expect(legsFrames(15, 4, ["home"])).toBe(1);
    expect(cardLegsLine(15, 4, ["home"])?.why).toBe(false);
  });

  test("with no built-in category on, says why the chips are off, whatever the pick", () => {
    const why = { text: "Ножки — только во встроенных категориях", why: true };
    expect(cardLegsLine(15, 20, [PARIS])).toEqual(why);
    expect(cardLegsLine(0, 20, [PARIS, BAKERIES])).toEqual(why);
    expect(cardLegsLine(30, 20, [])).toEqual(why);
  });
});

describe("«Автопилот»'s row (mockups 34, 34#few)", () => {
  const avatar = (toGenerate: number, blocked: unknown = null) => ({ toGenerate, blocked });
  const plan = (...avatars: { toGenerate: number; blocked: unknown }[]) => ({
    avatars,
    totals: { toGenerate: avatars.reduce((sum, a) => sum + (a.blocked === null ? a.toGenerate : 0), 0) },
  });
  const THREE = ["home", "shoot", "glam"] as const;

  test("sums each avatar's own legs frames: ≈ 3 of 22 at «Немного», ≈ 5 at «Много» (the mockup's plan)", () => {
    const three = plan(avatar(9), avatar(7), avatar(6));
    expect(launchLegsRow(15, three, THREE)).toEqual({ shown: 15, off: false, caption: { text: `≈ 3 из 22${NBSP}новых кадров — ${WHAT}`, why: false } });
    expect(launchLegsRow(30, three, THREE).caption?.text).toBe(`≈ 5 из 22${NBSP}новых кадров — ${WHAT}`);
    expect(launchLegsRow(30, plan(avatar(21)), THREE).caption?.text).toBe(`≈ 6 из 21${NBSP}нового кадра — ${WHAT}`);
  });

  test("a blocked avatar's photos are not counted", () => {
    expect(launchLegsRow(15, plan(avatar(20, { kind: "open-set" }), avatar(20)), ["home"]).caption?.text).toBe(`≈ 3 из 20${NBSP}новых кадров — ${WHAT}`);
  });

  test("«Нет» on: no caption", () => {
    expect(launchLegsRow(0, plan(avatar(20)), THREE)).toEqual({ shown: 0, off: false, caption: null });
  });

  test("no plan yet, or nothing new to draw: what the frames are, without a count", () => {
    const words = { text: "Ножки и стопы крупно; лицо может не попасть в кадр, сходство на таких кадрах только отмечается.", why: false };
    expect(launchLegsRow(15, null, THREE)).toEqual({ shown: 15, off: false, caption: words });
    expect(launchLegsRow(30, plan(avatar(0), avatar(0)), THREE)).toEqual({ shown: 30, off: false, caption: words });
  });

  test("no avatar draws 4 new photos: the chips are off on the pick, which is kept, saying «Ножки — от 4 фото»", () => {
    const few = { text: "Ножки — от 4 фото", why: true };
    expect(launchLegsRow(15, plan(avatar(1), avatar(1), avatar(1)), THREE)).toEqual({ shown: 15, off: true, caption: few });
    expect(launchLegsRow(0, plan(avatar(3)), THREE)).toEqual({ shown: 0, off: true, caption: few });
    // A blocked avatar's 10 do not count; the one that draws has 3.
    expect(launchLegsRow(30, plan(avatar(10, { kind: "open-set" }), avatar(3)), THREE)).toEqual({ shown: 30, off: true, caption: few });
    // One off the limit: 4 new photos hold a legs frame.
    expect(launchLegsRow(15, plan(avatar(4), avatar(1)), ["home"])).toEqual({ shown: 15, off: false, caption: { text: `≈ 1 из 5${NBSP}новых кадров — ${WHAT}`, why: false } });
  });

  test("a plan whose new photos round to no legs frame says so in words, never «≈ 0 из N»", () => {
    const FEW = { text: "Ножки — слишком мало кадров во встроенных категориях", why: true };
    expect(legsFrames(15, 4, ["home", PARIS, BAKERIES])).toBe(0);
    expect(launchLegsRow(15, plan(avatar(4)), ["home", PARIS, BAKERIES])).toEqual({ shown: 15, off: false, caption: FEW });
  });

  test("«Догенерировать недостающие» off: no new frame is drawn, so the chips are off on the kept pick, saying why", () => {
    const only = { text: "Ножки — только для новых кадров", why: true };
    expect(launchLegsRow(15, plan(avatar(0)), THREE, false)).toEqual({ shown: 15, off: true, caption: only });
    expect(launchLegsRow(30, null, THREE, false)).toEqual({ shown: 30, off: true, caption: only });
    expect(launchLegsRow(0, plan(avatar(0)), THREE, false)).toEqual({ shown: 0, off: true, caption: only });
    // With no built-in category on, that reason comes first.
    expect(launchLegsRow(15, null, [PARIS], false).caption?.text).toBe("Ножки — только во встроенных категориях");
    // On again, the row is as it was.
    expect(launchLegsRow(15, plan(avatar(20)), ["home"], true).off).toBe(false);
  });

  test("no built-in category on: the chips are off on «Нет», saying why, with a plan or without", () => {
    const why = { text: "Ножки — только во встроенных категориях", why: true };
    expect(launchLegsRow(15, plan(avatar(20)), [PARIS])).toEqual({ shown: 0, off: true, caption: why });
    expect(launchLegsRow(30, null, [PARIS, BAKERIES])).toEqual({ shown: 0, off: true, caption: why });
    expect(launchLegsRow(15, plan(avatar(1)), [])).toEqual({ shown: 0, off: true, caption: why });
  });
});

// ---------- remembered per avatar (wave 5e, owner decision) ----------

function memory(): Pick<Storage, "getItem" | "setItem" | "removeItem"> & { items: Map<string, string> } {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  };
}
const blocked: Pick<Storage, "getItem" | "setItem" | "removeItem"> = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("blocked");
  },
  removeItem: () => {
    throw new Error("blocked");
  },
};

describe("«Ножки» remembered per avatar", () => {
  test("is «Нет» for an avatar it was never chosen for", () => {
    expect(readLegs(memory(), "avatar-mia-0001")).toBe(0);
  });

  test("keeps the share for that avatar only", () => {
    const storage = memory();
    writeLegs(storage, "avatar-mia-0001", 30);
    expect(readLegs(storage, "avatar-mia-0001")).toBe(30);
    expect(readLegs(storage, "avatar-ava-0002")).toBe(0);
    expect(storage.items.get(`${LEGS_KEY_PREFIX}avatar-mia-0001`)).toBe("30");
  });

  test("forgets the key when it goes back to «Нет»: the default is not stored", () => {
    const storage = memory();
    writeLegs(storage, "avatar-mia-0001", 15);
    writeLegs(storage, "avatar-mia-0001", 0);
    expect(storage.items.size).toBe(0);
  });

  test("reads «Нет» for a stored value that is not a share the contract takes", () => {
    const storage = memory();
    for (const bad of ["20", "0", "", "15%", "NaN", "30.5"]) {
      storage.items.set(`${LEGS_KEY_PREFIX}avatar-mia-0001`, bad);
      expect(readLegs(storage, "avatar-mia-0001")).toBe(0);
    }
  });

  test("reads «Нет» and does not throw where the storage is blocked or absent", () => {
    expect(readLegs(blocked, "avatar-mia-0001")).toBe(0);
    expect(() => writeLegs(blocked, "avatar-mia-0001", 15)).not.toThrow();
    expect(readLegs(null, "avatar-mia-0001")).toBe(0);
    expect(() => writeLegs(null, "avatar-mia-0001", 15)).not.toThrow();
  });
});
