import { describe, expect, test } from "bun:test";
import { BANKS } from "./banks";
import { BOLD_COMPANIONS } from "./banks/companions";
import { COVER } from "./banks/companions/outfits";
import { ORDINARY_BANK_CATEGORIES, type BankPlace, type CategoryBank, type Moment } from "./banks/types";
import { shotOf } from "./captures";
import { coverageOf, templateSentence, type TemplateSlot } from "./template";

// 5a.4 (S5.BA3, plan s5a4 I5.73, I5.74, §5.5, H1, H3): the template reads a slot's bank through the one lookup (the five on the route read their companion), and the coverage sentence it
// appends follows the avatar's origin: an imported or unknown-origin avatar always says the kept `coverage`; a Studio-created avatar says the `openCoverage` of the class P-BA drew
// open, or no sentence at all.

const KEY = "run-1:slot-1";
const LACE = "The lace is lined and opaque: her bra fully covers her breasts and her panties fully cover her.";
const SATIN_SET = "Her cami and shorts are opaque satin.";

function find(bank: CategoryBank, wanted: (moment: Moment) => boolean): { place: BankPlace; moment: Moment } {
  for (const place of bank.places) {
    const moment = place.moments.find(wanted);
    if (moment !== undefined) return { place, moment };
  }
  throw new Error("the bank has no such moment");
}

/** A routed slot of a bank's place, moment and outfit, on the first capture the moment fits, facing as the moment does. */
function slotOf(category: string, found: { place: BankPlace; moment: Moment }, outfit: string, extra: Partial<TemplateSlot> = {}): TemplateSlot {
  const capture = found.moment.captures[0];
  if (capture === undefined) throw new Error("a moment with no capture");
  return { category, location: found.place.name, activity: found.moment.text, outfit, shot: shotOf(capture), capture, pose: found.moment.angle ?? "front", route: "seedream", ...extra };
}

const CAMI = "a satin cami and satin shorts";
const BLACK_LACE = "a black lace bra and panties";

describe("coverageOf: the sentence follows the origin (I5.74, H3)", () => {
  const outfit = { coverage: "kept outfit", openCoverage: "open outfit" };
  const moment = { coverage: "kept moment", openCoverage: "open moment" };

  test("an imported or unknown-origin avatar says the moment's kept sentence, else the outfit's", () => {
    expect(coverageOf(moment, outfit, false)).toBe("kept moment");
    expect(coverageOf({}, outfit, false)).toBe("kept outfit");
    expect(coverageOf(moment, outfit)).toBe("kept moment");
  });

  test("a Studio-created avatar says the open sentence of the item that carries a coverage: the moment's, else the outfit's", () => {
    expect(coverageOf(moment, outfit, true)).toBe("open moment");
    expect(coverageOf({}, outfit, true)).toBe("open outfit");
  });

  test("a Studio-created avatar says no sentence where the item has a coverage and no open one", () => {
    expect(coverageOf({}, { coverage: "kept outfit" }, true)).toBeUndefined();
    expect(coverageOf({ coverage: "kept moment" }, outfit, true)).toBeUndefined();
  });

  test("an item with no coverage says none, for either origin", () => {
    expect(coverageOf({}, {}, true)).toBeUndefined();
    expect(coverageOf({}, {}, false)).toBeUndefined();
  });
});

