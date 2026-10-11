import { describe, expect, test } from "bun:test";
import { isOwnerBannedOutfit, LEGWEAR_CLASH_WORDS } from "./words";

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

describe("LEGWEAR_CLASH_WORDS", () => {
  test.each(["slips one heel off", "slips on her heels", "pulls up her socks", "sits with her bare feet up", "shows the soles of her feet"])("clashes: «%s»", (text) => {
    expect(LEGWEAR_CLASH_WORDS.test(text)).toBe(true);
  });

  test.each(["sits with one leg crossed", "stretches her legs"])("does not clash: «%s» (plan r1.4)", (text) => {
    expect(LEGWEAR_CLASH_WORDS.test(text)).toBe(false);
  });
});
