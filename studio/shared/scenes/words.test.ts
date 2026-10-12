import { describe, expect, test } from "bun:test";
import { isOwnerBannedOutfit, LEGS_UNSUITED_OUTFITS, LEGWEAR_CLASH_WORDS, notDenimClause, unfabricBottomsIn, type Bottom } from "./words";
import * as words from "./words";

// C3′ (the owner's verdict, 2026-10-12): Grok draws an unnamed «mini skirt» or «shorts» as DENIM (R3#03 «a hoodie, a mini skirt and sneakers», R4#04 «a tank top and
// shorts»); the wording probe drew no denim once the outfit named a fabric, or said «her skirt is not denim». The detector finds the bottoms a text leaves unnamed.
describe("unfabricBottomsIn: a skirt, shorts or a skort named without its fabric", () => {
  test.each<[string, Bottom[]]>([
    ["a hoodie, a mini skirt and sneakers", ["skirt"]],
    ["a tank top and shorts", ["shorts"]],
    ["a pleated mini and a fitted top", ["skirt"]],
    ["a miniskirt and a tee", ["skirt"]],
    ["a mini-skirt and a tee", ["skirt"]],
    ["a tee and a skort", ["skort"]],
    ["a crop top and pajama shorts", ["shorts"]],
    ["a cropped hoodie and bike shorts", ["shorts"]],
    ["a black pleated mini skirt", ["skirt"]],
    ["a tee and hot pants", ["shorts"]],
    ["a tee and bermuda shorts", ["shorts"]],
    ["a knit top and a mini, a tee", ["skirt"]],
    ["a halter top and a midi skirt, and lounge shorts", ["skirt", "shorts"]],
    ["On a terrace, she is reading, wearing a linen shirt and shorts, smiling.", ["shorts"]],
  ])("«%s» leaves %p unnamed", (text, bottoms) => {
    expect(unfabricBottomsIn(text)).toEqual(bottoms);
  });

  test.each([
    "a tank top and cotton sleep shorts",
    "a crop top and lycra bike shorts",
    "grey jersey lounge shorts and a tee",
    "a hoodie, a knit mini and sneakers",
    "a white top and leather mini skirt",
    "a sequin mini skirt and a crop top",
    "a tank top, a linen skirt and boots",
    "a skirt in light linen and a tee",
    "shorts made of soft cotton",
    "a cotton-blend skirt",
    "a fitted mini dress",
    "a red mini dress and heels",
    "a white tee and jeans",
    "a denim jacket and a linen skirt",
    "nothing to wear here",
  ])("«%s» names every bottom's fabric, or none at all", (text) => {
    expect(unfabricBottomsIn(text)).toEqual([]);
  });

  test.each(["a tee and denim shorts", "a denim mini skirt", "a skirt in light denim", "jean shorts and a tee"])("denim «%s» is the owner's ban, not an unnamed bottom", (text) => {
    expect(unfabricBottomsIn(text)).toEqual([]);
    expect(isOwnerBannedOutfit(text)).toBe(true);
  });

  // Review (C3′ round 2): «mini» before a noun of its own is no skirt, and «Bermuda» alone no shorts, so a sentence about mini golf never says her skirt is not denim.
  test.each(["playing mini golf", "a tee and a mini bag", "carrying a mini backpack", "holding a mini cup", "on a beach in Bermuda", "a tee and bermudas"])("«%s» names no bottom", (text) => {
    expect(unfabricBottomsIn(text)).toEqual([]);
  });

  test.each(["a mini skirt (not denim) and a tee", "a tank top and shorts, not denim", "a mini skirt, not denim, and a tee"])("«%s» already says it is not denim: named", (text) => {
    expect(unfabricBottomsIn(text)).toEqual([]);
  });

  test("a bottom the text already says is not denim is named", () => {
    expect(unfabricBottomsIn("a tank top and shorts, her shorts are not denim, smiling")).toEqual([]);
    expect(unfabricBottomsIn("a mini skirt and a tee, her skirt is not denim")).toEqual([]);
  });

  test("each bottom is told once, in the order the text names them", () => {
    expect(unfabricBottomsIn("a skort, shorts, a skirt and more shorts")).toEqual(["skort", "shorts", "skirt"]);
  });
});

