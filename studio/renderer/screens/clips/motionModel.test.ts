import { describe, expect, test } from "bun:test";
import { MOTION_PROBLEMS, MOTION_PROBLEMS_RU, OWN_IDEA_MAX, OwnIdeaText, type MotionProblem } from "../../../shared/engine";
import {
  batchTagOf,
  checkIdea,
  flattenLines,
  frameNotesNews,
  ideaFaultText,
  ideaNoneLine,
  insertIdeaText,
  lineText,
  motionGoneNews,
  motionMoneyWord,
  motionRowLabel,
  rejectedPaidLine,
  rejectionText,
  showsEnglish,
  suggestedLine,
  suggestNoneLine,
  translatedLine,
} from "./motionModel";

// 5b.2 part C, S5.WC5 (plan s5b2 §5.3 «Money per call», I5.68; README §S5.WCD «Деньги на экране»): what a part C call cost, in the window's words. «бесплатно» ONLY when the call cost nothing
// (`costMicros === 0`, a moderation 4xx); any other cost is «оплачено $X», never below $0.001 (`motionCostShownMicros`), to the nearest in three decimals — whatever the outcome was.

/** The no-break spaces the lines bind their numbers and dashes with, read as plain spaces. */
const plain = (text: string): string => text.replace(/ /g, " ");

describe("the money word of a part C call", () => {
  test("0 µ$ is «бесплатно», and only 0", () => {
    expect(motionMoneyWord(0)).toBe("бесплатно");
    expect(motionMoneyWord(1)).not.toBe("бесплатно");
  });

  test("a cost above 0 is «оплачено $X», never «$0.000»: anything below $0.001 shows as $0.001", () => {
    expect(motionMoneyWord(1)).toBe("оплачено $0.001");
    expect(motionMoneyWord(400)).toBe("оплачено $0.001");
    expect(motionMoneyWord(999)).toBe("оплачено $0.001");
    expect(motionMoneyWord(1_000)).toBe("оплачено $0.001");
  });

  test("the mockups' figures: 62b $0.003, 62c $0.004, 63a $0.001, 63b $0.002, a whole ceiling $0.015", () => {
    expect(motionMoneyWord(3_400)).toBe("оплачено $0.003");
    expect(motionMoneyWord(1_800 + 2_100)).toBe("оплачено $0.004");
    expect(motionMoneyWord(1_000)).toBe("оплачено $0.001");
    expect(motionMoneyWord(900 + 1_100)).toBe("оплачено $0.002");
    expect(motionMoneyWord(14_810)).toBe("оплачено $0.015");
  });

  test("a figure that is not whole micro-dollars is refused, not shown", () => {
    expect(() => motionMoneyWord(-1)).toThrow();
    expect(() => motionMoneyWord(0.5)).toThrow();
  });
});

describe("the result lines (62b, 62c, 63a, 63b)", () => {
  test("62b: the count agrees with its noun, the cost after the dash", () => {
    expect(plain(lineText(suggestedLine(3, 3_400)))).toBe("Предложено 3 движения — оплачено $0.003.");
    expect(plain(lineText(suggestedLine(1, 3_400)))).toBe("Предложено 1 движение — оплачено $0.003.");
    expect(plain(lineText(suggestedLine(2, 0)))).toBe("Предложено 2 движения — бесплатно.");
    expect(suggestedLine(3, 3_400).money).toBe("$0.003");
  });

  test("62c: paid — even a paid answer then a moderation refusal (a cost above 0) — says what it cost; free only at 0", () => {
    expect(plain(lineText(suggestNoneLine(1_800 + 2_100)))).toBe("Не получилось предложить движения — оплачено $0.004.");
    expect(plain(lineText(suggestNoneLine(1)))).toBe("Не получилось предложить движения — оплачено $0.001.");
    expect(plain(lineText(suggestNoneLine(0)))).toBe("Модель не стала смотреть этот кадр — бесплатно");
  });

  test("63a and 63b: a translation, a rejection's cost, and both ends of `none`", () => {
    expect(plain(lineText(translatedLine(1_000)))).toBe("Идея переведена — оплачено $0.001.");
    expect(plain(lineText(rejectedPaidLine(2_000)))).toBe("За перевод оплачено $0.002.");
    expect(plain(lineText(rejectedPaidLine(0)))).toBe("Перевод — бесплатно.");
    expect(plain(lineText(ideaNoneLine(2_200)))).toBe("Не получилось перевести идею — оплачено $0.002.");
    expect(plain(lineText(ideaNoneLine(0)))).toBe("Модель не стала переводить эту идею — бесплатно");
  });
});

describe("a rejected idea (63b, 63c)", () => {
  test("each code says the contract's own text", () => {
    for (const problem of MOTION_PROBLEMS) expect(rejectionText([problem])).toBe(MOTION_PROBLEMS_RU[problem]);
    expect(rejectionText(["two-movements"])).toBe("Так не получится: два движения сразу — оставьте одно.");
    expect(rejectionText(["takes-off"])).toBe("Так не получится: здесь одежда остаётся на месте — такое движение только для кадров «Смелой».");
  });

  test("one text per refusal: the first problem in the contract's display order, whatever order they came in", () => {
    const shuffled: MotionProblem[] = ["too-long", "takes-off", "content"];
    expect(rejectionText(shuffled)).toBe(MOTION_PROBLEMS_RU.content);
    expect(rejectionText(["too-long", "two-movements"])).toBe(MOTION_PROBLEMS_RU["two-movements"]);
    expect(rejectionText([])).toBeNull();
  });
});

