import { describe, expect, test } from "bun:test";
import { ORDINARY_SCENE_CATEGORIES, splitCount, type CategoryRef } from "../../../shared/engine";
import { levelCountsOf, tierSpreadOf } from "../../../shared/scenes/level";
import {
  BOLD_ONLY,
  boldAttemptLine,
  drawsBoldFrames,
  flirtyCaption,
  flirtyFrames,
  gatedNote,
  launchFlirtyCaption,
  LEVEL_KEY_PREFIX,
  levelFrames,
  readLevel,
  writeLevel,
} from "./level";

// S5.7c (plan s5a2 §6.3, I5.28; mockups 25 and 30): «Подача» on the window's side — how many frames «Кокетливая» makes flirty, the caption that says so, and
// the choice remembered per avatar (owner: «Обычная» by default, remembered per avatar).

describe("flirtyFrames (I5.28): round-half-up(0.6 × n) of each built-in category's photos", () => {
  test("is 12 of 20 over «Дом», «Виды» and «Гламур», as mockup 25 says", () => {
    expect(flirtyFrames(20, ["home", "travel", "glam"])).toBe(12);
  });

  test("is 10 of 20 over the five built-ins (4 each, 2.4 → 2)", () => {
    // 2026-10-12, S5.9b2 (plan s5a3 §6.4 r3): the five ordinary built-ins by name (the «Смелая» two join SceneCategory); the assertion is kept.
    expect(flirtyFrames(20, ORDINARY_SCENE_CATEGORIES)).toBe(10);
  });

  test.each([
    [0, 0],
    [1, 1],
    [2, 1],
    [3, 2],
    [4, 2],
    [5, 3],
    [10, 6],
    [99, 59],
    [100, 60],
  ])("is %i → %i for one built-in category", (n, flirty) => {
    expect(flirtyFrames(n, ["home"])).toBe(flirty);
  });

  test("leaves a custom category ordinary: only the built-ins' photos count", () => {
    // 10 photos over «Дом» and one custom category: 5 + 5, only «Дом»'s five count.
    expect(flirtyFrames(10, ["home", "cat-paris-cafes"])).toBe(3);
    expect(flirtyFrames(10, ["cat-paris-cafes"])).toBe(0);
  });

  test("counts nothing with no category", () => {
    expect(flirtyFrames(20, [])).toBe(0);
  });
});

describe("the caption", () => {
  test("is mockup 25's words, the count bound to its word", () => {
    expect(flirtyCaption(12, 20)).toBe("12 из 20 кадров — кокетливые: взгляд, улыбка, поза. Одежда — из категорий.");
  });

  test("says «из 21 кадра» after «из»", () => {
    expect(flirtyCaption(13, 21)).toBe("13 из 21 кадра — кокетливые: взгляд, улыбка, поза. Одежда — из категорий.");
  });
});

