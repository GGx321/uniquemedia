import { describe, expect, test } from "bun:test";
import { isOwnerBannedOutfit, LEGS_UNSUITED_OUTFITS, LEGWEAR_CLASH_WORDS } from "./words";

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
