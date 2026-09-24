import { describe, expect, test } from "bun:test";
import { adultTextProblems, ageMentions, ageUpperBounds, DESCRIPTOR_MAX_CHARS, hardYouthWords, nonAsciiDigits, youthRuleNames, youthWords } from "./ageText";

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

describe("ageMentions: a compound number word is one number", () => {
  test.each([
    ["Adult woman aged twenty-five.", [25]],
    ["aged twenty-five", [25]],
    ["ages twenty-one to twenty-five", [21, 25]],
    ["aged thirty-two", [32]],
    ["ages sixteen-eighteen", [16, 18]],
    ["aged 16-18", [16, 18]],
    ["aged twenty-five-ish", [25]],
  ])("%s → %p", (text, ages) => {
    expect(ageMentions(text)).toEqual(ages);
  });

  test("so a descriptor or a vibe that states the age as words is not read as a second, younger age", () => {
    expect(adultTextProblems("Adult woman aged twenty-five", 25, "vibe")).toEqual([]);
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
    "kidney-shaped pool",
    "the minority of days",
    "canteen lunch",
    "fifteen minutes of fame",
    "мечтала об этом в юности",
    "девушка в кафе",
    "детали интерьера",
    "25-year-old woman, light olive skin, hazel eyes, slim athletic build.",
  ])("does not flag %p", (text) => {
    expect(youthWords(text, "descriptor")).toEqual([]);
  });
});

describe("youthWords in vibe scope", () => {
  test.each(["with her girlfriend", "girlfriends on a trip", "a youthful smile", "baby-faced", "college freshman", "young woman", "a boyish frame"])(
    "lets the ordinary %p through (the descriptor refuses it)",
    (text) => {
      expect(youthWords(text, "vibe")).toEqual([]);
      expect(youthWords(text, "descriptor").length).toBeGreaterThan(0);
    },
  );

  test.each(HARD_WORDS)("still flags the hard marker %p", (word) => {
    expect(youthWords(`a ${word} in a cafe`, "vibe").length).toBeGreaterThan(0);
  });

  test.each(SOFT_WORDS)("lets %p through (the descriptor check catches it later)", (word) => {
    expect(youthWords(`a ${word} in a cafe`, "vibe")).toEqual([]);
  });
});

describe("hardYouthWords", () => {
  test("finds the hard markers of a minor, as the text has them", () => {
    expect(hardYouthWords("She could be a teenager, maybe in high school.")).toEqual(["teenager", "high school"]);
    expect(hardYouthWords("possibly a minor, underage look")).toEqual(["minor", "underage"]);
  });

  test("leaves the words that only describe a youthful look to the descriptor's stricter set", () => {
    expect(hardYouthWords("a young, youthful woman, girl next door")).toEqual([]);
    expect(youthWords("a young, youthful woman, girl next door", "descriptor")).not.toEqual([]);
  });

  test("is the vibe's whole set of youth words", () => {
    for (const text of ["teen model", "school uniform", "a young woman", "petite and young-looking", "adolescent features"]) {
      expect(hardYouthWords(text)).toEqual(youthWords(text, "vibe"));
    }
  });
});

