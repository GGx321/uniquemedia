import { describe, expect, test } from "bun:test";
import {
  adultTextProblems,
  ageMentions,
  ageUpperBounds,
  allYouthRuleNames,
  DESCRIPTOR_MAX_CHARS,
  hardYouthWords,
  namesNumberWord,
  youthRuleNames,
  youthWords,
} from "./ageText";

// The core of the kept minor-age guard (owner, 2026-10-29: slim it, do not remove it): an explicit age or an under-21 bound in English or Russian, digits or
// words; the youth words and the school context of the existing lists, as whole words in any case; a plain normalisation (case, fullwidth forms, dashes,
// spaces, invisible characters, accents) and the script rule against look-alike letters. A few rows per rule, folded: each test prints every row it misses.

/** The rows whose answer differs from the expected one, each with what it got, so one failing run names all of them. */
function misses<Row, Answer>(rows: readonly Row[], read: (row: Row) => Answer, want: (row: Row) => Answer): { row: Row; got: Answer }[] {
  return rows.flatMap((row) => {
    const got = read(row);
    return Bun.deepEquals(got, want(row)) ? [] : [{ row, got }];
  });
}

const isYouth = (text: string, scope: "descriptor" | "vibe"): boolean => youthWords(text, scope).length > 0;

describe("ageMentions: an age stated outright", () => {
  test("reads the English forms, in digits and in words", () => {
    const rows: [string, number[]][] = [
      ["25-year-old woman", [25]],
      ["17 years old", [17]],
      ["seventeen-year-old", [17]],
      ["17 years young", [17]],
      ["aged 17", [17]],
      ["age: 17", [17]],
      ["at the age of 17", [17]],
      ["aged twenty-five", [25]],
      ["twenty five years old", [25]],
      ["17 y/o", [17]],
      ["17yo", [17]],
      ["17 y.o.", [17]],
      ["looks 16", [16]],
      ["looks like she's 17", [17]],
      ["could pass for 16", [16]],
      ["she's 17", [17]],
      ["she is sixteen", [16]],
      ["she'll be 17", [17]],
      ["her age is 16", [16]],
      ["at 17, she moved to Paris", [17]],
      ["at seventeen", [17]],
      ["just turned 18", [18]],
      ["barely 18", [18]],
      ["sweet sixteen", [16]],
      ["25-year-old woman who looks 17 years old", [25, 17]],
    ];
    expect(misses(rows, ([text]) => ageMentions(text), ([, ages]) => ages)).toEqual([]);
  });

  test("reads the Russian forms, in digits and in words", () => {
    const rows: [string, number[]][] = [
      ["15 лет", [15]],
      ["3 года", [3]],
      ["16-летняя", [16]],
      ["15-ти летняя", [15]],
      ["пятнадцатилетняя", [15]],
      ["двадцатипятилетняя", [25]],
      ["Шестнадцать лет", [16]],
      ["двадцать пять лет", [25]],
      ["выглядит на 15", [15]],
      ["лет 15 на вид", [15]],
      ["ей 16", [16]],
      ["ей всего шестнадцать", [16]],
      ["16 годиков", [16]],
    ];
    expect(misses(rows, ([text]) => ageMentions(text), ([, ages]) => ages)).toEqual([]);
  });

  test("reads no age in a count, a measure, a clock time or a lone «one»", () => {
    const rows = [
      "has lived in Lisbon for 3 years",
      "170 cm tall, size 38 shoes",
      "she's 5 feet tall",
      "she's 5'6\" with long legs",
      "she's one of a kind",
      "looks like one of the locals",
      "barely 5 feet tall",
      "2 or 3 coffees a day",
      "wakes up at 6, drinks coffee",
      "at 7:30 she runs",
      "in her mid-twenties",
      "в летнем платье",
      "дай ей кофе",
      "ей всего хватает",
    ];
    expect(misses(rows, ageMentions, () => [])).toEqual([]);
  });
});

