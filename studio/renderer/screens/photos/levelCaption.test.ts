import { describe, expect, test } from "bun:test";
import type { CategoryRef, LegsShare } from "../../../shared/engine";
import { BED_POOL, category, PARIS_POOL } from "./categoryScreenKit";
import {
  cardImportedLine,
  cardLevelCaption,
  flirtyCaption,
  FLIRTY_BUILTIN_ONLY,
  launchImportedLine,
  launchLevelCaption,
  type CardCaptionContext,
  type LaunchCaptionContext,
} from "./level";

// 5a.4 (S5.BA8a, plan s5a4 §5.9 rows 1, 2, 19, 19a, 19b; r2.3 L1–L5, M2; r2.4 N1–N3): the «Смелая» caption of the card and of «Автопилот», word for word. The names are neutral fixtures: Ava is made
// in Studio, Bea and Cleo are imported (the owner's own avatars are never in a public repo).

const NB = "\u00A0";
/** «Seedream 5 Pro · 2K», joined by non-breaking spaces (§5.9). */
const MODEL = `Seedream${NB}5${NB}Pro${NB}·${NB}2K`;
const THE_RUN = `Рисует их ${MODEL}.`;
const IMPORTED_TAIL = "без простыни, полотенца и пены; в промпте бельё плотное.";

const AVA = { name: "Ava", origin: "studio" } as const;
const BEA = { name: "Bea", origin: "imported" } as const;
const CLEO = { name: "Cleo", origin: "imported" } as const;
const PARIS = category(1, "Кофейни Парижа", PARIS_POOL);
const [firstPlace] = PARIS_POOL.locations;
if (firstPlace === undefined) throw new Error("the fixture pool has no place");
const BY_THE_POOL = category(2, "У бассейна", { ...PARIS_POOL, locations: [...PARIS_POOL.locations.slice(0, 5), { ...firstPlace, name: "hotel pool" }] });
const BED = category(3, "Постель", BED_POOL);

const CUSTOMS = [PARIS, BY_THE_POOL, BED];
const card = (avatar: CardCaptionContext["avatar"], legs: LegsShare = 0): CardCaptionContext => ({ avatar, legs, customs: [PARIS, BY_THE_POOL, BED] });
const launch = (avatars: LaunchCaptionContext["avatars"], legs: LegsShare = 0): LaunchCaptionContext => ({ avatars, legs, customs: [PARIS, BY_THE_POOL, BED] });
const avatar = (toGenerate: number, blocked: "open-set" | null = null) => ({ toGenerate, blocked });

