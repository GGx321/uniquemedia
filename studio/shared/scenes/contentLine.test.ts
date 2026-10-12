import { describe, expect, test } from "bun:test";
import { BOLD_EXEMPT_YOUTH } from "./banks/boldRules";
import { CONTENT_LEVELS, contentProblems, type ContentLevel, type ContentProblem } from "./contentLine";

// S5.9b1 (plan s5a3 §5.1, §5.2): the content line is one pure function with the level as a parameter. "ordinary" and "flirty" are today's word gate
// (a youth word, then a revealing word); "bold" is the owner's «Смелая»: youth words only, with the garment name «babydoll» exempt. Rows are literal.

const reasons = (text: string, level: ContentLevel): ContentProblem["reason"][] => contentProblems(text, level).map((p) => p.reason);

const SHARED_LEVELS: ContentLevel[] = ["ordinary", "flirty"];

describe("contentProblems at ordinary and flirty (today's gate, unchanged)", () => {
  test.each(SHARED_LEVELS)("%s: a clean sentence has no problem", (level) => {
    expect(contentProblems("She leans on the bridge railing as the evening light turns the river gold.", level)).toEqual([]);
  });

  test.each(SHARED_LEVELS)("%s: a youth word is named with the words the rule found", (level) => {
    expect(contentProblems("The little girl waves from the bridge.", level)).toEqual([{ reason: "youth-word", words: ["girl"] }]);
  });

  test.each(SHARED_LEVELS)("%s: a revealing word is named as the text wrote it", (level) => {
    expect(contentProblems("She wears a Bikini on the bridge.", level)).toEqual([{ reason: "revealing-word", words: ["Bikini"] }]);
  });

  test.each(SHARED_LEVELS)("%s: a sentence with both says the youth words first", (level) => {
    expect(reasons("The girl wears a bikini.", level)).toEqual(["youth-word", "revealing-word"]);
  });

  test.each(SHARED_LEVELS)("%s: «a white string bikini» is refused as revealing", (level) => {
    expect(reasons("a white string bikini", level)).toEqual(["revealing-word"]);
  });

  test.each(SHARED_LEVELS)("%s: «a sheer babydoll over a lace set» is refused as a youth word (the garment name matches the baby rule)", (level) => {
    expect(contentProblems("a sheer babydoll over a lace set", level)).toEqual([{ reason: "youth-word", words: ["babydoll"] }]);
  });

  test.each(SHARED_LEVELS)("%s: «sheer black stockings» is refused as revealing", (level) => {
    expect(reasons("sheer black stockings", level)).toEqual(["revealing-word"]);
  });

  test.each(SHARED_LEVELS)("%s: «nude lipstick» is legal", (level) => {
    expect(contentProblems("nude lipstick and a linen dress", level)).toEqual([]);
  });

  test.each(SHARED_LEVELS)("%s: the exposure words are no word of the gate (they are bank-design sweeps)", (level) => {
    expect(contentProblems("topless, naked under the sheet", level)).toEqual([]);
  });
});

describe("contentProblems at bold (the owner's «Смелая»: youth words only)", () => {
  test.each([
    "a black lace bra and panties",
    "a white string bikini",
    "a sheer babydoll over a lace set",
    "sheer black stockings",
    "topless",
    "naked under the sheet",
    "bent over, pulling her jeans up over her panties",
    "a lace thong and a robe over lingerie",
    "a swimsuit, a sports bra and a slip dress",
    "Stockings and a Bikini",
  ])("bold: «%s» is legal", (text) => {
    expect(contentProblems(text, "bold")).toEqual([]);
  });

  test("bold: a youth word is still refused, named with the words the rule found", () => {
    expect(contentProblems("a petite schoolgirl in a skirt", "bold")).toEqual([{ reason: "youth-word", words: ["schoolgirl", "schoolgirl", "petite"] }]);
  });

  test("bold: a youth word is refused next to revealing words, and only the youth word is named", () => {
    expect(contentProblems("the girl in a bikini and stockings", "bold")).toEqual([{ reason: "youth-word", words: ["girl"] }]);
  });

  test("bold: a revealing-word problem is never reported", () => {
    for (const text of ["bikini", "lingerie", "thong", "stockings", "slip dress", "robe over lingerie", "sports bra", "swimwear", "swimsuit"]) {
      expect(reasons(text, "bold")).toEqual([]);
    }
  });

  test("bold: «babydolls», in the plural, is the same exempt garment", () => {
    expect(contentProblems("two sheer babydolls on the chair", "bold")).toEqual([]);
  });

  test("bold: «baby doll» in two words is not the exempt garment name", () => {
    expect(contentProblems("a baby doll nightdress", "bold")).toEqual([{ reason: "youth-word", words: ["baby"] }]);
  });

  test("bold: «baby blue» next to a babydoll is still refused, the garment alone is exempt", () => {
    expect(contentProblems("a baby blue babydoll", "bold")).toEqual([{ reason: "youth-word", words: ["baby"] }]);
  });

  test("bold: the exemption is the garment name only: «baby» alone is refused", () => {
    expect(contentProblems("her baby sister", "bold")).toEqual([{ reason: "youth-word", words: ["baby"] }]);
  });

  test("bold: the Russian youth words are refused too", () => {
    expect(reasons("школьница в белье", "bold")).toEqual(["youth-word"]);
  });
});

describe("the bold exemption list (banks/boldRules.ts)", () => {
  test("it names the garment «babydoll» and nothing else", () => {
    expect([...BOLD_EXEMPT_YOUTH]).toEqual(["babydoll"]);
  });
});

describe("the levels", () => {
  test("they are ordinary, flirty and bold, in that order", () => {
    expect([...CONTENT_LEVELS]).toEqual(["ordinary", "flirty", "bold"]);
  });

  test("ordinary and flirty answer the same on every row of this file", () => {
    for (const text of ["a bikini", "the girl", "a sheer babydoll", "nude lipstick", "stockings and a thong", "", "   "]) {
      expect(contentProblems(text, "flirty")).toEqual(contentProblems(text, "ordinary"));
    }
  });

  test("an empty text has no problem at any level", () => {
    for (const level of CONTENT_LEVELS) expect(contentProblems("", level)).toEqual([]);
  });
});
