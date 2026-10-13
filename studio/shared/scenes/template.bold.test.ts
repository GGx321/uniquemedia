import { describe, expect, test } from "bun:test";
import { BANKS } from "./banks";
import type { Level } from "./banks/types";
import { coverageOf, templateSentence, type TemplateSlot } from "./template";

// 5a.3 (S5.9c, plan s5a3 §7.3, M3, I5.37): the code template learns the third level. A bold slot takes the flirty gaze and cue entries, reads its stockings from the bank's
// bold list (and only on the outfits that list names), and appends the positive coverage sentence of what it shows, once. Everything at ordinary and flirty reads as it did.

const KEYS = Array.from({ length: 30 }, (_, i) => `run-${i}:slot-${(i % 9) + 1}`);

const LACE = "The lace is lined and opaque: her bra fully covers her breasts and her panties fully cover her.";
const SATIN = "a satin slip nightdress";

function slot(level: Level, extra: Partial<TemplateSlot> = {}): TemplateSlot {
  return { category: "nightwear", location: "her bedroom", activity: "stretches after waking up", outfit: SATIN, shot: "mirror", capture: "mirror", pose: "front", level, ...extra };
}

describe("a bold slot reads like a flirty one where the bank has nothing bolder to say", () => {
  test("an ordinary moment in a satin outfit renders the very sentence of a flirty slot, whatever the key", () => {
    for (const key of KEYS) expect(templateSentence(slot("bold"), { key })).toBe(templateSentence(slot("flirty"), { key }));
  });

  test("an ordinary slot of the same moment and outfit keeps the ordinary gaze and cue (it is not the flirty sentence)", () => {
    const flirty = KEYS.map((key) => templateSentence(slot("flirty"), { key }));
    const ordinary = KEYS.map((key) => templateSentence(slot("ordinary"), { key }));
    expect(ordinary).not.toEqual(flirty);
  });
});

describe("the legwear list follows the slot's level", () => {
  const BLACK = "black thigh-high stockings";

  test("a bold slot wears stockings of the bold list on an outfit that list names", () => {
    expect(templateSentence(slot("bold", { legwear: BLACK }), { key: KEYS[0] as string })).toContain(`wearing ${SATIN} with ${BLACK}`);
  });

  test("the same stockings on a flirty slot render nothing: stockings are bold-only", () => {
    expect(templateSentence(slot("flirty", { legwear: BLACK }), { key: KEYS[0] as string })).toBeNull();
  });

  test("the same stockings on an ordinary slot render nothing", () => {
    expect(templateSentence(slot("ordinary", { legwear: BLACK }), { key: KEYS[0] as string })).toBeNull();
  });

  test("stockings on a bold slot whose outfit is cotton render nothing: the bold list goes with the satin and the lingerie", () => {
    expect(templateSentence(slot("bold", { legwear: BLACK, outfit: "cotton pajama shorts and a tee" }), { key: KEYS[0] as string })).toBeNull();
  });

  test("the ordinary list's socks on a bold slot render nothing: a bold slot reads the bold list", () => {
    expect(templateSentence(slot("bold", { legwear: "thigh-high socks" }), { key: KEYS[0] as string })).toBeNull();
  });

  test("the ordinary list's socks on a flirty slot still render, as they always did", () => {
    expect(templateSentence(slot("flirty", { legwear: "thigh-high socks" }), { key: KEYS[0] as string })).toContain(`wearing ${SATIN} with thigh-high socks`);
  });
});

describe("the coverage sentence", () => {
  test("a lingerie outfit's coverage ends its sentence, once", () => {
    const text = templateSentence(slot("bold", { location: "her bed", activity: "lies back with her arms up", shot: "selfie", capture: "above", outfit: "a black lace bra and panties" }), { key: KEYS[0] as string }) as string;
    expect(text.endsWith(` ${LACE}`)).toBe(true);
    expect(text.split(LACE)).toHaveLength(2);
  });

  test("a moment's coverage is the one a pinned outfit with none takes", () => {
    const text = templateSentence(slot("bold", { location: "her bed", activity: "lies holding the sheet to her chest", shot: "selfie", capture: "above", outfit: "only the white bedsheet" }), { key: KEYS[0] as string }) as string;
    expect(text.endsWith(" The white sheet is held up to her chest and fully covers her breasts and her hips.")).toBe(true);
  });

  test("an outfit with no coverage and a moment with none add nothing: the sentence ends as a sentence of the template does", () => {
    const text = templateSentence(slot("ordinary", { outfit: "cotton pajama shorts and a tee" }), { key: KEYS[0] as string }) as string;
    expect(text.endsWith(".")).toBe(true);
    expect(text.split(". ")).toHaveLength(1);
  });

  test("the moment's coverage wins over the outfit's", () => {
    expect(coverageOf({ coverage: "Hers is the moment's." }, { coverage: "Hers is the outfit's." })).toBe("Hers is the moment's.");
  });

  test("with no coverage on the moment the outfit's is used, and with neither there is none", () => {
    expect(coverageOf({}, { coverage: "Hers is the outfit's." })).toBe("Hers is the outfit's.");
    expect(coverageOf({}, {})).toBeUndefined();
  });

  test("an equal sentence in the run is still redrawn: the dedup reads the whole text, coverage included", () => {
    const first = templateSentence(slot("bold", { location: "her bed", activity: "lies back with her arms up", shot: "selfie", capture: "above", outfit: "a black lace bra and panties" }), { key: KEYS[0] as string }) as string;
    const again = templateSentence(slot("bold", { location: "her bed", activity: "lies back with her arms up", shot: "selfie", capture: "above", outfit: "a black lace bra and panties" }), { key: KEYS[0] as string, seen: new Set([first]) }) as string;
    expect(again).not.toBe(first);
    expect(again.endsWith(` ${LACE}`)).toBe(true);
  });

  test("the nightwear bank has the outfits the tests above name", () => {
    const outfits = BANKS.nightwear.outfits.map((o) => o.text);
    for (const name of [SATIN, "a black lace bra and panties", "only the white bedsheet", "cotton pajama shorts and a tee"]) expect(outfits).toContain(name);
  });
});
