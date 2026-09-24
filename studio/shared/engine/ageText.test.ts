import { describe, expect, test } from "bun:test";
import { adultTextProblems, ageMentions, ageUpperBounds, nonAsciiDigits, youthWords } from "./ageText";

describe("ageMentions", () => {
  test.each([
    // English, digits
    ["25-year-old woman", [25]],
    ["looks 17 years old", [17]],
    ["a 17 year old face", [17]],
    ["17-years-old", [17]],
    ["17 years of age", [17]],
    ["aged 17", [17]],
    ["age 17", [17]],
    ["age: 17", [17]],
    ["at the age of 17", [17]],
    ["17 yo", [17]],
    ["17yo", [17]],
    ["17 y.o.", [17]],
    ["17 y/o", [17]],
    ["17 yrs old", [17]],
    ["17 yrs", [17]],
    ["looks 16", [16]],
    ["looks like 16", [16]],
    ["looks like she is 17", [17]],
    ["looks like she's 17", [17]],
    ["seems 15", [15]],
    ["could pass for 16", [16]],
    ["passes for 16", [16]],
    ["appears about 14", [14]],
    ["appears to be 15", [15]],
    ["121-year-old", [121]],
    // English, words
    ["seventeen-year-old", [17]],
    ["Seventeen-Year-Old", [17]],
    ["seventeen years old", [17]],
    ["aged fifteen", [15]],
    ["twelve y.o.", [12]],
    ["looks seventeen", [17]],
    ["seems fifteen", [15]],
    ["appears around fourteen", [14]],
    ["one-year-old", [1]],
    ["a twenty-year-old", [20]],
    ["twenty-five-year-old", [25]],
    ["twenty five years old", [25]],
    // compatibility forms fold to ASCII first (NFKC)
    ["looks １７ years old", [17]],
    // Russian
    ["выглядит на 15 лет", [15]],
    ["выглядит на пятнадцать", [15]],
    ["лет 15 на вид", [15]],
    ["25 лет", [25]],
    ["3 года", [3]],
    ["1 год", [1]],
    ["16-летняя", [16]],
    ["15-ти летняя", [15]],
    ["15-ти-летняя", [15]],
    ["пятнадцатилетняя", [15]],
    ["пятнадцати летняя", [15]],
    ["пятнадцатилетка", [15]],
    ["16-летка", [16]],
    ["Шестнадцать лет", [16]],
    ["двадцать пять лет", [25]],
    ["двадцатипятилетняя", [25]],
    ["восемнадцатилетняя", [18]],
    // several at once
    ["25-year-old woman who looks 17 years old", [25, 17]],
  ])("finds the age in %p", (text, expected) => {
    expect(ageMentions(text)).toEqual(expected);
  });

  test.each([
    "two freckles and one small mole",
    "has lived in Lisbon for 3 years",
    "170 cm tall, size 38 shoes",
    "one hand holds the phone",
    "looks like one of the locals",
    "seems one of a kind",
    "looks great in 2 dresses",
    "в летнем платье",
    "coffee, travel, books",
  ])("finds no age in %p", (text) => {
    expect(ageMentions(text)).toEqual([]);
  });
});

describe("ageUpperBounds", () => {
  test.each([
    ["under 18", [18]],
    ["under-18", [18]],
    ["looks under 18 years old", [18]],
    ["below 21", [21]],
    ["younger than 20.", [20]],
    ["less than eighteen", [18]],
    ["under 30", [30]],
    ["младше 18", [18]],
    ["моложе 16 лет", [16]],
  ])("finds the bound in %p", (text, expected) => {
    expect(ageUpperBounds(text)).toEqual(expected);
  });

  test.each(["under 5 minutes of makeup", "below the knee", "under the sun", "less than 3 coffees a day"])(
    "finds no age bound in %p",
    (text) => {
      expect(ageUpperBounds(text)).toEqual([]);
    },
  );
});

describe("nonAsciiDigits", () => {
  test.each([
    ["Arabic-Indic", "looks ١٧ years old"],
    ["Eastern Arabic", "۱۷ yo"],
    ["Devanagari", "१७ years old"],
  ])("finds %s digits", (_label, text) => {
    expect(nonAsciiDigits(text).length).toBeGreaterThan(0);
  });

  test.each(["25-year-old woman", "looks １７ years old"])("finds none in %p (fullwidth folds to ASCII)", (text) => {
    expect(nonAsciiDigits(text)).toEqual([]);
  });
});

const HARD_WORDS = [
  "teen",
  "teens",
  "teenage",
  "teenager",
  "teenagers",
  "TEENAGE",
  "preteen",
  "pre-teen",
  "tween",
  "tweens",
  "schoolgirl",
  "Schoolgirl",
  "school girl",
  "schoolgirls",
  "school uniform",
  "high school",
  "high-school",
  "highschool",
  "loli",
  "lolita",
  "jailbait",
  "minor",
  "minors",
  "underage",
  "under-age",
  "young-looking",
  "young looking",
  "barely legal",
  "ｔｅｅｎ",
  "подросток",
  "подростки",
  "подростковый",
  "школьница",
  "Школьницы",
  "школьная форма",
  "школьной форме",
  "ученица",
  "ученицы",
  "несовершеннолетняя",
  "несовершеннолетний",
  "малолетка",
  "малолетняя",
  "малышка",
  "юная",
  "юной",
];

const SOFT_WORDS = ["girl", "girls", "it-girl", "cover girl", "kid", "kids", "kids-free", "child", "children", "children's books", "childlike", "девочка", "девочки", "ребёнок", "ребенок"];

