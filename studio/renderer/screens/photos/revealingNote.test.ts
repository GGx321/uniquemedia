import { describe, expect, test } from "bun:test";
import { CUSTOM_BOLD_BANKS, impliedItemsOf } from "../../../shared/scenes/banks/companions";
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

// 2026-10-12, S5.9g (plan s5a3 §13.1 «Мои категории»; mockup 54): «Смелая» shipped, so the note no longer promised it; it said where those frames were drawn.
// 5a.4 (S5.BA8b, plan s5a4 §5.9 rows 15, 16; r2.2 D4, r2.3 M5; mockup 66): «Смелая» draws every category now, a custom one included, so the note says what it gives
// there — lingerie at home or in a room, in the category's world, swimwear at the water — and what nothing gives. «в духе описания» is gone: the engine never draws
// an outfit from the description (I5.78). The two notes are no longer one sentence in two tenses: the created card says the category's outfits are ordinary.
// BA8b round 2 (owner question 1, the controller's default (b)): «Голой Seedream не рисует» was not the whole truth — a Studio-created avatar's most revealing frames may be an implied
// cover — so the notes say «Полностью голой …» and which covers. The covers are a custom category's own, read from its banks (r2.4 N1): the sheet and the towel, no foam.
describe("REVEALING_NOTE", () => {
  test("before «Создать» (row 15, mockup 66): what «Смелая» gives a custom category, and what a Studio-created avatar may get besides", () => {
    expect(REVEALING_NOTE).toBe(
      "Бельё и купальники даёт подача «Смелая»: с ней она выйдет в белье дома или в номере, в мире категории, а у воды — в купальнике. Полностью голой Seedream не рисует; у аватара из Studio часть кадров — только простыня или полотенце.",
    );
  });

  test("on a created category's card (row 16, mockup 66#created): its own outfits are ordinary, and what «Смелая» gives", () => {
    expect(REVEALING_NOTE_DONE).toBe(
      "Наряды категории — обычные. С подачей «Смелая» она выйдет в белье дома или в номере, а у воды — в купальнике. Полностью голой Seedream не рисует; у аватара из Studio часть кадров — только простыня или полотенце.",
    );
  });

  test("the covers named are the custom banks' own: the rooms bank has the sheet and the towel, the water bank none (a bank edit changes the notes)", () => {
    expect([...impliedItemsOf(CUSTOM_BOLD_BANKS.rooms), ...impliedItemsOf(CUSTOM_BOLD_BANKS.water)]).toEqual(["sheet", "towel"]);
    for (const note of [REVEALING_NOTE, REVEALING_NOTE_DONE]) expect(note).not.toContain("пена");
  });

  test("neither note sends the owner to the two built-ins any more, nor promises an outfit «в духе описания»", () => {
    for (const note of [REVEALING_NOTE, REVEALING_NOTE_DONE]) {
      expect(note).not.toContain("во встроенных");
      expect(note).not.toContain("не рисуем");
      expect(note).not.toContain("в духе описания");
    }
  });
});
