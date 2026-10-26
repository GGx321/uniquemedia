import { describe, expect, test } from "bun:test";
import { BOLD_EXEMPT_YOUTH } from "./banks/boldRules";
import { boldContentLevel, CONTENT_LEVELS, contentLevelOf, contentProblems, type ContentLevel, type ContentProblem } from "./contentLine";

// S5.9b1 (plan s5a3 §5.1, §5.2): the content line is one pure function with the level as a parameter. "ordinary" and "flirty" are today's word gate
// (a youth word, then a revealing word); "bold" is the owner's «Смелая»: youth words only, with the garment name «babydoll» exempt. Rows are literal.

const reasons = (text: string, level: ContentLevel): ContentProblem["reason"][] => contentProblems(text, level).map((p) => p.reason);

const bold = boldContentLevel();
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
    expect(contentProblems(text, bold)).toEqual([]);
  });

  test("bold: a youth word is still refused, named with the words the rule found", () => {
    expect(contentProblems("a petite schoolgirl in a skirt", bold)).toEqual([{ reason: "youth-word", words: ["schoolgirl", "schoolgirl", "petite"] }]);
  });

  test("bold: a youth word is refused next to revealing words, and only the youth word is named", () => {
    expect(contentProblems("the girl in a bikini and stockings", bold)).toEqual([{ reason: "youth-word", words: ["girl"] }]);
  });

  test("bold: a revealing-word problem is never reported", () => {
    for (const text of ["bikini", "lingerie", "thong", "stockings", "slip dress", "robe over lingerie", "sports bra", "swimwear", "swimsuit"]) {
      expect(reasons(text, bold)).toEqual([]);
    }
  });

  test("bold: «babydolls», in the plural, is the same exempt garment", () => {
    expect(contentProblems("two sheer babydolls on the chair", bold)).toEqual([]);
  });

  test("bold: «baby doll» in two words is not the exempt garment name", () => {
    expect(contentProblems("a baby doll nightdress", bold)).toEqual([{ reason: "youth-word", words: ["baby"] }]);
  });

  test("bold: «baby blue» next to a babydoll is still refused, the garment alone is exempt", () => {
    expect(contentProblems("a baby blue babydoll", bold)).toEqual([{ reason: "youth-word", words: ["baby"] }]);
  });

  test("bold: the exemption is the garment name only: «baby» alone is refused", () => {
    expect(contentProblems("her baby sister", bold)).toEqual([{ reason: "youth-word", words: ["baby"] }]);
  });

  test("bold: the Russian youth words are refused too", () => {
    expect(reasons("школьница в белье", bold)).toEqual(["youth-word"]);
  });
});

// S5.9b1 review: lingerie and swimwear are «Смелая» only, so the underwear and nudity words, their plurals and their obfuscations are refused at ordinary
// and flirty, and stay legal at bold.
describe("the underwear and nudity words by level (S5.9b1 review)", () => {
  const ROWS: Array<[string, string]> = [
    ["a black lace bra and panties", "bra"],
    ["her underwear on the floor", "underwear"],
    ["white cotton briefs", "briefs"],
    ["a pink bralette", "bralette"],
    ["topless on the bed", "topless"],
    ["naked under the sheet", "naked"],
    ["three bikinis", "bikinis"],
    ["two thongs", "thongs"],
    ["red swimsuits", "swimsuits"],
    ["Ｂｉｋｉｎｉ", "Bikini"],
    ["bi​kini", "bikini"],
    ["b i k i n i", "bikini"],
  ];

  test.each(SHARED_LEVELS.flatMap((level) => ROWS.map(([text, word]) => [level, text, word] as const)))("%s: «%s» is refused as revealing (%s)", (level, text, word) => {
    const revealing = contentProblems(text, level).filter((p) => p.reason === "revealing-word");
    expect(revealing.flatMap((p) => p.words)).toContain(word);
  });

  test.each(ROWS)("bold: «%s» is legal", (text) => {
    expect(contentProblems(text, bold)).toEqual([]);
  });

  test.each(SHARED_LEVELS)("%s: «nude lipstick», a briefcase and a bracelet are legal", (level) => {
    expect(contentProblems("nude lipstick, a briefcase and a bracelet", level)).toEqual([]);
  });
});

