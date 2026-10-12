import { describe, expect, test } from "bun:test";
import { isHandCapture, LEGS_CAPTURES, shotOf, type Capture } from "../captures";
import { momentAllowed } from "../render";
import { legwearFits } from "../template";
import { LEGS_UNSUITED_OUTFITS, YOUTH_PROPS, isOwnerBannedOutfit } from "../words";
import { BANKS } from "./index";
import { categoryBankProblems, MOTION_TEXT_MAX } from "./schema";
import { BANK_CATEGORIES, type BankCategory, type Moment } from "./types";

// 5a.2c (S5.8a, plan s5a2 §7.2): the «Ножки» banks. A legs moment carries `legs: { framing: "legs" }` and is drawn only on a legs slot. The table below is the plan's,
// in the owner's rules: at home she shoots herself (the friend's `low-feet` line is for places outside only, so the «Дом» feet moments are `pov-legs` shots, the
// compositions kept), the taxi is a selfie place (its legs frame looks down along her own legs), and side or back to the mirror shows only her reflection.

interface Row {
  category: BankCategory;
  place: string;
  text: string;
  motion: string;
  captures: readonly Capture[];
}

const TABLE: Row[] = [
  { category: "home", place: "her bedroom", text: "stretches her legs along the bed", motion: "she points and flexes her toes slowly", captures: ["pov-legs"] },
  { category: "home", place: "her bed", text: "lies with her bare feet forward", motion: "she wiggles her toes a little", captures: ["pov-legs"] },
  { category: "home", place: "her bed", text: "sits with her socked feet forward", motion: "she crosses and uncrosses her ankles slowly", captures: ["pov-legs"] },
  { category: "home", place: "her bedroom", text: "sits, soles toward the mirror", motion: "she taps her feet together a little", captures: ["mirror-hidden"] },
  { category: "home", place: "her bedroom", text: "lifts one bare foot to the mirror", motion: "she lifts her foot a little and lowers it", captures: ["mirror-hidden"] },
  { category: "photoshoot", place: "a cafe table on the pavement", text: "sits with her ankles crossed", motion: "she shifts her crossed ankles slowly", captures: ["low-feet"] },
  { category: "photoshoot", place: "a cafe table on the pavement", text: "sits with one knee over the other", motion: "she tilts her raised foot slowly", captures: ["low-feet"] },
  { category: "photoshoot", place: "a quiet street corner", text: "sits on the steps, legs out", motion: "she flexes her feet a little", captures: ["low-feet"] },
  { category: "travel", place: "a balcony over city rooftops", text: "stretches her legs on the chair", motion: "she stretches her toes toward the railing a little", captures: ["pov-legs"] },
  { category: "travel", place: "a garden pond", text: "sits on the grass, legs out", motion: "she wiggles her toes a little", captures: ["pov-legs"] },
  { category: "travel", place: "a dirt path above green hills", text: "rests on a flat rock, legs forward", motion: "she flexes her feet slowly", captures: ["pov-legs"] },
  { category: "glamour", place: "a street outside a bar", text: "steps into her heels by the door", motion: "she rises onto her toes a little", captures: ["low-feet"] },
  { category: "glamour", place: "the back seat of a taxi", text: "sits with her legs crossed", motion: "she taps her foot slowly", captures: ["pov-legs"] },
  { category: "glamour", place: "the back seat of a taxi", text: "sits with her knees together", motion: "she shifts her feet a little", captures: ["pov-legs"] },
  { category: "glamour", place: "a cocktail bar", text: "sits on a stool, ankles crossed", motion: "she rocks her crossed ankles slowly", captures: ["low-feet"] },
  { category: "fitness", place: "a home workout corner", text: "stretches her legs on the mat", motion: "she flexes her feet slowly", captures: ["pov-legs"] },
  { category: "fitness", place: "a yoga mat on her living-room floor", text: "sits with her legs stretched out", motion: "she reaches toward her toes slowly", captures: ["pov-legs"] },
  { category: "fitness", place: "a park running path", text: "stretches her calves", motion: "she presses her heel down a little", captures: ["low-feet"] },
];

const legsMoments = (category: BankCategory): { place: string; moment: Moment }[] =>
  BANKS[category].places.flatMap((place) => place.moments.filter((m) => m.legs !== undefined).map((moment) => ({ place: place.name, moment })));

