import { describe, expect, test } from "bun:test";
import { CategoryRef, SceneCategory } from "../../shared/engine";
import { BANKS } from "../../shared/scenes/banks";
import { ORDINARY_BANK_CATEGORIES } from "../../shared/scenes/banks/types";
import { categoryRefOf, ORDINARY_BUILT_INS, plannerCategoryOf } from ".";
import { POOLS } from "./pools";
import { CATEGORIES } from "./types";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5a.2 (S5.6R, I5.33 «ids stay»): the stored ids and the engine names of the built-in categories do not change in 5a.2, and no id is added for «Смелая» (the level of 5a.3, which gets
// new ids of its own when it ships). A stored plan, set or photo names its category by these five strings; a sixth, or a renamed one, would orphan old data.

const IDS = ["home", "travel", "shoot", "glam", "fit"] as const;
/** The same five as the engine names them (pools, banks, planner). */
const ENGINE_NAMES = ["home", "travel", "photoshoot", "glamour", "fitness"] as const;
const BOLD_LIKE = /bold|daring|brave|smel|boudoir|lingerie|nightwear|swimwear|beach|pool|nude/i;

describe("the built-in category ids stay (I5.33)", () => {
  test("the contract's SceneCategory is exactly the five stored ids, in the canonical order", () => {
    expect([...SceneCategory.options]).toEqual([...IDS]);
  });

  test("the engine's category names are the same five, and each maps to its stored id and back", () => {
    expect([...CATEGORIES]).toEqual([...ENGINE_NAMES]);
    expect(CATEGORIES.map((name) => categoryRefOf(name))).toEqual([...IDS]);
    expect(IDS.map((id) => plannerCategoryOf(id))).toEqual([...ENGINE_NAMES]);
  });

  // 5a.3 (S5.9b2, plan s5a3 §6.4 r3): the five ordinary built-ins by name, beside the category list the two «Смелая» categories join. The sweeps that hold a
  // plan to the ordinary and flirty rules run over these five; the engine's and the banks' copies are the same list.
  test("ORDINARY_BUILT_INS names the five ordinary built-ins in the canonical order, and the banks' list is the same", () => {
    expect([...ORDINARY_BUILT_INS]).toEqual([...ENGINE_NAMES]);
    expect([...ORDINARY_BANK_CATEGORIES]).toEqual([...ORDINARY_BUILT_INS]);
    expect(ORDINARY_BUILT_INS.every((name) => CATEGORIES.includes(name))).toBe(true);
  });

  test("the pools and the banks hold those five and no other category", () => {
    expect(Object.keys(POOLS).sort()).toEqual([...ENGINE_NAMES].sort());
    expect(Object.keys(BANKS).sort()).toEqual([...ENGINE_NAMES].sort());
  });
});

describe("no «Смелая» category id exists yet (I5.33)", () => {
  test("none of the ids, the pools' keys or the banks' keys names a bolder level", () => {
    for (const id of [...SceneCategory.options, ...CATEGORIES, ...Object.keys(POOLS), ...Object.keys(BANKS)]) expect(BOLD_LIKE.test(id)).toBe(false);
  });

  test.each(["bold", "daring", "smelaya", "smelaja", "brave", "lingerie", "beach", "pool"])("«%s» is not a category ref the contract accepts", (id) => {
    expect(CategoryRef.safeParse(id).success).toBe(false);
  });

  test("the five ids are all the contract accepts as a built-in ref", () => {
    for (const id of IDS) expect(CategoryRef.safeParse(id).success).toBe(true);
  });
});