describe("notDenimClause: the probe's wording (c3fix 3a), by the bottoms", () => {
  test.each<[Bottom[], string]>([
    [["skirt"], "her skirt is not denim"],
    [["shorts"], "her shorts are not denim"],
    [["skort"], "her skort is not denim"],
    [["skirt", "shorts"], "her skirt and shorts are not denim"],
  ])("%p: «%s»", (bottoms, clause) => {
    expect(notDenimClause(bottoms)).toBe(clause);
  });

  test("the clause is no denim garment itself, by the owner's ban", () => {
    for (const bottoms of [["skirt"], ["shorts"], ["skort"], ["skirt", "shorts"]] as Bottom[][]) expect(isOwnerBannedOutfit(notDenimClause(bottoms))).toBe(false);
  });
});

// Review L2 of S5.6a: the owner's «no denim shorts and no denim skirts» holds nowhere, so the check is exported for S5.6b to filter a custom pool's
// outfits too; and a moment with one heel in it clashes with legwear as one with heels does.

describe("isOwnerBannedOutfit (the owner: no denim shorts, no denim skirts, anywhere)", () => {
  test.each([
    "a tee and denim shorts", "a crop top and a denim mini skirt", "a denim mini and a tee", "a tank top and cut-offs", "a tank top and cutoffs", "a tank top and jean shorts",
    "a tee and jorts", "a denim skirt", "a denim miniskirt", "a jean miniskirt", "a denim mini-skirt", "a denim skort", "denim hot pants", "a tee and jean hot pants",
  ])(
    "refuses «%s»",
    (outfit) => {
      expect(isOwnerBannedOutfit(outfit)).toBe(true);
    },
  );

  test.each(["a denim jacket and jeans", "jeans and a white tee", "a mini skirt with a cropped top", "biker shorts and a crop top"])("allows «%s»", (outfit) => {
    expect(isOwnerBannedOutfit(outfit)).toBe(false);
  });
});

// S5.6R (HIGH 1): the rule caught only «denim» or «jean» right before the garment, so «a denim midi skirt», «denim bike shorts», «distressed denim short
// shorts» and «a skirt in light denim» passed (about a quarter of the slots of a typical custom pool). Up to three words may now stand between the two,
// and the garment may come first («(skirt|shorts|skort) in|of … denim»). A word that starts another garment or joins one («jacket», «and», «with») ends
// the phrase, so a denim jacket worn with a linen skirt still passes.
describe("isOwnerBannedOutfit: the words between, and the garment first (S5.6R)", () => {
  const DENIM = ["denim", "jean", "jeans"];
  const BETWEEN = ["", "light", "light-wash", "distressed", "frayed", "white", "high-waisted", "ripped", "dark wash", "soft washed", "cut-off", "button-front", "A-line"];
  const BOTTOMS = [
    "shorts", "skirt", "skirts", "skort", "mini", "midi", "maxi", "miniskirt", "mini skirt", "midi skirt", "maxi skirt", "pencil skirt", "wrap skirt", "pleated skirt",
    "bike shorts", "bermuda shorts", "short shorts", "overall shorts", "hot pants",
  ];
  const OPENINGS = ["", "a ", "a white tee and ", "a crop top with "];

  /** Every phrasing «{opening}{denim} {up to three words} {bottom}», each a ban: two words and a two-word garment, or three words and a one-word one. */
  const forward = OPENINGS.flatMap((opening) =>
    DENIM.flatMap((denim) => [
      ...BETWEEN.flatMap((between) => BOTTOMS.map((bottom) => `${opening}${denim} ${between === "" ? "" : `${between} `}${bottom}`)),
      ...["shorts", "skirt", "skort", "mini", "midi", "maxi"].map((bottom) => `${opening}${denim} faded blue stretch ${bottom}`),
    ]),
  );
  /** Every phrasing «{bottom} in|of|made of {up to three words} {denim}», each a ban. */
  const backward = ["a skirt", "shorts", "a skort", "a mini skirt", "short shorts", "bermuda shorts"].flatMap((bottom) =>
    ["in", "of", "made of"].flatMap((join) => ["", "light", "a light-wash", "soft faded blue"].flatMap((between) => DENIM.map((denim) => `${bottom} ${join} ${between === "" ? "" : `${between} `}${denim}`))),
  );

  test(`refuses every one of ${forward.length} phrasings with the denim first, up to three words before the garment`, () => {
    expect(forward.filter((outfit) => !isOwnerBannedOutfit(outfit))).toEqual([]);
  });

  test(`refuses every one of ${backward.length} phrasings with the garment first and the denim after «in» or «of»`, () => {
    expect(backward.filter((outfit) => !isOwnerBannedOutfit(outfit))).toEqual([]);
  });

  test.each(["a denim midi skirt", "a denim maxi skirt", "a denim pencil skirt", "denim bike shorts", "a denim wrap skirt", "distressed denim short shorts", "a skirt in light denim", "denim bermuda shorts", "short shorts in denim", "a frayed denim pleated skirt", "a tee and a Denim Mini Skirt"])(
    "refuses the review's «%s»",
    (outfit) => {
      expect(isOwnerBannedOutfit(outfit)).toBe(true);
    },
  );

  // S5.6R (round D): a hyphen between the denim and the garment is a ban too, and «bermudas» is a garment of its own.
  test.each([
    "jean-shorts", "a jean-skirt", "a denim-skirt", "denim-shorts", "a tee and jean-shorts", "a crop top with a denim-skirt", "a jeans-skirt", "denim-skort", "denim-hot pants",
    "denim bermudas", "a denim bermuda", "jean bermudas", "denim-bermudas", "light denim bermudas", "bermudas in denim", "bermudas made of light denim", "a tee and jean-bermudas",
  ])("refuses the hyphenated and bermuda form «%s»", (outfit) => {
    expect(isOwnerBannedOutfit(outfit)).toBe(true);
  });

  test.each(["a denim-jacket over a linen skirt", "a denim-jacket and bermudas", "bermudas in linen", "linen bermudas and a denim jacket", "a jean-jacket with bermudas"])(
    "allows «%s» (round D)",
    (outfit) => {
      expect(isOwnerBannedOutfit(outfit)).toBe(false);
    },
  );

  test.each([
    "a denim jacket with a linen skirt",
    "a denim jacket and a mini skirt",
    "a denim shirt over a midi skirt",
    "a denim shirt tucked into a pleated skirt",
    "jeans and a mini skirt",
    "a jean jacket, a pleated skirt",
    "a linen skirt and a denim jacket",
    "shorts with a denim jacket",
    "a midi skirt in linen and a denim jacket",
    "a skirt in white linen with a jean jacket",
    "a denim jacket over running shorts",
    "a denim vest and a maxi skirt",
    "a denim dress and bike shorts",
    "a pleated mini and a fitted top",
    "hot pants and a crop top",
  ])("allows «%s»: the denim is another garment", (outfit) => {
    expect(isOwnerBannedOutfit(outfit)).toBe(false);
  });
});

