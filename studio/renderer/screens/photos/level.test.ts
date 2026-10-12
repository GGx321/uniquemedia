import { describe, expect, test } from "bun:test";
import { ORDINARY_SCENE_CATEGORIES, splitCount } from "../../../shared/engine";
import { flirtyCountOf, levelCountsOf } from "../../../shared/scenes/level";
import {
  BOLD_FIVE,
  BOLD_ONLY,
  BOLD_SLOW,
  boldAttemptLine,
  cardLevelCaption,
  flirtyCaption,
  flirtyFrames,
  gatedNote,
  launchFlirtyCaption,
  launchLevelCaption,
  LEVEL_KEY_PREFIX,
  LEVEL_OPTIONS,
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

const NB = " ";
const SEEDREAM_TAIL = "Смелые кадры рисует Seedream 5 Pro · 2K.";

describe("«Подача» offers all three faces now", () => {
  test("«Обычная · Кокетливая · Смелая», in that order, none of them held back", () => {
    expect(LEVEL_OPTIONS.map((o) => [o.value, o.label])).toEqual([
      ["ordinary", "Обычная"],
      ["flirty", "Кокетливая"],
      ["bold", "Смелая"],
    ]);
  });
});

describe("levelFrames: the bold and flirty frames of a run, from the shared rules (never re-derived here)", () => {
  test("is levelCountsOf in each «Смелая» category and flirtyCountOf(·, flirty) in each of the five, over the planner's own split", () => {
    for (const count of [5, 10, 20, 25, 37, 100]) {
      const categories = ["home", "glam", "nightwear", "beach", "cat-paris-cafes"] as const;
      let bold = 0;
      let flirty = 0;
      for (const { ref, count: n } of splitCount(count, categories)) {
        if (ref === "nightwear" || ref === "beach") {
          bold += levelCountsOf(n).bold;
          flirty += levelCountsOf(n).flirty;
        } else if (ref === "home" || ref === "glam") flirty += flirtyCountOf(n, "flirty");
      }
      expect(levelFrames(count, categories, "bold")).toMatchObject({ bold, flirty });
    }
  });

  test("names the «Смелая» categories that get photos, in the run's order", () => {
    expect(levelFrames(20, ["nightwear", "beach"], "bold").boldCategories).toEqual(["nightwear", "beach"]);
    expect(levelFrames(20, ["home", "nightwear"], "bold").boldCategories).toEqual(["nightwear"]);
    // Five photos over seven categories: the last two get none, so no frame of theirs is bold.
    expect(levelFrames(5, ["home", "travel", "shoot", "glam", "fit", "nightwear", "beach"], "bold")).toMatchObject({ bold: 0, boldCategories: [] });
  });

  test("is «Кокетливая»'s count at «Кокетливая», and nothing at «Обычная»", () => {
    expect(levelFrames(20, ["home", "travel", "glam"], "flirty")).toMatchObject({ bold: 0, flirty: 12 });
    expect(levelFrames(20, ["home", "nightwear"], "ordinary")).toMatchObject({ bold: 0, flirty: 0, boldCategories: [] });
  });
});

describe("the card's «Подача» caption (mockups 47, 47a, 47b, 48#kept)", () => {
  test("«Обычная» says nothing; nor does a run of no photos", () => {
    expect(cardLevelCaption("ordinary", 20, ["home"])).toBe(null);
    expect(cardLevelCaption("bold", 0, ["nightwear"])).toBe(null);
    expect(cardLevelCaption("flirty", 0, ["home"])).toBe(null);
  });

  test("47: «Ночнушки и бельё» 10 + «Пляж и бассейн» 10 → 8 of 20 bold, 8 flirty, the words of both categories", () => {
    expect(cardLevelCaption("bold", 20, ["nightwear", "beach"])).toBe(`8 из 20${NB}кадров — смелые: бельё, купальники; 8 — кокетливые. ${SEEDREAM_TAIL}`);
  });

  test("47a: «Дом» 10 + «Ночнушки и бельё» 10 → 4 bold, 10 flirty, no «купальники»", () => {
    expect(cardLevelCaption("bold", 20, ["home", "nightwear"])).toBe(`4 из 20${NB}кадров — смелые: бельё; 10 — кокетливые. ${SEEDREAM_TAIL}`);
  });

  test("48#kept, back on «Смелая»: 7 + 7 + 6 → 2 bold, 11 flirty; the count follows the stepper (25 → 10 and 10)", () => {
    expect(cardLevelCaption("bold", 20, ["home", "travel", "nightwear"])).toBe(`2 из 20${NB}кадров — смелые: бельё; 11 — кокетливые. ${SEEDREAM_TAIL}`);
    expect(cardLevelCaption("bold", 25, ["nightwear", "beach"])).toBe(`10 из 25${NB}кадров — смелые: бельё, купальники; 10 — кокетливые. ${SEEDREAM_TAIL}`);
  });

  test("47b: only the five → the plan's line; only custom categories → «Подача — только во встроенных категориях»", () => {
    expect(BOLD_FIVE).toBe("Смелые кадры — только в «Ночнушки и бельё» и «Пляж и бассейн». Остальные категории — как «Кокетливая».");
    expect(cardLevelCaption("bold", 20, ORDINARY_SCENE_CATEGORIES)).toBe(BOLD_FIVE);
    expect(cardLevelCaption("bold", 20, ["home", "cat-paris-cafes"])).toBe(BOLD_FIVE);
    expect(cardLevelCaption("bold", 20, ["cat-paris-cafes"])).toBe("Подача — только во встроенных категориях");
  });

  test("«Кокетливая» says what it always said", () => {
    expect(cardLevelCaption("flirty", 20, ["home", "travel", "glam"])).toBe(flirtyCaption(12, 20));
    expect(cardLevelCaption("flirty", 20, ["cat-paris-cafes"])).toBe("Подача — только во встроенных категориях");
  });
});

describe("the lines around «Смелая»", () => {
  test("the slow-frames line is the plan's (r3.1), word for word", () => {
    expect(BOLD_SLOW).toBe("Кадры «Смелой» рисуются дольше — около минуты каждый.");
  });

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

// Mockup 52: three avatars with 5, 6 and 7 new photos over the two «Смелая» categories → ≈ 7 bold and 6 flirty of 18.
describe("the launch's «Подача» caption at «Смелая» (mockup 52)", () => {
  const avatar = (toGenerate: number, blocked: "open-set" | null = null) => ({ toGenerate, blocked });
  const plan = { avatars: [avatar(5), avatar(6), avatar(7)], totals: { toGenerate: 18 } };

  test("sums each avatar's bold and flirty frames over its new photos: ≈ 7 and 6 of 18", () => {
    expect(launchLevelCaption("bold", plan, ["nightwear", "beach"])).toBe(`≈ 7 из 18${NB}новых кадров — смелые: бельё, купальники; 6 — кокетливые. ${SEEDREAM_TAIL}`);
  });

  test("leaves a blocked avatar out, as the plan's totals do", () => {
    const blocked = { avatars: [avatar(5), avatar(6, "open-set")], totals: { toGenerate: 5 } };
    expect(launchLevelCaption("bold", blocked, ["nightwear", "beach"])).toBe(`≈ 2 из 5${NB}новых кадров — смелые: бельё, купальники; 2 — кокетливые. ${SEEDREAM_TAIL}`);
  });

  test("with only the five on, says they draw as «Кокетливая»; with only custom ones, where «Подача» works", () => {
    expect(launchLevelCaption("bold", plan, ["home", "fit"])).toBe(BOLD_FIVE);
    expect(launchLevelCaption("bold", null, ["home", "fit"])).toBe(BOLD_FIVE);
    expect(launchLevelCaption("bold", plan, ["cat-paris-cafes"])).toBe("Подача — только во встроенных категориях");
  });

  // 2026-10-12, S5.9g round 2: «≈» like mockup 52's caption, and nothing at all when the plan draws no new frame (no bold frame to speak of).
  test("with no plan yet, says the share of a «Смелая» category's ten frames with «≈», as mockup 52 words its caption", () => {
    expect(launchLevelCaption("bold", null, ["home", "nightwear"])).toBe(`≈ 4 из 10${NB}новых кадров — смелые: бельё; 4 — кокетливые. ${SEEDREAM_TAIL}`);
  });

  test("with nothing new to draw, says nothing", () => {
    expect(launchLevelCaption("bold", { avatars: [avatar(0)], totals: { toGenerate: 0 } }, ["home", "nightwear"])).toBe(null);
  });

  test("«Кокетливая» says what it always said, «Обычная» nothing", () => {
    expect(launchLevelCaption("flirty", plan, ["home", "shoot"])).toBe(launchFlirtyCaption(plan, ["home", "shoot"]));
    expect(launchLevelCaption("ordinary", plan, ["home"])).toBe(null);
  });
});