describe("adultTextProblems", () => {
  test("is empty for a vibe that restates the same age", () => {
    expect(adultTextProblems("aged 25, with a youthful smile", 25, "vibe")).toEqual([]);
  });

  test("refuses a descriptor that restates the age: only the anchor may carry a number", () => {
    expect(adultTextProblems("25-year-old woman, aged 25", 25, "descriptor")).toEqual(["number"]);
  });

  test("reports another age", () => {
    expect(adultTextProblems("25-year-old woman, looks 17", 25, "descriptor")).toContain("other-age");
  });

  test.each(["under 18", "below 21", "younger than 21"])("reports the bound %p even at age 21", (bound) => {
    expect(adultTextProblems(`21-year-old woman, looks ${bound}`, 21, "descriptor")).toContain("under-21-bound");
  });

  test("allows an upper bound above 21 in a vibe", () => {
    expect(adultTextProblems("looks under 30", 25, "vibe")).toEqual([]);
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

// ---------- the gaps the T0 review left open (T6a) ----------

describe("ages stated in the T6a gap forms", () => {
  test.each([
    // "she's N", "she is N"
    ["she's 17", [17]],
    ["She's 17!", [17]],
    ["she is sixteen", [16]],
    ["she’s only 16.", [16]],
    ["he is 15 and loves games", [15]],
    ["she was 17, now she travels", [17]],
    // "at N"
    ["at 17, she moved to Paris", [17]],
    ["at 16 she started modelling", [16]],
    ["at seventeen he left home", [17]],
    ["at 17 years", [17]],
    // "N years young"
    ["17 years young", [17]],
    ["seventeen years young", [17]],
    ["17-years-young", [17]],
    ["17 yrs young", [17]],
    // "ages N-M"
    ["ages 16-18", [16, 18]],
    ["ages 16 to 18", [16, 18]],
    ["aged 16-18", [16, 18]],
    ["ages 16", [16]],
    // "ей всего N"
    ["ей всего 16", [16]],
    ["ей всего шестнадцать лет", [16]],
    ["ему только 15", [15]],
  ])("finds the age in %p", (text, expected) => {
    expect(ageMentions(text)).toEqual(expected);
  });

  test.each([
    "she's 5 feet tall",
    "she is 170 cm tall",
    "she's 5'6\" with long legs",
    "she's 100% herself",
    "she is 3 out of 4 sisters",
    "she's one of a kind",
    "she is 2 hours from the sea",
    "wakes up at 6, drinks coffee",
    "coffee at 7 am",
    "meet at 5 pm",
    "at 7:30 she runs",
    "forever young at heart",
    "for ages, she has loved books",
    "images 3 and pages 12",
    "ей всего хватает",
  ])("finds no age in %p", (text) => {
    expect(ageMentions(text)).toEqual([]);
  });

  test("a descriptor that says she is another age is refused", () => {
    expect(adultTextProblems("25-year-old woman; she is sixteen at heart", 25, "descriptor")).toContain("other-age");
  });
});

describe("youth words in the T6a gap forms", () => {
  test.each([
    "underaged",
    "adolescent",
    "adolescents",
    "adolescence",
    "pubescent",
    "prepubescent",
    "juvenile",
    "juveniles",
    "старшеклассница",
    "Старшеклассницы",
    "старшеклассник",
    "пятиклассница",
    "одноклассница",
  ])("flags %p in every scope", (word) => {
    expect([youthWords(`a ${word} in a cafe`, "descriptor").length > 0, youthWords(`a ${word} in a cafe`, "vibe").length > 0]).toEqual([true, true]);
  });

  test.each(["классный стиль", "классная и уютная", "a classy look", "adult, adulthood", "a juicy peach", "public beaches"])(
    "does not flag %p",
    (text) => {
      expect(youthWords(text, "descriptor")).toEqual([]);
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
    expect(adultTextProblems("25-year-old woman, hazel eyes (slim build); natural makeup & high cheekbones!", 25, "descriptor")).toEqual([]);
  });
});

// ---------- T6a-2a review: the descriptor is engine-written, so it is held strictly ----------

const D = "25-year-old European woman, hazel eyes, ";

describe("the descriptor carries no number but its age anchor", () => {
  test.each([
    // digits anywhere else: leetspeak, a second age, a bound, "18+"
    "t33n look",
    "te3n look",
    "l0li look",
    "18+",
    "looks as she did at 16.",
    "the face she had at 16",
    "of 16 summers",
    "a woman of 16",
    "her age is 16",
    "who is 16",
    "she's 5 feet tall",
    "3 ear piercings",
    // number words: two to ninety, every -teen form, compounds, ordinals (a lone "one" is allowed since the follow-up review)
    "two freckles",
    "nine",
    "a face of sixteen",
    "sixteen summers old",
    "sixteen-ish",
    "in tenth grade",
    "in her mid-twenties",
    "twenty minus five",
    "a twenty-one look",
    "twelfth",
    "a woman who is sixteen",
  ])("refuses %p", (rest) => {
    expect(adultTextProblems(`${D}${rest}`, 25, "descriptor")).toContain("number");
  });

  test("the anchor is the only number: a second anchor is refused", () => {
    expect(adultTextProblems(`${D}a 25-year-old look`, 25, "descriptor")).toContain("number");
  });

  test("an anchor inside a longer number leaves a digit: 125-year-old is refused", () => {
    expect(adultTextProblems("125-year-old European woman", 25, "descriptor")).toContain("number");
  });

  test.each(["someone", "stone-grey eyes", "a tenderly soft jawline", "often smiling", "tone", "alone"])(
    "a number word inside another word is not a number: %p",
    (rest) => {
      expect(adultTextProblems(`${D}${rest}`, 25, "descriptor")).toEqual([]);
    },
  );

  test("in a vibe, ordinary numbers stay allowed", () => {
    expect(adultTextProblems("two coffees a day, 3 ear piercings", 25, "vibe")).toEqual([]);
  });
});

describe("the descriptor reads letters spelled out one by one as a word", () => {
  test.each(["t e e n look", "t-e-e-n look", "t.e.e.n. look", "T.E.E.N look", "a k i d look"])("refuses %p", (rest) => {
    expect(adultTextProblems(`${D}${rest}`, 25, "descriptor")).toContain("youth-word");
  });

  test.each(["a woman, a b c", "an A-list look", "U.S.-born"])("an ordinary run of letters that spells nothing passes: %p", (rest) => {
    expect(adultTextProblems(`${D}${rest}`, 25, "descriptor")).toEqual([]);
  });
});

describe("the descriptor refuses every word that suggests she is not a grown adult", () => {
  test.each([
    "baby-faced", "babyface", "baby face", "babydoll look",
    "girlish face", "girly look", "a girl", "her girlfriends",
    "nymphet", "lolicon", "loli", "lolita-esque",
    "jailbait", "jail-bait", "jail bait",
    "barely legal", "barelylegal", "barely of age", "just legal", "just barely legal age",
    "coed look", "co-ed look", "college freshman look", "sophomore look",
    "school-age look", "school aged look", "plaid school skirt", "sailor uniform",
    "sixth-grader look", "in third grade", "grade-schooler",
    "kiddie face", "kiddo", "not old enough to drink", "not yet legal drinking age",
    "youthful face", "young-looking", "young looking", "younger-looking face", "looks much younger than her age",
    "childlike face", "child-like face", "childish grin", "doll-like face",
    "petite frame", "tiny frame", "underdeveloped figure", "undeveloped figure", "flat-chested",
    "pigtails and braces", "half her age",
    "prepubescent", "pre-pubescent", "under age", "adolescent", "minor", "tween",
    "fresh out of high school", "fresh out of highschool", "in her late teens", "teenaged",
  ])("refuses %p", (rest) => {
    expect(adultTextProblems(`${D}${rest}`, 25, "descriptor")).toContain("youth-word");
  });

  test.each([
    "a beauty mark above the lip",
    "high cheekbones",
    "light freckles across the nose",
    "natural makeup",
    "a small nose piercing",
    "a soft jawline and full eyebrows",
    "juicy",
  ])("keeps the ordinary adult %p", (rest) => {
    expect(adultTextProblems(`${D}${rest}.`, 25, "descriptor")).toEqual([]);
  });
});

describe("every scope: hard markers written apart", () => {
  test.each(["jail bait", "jail-bait", "lolicon", "nymphet", "nymphets", "barelylegal", "barely-legal"])("flags %p in the vibe too", (word) => {
    expect(youthWords(`a ${word} vibe`, "vibe").length).toBeGreaterThan(0);
  });

  test("an invisible format character inside a word hides nothing: t\\uFEFFeen, te\\u2060en", () => {
    expect(youthWords("te\uFEFFen look", "vibe").length).toBeGreaterThan(0);
    expect(youthWords("te\u2060en look", "vibe").length).toBeGreaterThan(0);
  });
});

describe("the vibe: every age after she's, who is, she'll be, age is (T6a-2a review)", () => {
  test.each([
    ["she's seven", [7]],
    ["she is nine", [9]],
    ["she was eight", [8]],
    ["she's only six", [6]],
    ["she's 9", [9]],
    ["she'll be 17", [17]],
    ["she will be seventeen", [17]],
    ["who is 16", [16]],
    ["a woman who is sixteen", [16]],
    ["who was 15", [15]],
    ["her age is 16", [16]],
    ["his age was 15", [15]],
    ["at seventeen", [17]],
    ["she's 17 again", [17]],
    ["she is 17 at heart", [17]],
    ["she's twenty", [20]],
    ["she is 20 now", [20]],
  ])("finds the age in %p", (text, expected) => {
    expect(ageMentions(text)).toEqual(expected);
  });

  test.each(["she's one of a kind", "she's one in a million", "she's 5 feet", "she's 5'4\"", "at 7:30 she runs", "wakes at seven", "at ten o'clock"])(
    "finds no age in %p",
    (text) => {
      expect(ageMentions(text)).toEqual([]);
    },
  );
});

describe("not yet N and going on N are bounds, not ages (T6a-2a review)", () => {
  test.each([
    ["not yet 18", [18]],
    ["not yet 21", [21]],
    ["not yet twenty-one", [21]],
    ["25 going on 15", [15]],
  ])("%p is a bound", (text, expected) => {
    expect(ageUpperBounds(text)).toEqual(expected);
    expect(ageMentions(text).filter((n) => expected.includes(n))).toEqual([]);
  });

  test("not yet 21 is refused at age 21, where it used to count as her own age", () => {
    expect(adultTextProblems("not yet 21", 21, "vibe")).toContain("under-21-bound");
  });

  test("not yet 30 is no problem in a vibe at 25", () => {
    expect(adultTextProblems("not yet 30", 25, "vibe")).toEqual([]);
  });
});

describe("reviewer probes on the descriptor, each refused", () => {
  test.each([
    "her age is 16",
    "a woman who is sixteen",
    "who is 16",
    "she turned 16",
    "she'll be 17",
    "she's barely 18",
    "she's in 10th grade",
    "in tenth grade",
    "a sixteen-year-old's face",
    "sixteen-ish",
    "the look of a sixteen year old",
    "teenaged",
    "a woman of 16",
    "she's seven",
    "she is nine",
    "she was eight",
    "she's only six",
    "at seven, she",
    "she's 9",
    "te\uFEFFen look",
    "she's 5 feet",
    "at 7:30 she runs",
    "at 16, she moved",
    "she is sixteen",
    "she's 16.",
    "ей всего 16",
    "старшеклассница",
    "классный",
    "she's 5'4\"",
    "she's 17 again",
    "she is 17 at heart",
    "at seventeen",
    "she's twenty",
    "she is 20 now",
  ])("%p", (probe) => {
    expect(adultTextProblems(`25-year-old woman, ${probe}`, 25, "descriptor").length).toBeGreaterThan(0);
  });

  test.each([
    ["she's seven", false],
    ["she is nine", false],
    ["she was eight", false],
    ["she's only six", false],
    ["at seven, she", false],
    ["she's 9", false],
    ["she's one of a kind", true],
    ["she's one in a million", true],
    ["te\uFEFFen look", false],
    ["she's 5 feet", true],
    ["at 7:30 she runs", true],
    ["at 16, she moved", false],
    ["she is sixteen", false],
    ["she's 16.", false],
    ["ей всего 16", false],
    ["старшеклассница", false],
    ["классный", true],
    ["forever young", true],
    ["juicy", true],
    ["she's 5'4\"", true],
    ["she's 17 again", false],
    ["she is 17 at heart", false],
    ["at seventeen", false],
    ["she's twenty", false],
    ["she is 20 now", false],
  ] as const)("as a vibe at 25, %p passes: %p", (probe, passes) => {
    expect(adultTextProblems(probe, 25, "vibe").length === 0).toBe(passes);
  });
});

// ---------- T6a-2a follow-up: before any paid image call ----------

const F = "25-year-old European woman, light olive skin, hazel eyes, shoulder-length wavy chestnut hair, athletic build";

describe("the descriptor refuses more words that suggest she is not a grown adult", () => {
  test.each([
    "an innocent look", "big innocent eyes", "virginal look", "a virgin", "nubile figure", "cherubic cheeks", "an ingenue look",
    "a waif-like frame", "baby fat on her cheeks", "a babyish smile", "babies", "fresh-faced", "freshfaced", "college-age look",
    "a young face", "young-faced", "young features", "a young look", "a young-looking face", "doe-eyed", "doe eyed", "prom-queen smile", "prom queen",
    "junior look", "jr. look", "tweenish", "lil face", "smol frame", "yung look", "gurl look", "grl look", "a lass", "a lassie", "a missy",
    "a young miss", "a maiden", "a damsel", "kawaii look", "chibi face", "shoujo look", "a nymph-like look", "minorly", "a kiddish look",
    "a bambina look", "a nina look", "kindergarten teacher look",
  ])("refuses %p", (rest) => {
    expect(adultTextProblems(`${F}, ${rest}.`, 25, "descriptor")).toContain("youth-word");
  });

  test.each(["teeen look", "sixteeen", "giiirl", "t/e/e/n features", "t'e'e'n look", "t,e,e,n look", "(t)(e)(e)(n) look", "t-een look", "tee-n look", "t een look"])(
    "refuses %p: repeated letters and odd separators hide nothing",
    (rest) => {
      expect(adultTextProblems(`${F}, ${rest}.`, 25, "descriptor").length).toBeGreaterThan(0);
    },
  );

  test.each(["an innocent look", "fresh-faced", "teeen look", "t/e/e/n"])("the vibe still lets %p through (the descriptor gate refuses it)", (vibe) => {
    expect(adultTextProblems(vibe, 25, "vibe")).toEqual([]);
  });
});

describe("the descriptor keeps ordinary adult wording that would otherwise cost a paid retry", () => {
  test.each([
    // neutral geometry
    "a round face", "a small frame", "a slight build", "a button nose", "rosy cheeks", "a soft round face", "a delicate, slight build",
    // a lone "one"
    "a small mole on one cheek", "one dimple in her left cheek", "her hair parted to one side", "a small tattoo on the inner wrist, one small nose stud",
    "long lashes and a sun-kissed complexion; no one would forget her face",
    // decades as a style, old-school, salon-grade
    "seventies-style curtain bangs", "nineties supermodel brows", "a sixties-inspired winged liner", "thirties finger waves",
    "old-school glamour makeup", "salon-grade blowout",
    // the rest of the reviewer's adult probe list
    "dimples, high cheekbones, full eyebrows, soft jawline, natural makeup", "a light dusting of freckles, heart-shaped face, button nose",
    "no-makeup makeup look", "a V-shaped jawline", "an A-line silhouette", "a T-zone with a soft sheen", "a U.S.-born look",
    "deep-set eyes, a strong Roman nose", "strong brows, a mole at the jaw, a small nose piercing", "a slender neck and a first-class smile",
    "a second piercing in the ear", "naturally flushed cheeks", "a fresh complexion", "well-groomed arched eyebrows, a hint of mascara",
    "rosy cheeks, a sprinkle of freckles",
    // not refused by the review's list: neutral descriptions of a grown woman
    "cute little nose", "elfin features",
  ])("keeps %p", (rest) => {
    expect(adultTextProblems(`${F}, ${rest}.`, 25, "descriptor")).toEqual([]);
  });

  test.each(["one small mole", "she's one of a kind", "she's one in a million"])("keeps the lone \"one\" in %p", (rest) => {
    expect(adultTextProblems(`${F}, ${rest}.`, 25, "descriptor")).toEqual([]);
  });

  test.each(["a face of one", "who is one"])("a lone %p is not taken for an age (no realistic minor marker; the anchor states her age)", (rest) => {
    expect(adultTextProblems(`${F}, ${rest}.`, 25, "descriptor")).toEqual([]);
  });

  test.each([
    "in her early twenties", "twenties-style", "sixty", "a sixty-year-old look", "twenty-one", "two moles", "she's two", "who is nine",
    "schoolgirl", "a school uniform", "a sixth-grader", "in tenth grade", "a school look", "a youthful glow", "a tiny mole above the lip", "a girl-next-door charm",
  ])("still refuses %p", (rest) => {
    expect(adultTextProblems(`${F}, ${rest}.`, 25, "descriptor").length).toBeGreaterThan(0);
  });
});

describe("the descriptor names the rule a word broke, from our own list", () => {
  test.each([
    ["a girlish grin", ["girl"]],
    ["fresh-faced, a tiny mole", ["fresh-faced", "tiny"]],
    ["t/e/e/n features", ["teen"]],
    ["a sixth-grader look", ["Nth grade"]],
  ])("%p → %p", (rest, names) => {
    expect(youthRuleNames(`${F}, ${rest}.`, "descriptor").sort()).toEqual([...names].sort());
  });

  test("a name is ours, never text of the answer", () => {
    expect(youthRuleNames(`${F}, GiRlIsH, TEEENAGE look.`, "descriptor").sort()).toEqual(["girl", "teen"]);
  });
});

describe("an over-long descriptor is refused at once, whatever it holds", () => {
  test("600 chars is the limit: the checks run up to it, a longer text is only 'too-long'", () => {
    expect(DESCRIPTOR_MAX_CHARS).toBe(600);
    expect(adultTextProblems(`25-year-old woman, ${"a".repeat(600)}`, 25, "descriptor")).toEqual(["too-long"]);
  });

  test("24,000 chars of single letters is refused in well under a frame", () => {
    const text = `25-year-old woman, ${Array.from({ length: 12_000 }, (_, i) => "abcdefghijklmnopqrstuvwxyz"[i % 26]).join(" ")}`;
    const started = performance.now();

    expect(adultTextProblems(text, 25, "descriptor")).toEqual(["too-long"]);
    expect(performance.now() - started).toBeLessThan(20);
  });

  test("a 600-char descriptor of spelled-out letters is checked quickly: the join is linear", () => {
    const text = `25-year-old woman, ${Array.from({ length: 290 }, (_, i) => "bcdfghjklmnpqrsvwxz"[i % 19]).join(" ")}`.slice(0, 600);
    const started = performance.now();

    adultTextProblems(text, 25, "descriptor");
    expect(performance.now() - started).toBeLessThan(20);
  });
});

// ---------- T6a-2a final: "young" and "boyish"; nina only as a real word ----------

describe("the descriptor refuses young and boyish: the anchor carries her age", () => {
  test.each(["young woman", "a young woman's warm smile", "youngish", "a young face", "forever young", "a slight, boyish frame", "boyish charm", "Young"])("refuses %p", (rest) => {
    expect(youthRuleNames(`${F}, ${rest}.`, "descriptor").some((name) => name === "young" || name === "boyish" || name === "young-looking")).toBe(true);
  });

  test.each(["young woman", "a slight, boyish frame"])("the vibe still lets %p through", (vibe) => {
    expect(adultTextProblems(vibe, 25, "vibe")).toEqual([]);
  });
});

describe("nina is refused as a word, never as a join of short words (reviewer join.probe.ts)", () => {
  test.each(["tan in a", "sun in a", "an in a", "on in a", "in in a", "tan in as", "sun in as", "an in as", "on in as", "in in as"])(
    "keeps %p before a longer word",
    (phrase) => {
      expect(adultTextProblems(`25-year-old European woman, ${phrase} hair.`, 25, "descriptor")).toEqual([]);
    },
  );

  test.each(["a nina look", "a ni\u00F1a look", "ninas"])("still refuses the word in %p", (rest) => {
    expect(youthRuleNames(`${F}, ${rest}.`, "descriptor")).toContain("nina");
  });
});