describe("the legs banks (plan s5a2 §7.2)", () => {
  test.each(TABLE)("$category · $place · «$text» is a legs moment with its motion and captures", (row) => {
    const found = legsMoments(row.category).find((l) => l.place === row.place && l.moment.text === row.text);
    expect(found?.moment.motion).toBe(row.motion);
    expect(found?.moment.captures).toEqual(row.captures);
    expect(found?.moment.legs).toEqual({ framing: "legs" });
  });

  test("no other legs moment is in the banks: the table is the plan's, exactly", () => {
    const expected = TABLE.map((r) => `${r.category} | ${r.place} | ${r.text}`).sort();
    const found = BANK_CATEGORIES.flatMap((c) => legsMoments(c).map((l) => `${c} | ${l.place} | ${l.moment.text}`)).sort();
    expect(found).toEqual(expected);
  });

  test("every legs moment carries a motion that is small, slow and one movement (I5.35)", () => {
    for (const category of BANK_CATEGORIES) {
      for (const { moment } of legsMoments(category)) {
        expect(moment.motion.length, moment.text).toBeGreaterThan(0);
        expect(moment.motion.length, moment.text).toBeLessThanOrEqual(MOTION_TEXT_MAX);
      }
    }
  });

  test("a legs moment fits a legs slot and no other: it is drawn on a legs framing only", () => {
    for (const category of BANK_CATEGORIES) {
      for (const { moment } of legsMoments(category)) {
        for (const capture of moment.captures) {
          expect(momentAllowed(moment, capture, moment.angle ?? "front", "ordinary", "legs"), `${moment.text} on ${capture}`).toBe(true);
          expect(momentAllowed(moment, capture, moment.angle ?? "front", "ordinary"), `${moment.text} on ${capture}, no framing`).toBe(false);
        }
      }
    }
  });

  test("no ordinary moment lists a legs capture: pov-legs and low-feet belong to legs moments", () => {
    for (const category of BANK_CATEGORIES) {
      for (const place of BANKS[category].places) {
        for (const moment of place.moments) if (moment.legs === undefined) expect(moment.captures.filter((c) => LEGS_CAPTURES.includes(c)), moment.text).toEqual([]);
      }
    }
  });
});

describe("the owner's rules on the legs banks", () => {
  test("at home she shoots herself: no «Дом» legs moment is a friend's photo, and `low-feet` is outside only", () => {
    for (const { moment } of legsMoments("home")) {
      expect(moment.captures.filter((c) => shotOf(c) === "friend" || c === "candid"), moment.text).toEqual([]);
    }
    for (const category of BANK_CATEGORIES) {
      for (const place of BANKS[category].places.filter((p) => p.room === true)) {
        for (const moment of place.moments) if (moment.legs !== undefined) expect(moment.captures.includes("low-feet"), `${place.name}: ${moment.text}`).toBe(false);
      }
    }
  });

  test("the taxi is a selfie place: its legs moment is a look down along her own legs, never a crouching friend", () => {
    const taxi = legsMoments("glamour").filter((l) => l.place === "the back seat of a taxi");
    expect(taxi.length).toBeGreaterThan(0);
    for (const { moment } of taxi) expect(moment.captures.every((c) => isHandCapture(c)), moment.text).toBe(true);
  });

  test("side or back to the mirror shows only her reflection: a mirror legs moment faces the mirror", () => {
    for (const category of BANK_CATEGORIES) {
      for (const { moment } of legsMoments(category)) {
        if (moment.captures.some((c) => shotOf(c) === "mirror")) {
          expect(moment.mirrorBack, moment.text).toBeUndefined();
          expect(moment.angle === undefined || moment.angle === "three-quarter", moment.text).toBe(true);
        }
      }
    }
  });

  test("prone is only on a bed: no legs moment lies on her stomach", () => {
    for (const category of BANK_CATEGORIES) for (const { moment } of legsMoments(category)) expect(moment.text, moment.text).not.toMatch(/stomach|prone/);
  });

  test("no denim and no youth prop in a legs moment or its motion (K-17)", () => {
    for (const category of BANK_CATEGORIES) {
      for (const { moment } of legsMoments(category)) {
        for (const said of [moment.text, moment.motion]) {
          expect(isOwnerBannedOutfit(said), said).toBe(false);
          expect(YOUTH_PROPS.test(said), said).toBe(false);
        }
      }
    }
  });

  test("a self-shot legs moment names no phone and no selfie, and holds nothing in a hand", () => {
    for (const category of BANK_CATEGORIES) {
      for (const { moment } of legsMoments(category)) {
        if (!moment.captures.some(isHandCapture)) continue;
        expect(moment.phone, moment.text).toBeUndefined();
        expect(moment.twoHanded, moment.text).toBe(false);
        expect(moment.text, moment.text).not.toMatch(/phone|selfie/i);
      }
    }
  });
});

