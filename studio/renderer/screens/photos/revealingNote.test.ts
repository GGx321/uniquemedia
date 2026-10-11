import { describe, expect, test } from "bun:test";
import { asksForRevealing, REVEALING_NOTE, REVEALING_NOTE_DONE } from "./revealingNote";

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

describe("asksForRevealing: more Russian phrasings", () => {
  const ASKS = [
    "на голое тело",
    "голые",
    "полуобнажённая",
    "полуобнаженная девушка",
    "полуголая",
    "раздетая",
    "раздетой на кровати",
    "без одежды",
    "в халате",
    "халат",
    "в пеньюаре",
    "в неглиже",
    "в ночной сорочке",
    "ночная сорочка",
    "боди",
    "в чёрном боди",
    "robe over lingerie",
  ];
  for (const text of ASKS) {
    test(`matches «${text}»`, () => {
      expect(asksForRevealing(text)).toBe(true);
    });
  }
});

describe("asksForRevealing: what IS drawn stays quiet", () => {
  const ORDINARY = [
    "с обнажёнными плечами",
    "обнажённые плечи",
    "с голой спиной",
    "голые руки",
    "голые ноги и босоножки",
    "с обнаженными руками",
    "nude lipstick",
    "nude makeup",
    "nude-colored dress",
    "nude heels",
    "a nude color palette",
    "плавка",
    "плавкий предохранитель",
    "Christmas stocking",
    "christmas stockings by the fireplace",
    "бель-этаж",
    "бельэтаж",
    "бодифлекс",
    "халатность",
  ];
  for (const text of ORDINARY) {
    test(`does not match «${text}»`, () => {
      expect(asksForRevealing(text)).toBe(false);
    });
  }

  test("a bare «голая» or «обнажённая» still matches next to a body part elsewhere in the text", () => {
    expect(asksForRevealing("голая, руки за головой")).toBe(true);
    expect(asksForRevealing("обнажённая, плечи в кадре")).toBe(true);
  });

  test("flip-flops called thongs still match (ambiguous, left matching)", () => {
    expect(asksForRevealing("thongs on the beach")).toBe(true);
  });

  test("a plain «nude» still matches", () => {
    expect(asksForRevealing("a nude on the bed")).toBe(true);
  });
});

describe("asksForRevealing: Unicode forms", () => {
  test("reads a decomposed text (NFD) like the composed one", () => {
    expect(asksForRevealing("голой".normalize("NFD"))).toBe(true);
    expect(asksForRevealing("в нижнем бельё".normalize("NFD"))).toBe(true);
    expect(asksForRevealing("обнажённая".normalize("NFD"))).toBe(true);
    expect(asksForRevealing("белый".normalize("NFD"))).toBe(false);
  });
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

  test("on a created category's card it speaks in the past tense and is otherwise the same sentence", () => {
    expect(REVEALING_NOTE_DONE).toBe("Бельё, купальники и обнажёнку пока не рисуем — категория вышла в обычной одежде. Это появится с уровнем «Смелая».");
  });
});