describe("the card's caption at «Смелая» (§5.9 row 1)", () => {
  test("«Ночнушки и бельё» alone, Ava, 20 photos: the clothing, the sheet, the tiers over the request, the places", () => {
    expect(cardLevelCaption("bold", 20, ["nightwear"], card(AVA))).toBe(
      `Все 20${NB}кадров — в белье или атласе; часть смелых — только простыня. Откровеннее всего — 8, кокетливо — 8, скромнее — 4. Места — дома. ${THE_RUN}`,
    );
  });

  test("«Дом» alone, Ava: «в белье или атласе … Места — дома.» with the three covers", () => {
    expect(cardLevelCaption("bold", 20, ["home"], card(AVA))).toBe(
      `Все 20${NB}кадров — в белье или атласе; часть смелых — только простыня, полотенце или пена. Откровеннее всего — 8, кокетливо — 8, скромнее — 4. Места — дома. ${THE_RUN}`,
    );
  });

  test("the tiers are counted over the whole request, 8 / 8 / 4 of 20 over the five (r2.2 D1)", () => {
    expect(cardLevelCaption("bold", 20, ["home", "travel", "shoot", "glam", "fit"], card(AVA))).toContain("Откровеннее всего — 8, кокетливо — 8, скромнее — 4.");
  });

  test("the five together: every word the categories give, the covers in the clause's order", () => {
    expect(cardLevelCaption("bold", 20, ["home", "travel", "shoot", "glam", "fit"], card(AVA))).toBe(
      `Все 20${NB}кадров — в белье, атласе или купальнике у воды; часть смелых — только простыня, полотенце или пена. Откровеннее всего — 8, кокетливо — 8, скромнее — 4. Места — дома, в номере, на балконе, у воды. ${THE_RUN}`,
    );
  });

  // r2.3 L2: «Пляж и бассейн» alone has no places and no implied cover.
  test("«Пляж и бассейн» alone: «в купальнике у воды», no cover clause (Ava included), no «Места — …»", () => {
    const caption = cardLevelCaption("bold", 20, ["beach"], card(AVA));
    expect(caption).toBe(`Все 20${NB}кадров — в купальнике у воды. Откровеннее всего — 8, кокетливо — 8, скромнее — 4. ${THE_RUN}`);
    expect(caption).not.toContain("Места");
    expect(caption).not.toContain("часть смелых");
  });

  test("«Пляж и бассейн» beside «Дом» adds the swimwear and no place", () => {
    expect(cardLevelCaption("bold", 20, ["home", "beach"], card(AVA))).toContain("— в белье, атласе или купальнике у воды;");
    expect(cardLevelCaption("bold", 20, ["home", "beach"], card(AVA))).toContain("Места — дома.");
  });

  // r2.3 L3.
  test("«Фитнес» alone says «в белье»; with «Ножки» it adds «или атласе» (its legs frames wear satin)", () => {
    expect(cardLevelCaption("bold", 20, ["fit"], card(AVA, 0))).toContain(`кадров — в белье; часть смелых — только полотенце.`);
    expect(cardLevelCaption("bold", 20, ["fit"], card(AVA, 15))).toContain(`кадров — в белье или атласе; часть смелых — только полотенце.`);
  });

  test("a custom category: «в белье», in a room or at home, the sheet and the towel", () => {
    expect(cardLevelCaption("bold", 20, [PARIS.categoryId], card(AVA))).toBe(
      `Все 20${NB}кадров — в белье; часть смелых — только простыня или полотенце. Откровеннее всего — 8, кокетливо — 8, скромнее — 4. Места — дома, в номере. ${THE_RUN}`,
    );
  });

  test("a custom category with a water place adds «купальнике у воды» and «у воды»", () => {
    expect(cardLevelCaption("bold", 20, [BY_THE_POOL.categoryId], card(AVA))).toBe(
      `Все 20${NB}кадров — в белье или купальнике у воды; часть смелых — только простыня или полотенце. Откровеннее всего — 8, кокетливо — 8, скромнее — 4. Места — дома, в номере, у воды. ${THE_RUN}`,
    );
  });

  test("a custom category beside «Пляж и бассейн» keeps the custom category's covers", () => {
    expect(cardLevelCaption("bold", 20, ["beach", PARIS.categoryId], card(AVA))).toContain("часть смелых — только простыня или полотенце.");
  });

  describe("the cover clause only for a Studio-created avatar (r2.3 M2)", () => {
    test("Bea (imported) beside «Дом»: no clause", () => {
      expect(cardLevelCaption("bold", 20, ["home"], card(BEA))).toBe(
        `Все 20${NB}кадров — в белье или атласе. Откровеннее всего — 8, кокетливо — 8, скромнее — 4. Места — дома. ${THE_RUN}`,
      );
    });

    test("an avatar nobody could read (no origin, null) is the imported side", () => {
      expect(cardLevelCaption("bold", 20, ["home"], card({ name: "Dee" }))).not.toContain("часть смелых");
      expect(cardLevelCaption("bold", 20, ["home"], card(null))).not.toContain("часть смелых");
      expect(cardLevelCaption("bold", 20, ["home"], card({ name: "Eve", origin: "portrait-3" }))).not.toContain("часть смелых");
    });
  });

  describe("a part whose count is 0 is left out, and N = 1 reads «Кадр» (r2.3 L5)", () => {
    test("2 photos: 1 bold, 1 flirty, no «скромнее — 0»", () => {
      expect(cardLevelCaption("bold", 2, ["home"], card(BEA))).toBe(`Все 2${NB}кадра — в белье или атласе. Откровеннее всего — 1, кокетливо — 1. Места — дома. ${THE_RUN}`);
    });

    test("1 photo: «Кадр — …», the first part that is left capitalised", () => {
      expect(cardLevelCaption("bold", 1, ["home"], card(BEA))).toBe(`Кадр — в белье или атласе. Кокетливо — 1. Места — дома. Рисует его ${MODEL}.`);
    });

    test("21 photos: the count agrees with its word", () => {
      expect(cardLevelCaption("bold", 21, ["home"], card(BEA))).toMatch(/^Все 21\u00A0кадр — /);
    });
  });

  test("«Обычная» says nothing; nor does a run of no photos or of no category", () => {
    expect(cardLevelCaption("ordinary", 20, ["home"], card(AVA))).toBe(null);
    expect(cardLevelCaption("bold", 0, ["home"], card(AVA))).toBe(null);
    expect(cardLevelCaption("bold", 20, [], card(AVA))).toBe(null);
  });

  test("a custom category the library does not hold has no words, so the caption is null rather than a sentence about nothing", () => {
    expect(cardLevelCaption("bold", 20, ["cat-gone-for-good"], card(AVA))).toBe(null);
  });

  test("«Кокетливая» says what it always said, custom-only included", () => {
    expect(cardLevelCaption("flirty", 20, ["home", "travel", "glam"], card(AVA))).toBe(flirtyCaption(12, 20));
    expect(cardLevelCaption("flirty", 20, [PARIS.categoryId], card(AVA))).toBe(FLIRTY_BUILTIN_ONLY);
  });
});