describe("youthWords in descriptor scope", () => {
  test.each([...HARD_WORDS, ...SOFT_WORDS])("flags %p", (word) => {
    expect(youthWords(`a ${word} in a cafe`, "descriptor").length).toBeGreaterThan(0);
  });

  test.each([
    "with her girlfriend",
    "girlfriends on a trip",
    "kidney-shaped pool",
    "the minority of days",
    "canteen lunch",
    "fifteen minutes of fame",
    "young woman",
    "a youthful smile",
    "мечтала об этом в юности",
    "девушка в кафе",
    "детали интерьера",
    "25-year-old woman, light olive skin, hazel eyes, slim athletic build.",
  ])("does not flag %p", (text) => {
    expect(youthWords(text, "descriptor")).toEqual([]);
  });
});

describe("youthWords in vibe scope", () => {
  test.each(HARD_WORDS)("still flags the hard marker %p", (word) => {
    expect(youthWords(`a ${word} in a cafe`, "vibe").length).toBeGreaterThan(0);
  });

  test.each(SOFT_WORDS)("lets %p through (the descriptor check catches it later)", (word) => {
    expect(youthWords(`a ${word} in a cafe`, "vibe")).toEqual([]);
  });
});

describe("adultTextProblems", () => {
  test("is empty for an adult text that restates the same age", () => {
    expect(adultTextProblems("25-year-old woman, aged 25, with a youthful smile", 25, "descriptor")).toEqual([]);
  });

  test("reports another age", () => {
    expect(adultTextProblems("25-year-old woman, looks 17", 25, "descriptor")).toContain("other-age");
  });

  test.each(["under 18", "below 21", "younger than 21"])("reports the bound %p even at age 21", (bound) => {
    expect(adultTextProblems(`21-year-old woman, looks ${bound}`, 21, "descriptor")).toContain("under-21-bound");
  });

  test("allows an upper bound above 21", () => {
    expect(adultTextProblems("25-year-old woman, looks under 30", 25, "descriptor")).toEqual([]);
  });

  test("reports non-ASCII digits", () => {
    expect(adultTextProblems("25-year-old woman, ١٧", 25, "descriptor")).toContain("non-ascii-digits");
  });

  test("reports a youth word", () => {
    expect(adultTextProblems("25-year-old schoolgirl", 25, "descriptor")).toContain("youth-word");
  });
});

// ---------- final round: normalisation, script policy, more age contexts ----------

describe("normalisation before matching", () => {
  test.each([
    ["non-breaking hyphens (U+2011)", "17‑year‑old", [17]],
    ["hyphens (U+2010)", "17‐year‐old", [17]],
    ["em dashes", "17—year—old", [17]],
    ["a thin space", "17 years old", [17]],
    ["a narrow no-break space", "17 years old", [17]],
  ])("finds the age written with %s", (_label, text, expected) => {
    expect(ageMentions(text)).toEqual(expected);
  });
});

describe("more age contexts", () => {
  test.each([
    ["ей 16", [16]],
    ["ей шестнадцать", [16]],
    ["16 годиков", [16]],
    ["barely 18", [18]],
    ["just turned 18", [18]],
    ["not yet 18", [18]],
    ["25 going on 15", [15]],
    ["16 or 17", [16, 17]],
    ["sweet sixteen", [16]],
  ])("finds the age in %p", (text, expected) => {
    expect(ageMentions(text)).toEqual(expected);
  });

  test.each([
    "barely 5 feet tall",
    "2 or 3 coffees a day",
    "in her mid-twenties",
    "going on a trip",
    "just turned the corner",
    "дай ей кофе",
  ])("finds no age in %p", (text) => {
    expect(ageMentions(text)).toEqual([]);
  });

  test.each(["teenie", "teeny-bopper", "middle-schooler", "middle school", "10th-grader", "10th grade", "3rd grader", "тинейджер", "тинейджеры", "школота"])(
    "flags %p in every scope",
    (word) => {
      expect([youthWords(`a ${word}`, "descriptor").length > 0, youthWords(`a ${word}`, "vibe").length > 0]).toEqual([
        true,
        true,
      ]);
    },
  );
});

describe("script policy", () => {
  test.each([
    ["a Cyrillic o inside an English word", "25-year-old woman, 17 years оld"],
    ["a Cyrillic e inside an English word", "25-year-old woman, sixteen yеars old"],
    ["Russian words", "25-year-old woman, юная"],
    ["CJK", "25-year-old woman, 16歳"],
    ["accented Latin (the engine writes plain English)", "25-year-old woman from a café"],
  ])("rejects a descriptor with %s", (_label, text) => {
    expect(adultTextProblems(text, 25, "descriptor")).toContain("script");
  });

  test.each([
    ["a word mixing Latin and Cyrillic", "17 years оld"],
    ["another mixed word", "sixteen yеars old"],
    ["CJK", "16歳"],
    ["Greek", "εφηβος"],
  ])("rejects a vibe with %s", (_label, text) => {
    expect(adultTextProblems(text, 25, "vibe")).toContain("script");
  });

  test.each([
    ["Russian", "уютная, любит кофе и путешествия"],
    ["English", "girl next door, coffee, travel, books"],
    ["both, in separate words", "coffee, кофе, travel"],
    ["accented Latin", "café au lait, crème brûlée"],
    ["an emoji", "coffee ☕"],
  ])("accepts a vibe in %s", (_label, text) => {
    expect(adultTextProblems(text, 25, "vibe")).toEqual([]);
  });

  test("folds accents before matching youth words in a vibe", () => {
    expect(adultTextProblems("tëen vibes", 25, "vibe")).toContain("youth-word");
  });

  test("accepts a plain English descriptor", () => {
    expect(adultTextProblems("25-year-old woman in her mid-twenties, hazel eyes (slim build).", 25, "descriptor")).toEqual([]);
  });
});