describe("ageUpperBounds: «under N»", () => {
  test("reads the bound in English and in Russian", () => {
    const rows: [string, number[]][] = [
      ["under 18", [18]],
      ["under-18", [18]],
      ["below 21", [21]],
      ["younger than 20.", [20]],
      ["less than eighteen", [18]],
      ["not yet 21", [21]],
      ["25 going on 15", [15]],
      ["младше 18", [18]],
      ["моложе 16 лет", [16]],
    ];
    expect(misses(rows, ([text]) => ageUpperBounds(text), ([, bounds]) => bounds)).toEqual([]);
  });

  test("reads none where «under» or «less than» bounds no age", () => {
    expect(misses(["under 5 minutes of makeup", "below the knee", "under the sun", "less than 3 coffees a day"], ageUpperBounds, () => [])).toEqual([]);
  });
});

describe("the normalisation every check runs on", () => {
  test("folds case, fullwidth forms, every dash and every space", () => {
    const rows: [string, number[]][] = [
      ["Seventeen-Year-Old", [17]],
      ["looks １７ years old", [17]],
      ["17‑year‑old", [17]],
      ["17—year—old", [17]],
      ["17 years old", [17]],
    ];
    expect(misses(rows, ([text]) => ageMentions(text), ([, ages]) => ages)).toEqual([]);
    expect(misses(["TEENAGE", "ｔｅｅｎ", "ШКОЛЬНИЦА"], (word) => isYouth(`a ${word} in a cafe`, "vibe"), () => true)).toEqual([]);
  });

  test("an invisible character or an accent inside a word hides nothing", () => {
    expect(misses(["te⁠en look", "te﻿en look", "tëen vibes"], (text) => isYouth(text, "vibe"), () => true)).toEqual([]);
  });

  test("a digit that is not ASCII is refused", () => {
    expect(adultTextProblems("looks ١٧ years old", 25, "vibe")).toContain("non-ascii-digits");
    expect(adultTextProblems("looks １７ years old", 17, "vibe")).toEqual([]);
  });
});