describe("the card's line for an imported avatar (§5.9 row 2, r2.4 N3)", () => {
  const LINE = `Аватар из фото — ${IMPORTED_TAIL}`;

  test("Bea beside «Дом»: the line of its own", () => {
    expect(cardImportedLine("bold", 20, ["home"], card(BEA))).toBe(LINE);
  });

  test("Bea with «Пляж и бассейн» alone: no line (r2.3 L1, N2)", () => {
    expect(cardImportedLine("bold", 20, ["beach"], card(BEA))).toBe(null);
  });

  test("Bea with «Пляж и бассейн» and another category: the line", () => {
    expect(cardImportedLine("bold", 20, ["beach", "fit"], card(BEA))).toBe(LINE);
  });

  test("Bea with a custom category: the line (its rooms have the sheet and the towel)", () => {
    expect(cardImportedLine("bold", 20, [PARIS.categoryId], card(BEA))).toBe(LINE);
  });

  test("Ava (Studio-created): no line", () => {
    expect(cardImportedLine("bold", 20, ["home"], card(AVA))).toBe(null);
  });

  test("an avatar nobody could read reads as imported", () => {
    expect(cardImportedLine("bold", 20, ["home"], card(null))).toBe(LINE);
  });

  test("below «Смелая», or with nothing to draw: no line", () => {
    expect(cardImportedLine("flirty", 20, ["home"], card(BEA))).toBe(null);
    expect(cardImportedLine("ordinary", 20, ["home"], card(BEA))).toBe(null);
    expect(cardImportedLine("bold", 0, ["home"], card(BEA))).toBe(null);
    expect(cardImportedLine("bold", 20, [], card(BEA))).toBe(null);
  });
});