describe("legwear on the legs moments (the §5.1 rule)", () => {
  const outfit = { text: "a pleated mini and a fitted top", showsLegs: true as const };

  test("«stretches her legs along the bed» takes legwear, as the legs slots need it", () => {
    const along = legsMoments("home").find((l) => l.moment.text === "stretches her legs along the bed")?.moment;
    expect(along).toBeDefined();
    if (along !== undefined) expect(legwearFits(along, outfit)).toBe(true);
  });

  test.each(["lies with her bare feet forward", "sits with her socked feet forward", "sits, soles toward the mirror", "lifts one bare foot to the mirror"])("«%s» names her feet or soles itself, so it takes none", (text) => {
    const moment = legsMoments("home").find((l) => l.moment.text === text)?.moment;
    expect(moment).toBeDefined();
    if (moment !== undefined) expect(legwearFits(moment, outfit)).toBe(false);
  });

  test("«steps into her heels by the door» takes none: the heels are the footwear", () => {
    const moment = legsMoments("glamour").find((l) => l.moment.text === "steps into her heels by the door")?.moment;
    expect(moment).toBeDefined();
    if (moment !== undefined) expect(legwearFits(moment, { text: "a fitted black bodycon dress", showsLegs: true })).toBe(false);
  });

  test("stockings are not a legwear item of any bank: they wait for «Смелая» (5a.3)", () => {
    for (const category of BANK_CATEGORIES) {
      for (const item of BANKS[category].legwear?.items ?? []) expect(item).not.toMatch(/stocking/i);
    }
  });
});

// S5.8a review: variety, a frame that does not stage the face, no hands in a frame whose hands are empty, and a low angle that is not an upskirt.
describe("every category has legs moments to vary (I5.24)", () => {
  test.each([...BANK_CATEGORIES])("%s: at least 3 legs moments across at least 2 places", (category) => {
    const found = legsMoments(category);
    expect(found.length).toBeGreaterThanOrEqual(3);
    expect(new Set(found.map((l) => l.place)).size).toBeGreaterThanOrEqual(2);
  });

  test("«Фитнес» has at least two more outfits that show her legs than the two it had", () => {
    expect(BANKS.fitness.outfits.filter((o) => o.showsLegs === true).length).toBeGreaterThanOrEqual(4);
  });
});

describe("a legs frame whose hands are empty holds nothing in them", () => {
  test("a low-feet moment (a friend's photo with both of her hands empty) and a pov-legs one are not two-handed and name no phone", () => {
    for (const category of BANK_CATEGORIES) {
      for (const { moment } of legsMoments(category)) {
        if (!moment.captures.some((c) => c === "low-feet" || c === "pov-legs")) continue;
        expect(moment.twoHanded, moment.text).toBe(false);
        expect(moment.phone, moment.text).toBeUndefined();
      }
    }
  });
});

describe("a low angle under a mini reads as an upskirt shot", () => {
  test("every legs moment pins its outfits, and none is a mini or short dress or skirt, a bodycon, or a sweater or tee worn as a dress", () => {
    for (const category of BANK_CATEGORIES) {
      for (const { moment } of legsMoments(category)) {
        expect(moment.outfits?.length ?? 0, moment.text).toBeGreaterThan(0);
        for (const outfit of moment.outfits ?? []) expect(LEGS_UNSUITED_OUTFITS.test(outfit), `${moment.text}: ${outfit}`).toBe(false);
      }
    }
  });

  test("a bank whose legs moment pins a mini dress is refused at load", () => {
    const home = { ...BANKS.home, places: BANKS.home.places.map((p) => ({ ...p, moments: p.moments.map((m) => (m.text === "lies with her bare feet forward" ? { ...m, outfits: ["a pleated mini and a fitted top"] } : m)) })) };
    expect(categoryBankProblems(home, "home").join("\n")).toMatch(/\[legs-outfit\]/);
  });

  test("a bank whose legs moment pins nothing is refused at load", () => {
    const home = { ...BANKS.home, places: BANKS.home.places.map((p) => ({ ...p, moments: p.moments.map((m) => (m.text === "lies with her bare feet forward" ? { ...m, outfits: undefined } : m)) })) };
    expect(categoryBankProblems(home, "home").join("\n")).toMatch(/\[legs-outfit\]/);
  });
});