describe("the rows", () => {
  test("an own idea is «Своя идея: …»; a suggestion, the scene and the code keep their label", () => {
    expect(motionRowLabel({ source: "own", label: "медленно поворачивает голову…" })).toBe("Своя идея: медленно поворачивает голову…");
    expect(motionRowLabel({ source: "vision", label: "Дует на чай" })).toBe("Дует на чай");
    expect(motionRowLabel({ source: "code", label: "Моргает и улыбается" })).toBe("Моргает и улыбается");
  });

  test("the English shows under what a model wrote and under the scene, not under the code", () => {
    expect(["scene", "code", "vision", "own"].map((source) => showsEnglish({ source: source as "scene" }))).toEqual([true, false, true, true]);
  });

  test("59d: a batch row marks a suggestion and an own idea", () => {
    expect([batchTagOf({ source: "scene" }), batchTagOf({ source: "code" }), batchTagOf({ source: "vision" }), batchTagOf({ source: "own" })]).toEqual([null, null, "предложено", "своя идея"]);
  });

  test("62d: the frame's notes are said as one sentence, in lower case after «:» and «;»; none says nothing", () => {
    expect(frameNotesNews(["capture-differs", "second-phone"])).toBe("Заметки о кадре: камера в кадре не такая, как в сцене; в кадре виден второй телефон — он может остаться в клипе.");
    expect(frameNotesNews(["second-phone"])).toBe("Заметки о кадре: в кадре виден второй телефон — он может остаться в клипе.");
    expect(frameNotesNews([])).toBeNull();
  });

  test("a chosen row that left the list is said with what is chosen now", () => {
    expect(plain(motionGoneNews("Дует на чай", "Как в сцене"))).toBe("Движение «Дует на чай» больше не в списке — выбрано «Как в сцене».");
  });
});

describe("the idea field (63): the contract's `OwnIdeaText` decides", () => {
  const sample = [
    "медленно поворачивает голову, прислушиваясь к шуму за окном",
    "   ",
    "",
    "медленно поворачивает голову\tк окну",
    "\tулыбается",
    "улыбается 👩‍🦰",
    "улыбается 🙂",
    "123 !!!",
    "🙂",
    "улыбается​медленно",
    "улыбается снова",
    "у".repeat(OWN_IDEA_MAX),
    "у".repeat(OWN_IDEA_MAX + 1),
  ];

  test("a text is sendable exactly when the contract takes it", () => {
    for (const text of sample) expect({ text, ok: checkIdea(text).ok }).toEqual({ text, ok: OwnIdeaText.safeParse(text).success });
  });

  test("a sendable text goes without its edge spaces", () => {
    expect(checkIdea("  улыбается  ")).toEqual({ ok: true, idea: "улыбается" });
  });

  test("the cause it names: nothing typed says nothing; a ZWJ emoji, a tab or a separator is a service character; digits and signs alone want words", () => {
    expect(checkIdea("")).toEqual({ ok: false, fault: "blank" });
    expect(checkIdea("   ")).toEqual({ ok: false, fault: "blank" });
    expect(checkIdea("улыбается 👩‍🦰")).toEqual({ ok: false, fault: "service" });
    expect(checkIdea("медленно поворачивает голову\tк окну")).toEqual({ ok: false, fault: "service" });
    expect(checkIdea("улыбается снова")).toEqual({ ok: false, fault: "service" });
    expect(checkIdea("123 !!!")).toEqual({ ok: false, fault: "no-letter" });
    expect(checkIdea("🙂")).toEqual({ ok: false, fault: "no-letter" });
    expect(checkIdea("улыбается 🙂")).toEqual({ ok: true, idea: "улыбается 🙂" });
    expect(ideaFaultText("service")).toBe("Уберите из идеи служебные символы.");
    expect(ideaFaultText("no-letter")).toBe("Опишите движение словами.");
    expect(ideaFaultText("blank")).toBeNull();
  });

  test("Enter and pasted line breaks become spaces", () => {
    expect(flattenLines("медленно\nповорачивает\r\nголову\rк окну")).toBe("медленно поворачивает голову к окну");
    expect(insertIdeaText("улыбается", 9, 9, "\n")).toEqual({ value: "улыбается ", caret: 10 });
    expect(insertIdeaText("ab", 1, 1, "x\ny")).toEqual({ value: "ax yb", caret: 4 });
  });

  test("an insertion over a selection keeps the limit, and a cut never splits an emoji's surrogate pair", () => {
    const full = "у".repeat(OWN_IDEA_MAX - 1);
    expect(insertIdeaText(full, full.length, full.length, "ab")).toEqual({ value: `${full}a`, caret: OWN_IDEA_MAX });
    expect(insertIdeaText(full, full.length, full.length, "🙂")).toEqual({ value: full, caret: full.length });
    expect(insertIdeaText("abc", 0, 3, "xy")).toEqual({ value: "xy", caret: 2 });
  });
});