describe("«Автопилот»'s caption at «Смелая» (§5.9 rows 19, 19a, 19b)", () => {
  // Three avatars with 6 new photos each over «Дом»: each avatar's compose is one request, 2 / 3 / 1 of 6 each, so 6 / 9 / 3 of 18 (r2.2 D1).
  const plan = { avatars: [avatar(6), avatar(6), avatar(6)], totals: { toGenerate: 18 } };

  test("sums per avatar, with «≈»: 6 / 9 / 3 of 18, the cover clause because Ava is Studio-created", () => {
    expect(launchLevelCaption("bold", plan, ["home"], launch([AVA, BEA, CLEO]))).toBe(
      `Все 18${NB}новых кадров — в белье или атласе; часть смелых — только простыня, полотенце или пена. Откровеннее всего ≈ 6, кокетливо ≈ 9, скромнее ≈ 3. Места — дома. ${THE_RUN}`,
    );
  });

  test("only imported avatars selected: no clause", () => {
    expect(launchLevelCaption("bold", plan, ["home"], launch([BEA, CLEO]))).not.toContain("часть смелых");
  });

  test("no avatar selected: no clause", () => {
    expect(launchLevelCaption("bold", plan, ["home"], launch([]))).not.toContain("часть смелых");
  });

  test("leaves a blocked avatar out, as the plan's totals do", () => {
    const blocked = { avatars: [avatar(6), avatar(6, "open-set")], totals: { toGenerate: 6 } };
    expect(launchLevelCaption("bold", blocked, ["home"], launch([AVA, BEA]))).toContain(`Все 6${NB}новых кадров`);
    expect(launchLevelCaption("bold", blocked, ["home"], launch([AVA, BEA]))).toContain("Откровеннее всего ≈ 2, кокетливо ≈ 3, скромнее ≈ 1.");
  });

  test("«Пляж и бассейн» alone: no places, no clause", () => {
    const caption = launchLevelCaption("bold", plan, ["beach"], launch([AVA]));
    expect(caption).toBe(`Все 18${NB}новых кадров — в купальнике у воды. Откровеннее всего ≈ 6, кокетливо ≈ 9, скромнее ≈ 3. ${THE_RUN}`);
  });

  test("«Фитнес» says «атласе» only with «Ножки»", () => {
    expect(launchLevelCaption("bold", plan, ["fit"], launch([BEA], 0))).toContain("новых кадров — в белье. ");
    expect(launchLevelCaption("bold", plan, ["fit"], launch([BEA], 30))).toContain("новых кадров — в белье или атласе. ");
  });

  test("one new photo: «Новый кадр — …»", () => {
    const one = { avatars: [avatar(1)], totals: { toGenerate: 1 } };
    expect(launchLevelCaption("bold", one, ["home"], launch([BEA]))).toBe(`Новый кадр — в белье или атласе. Кокетливо ≈ 1. Места — дома. Рисует его ${MODEL}.`);
  });

  test("21 new photos: the count agrees with its word", () => {
    const many = { avatars: [avatar(21)], totals: { toGenerate: 21 } };
    expect(launchLevelCaption("bold", many, ["home"], launch([BEA]))).toMatch(/^Все 21\u00A0новый кадр — /);
  });

  test("with no plan yet: the share of ten, «Новые кадры — …» (r2.3 L4)", () => {
    expect(launchLevelCaption("bold", null, ["home", "beach"], launch([BEA]))).toBe(
      `Новые кадры — в белье, атласе или купальнике у воды. Из каждых 10: откровеннее всего ≈ 4, кокетливо ≈ 4, скромнее ≈ 2. Места — дома. ${THE_RUN}`,
    );
  });

  test("with no plan yet and a Studio-created avatar: the clause in #19's shape", () => {
    expect(launchLevelCaption("bold", null, ["home"], launch([AVA]))).toContain("в белье или атласе; часть смелых — только простыня, полотенце или пена. Из каждых 10:");
  });

  test("with nothing new to draw, or no category, says nothing", () => {
    expect(launchLevelCaption("bold", { avatars: [avatar(0)], totals: { toGenerate: 0 } }, ["home"], launch([AVA]))).toBe(null);
    expect(launchLevelCaption("bold", plan, [], launch([AVA]))).toBe(null);
    expect(launchLevelCaption("bold", null, [], launch([AVA]))).toBe(null);
  });

  test("«Кокетливая» says what it always said, «Обычная» nothing", () => {
    expect(launchLevelCaption("flirty", plan, ["home", "shoot"], launch([AVA]))).toMatch(/^≈ \d+ из\s18\sновых кадров — кокетливые/);
    expect(launchLevelCaption("ordinary", plan, ["home"], launch([AVA]))).toBe(null);
  });
});

describe("«Автопилот»'s imported-avatar line (§5.9 row 19b, r2.4 N2, N3)", () => {
  test("one imported avatar: «Аватар из фото (Bea) — …»", () => {
    expect(launchImportedLine("bold", ["home"], [AVA, BEA], CUSTOMS)).toBe(`Аватар из фото (Bea) — ${IMPORTED_TAIL}`);
  });

  test("several: «Аватары из фото (Bea, Cleo) — …», in the order they were picked", () => {
    expect(launchImportedLine("bold", ["home"], [BEA, AVA, CLEO], CUSTOMS)).toBe(`Аватары из фото (Bea, Cleo) — ${IMPORTED_TAIL}`);
  });

  test("only Studio-created avatars, or none: no line", () => {
    expect(launchImportedLine("bold", ["home"], [AVA], CUSTOMS)).toBe(null);
    expect(launchImportedLine("bold", ["home"], [], CUSTOMS)).toBe(null);
  });

  test("not shown when «Пляж и бассейн» is the only category (N2)", () => {
    expect(launchImportedLine("bold", ["beach"], [BEA], CUSTOMS)).toBe(null);
    expect(launchImportedLine("bold", ["beach", "home"], [BEA], CUSTOMS)).not.toBe(null);
  });

  test("a custom category the library does not hold (not loaded, deleted) gives no lingerie to speak of", () => {
    expect(launchImportedLine("bold", ["cat-gone-for-good"], [BEA], CUSTOMS)).toBe(null);
    expect(cardImportedLine("bold", 20, ["cat-gone-for-good"], card(BEA))).toBe(null);
  });

  test("an avatar nobody could read is imported", () => {
    expect(launchImportedLine("bold", ["home"], [{ name: "Dee" }], CUSTOMS)).toBe(`Аватар из фото (Dee) — ${IMPORTED_TAIL}`);
  });

  test("below «Смелая»: no line", () => {
    expect(launchImportedLine("flirty", ["home"], [BEA], CUSTOMS)).toBe(null);
    expect(launchImportedLine("ordinary", ["home"], [BEA], CUSTOMS)).toBe(null);
  });
});
