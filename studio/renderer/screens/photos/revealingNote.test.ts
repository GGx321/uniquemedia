import { describe, expect, test } from "bun:test";
import { asksForRevealing, REVEALING_NOTE } from "./revealingNote";

// S5.5: the pool generator draws no lingerie, swimwear or nudity until the «Смелая» level ships (poolGen.ts), so a custom category that asks for it comes out in
// everyday clothes. The owner is told before he creates it and on the card. This pins the word match: a pure function of the description, renderer-only.

describe("asksForRevealing: Russian words", () => {
  const ASKS = [
    "В нижнем брендовом белье на кровати для рекламы",
    "в нижнем белье",
    "нижнее бельё",
    "кружевное БЕЛЬЁ",
    "красивого белья",
    "с бельем в руках",
    "в трусах и майке",
    "трусики",
    "без лифчика",
    "лифчик на стуле",
    "в бюстгальтере",
    "в стрингах",
    "стринги",
    "в чулках",
    "чулки со швом",
    "в купальнике у бассейна",
    "купальник",
    "в бикини на пляже",
    "голая на кровати",
    "лежит голой",
    "обнажённая",
    "обнажена",
    "обнаженка",
    "топлес на пляже",
    "в плавках",
  ];
  for (const text of ASKS) {
    test(`matches «${text}»`, () => {
      expect(asksForRevealing(text)).toBe(true);
    });
  }
});

describe("asksForRevealing: English words", () => {
  const ASKS = ["wearing lingerie", "Lingerie on the bed", "in her underwear", "a black bra", "bras on a chair", "in panties", "a thong", "in stockings", "a swimsuit by the pool", "swimwear", "in a bikini", "nude", "completely naked", "topless on a beach", "a sports bra", "a slip dress"];
  for (const text of ASKS) {
    test(`matches «${text}»`, () => {
      expect(asksForRevealing(text)).toBe(true);
    });
  }
});

describe("asksForRevealing: the boundaries", () => {
  const ORDINARY = [
    "белый",
    "в белом платье",
    "белая рубашка и белые кеды",
    "бельгийский шоколад",
    "в Бельгии",
    "бельмо",
    "трусливый",
    "трус",
    "голова",
    "голос",
    "голубое платье",
    "голые руки",
    "купальная шапочка",
    "чулан",
    "стрингер",
    "bracelet",
    "brand new shoes",
    "Brazil",
    "an embrace",
    "a nudge",
    "a stonework museum",
    "a car-free zone",
    "a cocktail bar and a restaurant",
    "",
    "   ",
  ];
  for (const text of ORDINARY) {
    test(`does not match «${text}»`, () => {
      expect(asksForRevealing(text)).toBe(false);
    });
  }

  test("ignores case", () => {
    expect(asksForRevealing("БИКИНИ")).toBe(true);
    expect(asksForRevealing("Topless")).toBe(true);
  });

  test("reads ё and е as the same letter", () => {
    expect(asksForRevealing("бельё")).toBe(true);
    expect(asksForRevealing("белье")).toBe(true);
    expect(asksForRevealing("обнажённая")).toBe(true);
    expect(asksForRevealing("обнаженная")).toBe(true);
  });

  test("matches a word at the start, in the middle and at the end of the text", () => {
    expect(asksForRevealing("бельё, кровать")).toBe(true);
    expect(asksForRevealing("девушка в белье на кровати")).toBe(true);
    expect(asksForRevealing("кровать, бельё")).toBe(true);
    expect(asksForRevealing("кровать (бельё)")).toBe(true);
  });

  test("matches on a later line of a multi-line description", () => {
    expect(asksForRevealing("Дома вечером.\nВ белье на кровати.")).toBe(true);
  });
});

describe("REVEALING_NOTE", () => {
  test("is the neutral sentence the owner asked for", () => {
    expect(REVEALING_NOTE).toBe("Бельё, купальники и обнажёнку пока не рисуем — категория выйдет в обычной одежде. Это появится с уровнем «Смелая».");
  });
});