describe("youth words", () => {
  test("the English hard markers are refused in every scope, whole word, any case", () => {
    const words = [
      "teen", "teens", "teenager", "preteen", "pre-teen", "tween", "schoolgirl", "school girl", "school uniform", "high school", "middle school",
      "10th grade", "loli", "lolita", "jailbait", "jail bait", "nymphet", "minor", "underage", "under-age", "barely legal", "adolescent", "prepubescent",
      "juvenile", "young-looking",
    ];
    const both = (word: string): [boolean, boolean] => [isYouth(`a ${word} in a cafe`, "descriptor"), isYouth(`a ${word} in a cafe`, "vibe")];
    expect(misses(words, both, () => [true, true])).toEqual([]);
  });

  test("the Russian hard markers are refused in every scope, in their word forms", () => {
    const words = [
      "подросток", "подростки", "школьница", "Школьницы", "школьная форма", "школьной форме", "ученица", "несовершеннолетняя", "малолетка", "малышка",
      "юная", "юной", "тинейджер", "школота", "лолита", "нимфетка", "старшеклассница", "пятиклассница", "первоклашка",
    ];
    const both = (word: string): [boolean, boolean] => [isYouth(`она ${word} в кафе`, "descriptor"), isYouth(`она ${word} в кафе`, "vibe")];
    expect(misses(words, both, () => [true, true])).toEqual([]);
  });

  test("a school grade in Russian is refused: the third to the eleventh before «класс», in any case", () => {
    const rows = [
      "в девятом классе",
      "девятый класс",
      "из третьего класса",
      "ученица одиннадцатого класса",
      "в девятых классах",
      "в девятом-классе",
      "девушка девятого класса поезда",
    ];
    expect(misses(rows, (text) => hardYouthWords(`медленно раздевается, ${text}`).length > 0, () => true)).toEqual([]);
  });

  test("the descriptor's set refuses the softer words a vibe lets through", () => {
    const words = ["girl", "girls", "kid", "child", "baby-faced", "young woman", "youthful smile", "petite", "tiny frame", "college freshman", "boyish frame", "innocent look", "toddler", "infant", "newborn", "девочка", "ребёнок", "младенец"];
    const scopes = (word: string): [boolean, boolean] => [isYouth(`a ${word} in a cafe`, "descriptor"), isYouth(`a ${word} in a cafe`, "vibe")];
    expect(misses(words, scopes, () => [true, false])).toEqual([]);
  });

  test("an infant's things are youth words of the descriptor's set", () => {
    const rows = [
      "with a pacifier", "in a diaper", "in nappies", "with a sippy cup", "with a teether", "holding a bottle of formula",
      "с соской", "берёт соску в рот", "сосёт пустышку", "с пустышкой", "в подгузнике", "в памперсе", "трясёт погремушкой", "в слюнявчике", "в ползунках", "в детской кроватке",
    ];
    expect(misses(rows, (text) => isYouth(`she slowly undresses ${text}`, "descriptor"), () => true)).toEqual([]);
  });

  test("ordinary words never read as youth words, even in the descriptor's stricter set", () => {
    const rows = [
      "Little Italy", "a studio portrait", "a classic look", "a classy look", "old-school glamour", "kidney-shaped pool", "the minority of days",
      "canteen lunch", "public beaches", "a juicy peach", "adult, adulthood", "25-year-old woman, light olive skin, hazel eyes",
      "классный стиль", "это класс", "в первом классе поезда", "в первом классе самолёта", "билет второго класса", "мечтала об этом в юности", "девушка в кафе",
      "детали интерьера", "малыш, улыбается", "медленно касается соска", "проводит пальцем по соску", "соскальзывает с кровати", "соскучилась", "ложится в кроватку",
      "двигает ползунок громкости",
    ];
    expect(misses(rows, (text) => youthWords(text, "descriptor"), () => [])).toEqual([]);
  });

  test("hardYouthWords is the vibe's set, as the text has the words", () => {
    expect(hardYouthWords("She could be a teenager, maybe in high school.")).toEqual(["teenager", "high school"]);
    expect(hardYouthWords("a young, youthful woman, girl next door")).toEqual([]);
  });
});

describe("a refusal never quotes the text", () => {
  test("the rule names are fixed names from our own list, never words of the text", () => {
    const text = "SchoolGirls in TEENAGE uniforms, a GiRlIsH grin";
    const names = youthRuleNames(text, "descriptor");
    const written = text.split(/[^\p{L}]+/u);
    expect([...names].sort()).toEqual(["girl", "school", "schoolgirl", "teen", "uniform"]);
    expect(names.filter((name) => !allYouthRuleNames("descriptor").includes(name))).toEqual([]);
    expect(names.filter((name) => written.includes(name))).toEqual([]);
  });

  test("a sixth-grader is told by the rule's name", () => {
    expect(youthRuleNames("a sixth-grader look", "descriptor")).toEqual(["Nth grade"]);
  });

  test("the names are distinct, and the descriptor's list holds the vibe's", () => {
    const descriptor = allYouthRuleNames("descriptor");
    expect(new Set(descriptor).size).toBe(descriptor.length);
    expect(allYouthRuleNames("vibe").filter((name) => !descriptor.includes(name))).toEqual([]);
  });
});