describe("the five on the route are written from their companion (I5.73)", () => {
  test("a routed «Дом» slot at a companion place renders, in the companion's own words", () => {
    const found = find(BOLD_COMPANIONS.home, (m) => m.level === undefined && m.legs === undefined);
    const text = templateSentence(slotOf("home", found, CAMI), { key: KEY });
    expect(text).not.toBeNull();
    expect(text?.toLowerCase()).toContain(found.place.at);
    expect(text).toContain(found.moment.text);
  });

  test("the same slot stored before 5a.4, with no route, reads the ordinary «Дом» bank and finds no such place", () => {
    const found = find(BOLD_COMPANIONS.home, (m) => m.level === undefined && m.legs === undefined);
    expect(templateSentence(slotOf("home", found, CAMI, { route: undefined }), { key: KEY })).toBeNull();
  });

  test.each([...ORDINARY_BANK_CATEGORIES])("every moment of the %s companion renders on every capture it lists, for either origin", (category) => {
    const bank = BOLD_COMPANIONS[category];
    for (const place of bank.places) {
      for (const moment of place.moments) {
        const outfits = moment.outfits ?? bank.outfits.filter((o) => o.pinOnly !== true && (moment.legs === undefined || o.showsLegs === true)).map((o) => o.text);
        const outfit = outfits[0];
        if (outfit === undefined) throw new Error(`no outfit for «${moment.text}»`);
        for (const capture of moment.captures) {
          for (const impliedNudity of [false, true]) {
            const slot = slotOf(category, { place, moment }, outfit, { capture, shot: shotOf(capture), ...(moment.legs === undefined ? {} : { framing: "legs" as const }), level: moment.level ?? "bold" });
            const text = templateSentence(slot, { key: KEY, impliedNudity });
            expect({ place: place.name, moment: moment.text, capture, impliedNudity, rendered: text !== null }).toEqual({ place: place.name, moment: moment.text, capture, impliedNudity, rendered: true });
          }
        }
      }
    }
  });

  test("a routed custom slot is the writer's: the template renders nothing for it", () => {
    const found = find(BOLD_COMPANIONS.home, (m) => m.level === undefined && m.legs === undefined);
    expect(templateSentence(slotOf("cat-paris-trip", found, CAMI), { key: KEY, snapshots: [{ ref: "cat-paris-trip" }] })).toBeNull();
  });

  test("nightwear and beach read their own bank with the route and without it", () => {
    const found = find(BANKS.nightwear, (m) => m.level === undefined && m.legs === undefined);
    const withRoute = templateSentence(slotOf("nightwear", found, CAMI), { key: KEY });
    const without = templateSentence(slotOf("nightwear", found, CAMI, { route: undefined }), { key: KEY });
    expect(withRoute).not.toBeNull();
    expect(withRoute).toBe(without);
  });
});

describe("the coverage of a lace frame follows the origin (H3)", () => {
  const found = find(BOLD_COMPANIONS.home, (m) => m.level === "flirty" && m.legs === undefined && m.outfits === undefined);
  const slot = slotOf("home", found, BLACK_LACE, { level: "flirty" });

  test("an imported avatar's lace frame says the kept sentence", () => {
    expect(templateSentence(slot, { key: KEY })).toContain(LACE);
    expect(templateSentence(slot, { key: KEY, impliedNudity: false })).toContain(LACE);
  });

  test("a Studio-created avatar's lace frame says no coverage sentence: P-BA drew the class without it", () => {
    const text = templateSentence(slot, { key: KEY, impliedNudity: true });
    expect(text).not.toBeNull();
    expect(text).not.toContain("lined and opaque");
  });

  test("a satin frame says the kept sentence to every avatar: P-BA drew no satin open", () => {
    const satin = find(BOLD_COMPANIONS.home, (m) => m.level === undefined && m.legs === undefined && m.outfits === undefined);
    for (const impliedNudity of [false, true]) expect(templateSentence(slotOf("home", satin, CAMI), { key: KEY, impliedNudity })).toContain(SATIN_SET);
  });

  test("a nightwear lace frame follows the same rule", () => {
    const night = find(BANKS.nightwear, (m) => m.level === undefined && m.legs === undefined && m.outfits === undefined);
    expect(templateSentence(slotOf("nightwear", night, BLACK_LACE, { level: "flirty" }), { key: KEY })).toContain(LACE);
    expect(templateSentence(slotOf("nightwear", night, BLACK_LACE, { level: "flirty" }), { key: KEY, impliedNudity: true })).not.toContain("lined and opaque");
  });
});

describe("an implied cover is drawn with the sentence its moment carries (r2.2 P5)", () => {
  const towel = find(BOLD_COMPANIONS.home, (m) => m.outfits?.includes("only a white bath towel") === true);
  const sheet = find(BOLD_COMPANIONS.home, (m) => m.outfits?.includes("only the white bedsheet") === true);

  test("the towel says the kept sentence to an imported avatar and its descriptive open one to a Studio-created avatar", () => {
    const slot = slotOf("home", towel, "only a white bath towel", { level: "bold" });
    expect(templateSentence(slot, { key: KEY, impliedNudity: false })).toContain(COVER.towel);
    const open = templateSentence(slot, { key: KEY, impliedNudity: true });
    expect(open).toContain(COVER.towelOpen);
    expect(open).not.toContain(COVER.towel);
  });

  test("the sheet says its one sentence to every avatar", () => {
    const slot = slotOf("home", sheet, "only the white bedsheet", { level: "bold" });
    for (const impliedNudity of [false, true]) expect(templateSentence(slot, { key: KEY, impliedNudity })).toContain(COVER.sheet);
  });
});