// Wave 5e (S5.8a follow-up): the legs blacklist saw «mini» and «short dress» as separate words only, so a compound («minidress», «miniskirt») or a plural
// («short skirts») slipped through it.
describe("LEGS_UNSUITED_OUTFITS", () => {
  test.each([
    "a pleated mini and a fitted top", "a satin minidress", "a pleated miniskirt", "a plaid mini-skirt and a tee", "two minis", "a black mini dress", "a mini skirt and a top",
    "a short dress", "short dresses", "a short skirt", "short skirts and a tee", "a short-skirt set", "a bodycon dress", "an oversized sweater as a dress", "an oversized tee",
  ])("refuses «%s»", (outfit) => {
    expect(LEGS_UNSUITED_OUTFITS.test(outfit)).toBe(true);
  });

  test.each(["a navy midi dress", "a long linen skirt", "a maxi dress", "soft joggers and a cropped tee", "grey leggings and a cropped tee", "linen shorts and a fitted tee", "a minimal knit top and trousers"])(
    "allows «%s»",
    (outfit) => {
      expect(LEGS_UNSUITED_OUTFITS.test(outfit)).toBe(false);
    },
  );
});

describe("LEGWEAR_CLASH_WORDS", () => {
  test.each(["slips one heel off", "slips on her heels", "pulls up her socks", "sits with her bare feet up", "shows the soles of her feet"])("clashes: «%s»", (text) => {
    expect(LEGWEAR_CLASH_WORDS.test(text)).toBe(true);
  });

  test.each(["sits with one leg crossed", "stretches her legs"])("does not clash: «%s» (plan r1.4)", (text) => {
    expect(LEGWEAR_CLASH_WORDS.test(text)).toBe(false);
  });
});

