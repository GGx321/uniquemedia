import { describe, expect, test } from "bun:test";
import { isHandCapture, LEGS_CAPTURES, shotOf, type Capture } from "../captures";
import { momentAllowed } from "../render";
import { legwearFits } from "../template";
import { YOUTH_PROPS, isOwnerBannedOutfit } from "../words";
import { BANKS } from "./index";
import { MOTION_TEXT_MAX } from "./schema";
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
  { category: "photoshoot", place: "a cafe table on the pavement", text: "sits with her ankles crossed", motion: "she swings her crossed foot slowly", captures: ["low-feet"] },
  { category: "travel", place: "a balcony over city rooftops", text: "stretches her legs on the chair", motion: "she stretches her toes toward the railing a little", captures: ["pov-legs"] },
  { category: "glamour", place: "a street outside a bar", text: "slips on her heels by the door", motion: "she settles her foot into the heel slowly", captures: ["low-feet"] },
  { category: "glamour", place: "the back seat of a taxi", text: "sits with her legs crossed", motion: "she crosses and uncrosses her legs slowly", captures: ["pov-legs"] },
  { category: "fitness", place: "a home workout corner", text: "stretches her legs on the mat", motion: "she flexes her feet slowly", captures: ["pov-legs"] },
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

  test("«slips on her heels by the door» takes none: the heels are the footwear", () => {
    const moment = legsMoments("glamour").find((l) => l.moment.text === "slips on her heels by the door")?.moment;
    expect(moment).toBeDefined();
    if (moment !== undefined) expect(legwearFits(moment, { text: "a fitted black bodycon dress", showsLegs: true })).toBe(false);
  });

  test("stockings are not a legwear item of any bank: they wait for «Смелая» (5a.3)", () => {
    for (const category of BANK_CATEGORIES) {
      for (const item of BANKS[category].legwear?.items ?? []) expect(item).not.toMatch(/stocking/i);
    }
  });
});