describe("adultTextProblems", () => {
  test("a vibe that restates her own age passes", () => {
    expect(adultTextProblems("aged 25, with a youthful smile", 25, "vibe")).toEqual([]);
  });

  test("another age is refused, in English and in Russian", () => {
    expect(adultTextProblems("25-year-old woman, looks 17", 25, "descriptor")).toContain("other-age");
    expect(adultTextProblems("ей 16", 25, "vibe")).toContain("other-age");
  });

  test("a bound of 21 or less is refused even at 21; one above 21 passes in a vibe", () => {
    const bounds = ["under 18", "below 21", "younger than 21", "not yet 21"];
    expect(misses(bounds, (bound) => adultTextProblems(`21-year-old woman, looks ${bound}`, 21, "descriptor").includes("under-21-bound"), () => true)).toEqual([]);
    expect(adultTextProblems("looks under 30", 25, "vibe")).toEqual([]);
  });

  test("a youth word is refused", () => {
    expect(adultTextProblems("25-year-old schoolgirl", 25, "descriptor")).toContain("youth-word");
  });

  test("a Latin word with a Cyrillic look-alike letter is refused, as is any non-ASCII letter in the descriptor", () => {
    const rows: [string, "descriptor" | "vibe"][] = [
      ["17 years оld", "vibe"],
      ["sixteen yеars old", "vibe"],
      ["tееn vibes", "vibe"],
      ["25-year-old woman, юная", "descriptor"],
      ["25-year-old woman from a café", "descriptor"],
    ];
    expect(misses(rows, ([text, scope]) => adultTextProblems(text, 25, scope).includes("script"), () => true)).toEqual([]);
  });

  test("a vibe in Russian, in English or both in separate words passes the script rule", () => {
    expect(misses(["уютная, любит кофе и путешествия", "girl next door, coffee, travel", "coffee, кофе, travel", "café au lait"], (text) => adultTextProblems(text, 25, "vibe"), () => [])).toEqual([]);
  });
});

describe("the descriptor holds no number but its age anchor", () => {
  const D = "25-year-old European woman, hazel eyes, ";

  test("a digit or a number word beside the anchor is refused", () => {
    const rows = ["t33n look", "18+", "a woman of 16", "two freckles", "sixteen-ish", "sixteenth", "in tenth grade", "in her mid-twenties", "twelfth", "a 25-year-old look"];
    expect(misses(rows, (rest) => adultTextProblems(`${D}${rest}`, 25, "descriptor").includes("number"), () => true)).toEqual([]);
    expect(adultTextProblems("125-year-old European woman", 25, "descriptor")).toContain("number");
  });

  test("a lone «one», a number word inside another word and a decade as a style pass", () => {
    const rows = ["a small mole on one cheek", "someone", "stone-grey eyes", "often smiling", "seventies-style curtain bangs", "nineties supermodel brows", "a first-class smile", "a second piercing in the ear", "old-school glamour makeup"];
    expect(misses(rows, (rest) => adultTextProblems(`${D}${rest}.`, 25, "descriptor"), () => [])).toEqual([]);
  });

  test("a vibe may count", () => {
    expect(adultTextProblems("two coffees a day, 3 ear piercings", 25, "vibe")).toEqual([]);
  });

  test("a descriptor over the limit is refused at once, for its length alone", () => {
    expect(DESCRIPTOR_MAX_CHARS).toBe(600);
    expect(adultTextProblems(`25-year-old woman, ${"a".repeat(600)}`, 25, "descriptor")).toEqual(["too-long"]);
  });
});

describe("namesNumberWord (the clip motion check's number rule)", () => {
  test("reads every number word but a lone «one», with its -teen, ordinal and «-ish» forms", () => {
    const rows = ["sixteen", "sixteenth", "sixteenish", "Fifteenth", "twenty-one", "twenties", "forty", "ninetieth", "eleventh", "a dozen"];
    expect(misses(rows, (text) => namesNumberWord(`she slowly turns, ${text}`), () => true)).toEqual([]);
  });

  test("never reads «one» or a word that only holds a number word", () => {
    const rows = ["one", "no one", "someone", "often", "tension", "canteen", "tender", "attention", "a tent"];
    expect(misses(rows, (text) => namesNumberWord(`she slowly turns, ${text}`), () => false)).toEqual([]);
  });
});
