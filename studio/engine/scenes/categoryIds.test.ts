import { describe, expect, test } from "bun:test";
import { BOLD_CATEGORIES, CategoryRef, isBoldCategory, ORDINARY_SCENE_CATEGORIES, SceneCategory } from "../../shared/engine";
import { BANKS } from "../../shared/scenes/banks";
import { BANK_CATEGORIES, ORDINARY_BANK_CATEGORIES } from "../../shared/scenes/banks/types";
import { BUILT_IN_LABEL, categoryRefOf, categoryStyleOf, ORDINARY_BUILT_INS, plannerCategoryOf } from ".";
import { POOLS } from "./pools";
import { CATEGORIES } from "./types";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5a.2 (S5.6R, I5.33 «ids stay»): the stored ids and the engine names of the five built-in categories never change: a stored plan, set or photo names its
// category by these strings, and a renamed one would orphan old data. «Смелая» got ids of its own when it shipped (5a.3, S5.9b2, plan s5a3 §6.1): `nightwear`
// («Ночнушки и бельё») and `beach` («Пляж и бассейн»), the same in the contract and the engine, after the five; no other id is added.

const ORDINARY_IDS = ["home", "travel", "shoot", "glam", "fit"] as const;
/** The same five as the engine names them (pools, banks, planner). */
const ORDINARY_NAMES = ["home", "travel", "photoshoot", "glamour", "fitness"] as const;
const BOLD_IDS = ["nightwear", "beach"] as const;
const BOLD_LIKE = /bold|daring|brave|smel|boudoir|lingerie|nightwear|swimwear|beach|pool|nude/i;

describe("the built-in category ids stay (I5.33)", () => {
  test("the contract's SceneCategory is the five stored ids in the canonical order, then the two «Смелая» ids", () => {
    expect([...SceneCategory.options]).toEqual([...ORDINARY_IDS, ...BOLD_IDS]);
  });

  test("the engine's category names are the five, then the two «Смелая» names, and each maps to its stored id and back", () => {
    expect([...CATEGORIES]).toEqual([...ORDINARY_NAMES, ...BOLD_IDS]);
    expect(CATEGORIES.map((name) => categoryRefOf(name))).toEqual([...ORDINARY_IDS, ...BOLD_IDS]);
    expect([...ORDINARY_IDS, ...BOLD_IDS].map((id) => plannerCategoryOf(id))).toEqual([...ORDINARY_NAMES, ...BOLD_IDS]);
  });

  // 5a.3 (S5.9b2, plan s5a3 §6.4 r3): the five ordinary built-ins by name, beside the category list the two «Смелая» categories join. The sweeps that hold a
  // plan to the ordinary and flirty rules run over these five; the engine's and the banks' copies are the same list.
  test("ORDINARY_BUILT_INS names the five ordinary built-ins in the canonical order, and the banks' list is the same", () => {
    expect([...ORDINARY_BUILT_INS]).toEqual([...ORDINARY_NAMES]);
    expect([...ORDINARY_BANK_CATEGORIES]).toEqual([...ORDINARY_BUILT_INS]);
    expect(ORDINARY_BUILT_INS.every((name) => CATEGORIES.includes(name))).toBe(true);
  });

  test("the pools and the banks hold those seven and no other category", () => {
    expect(Object.keys(POOLS).sort()).toEqual([...ORDINARY_NAMES, ...BOLD_IDS].sort());
    expect(Object.keys(BANKS).sort()).toEqual([...ORDINARY_NAMES, ...BOLD_IDS].sort());
    expect([...BANK_CATEGORIES]).toEqual([...CATEGORIES]);
  });
});

describe("the two «Смелая» ids, and no other (I5.33, plan s5a3 §6.1)", () => {
  test("BOLD_CATEGORIES names them; the contract's five ordinary ids are the rest of SceneCategory", () => {
    expect([...BOLD_CATEGORIES]).toEqual([...BOLD_IDS]);
    expect([...ORDINARY_SCENE_CATEGORIES]).toEqual([...ORDINARY_IDS]);
  });

  test("isBoldCategory says so for the two and for nothing else: not the five, a custom id or an own scene", () => {
    expect([...SceneCategory.options].filter(isBoldCategory)).toEqual([...BOLD_IDS]);
    for (const ref of ["cat-paris-cafes", "own", "bold", "Beach", "nightwear "]) expect(isBoldCategory(ref), ref).toBe(false);
  });

  test("the «Смелая» banks are the bold ones, and the five's banks are not", () => {
    for (const category of BANK_CATEGORIES) expect({ category, bold: BANKS[category].bold === true }).toEqual({ category, bold: isBoldCategory(category) });
  });

  test("none of the five's ids or names, pools or banks, names a bolder level", () => {
    for (const id of [...ORDINARY_SCENE_CATEGORIES, ...ORDINARY_BUILT_INS]) expect(BOLD_LIKE.test(id), id).toBe(false);
  });

  test.each(["bold", "daring", "smelaya", "smelaja", "brave", "lingerie", "pool", "swimwear", "Nightwear", "beaches"])("«%s» is not a category ref the contract accepts", (id) => {
    expect(CategoryRef.safeParse(id).success).toBe(false);
  });

  test("the seven ids are all the contract accepts as a built-in ref", () => {
    for (const id of [...ORDINARY_IDS, ...BOLD_IDS]) expect(CategoryRef.safeParse(id).success).toBe(true);
  });
});

describe("what the writer is told and how the photo is finished", () => {
  test("«Bedroom» and «Beach»: no longer than the five's longest label, so the built-in writer pin holds (plan s5a3 §6.1)", () => {
    expect([BUILT_IN_LABEL.nightwear, BUILT_IN_LABEL.beach]).toEqual(["Bedroom", "Beach"]);
    const longest = Math.max(...ORDINARY_BUILT_INS.map((c) => BUILT_IN_LABEL[c].length));
    for (const label of [BUILT_IN_LABEL.nightwear, BUILT_IN_LABEL.beach]) expect(label.length).toBeLessThanOrEqual(longest);
  });

  test("both are phone photos", () => {
    expect([categoryStyleOf("nightwear"), categoryStyleOf("beach")]).toEqual(["phone", "phone"]);
  });
});