// S5.7c (mockup 30): «Автопилот» composes per avatar, so the count is summed over the plan's avatars, of their new photos only — «≈», the plan's split by
// video being the engine's.
describe("the launch's caption", () => {
  const avatar = (toGenerate: number, blocked: "open-set" | null = null) => ({ toGenerate, blocked });

  test("sums each avatar's flirty frames over its new photos: ≈ 13 of 22 for 9, 6 and 7 over «Дом», «Улица», «Гламур»", () => {
    const preview = { avatars: [avatar(9), avatar(6), avatar(7)], totals: { toGenerate: 22 } };
    expect(launchFlirtyCaption(preview, ["home", "shoot", "glam"])).toBe("≈ 13 из 22 новых кадров — кокетливые: взгляд, улыбка, поза. Одежда — из категорий.");
  });

  test("leaves out a blocked avatar, as the plan's totals do", () => {
    const preview = { avatars: [avatar(9), avatar(6, "open-set")], totals: { toGenerate: 9 } };
    expect(launchFlirtyCaption(preview, ["home", "shoot", "glam"])).toBe("≈ 6 из 9 новых кадров — кокетливые: взгляд, улыбка, поза. Одежда — из категорий.");
  });

  test("says «из 21 нового кадра»", () => {
    const preview = { avatars: [avatar(21)], totals: { toGenerate: 21 } };
    expect(launchFlirtyCaption(preview, ["home"])).toBe("≈ 13 из 21 нового кадра — кокетливые: взгляд, улыбка, поза. Одежда — из категорий.");
  });

  // S5.7R carry-over (LOW): with only custom categories on «Кокетливая» works for none of the frames, and «≈ 0 из N» read as a fault; it says where «Подача» works, as the card does.
  test("with only custom categories on, says where «Подача» works, with a plan, with none and with nothing new", () => {
    const only = "Подача — только во встроенных категориях";
    const preview = { avatars: [avatar(9)], totals: { toGenerate: 9 } };
    expect(launchFlirtyCaption(preview, ["cat-paris-cafes"])).toBe(only);
    expect(launchFlirtyCaption(null, ["cat-paris-cafes", "cat-bakeries"])).toBe(only);
    expect(launchFlirtyCaption({ avatars: [avatar(0)], totals: { toGenerate: 0 } }, ["cat-paris-cafes"])).toBe(only);
  });

  test("a built-in category beside a custom one still counts its own frames", () => {
    const preview = { avatars: [avatar(10)], totals: { toGenerate: 10 } };
    expect(launchFlirtyCaption(preview, ["home", "cat-paris-cafes"])).toMatch(/^≈ 3 из\s10\sновых кадров — кокетливые/);
  });

  test("with no plan yet, or nothing new to draw, says the share itself", () => {
    const share = "6 из 10 новых кадров — кокетливые: взгляд, улыбка, поза. Одежда — из категорий.";
    expect(launchFlirtyCaption(null, ["home"])).toBe(share);
    expect(launchFlirtyCaption({ avatars: [avatar(0)], totals: { toGenerate: 0 } }, ["home"])).toBe(share);
  });
});