// S5.9b1: the revealing words moved here from engine/scenes/words.ts, so the one content-line module (contentLine.ts) and the mock read the same list.
describe("the revealing words (moved from the engine, S5.9b1)", () => {
  test("REVEALING_WORDS is a case-insensitive list without the global flag (S5.9b1 review: with the underwear words and the plurals)", () => {
    expect(words.REVEALING_WORDS.source).toBe(
      "\\b(bikinis?|swimsuits?|swimwear|lingerie|sports bras?|thongs?|stockings?|slip dress(?:es)?|robes? over lingerie|panties|panty|bras?|bralettes?|underwear|briefs|topless|naked)\\b",
    );
    expect(words.REVEALING_WORDS.flags).toBe("i");
  });

  test("hasRevealingWord answers true for a revealing word and false for a plain outfit", () => {
    expect(words.hasRevealingWord("a white bikini")).toBe(true);
    expect(words.hasRevealingWord("a linen dress")).toBe(false);
  });

  test("revealingWordsIn names each revealing word as the text wrote it, in order", () => {
    expect(words.revealingWordsIn("A Bikini, then stockings and a thong")).toEqual(["Bikini", "stockings", "thong"]);
  });

  test("revealingWordsIn gives the same answer on every call (no shared lastIndex)", () => {
    expect(words.revealingWordsIn("a bikini")).toEqual(["bikini"]);
    expect(words.revealingWordsIn("a bikini")).toEqual(["bikini"]);
  });
});

// S5.9b1 review: the revealing rule exists so lingerie and swimwear stay in «Смелая». Underwear, bras, nudity words and plurals slipped through it, and so
// did full-width letters, invisible characters and spaced-out letters. Text is folded the way `youthWords` folds it (NFKC, invisible format characters
// dropped, spacing tricks joined) before the list is read.
describe("the revealing words: more garments, plurals and obfuscation (S5.9b1 review)", () => {
  test.each([
    ["her panties", ["panties"]],
    ["a black panty", ["panty"]],
    ["a lace bra", ["bra"]],
    ["two bras on the bed", ["bras"]],
    ["a bralette", ["bralette"]],
    ["pink bralettes", ["bralettes"]],
    ["only her underwear", ["underwear"]],
    ["white briefs", ["briefs"]],
    ["topless", ["topless"]],
    ["naked under the sheet", ["naked"]],
    ["three bikinis", ["bikinis"]],
    ["two thongs", ["thongs"]],
    ["red swimsuits", ["swimsuits"]],
    ["two slip dresses", ["slip dresses"]],
    ["a sports bra", ["sports bra"]],
    ["black sports bras", ["sports bras"]],
    ["a robe over lingerie", ["robe over lingerie"]],
    ["robes over lingerie", ["robes over lingerie"]],
  ])("names the words of «%s»", (text, expected) => {
    expect(words.revealingWordsIn(text).map((w) => w.toLowerCase())).toEqual(expected);
  });

  test.each([
    ["full-width letters", "Ｂｉｋｉｎｉ", ["Bikini"]],
    ["a zero-width space", "bi​kini", ["bikini"]],
    ["a zero-width joiner", "lin‍gerie", ["lingerie"]],
    ["a soft hyphen", "pan­ties", ["panties"]],
    ["letters spaced apart", "b i k i n i", ["bikini"]],
    ["letters dotted apart", "t.h.o.n.g", ["thong"]],
    ["a leading article and spaced letters", "a b i k i n i", ["bikini"]],
    ["full-width letters and a capital", "ＴＨＯＮＧ", ["THONG"]],
  ])("sees through %s", (_trick, text, expected) => {
    expect(words.revealingWordsIn(text)).toEqual(expected);
  });

  test("hasRevealingWord sees through the same tricks", () => {
    expect(words.hasRevealingWord("Ｂｉｋｉｎｉ")).toBe(true);
    expect(words.hasRevealingWord("bi​kini")).toBe(true);
    expect(words.hasRevealingWord("a linen dress")).toBe(false);
  });

  test("a word seen in both forms is named once", () => {
    expect(words.revealingWordsIn("a bra and a bra")).toEqual(["bra", "bra"]);
  });

  test.each([
    "nude lipstick and nude heels",
    "a brand new bracelet",
    "a briefcase on the chair",
    "an umbrella and a bramble",
    "a braid and a bracket",
    "nakedness is not a garment",
    "a zebra print scarf",
    "the strapless dress",
    "a linen dress and a silk robe",
    "a slip on her shoe",
    "sheer black tights",
    "a tank top and shorts",
  ])("leaves «%s» alone", (text) => {
    expect(words.revealingWordsIn(text)).toEqual([]);
  });
});
