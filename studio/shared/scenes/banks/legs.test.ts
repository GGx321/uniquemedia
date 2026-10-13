import { describe, expect, test } from "bun:test";
import { isHandCapture, LEGS_CAPTURES, shotOf, type Capture } from "../captures";
import { momentAllowed } from "../render";
import { legwearFits } from "../template";
import { DRESS_LENGTH, DRESS_OR_SKIRT, LEGS_UNSUITED_OUTFITS, YOUTH_PROPS, isOwnerBannedOutfit } from "../words";
import { countInFamily, FEET_IN_THE_WATER, FEET_IN_THE_WATER_MAX, poseFamiliesOf, poseFamilyOf, poseWordsOf } from "./boldDesign.testkit";
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
  // C3′: the owner's chair frame replaced «sits, soles toward the mirror» (R1#08, «странное фото»).
  { category: "home", place: "a chair in her bedroom", text: "sits, legs crossed, a foot dangling", motion: "she swings her dangling foot slowly", captures: ["mirror-hidden"] },
  { category: "home", place: "her bedroom", text: "lifts one bare foot to the mirror", motion: "she lifts her foot a little and lowers it", captures: ["mirror-hidden"] },
  { category: "home", place: "her bedroom", text: "sits on the rug, legs stretched out", motion: "she flexes her feet a little", captures: ["pov-legs"] },
  { category: "home", place: "her bed", text: "lies with her ankles crossed", motion: "she crosses her ankles the other way slowly", captures: ["pov-legs"] },
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
  // 5a.3 (S5.9b2, plan s5a3 §6.2-§6.3, M5): the «Смелая» banks' eight (fourteen from S5.R4). Her own look down along her legs, or her feet to the mirror at home; never a low-feet frame.
  { category: "nightwear", place: "her bed", text: "lies with her legs crossed", motion: "she slides one ankle over the other slowly", captures: ["pov-legs"] },
  // S5.R4 round 2: worded apart from «Фитнес»'s «sits with her legs stretched out» and «Дом»'s chair frame; the poses are the same.
  { category: "nightwear", place: "an armchair in her bedroom", text: "stretches out her legs", motion: "she points her toes slowly", captures: ["pov-legs"] },
  // S5.R4 round 3: in place of «lifts one foot to the mirror» and «crosses her legs, a foot dangling», «Дом»'s poses and motions in other words.
  { category: "nightwear", place: "her bathroom", text: "stands with her feet together", motion: "she turns one foot out slowly", captures: ["mirror-hidden"] },
  { category: "nightwear", place: "an armchair in her bedroom", text: "sits, legs over the armrest", motion: "she bounces her feet a little", captures: ["mirror-hidden"] },
  // S5.R4: three more a «Смелая» bank, so the six legs slots of a 20-photo run at «Ножки» 30 % never repeat one; round 2: each a pose of its own.
  { category: "nightwear", place: "her bed", text: "lies on her side, one knee bent", motion: "she slides her top knee forward a little", captures: ["pov-legs"] },
  { category: "nightwear", place: "her bedroom", text: "stands on tiptoe by the mirror", motion: "she rises a little higher on her toes", captures: ["mirror-hidden"] },
  { category: "nightwear", place: "her bedroom", text: "steps toward the mirror", motion: "she takes a small step closer", captures: ["mirror-hidden"] },
  // S5.R4 round 2: «stretches her legs on the lounger» was «sits on the sand, legs out» again; one knee bent on the lounger is a pose of its own.
  { category: "beach", place: "a hotel pool", text: "lies on the lounger, one knee bent", motion: "she sways her bent knee slowly", captures: ["pov-legs"] },
  { category: "beach", place: "the beach", text: "sits on the sand, legs out", motion: "she slowly buries her toes in the sand", captures: ["pov-legs"] },
  { category: "beach", place: "the beach", text: "crosses her ankles on the towel", motion: "she taps her crossed feet together slowly", captures: ["pov-legs"] },
  { category: "beach", place: "a rooftop pool", text: "dangles her feet in the water", motion: "she dips her toes in the water slowly", captures: ["pov-legs"] },
  { category: "beach", place: "the water's edge", text: "lets the waves wash over her feet", motion: "she wiggles her toes in the foam slowly", captures: ["pov-legs"] },
  // S5.R4 round 3: «steps down into the water» (a rooftop pool) was the third «feet in the water» picture.
  { category: "beach", place: "the beach", text: "stands with her feet in the sand", motion: "she shifts from one foot to the other slowly", captures: ["pov-legs"] },
  { category: "beach", place: "the rocks by the sea", text: "lifts one leg, toes pointed", motion: "she lowers her lifted leg slowly", captures: ["pov-legs"] },
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

  test("C3′: the chair frame at the mirror (legs crossed, a foot dangling) names no feet of its own, so it takes legwear too", () => {
    const chair = legsMoments("home").find((l) => l.moment.text === "sits, legs crossed, a foot dangling")?.moment;
    expect(chair).toBeDefined();
    if (chair !== undefined) expect(legwearFits(chair, outfit)).toBe(true);
  });

  test.each(["lies with her bare feet forward", "sits with her socked feet forward", "lifts one bare foot to the mirror"])("«%s» names her feet or soles itself, so it takes none", (text) => {
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

// S5.R4 round 2 (the re-review, MEDIUM): the six legs slots of a 20-photo run at «Ножки» 30 % go round a bank's legs moments, so moments that are the same pose in other words are
// the same photo three times («sits with her legs stretched out», «sits on the sand, legs out», «stretches her legs on the lounger»: 3 of 6 legs frames in 29 of 45 beach runs).
// A legs moment's pose family is read from its words, the most telling first: a foot dangling is that, whether or not her legs are also crossed. Every legs moment of a «Смелая»
// bank has a family and no two share one; the five keep theirs (their plans are frozen), so the rule is held where the review found the repeat.
describe("a «Смелая» bank's legs moments are different poses (S5.R4 round 2)", () => {
  // S5.R4 round 3 (re-review, LOW): the first family a moment's words name was its family, so «sits on the pool steps, legs out» read as «stepping» and «stretches her legs out, ankles
  // crossed» as «legs crossed». Every family the words name is read, and a legs moment of a «Смелая» bank names exactly one.
  test.each<[string, string[]]>([
    ["sits on the pool steps, legs out", ["legs stretched out"]],
    ["stretches her legs out, ankles crossed", ["legs crossed", "legs stretched out"]],
    ["sits, legs crossed, a foot dangling", ["a foot dangling", "legs crossed"]],
    ["steps down into the water", ["feet in the water", "stepping"]],
    ["dangles her feet in the water", ["feet in the water"]],
    ["lets the waves wash over her feet", ["feet in the water"]],
    ["walks on tiptoe across the sand", ["on tiptoe"]],
    ["stands with her feet together", ["her feet together"]],
    ["stands with her feet in the sand", ["her feet in the sand"]],
    ["sits, legs over the armrest", ["legs over the armrest"]],
    ["sits on the floor", []],
  ])("«%s» names %p", (text, families) => {
    expect(poseFamiliesOf(text).sort()).toEqual(families);
  });

  // Polish after C4: the prompt sweep counted a run's «feet in the water» frames by the one family a moment names, so a moment worded into two families (a step down into the water)
  // was not counted at all. A frame counts in every family its words name.
  test("a frame counts in every family its words name", () => {
    const frames = ["steps down into the water", "dangles her feet in the water", "sits on the floor", "sits on the sand, legs out"];
    expect(countInFamily(frames, FEET_IN_THE_WATER)).toBe(2);
    expect(countInFamily(frames, "stepping")).toBe(1);
    expect(countInFamily(frames, "legs stretched out")).toBe(1);
  });

  test.each(["nightwear", "beach"] as const)("%s: every legs moment names exactly one pose family", (category) => {
    expect(legsMoments(category).map(({ moment }) => ({ text: moment.text, families: poseFamiliesOf(moment.text) })).filter((m) => m.families.length !== 1)).toEqual([]);
  });

  // S5.R4 round 3 (re-review, LOW): «kneels in front of the mirror» folds her legs under her, so they cannot fill most of the frame, which is what a legs frame says.
  test.each(["nightwear", "beach"] as const)("%s: no legs moment folds her legs under her", (category) => {
    const FOLDED = /\bkneel\w*\b|\b(?:legs?|feet)\s+(?:tucked\s+)?under\s+her\b|\bon her heels\b|\bcurled up\b/i;
    expect(legsMoments(category).map(({ moment }) => moment.text).filter((text) => FOLDED.test(text))).toEqual([]);
  });

  test("a moment's family is the one family its words name; none, or two, is no family", () => {
    expect(poseFamilyOf("sits, legs crossed, a foot dangling")).toBeUndefined();
    expect(poseFamilyOf("lies with her legs crossed")).toBe("legs crossed");
    expect(poseFamilyOf("sits on the sand, legs out")).toBe("legs stretched out");
    expect(poseFamilyOf("stretches her legs on the lounger")).toBe("legs stretched out");
    expect(poseFamilyOf("sits with her legs stretched out")).toBe("legs stretched out");
    expect(poseFamilyOf("crosses her ankles on the towel")).toBe("legs crossed");
    expect(poseFamilyOf("lies back, ankles crossed")).toBe("legs crossed");
    expect(poseFamilyOf("sits on the floor")).toBeUndefined();
  });

  // S5.R4 round 3: «dangles her feet in the water», «steps down into the water» and «lets the waves wash over her feet» were three families and one picture; her feet in the water is
  // one family, which a bank may hold twice on two places, never three times and never twice on one place.
  test.each(["nightwear", "beach"] as const)("%s: every legs moment has a pose family, and no two share one (her feet in the water: at most two, on two places)", (category) => {
    const families = legsMoments(category).map(({ place, moment }) => ({ place, text: moment.text, family: poseFamilyOf(moment.text) ?? "none" }));
    expect(families.filter((f) => f.family === "none").map((f) => f.text)).toEqual([]);
    const shared = families.filter((f, i) => f.family !== FEET_IN_THE_WATER && families.findIndex((g) => g.family === f.family) !== i).map((f) => `${f.family}: «${f.text}»`);
    expect(shared).toEqual([]);
    const wet = families.filter((f) => f.family === FEET_IN_THE_WATER);
    expect({ wet: wet.length <= FEET_IN_THE_WATER_MAX, places: new Set(wet.map((f) => f.place)).size === wet.length, texts: wet.map((f) => f.text) }).toMatchObject({ wet: true, places: true });
  });

  // S5.R4 round 3 (re-review, LOW): exact strings were not enough: «crosses her legs, a foot dangling» was «Дом»'s pose with «Дом»'s motion, and «lifts one foot to the mirror» was
  // «lifts one bare foot to the mirror». Texts are compared as poses (poseWordsOf: no articles, «her», numbers or «bare», stemmed), and so are motions.
  test("the comparison reads a pose, not a string", () => {
    expect(poseWordsOf("lifts one foot to the mirror")).toBe(poseWordsOf("lifts one bare foot to the mirror"));
    expect(poseWordsOf("crosses her legs, a foot dangling")).not.toBe(poseWordsOf("sits, legs crossed, a foot dangling"));
    expect(poseWordsOf("she swings her dangling foot slowly")).toBe(poseWordsOf("she swings her dangling foot a little"));
    expect(poseWordsOf("sits on the sand, legs out")).not.toBe(poseWordsOf("sits on the grass, legs out"));
  });

  test.each(["nightwear", "beach"] as const)("%s: no legs moment says what a moment of another bank says, in its text or its motion", (category) => {
    const others = BANK_CATEGORIES.filter((c) => c !== category).flatMap((c) => BANKS[c].places.flatMap((p) => p.moments.map((m) => ({ bank: c, moment: m }))));
    const texts = new Map(others.map((o) => [poseWordsOf(o.moment.text), `${o.bank}: «${o.moment.text}»`]));
    const motions = new Map(others.map((o) => [poseWordsOf(o.moment.motion), `${o.bank}: «${o.moment.motion}»`]));
    const same = legsMoments(category).flatMap(({ moment }) => [
      ...(texts.has(poseWordsOf(moment.text)) ? [`«${moment.text}» = ${texts.get(poseWordsOf(moment.text))}`] : []),
      ...(motions.has(poseWordsOf(moment.motion)) ? [`«${moment.motion}» = ${motions.get(poseWordsOf(moment.motion))}`] : []),
    ]);
    expect(same).toEqual([]);
  });

  test("a weight shift is one pose, whether it is on a leg or a hip", () => {
    expect(poseWordsOf("stands with her weight on one leg")).toBe(poseWordsOf("stands with her weight on one hip"));
    expect(poseWordsOf("she shifts her weight to the other leg slowly")).toBe(poseWordsOf("she shifts her weight slowly"));
    expect(poseWordsOf("stands with her weight on one leg")).not.toBe(poseWordsOf("stands with her hand on one leg"));
  });

  // Polish after C4: not only the legs moments. Only a moment's TEXT reaches the photo prompt, so a «Смелая» bank's moment with the text of a moment of another bank is that bank's photo
  // in other clothes. Every moment of both banks is held against every other bank, on the text alone. The twins below are known and only shrink: they are harmless in one run, because
  // the planner (planner.boldMix.sameMoment.test.ts) never lets a «Смелая» slot take a text another category holds in the same run. The test fails on any other twin, and on a listed
  // text that is no twin any more.
  const TEXT_TWINS: Record<"nightwear" | "beach", readonly string[]> = {
    // «Ночнушки» was written beside «Дом»: eleven of its bed, mirror and chair moments are «Дом»'s, one is «Гламур»'s, one «Фотосессия»'s, one «Гламур»'s wall.
    nightwear: [
      "lies on her side, head on her hand",
      "rests her cheek on the pillow",
      "lies on her stomach, one arm out",
      "lies prone, her cheek on her hand",
      "lies on her stomach, head tilted",
      "lies prone, glancing back",
      "lies prone, ankles crossed behind",
      "lies prone, feet raised behind",
      "lies on her stomach, hips behind",
      "lies on her stomach, feet up",
      "tucks her hair behind one ear",
      "adjusts the strap on her shoulder",
      "sits on the edge of the bed",
      "stands sideways to the mirror",
      "brushes her hair",
      "sits with one leg crossed",
      "pulls one knee up to her chest",
      "stretches her arms up, facing away",
      "leans against the wall",
    ],
    beach: ["shades her eyes with one hand", "adjusts the strap on her shoulder", "looks back over her shoulder", "sits hugging her knees", "tucks her hair back in the breeze"],
  };
  const textTwinsOf = (category: BankCategory): string[] => {
    const others = new Set(BANK_CATEGORIES.filter((c) => c !== category).flatMap((c) => BANKS[c].places.flatMap((p) => p.moments.map((m) => m.text.toLowerCase().trim()))));
    return BANKS[category].places.flatMap((p) => p.moments).map((m) => m.text).filter((text) => others.has(text.toLowerCase().trim()));
  };

  test.each(["nightwear", "beach"] as const)("%s: no moment has the text of a moment of another bank, but the listed twins", (category) => {
    expect(textTwinsOf(category).filter((text) => !TEXT_TWINS[category].includes(text))).toEqual([]);
  });

  test.each(["nightwear", "beach"] as const)("%s: every listed twin still is one", (category) => {
    const found = textTwinsOf(category);
    expect(TEXT_TWINS[category].filter((text) => !found.includes(text))).toEqual([]);
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

  // Round 2 (decision 4 as a whitelist): a dress or skirt on a legs moment names its length (midi, long or maxi); a blacklist cannot see «a navy wrap dress» of no length.
  test("a dress or a skirt a legs moment pins names midi, long or maxi", () => {
    for (const category of BANK_CATEGORIES) {
      for (const { moment } of legsMoments(category)) {
        for (const outfit of moment.outfits ?? []) if (DRESS_OR_SKIRT.test(outfit)) expect(DRESS_LENGTH.test(outfit), `${moment.text}: ${outfit}`).toBe(true);
      }
    }
  });

  test("a bank whose legs moment pins a dress of no length is refused at load", () => {
    const home = { ...BANKS.home, places: BANKS.home.places.map((p) => ({ ...p, moments: p.moments.map((m) => (m.text === "lies with her bare feet forward" ? { ...m, outfits: ["a fitted beige knit dress"] } : m)) })) };
    expect(categoryBankProblems({ ...home, outfits: [...home.outfits, { text: "a fitted beige knit dress", showsLegs: true as const, pinOnly: true as const }] }, "home").join("\n")).toMatch(/\[legs-outfit\]/);
  });

  // Wave 5e: the whitelist read the bare words «dress» and «skirt» only, so «a sundress», «a miniskirt» and «linen skirts» walked past it.
  const withPinned = (outfit: string) => {
    const home = { ...BANKS.home, places: BANKS.home.places.map((p) => ({ ...p, moments: p.moments.map((m) => (m.text === "lies with her bare feet forward" ? { ...m, outfits: [outfit] } : m)) })) };
    return categoryBankProblems({ ...home, outfits: [...home.outfits, { text: outfit, showsLegs: true as const, pinOnly: true as const }] }, "home").join("\n");
  };

  test.each(["a beige sundress", "a floral slipdress", "a linen skirts set", "a tee and wrap skirts", "a satin minidress", "a pleated miniskirt"])("a bank whose legs moment pins «%s» is refused at load", (outfit) => {
    expect(withPinned(outfit)).toMatch(/\[legs-outfit\]/);
  });

  test.each(["a navy midi sundress", "a long linen skirts set"])("a bank whose legs moment pins «%s», a length named, is not refused for its outfit", (outfit) => {
    expect(withPinned(outfit)).not.toMatch(/\[legs-outfit\]/);
  });

  // S5.R3: «long-sleeve» is a sleeve, not a length: the word `long` in it must not satisfy the whitelist.
  test.each(["a long-sleeve wrap dress", "a long sleeve knit dress", "a long-sleeved skirt set"])("a bank whose legs moment pins «%s», a sleeve and no length, is refused at load", (outfit) => {
    expect(withPinned(outfit)).toMatch(/\[legs-outfit\]/);
  });

  test.each(["a long-sleeve long dress", "a long-sleeve midi dress", "a long-sleeved maxi dress"])("a bank whose legs moment pins «%s», a sleeve and a length, is not refused for its outfit", (outfit) => {
    expect(withPinned(outfit)).not.toMatch(/\[legs-outfit\]/);
  });

  test("every legs moment pins at least four outfits, so a plan's legs frames do not all wear one", () => {
    for (const category of BANK_CATEGORIES) for (const { moment } of legsMoments(category)) expect(moment.outfits?.length ?? 0, `${category}: ${moment.text}`).toBeGreaterThanOrEqual(4);
  });

  test("a bank whose legs moment pins a mini dress is refused at load", () => {
    const home = { ...BANKS.home, places: BANKS.home.places.map((p) => ({ ...p, moments: p.moments.map((m) => (m.text === "lies with her bare feet forward" ? { ...m, outfits: ["a pleated wool mini skirt and a top"] } : m)) })) };
    expect(categoryBankProblems(home, "home").join("\n")).toMatch(/\[legs-outfit\]/);
  });

  test("a bank whose legs moment pins nothing is refused at load", () => {
    const home = { ...BANKS.home, places: BANKS.home.places.map((p) => ({ ...p, moments: p.moments.map((m) => (m.text === "lies with her bare feet forward" ? { ...m, outfits: undefined } : m)) })) };
    expect(categoryBankProblems(home, "home").join("\n")).toMatch(/\[legs-outfit\]/);
  });
});