/** A storage that keeps what is set, or one whose every call throws. */
function memory(): Pick<Storage, "getItem" | "setItem" | "removeItem"> & { items: Map<string, string> } {
  const items = new Map<string, string>();
  return { items, getItem: (k) => items.get(k) ?? null, setItem: (k, v) => void items.set(k, v), removeItem: (k) => void items.delete(k) };
}
const broken: Pick<Storage, "getItem" | "setItem" | "removeItem"> = {
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

describe("«Подача» remembered per avatar", () => {
  test("is «Обычная» for an avatar it was never chosen for", () => {
    expect(readLevel(memory(), "avatar-mia-0001")).toBe("ordinary");
  });

  test("keeps «Кокетливая» for that avatar only", () => {
    const storage = memory();
    writeLevel(storage, "avatar-mia-0001", "flirty");
    expect(readLevel(storage, "avatar-mia-0001")).toBe("flirty");
    expect(readLevel(storage, "avatar-ava-0002")).toBe("ordinary");
    expect(storage.items.get(`${LEVEL_KEY_PREFIX}avatar-mia-0001`)).toBe("flirty");
  });

  test("forgets the key when it goes back to «Обычная»: the default is not stored", () => {
    const storage = memory();
    writeLevel(storage, "avatar-mia-0001", "flirty");
    writeLevel(storage, "avatar-mia-0001", "ordinary");
    expect(storage.items.size).toBe(0);
    expect(readLevel(storage, "avatar-mia-0001")).toBe("ordinary");
  });

  // 2026-10-12, S5.9g (plan s5a3 §13.1, §18.4: «Смелая» is remembered per avatar like «Кокетливая»): the row used to read a stored «bold» as «Обычная», «Смелая»
  // not being a level yet. It is one now, so it is kept and read back; what the row still pins is that a value nobody wrote reads «Обычная».
  test("keeps «Смелая» for that avatar only, as it keeps «Кокетливая»", () => {
    const storage = memory();
    writeLevel(storage, "avatar-mia-0001", "bold");
    expect(storage.items.get(`${LEVEL_KEY_PREFIX}avatar-mia-0001`)).toBe("bold");
    expect(readLevel(storage, "avatar-mia-0001")).toBe("bold");
    expect(readLevel(storage, "avatar-ava-0002")).toBe("ordinary");
    writeLevel(storage, "avatar-mia-0001", "ordinary");
    expect(storage.items.size).toBe(0);
  });

  test("reads anything it does not know as «Обычная»", () => {
    const storage = memory();
    for (const stored of ["Смелая", "BOLD", "bold ", "", "spicy"]) {
      storage.items.set(`${LEVEL_KEY_PREFIX}avatar-mia-0001`, stored);
      expect(readLevel(storage, "avatar-mia-0001")).toBe("ordinary");
    }
  });

  test("works on with a storage that cannot be read or written, or with none", () => {
    expect(readLevel(broken, "avatar-mia-0001")).toBe("ordinary");
    expect(() => writeLevel(broken, "avatar-mia-0001", "flirty")).not.toThrow();
    expect(readLevel(null, "avatar-mia-0001")).toBe("ordinary");
    expect(() => writeLevel(null, "avatar-mia-0001", "flirty")).not.toThrow();
  });
});

// ---------- 5a.3 «Смелая» (S5.9g; plan s5a3 §13.1, I5.36; mockups 47, 47a, 47b, 48, 52 of .omc/stage5/design) ----------

describe("«Подача» offers all three faces now", () => {
});

describe("levelFrames: the tiers of a request, from the shared rules (never re-derived here)", () => {
  /** The tiers `tierSpreadOf` gives the planner's own split, summed: what the card and the autopilot say. */
  const spread = (count: number, categories: readonly CategoryRef[]) => {
    const parts = tierSpreadOf(splitCount(count, categories));
    return { bold: sum(parts.map((p) => p.bold)), flirty: sum(parts.map((p) => p.flirty)), ordinary: sum(parts.map((p) => p.ordinary)) };
  };
  const sum = (values: readonly number[]) => values.reduce((a, b) => a + b, 0);
  const FIVE_BEACH_CUSTOM: readonly CategoryRef[] = ["home", "travel", "shoot", "glam", "fit", "beach", "cat-paris-cafes"];

  // r2.2 D1: at «Смелая» the tiers are counted over the whole request, 8 / 8 / 4 of 20, not rounded inside each category (that gave 10 / 5 / 5).
  test("is 8 / 8 / 4 for 20 photos over the five", () => {
    expect(levelFrames(20, ORDINARY_SCENE_CATEGORIES, "bold")).toMatchObject({ bold: 8, flirty: 8, ordinary: 4 });
  });

  test.each([5, 10, 20, 25, 37, 100])("is the sum of tierSpreadOf over the planner's split for %i photos over the five, «Пляж и бассейн» and a custom category", (count) => {
    expect(levelFrames(count, FIVE_BEACH_CUSTOM, "bold")).toMatchObject(spread(count, FIVE_BEACH_CUSTOM));
  });

  test("keeps the totals of levelCountsOf over the whole request, whatever the categories", () => {
    for (const categories of [["home"], ["beach", "cat-paris-cafes"], ["nightwear", "beach"], FIVE_BEACH_CUSTOM] as const) {
      const { bold, flirty, ordinary } = levelFrames(20, categories, "bold");
      expect({ bold, flirty, ordinary }).toEqual(levelCountsOf(20));
    }
  });

  test("a single category gets exactly levelCountsOf of its photos", () => {
    expect(levelFrames(7, ["travel"], "bold")).toMatchObject({ bold: levelCountsOf(7).bold, flirty: levelCountsOf(7).flirty, ordinary: levelCountsOf(7).ordinary });
  });

  test("counts a custom category's photos too: it draws «Смелая» like the rest", () => {
    expect(levelFrames(20, ["cat-paris-cafes"], "bold")).toMatchObject({ bold: 8, flirty: 8, ordinary: 4 });
  });

  test("names every category that gets a photo, in the run's order", () => {
    expect(levelFrames(20, ["nightwear", "beach"], "bold").drawing).toEqual(["nightwear", "beach"]);
    expect(levelFrames(20, ["home", "nightwear", "cat-paris-cafes"], "bold").drawing).toEqual(["home", "nightwear", "cat-paris-cafes"]);
    // Five photos over seven categories: the last two get none, so they are not named.
    expect(levelFrames(5, ["home", "travel", "shoot", "glam", "fit", "nightwear", "beach"], "bold").drawing).toEqual(["home", "travel", "shoot", "glam", "fit"]);
  });

  test("is «Кокетливая»'s count at «Кокетливая» (unchanged), and nothing at «Обычная»", () => {
    expect(levelFrames(20, ["home", "travel", "glam"], "flirty")).toMatchObject({ bold: 0, flirty: 12 });
    expect(levelFrames(20, ["home", "nightwear"], "ordinary")).toMatchObject({ bold: 0, flirty: 0, drawing: [] });
  });

  test("counts nothing with no category", () => {
    expect(levelFrames(20, [], "bold")).toMatchObject({ bold: 0, flirty: 0, drawing: [] });
  });
});

// r2.2: every «Смелая» frame is Seedream, whatever the category, so the slow-frames line follows "«Смелая» with photos", not the two categories that used to be «Смелая».
describe("drawsBoldFrames: «Смелая» with photos in any category", () => {
  test.each<[string, readonly CategoryRef[]]>([
    ["the five", ORDINARY_SCENE_CATEGORIES],
    ["«Дом» alone", ["home"]],
    ["a custom category alone", ["cat-paris-cafes"]],
    ["«Пляж и бассейн» alone", ["beach"]],
  ])("is true for %s", (_name, categories) => {
    expect(drawsBoldFrames("bold", 20, categories)).toBe(true);
  });

  test("is true for one photo in «Дом»: no bold frame among it, but Seedream still draws it", () => {
    expect(drawsBoldFrames("bold", 1, ["home"])).toBe(true);
  });

  test("is false with no photo, with no category, and below «Смелая»", () => {
    expect(drawsBoldFrames("bold", 0, ["home"])).toBe(false);
    expect(drawsBoldFrames("bold", 20, [])).toBe(false);
    expect(drawsBoldFrames("flirty", 20, ["home"])).toBe(false);
    expect(drawsBoldFrames("ordinary", 20, ["nightwear"])).toBe(false);
  });
});

describe("the lines around «Смелая»", () => {

  test("a gated chip's title, and the note under the chips: none kept, one kept, both kept (48, 48#kept)", () => {
    expect(BOLD_ONLY).toBe("Только со «Смелой»");
    expect(gatedNote([])).toBe("Только со «Смелой»: «Ночнушки и бельё» и «Пляж и бассейн».");
    expect(gatedNote(["Ночнушки и бельё"])).toBe("Только со «Смелой»: выбранная «Ночнушки и бельё» вернётся вместе с ней.");
    expect(gatedNote(["Ночнушки и бельё", "Пляж и бассейн"])).toBe("Только со «Смелой»: выбранные вернутся вместе с ней.");
  });

  test("the price line reads the engine's figure for one Seedream attempt, rounded up, never a figure of its own", () => {
    expect(boldAttemptLine(93_000)).toBe("Seedream 2K — до $0.093 за попытку по прайсу");
    expect(boldAttemptLine(90_001)).toBe("Seedream 2K — до $0.091 за попытку по прайсу");
    expect(boldAttemptLine(120_000)).toBe("Seedream 2K — до $0.12 за попытку по прайсу");
  });
});