describe("the bold exemption list (banks/boldRules.ts)", () => {
  test("it names the garment «babydoll» and nothing else", () => {
    expect([...BOLD_EXEMPT_YOUTH]).toEqual(["babydoll"]);
  });
});

describe("the levels", () => {
  test("they are ordinary, flirty and bold, in that order", () => {
    expect([...CONTENT_LEVELS]).toEqual(["ordinary", "flirty", bold]);
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

// S5.9c (plan s5a3 §5.1), widened by 5a.4 (S5.BA1, I5.73): the level a slot or a scene is held to follows its CATEGORY or its ROUTE, never its mix level. `level` and `route` are
// required keys (`SceneLevel | undefined`, `SceneRoute | undefined`), so a caller that forgets one does not compile.
describe("contentLevelOf", () => {
  test.each(["nightwear", "beach"])("a %s slot is held to the bold line, whatever its own mix level", (category) => {
    expect(contentLevelOf({ category, level: undefined, route: undefined })).toBe(boldContentLevel());
    expect(contentLevelOf({ category, level: "ordinary", route: undefined })).toBe(boldContentLevel());
    expect(contentLevelOf({ category, level: "bold", route: "seedream" })).toBe(boldContentLevel());
  });

  test.each(["home", "travel", "photoshoot", "glamour", "fitness", "shoot", "glam", "fit", "cat-paris-cafes", "own"])("%s without the route is held to the ordinary line", (category) => {
    expect(contentLevelOf({ category, level: undefined, route: undefined })).toBe("ordinary");
  });

  test.each(["home", "travel", "photoshoot", "glamour", "fitness", "shoot", "glam", "fit", "cat-paris-cafes"])("%s with the route is held to the bold line", (category) => {
    expect(contentLevelOf({ category, level: "bold", route: "seedream" })).toBe(boldContentLevel());
    expect(contentLevelOf({ category, level: undefined, route: "seedream" })).toBe(boldContentLevel());
  });

  test("a flirty slot of the five without the route is still ordinary: the line lifts only for a «Смелая» frame", () => {
    expect(contentLevelOf({ category: "home", level: "flirty", route: undefined })).toBe("ordinary");
  });

  test("a bold level without the route is still ordinary: the route decides, never the level alone", () => {
    expect(contentLevelOf({ category: "home", level: "bold", route: undefined })).toBe("ordinary");
    expect(contentLevelOf({ category: "cat-paris-cafes", level: "bold", route: undefined })).toBe("ordinary");
  });

  test("the level it gives reads the texts as the bold line does", () => {
    expect(contentProblems("a white string bikini, topless", contentLevelOf({ category: "beach", level: undefined, route: undefined }))).toEqual([]);
    expect(contentProblems("a white string bikini", contentLevelOf({ category: "home", level: undefined, route: undefined })).map((p) => p.reason)).toEqual(["revealing-word"]);
    expect(contentProblems("a white string bikini, topless", contentLevelOf({ category: "home", level: "bold", route: "seedream" }))).toEqual([]);
  });

  test("a call without the level key, or without the route key, does not compile", () => {
    // @ts-expect-error `level` and `route` are required keys
    expect(contentLevelOf({ category: "home" })).toBe("ordinary");
    // @ts-expect-error `route` is a required key
    expect(contentLevelOf({ category: "home", level: undefined })).toBe("ordinary");
    // @ts-expect-error `level` is a required key
    expect(contentLevelOf({ category: "home", route: undefined })).toBe("ordinary");
  });
});
