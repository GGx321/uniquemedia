import { describe, expect, test } from "bun:test";
import { explicitActsIn, exposureWordsIn } from "./boldDesign.testkit";

// 5a.3 (S5.9b2, plan s5a3 §5.2, I5.37, K-36): what the «Смелая» banks are designed never to say, as test-only lists (answer (c): no runtime exposure rule on the
// owner's own text). Exposure: nipples, areolae, genitals; naked, topless, bottomless; «nude» of her (never the colour before a colourable noun); sheer,
// see-through or transparent before concept-r3's garments. Explicit acts: concept-r3 tier 1a. Each list with the rows it must catch and the ones it must not.

describe("the exposure words (concept-r3 tier 1b, K-36)", () => {
  test.each([
    ["her nipples show", ["nipples"]],
    ["an areola", ["areola"]],
    ["areolae", ["areolae"]],
    ["her genitals", ["genitals"]],
    ["naked under the sheet", ["naked"]],
    ["topless on the bed", ["topless"]],
    ["bottomless", ["bottomless"]],
    ["nude in the mirror", ["nude"]],
    ["she poses nude", ["nude"]],
    ["a sheer top with nothing under it", ["sheer top"]],
    ["a see-through blouse", ["see-through blouse"]],
    ["a transparent bra", ["transparent bra"]],
    ["sheer black panties", ["sheer black panties"]],
    ["a sheer lace bodysuit", ["sheer lace bodysuit"]],
    ["a transparent dress", ["transparent dress"]],
    ["a see-through shirt", ["see-through shirt"]],
    ["sheer lingerie", ["sheer lingerie"]],
  ])("catches «%s»", (text, words) => {
    expect(exposureWordsIn(text)).toEqual(words);
  });

  test.each([
    "nude lipstick",
    "nude heels",
    "a nude lip",
    "nude tights",
    "nude nails",
    "a nude colour",
    "a nude bra",
    "nude stockings",
    "sheer curtains",
    "sheer black tights",
    "sheer black stockings",
    "a sheer babydoll over a lace set",
    "a transparent phone case",
    "a see-through umbrella",
    "her sunglasses",
    "The lace is lined and opaque: her bra fully covers her breasts and her panties fully cover her.",
    "The white sheet is held up to her chest and fully covers her breasts and her hips.",
  ])("leaves «%s» alone", (text) => {
    expect(exposureWordsIn(text)).toEqual([]);
  });
});

describe("the explicit acts (concept-r3 tier 1a)", () => {
  test.each([
    "touching between her legs",
    "her hand between her legs",
    "grabbing her breasts",
    "squeezing her breast",
    "licking her finger",
    "sucking a lollipop",
    "legs spread",
    "with spread legs",
    "on all fours",
    "in a doggy style pose",
    "straddling the chair",
    "bends over toward the camera",
    "bending over toward the viewer",
    "bent over toward the lens",
  ])("catches «%s»", (text) => {
    expect(explicitActsIn(text).length).toBeGreaterThan(0);
  });

  test.each([
    "bent over, pulling her jeans up over her panties",
    "she bends over to tie her sneaker",
    "sits with her legs crossed",
    "stretches her legs on the lounger",
    "her arm across her chest holding a mug",
    "sips a cold drink by the water",
    "lies on her stomach, hips behind",
    "lies holding the sheet to her chest",
  ])("leaves «%s» alone", (text) => {
    expect(explicitActsIn(text)).toEqual([]);
  });
});
