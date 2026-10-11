import { describe, expect, test } from "bun:test";
import { BANK_RULE, categoryBankProblems, cueBankProblems, gazeBankProblems, hairBankProblems, MOMENT_VERBS } from "./schema";
import type { BankPlace, CategoryBank, Cue, Gaze, Hairstyle, Moment } from "./types";

// 5a.2 (S5.6a, I5.21, I5.35; plan s5a2 r1.2): the banks are validated with zod when they load, so a malformed bank is a test failure, never a
// production surprise. A valid fixture passes; then one row per rule breaks exactly that rule and must be refused with it. The engine-only word lists
// (the revealing words, the paper, screen and staging lists, the «silk pajamas» exemption) are swept in engine/scenes/banks.sweep.test.ts.

const MOMENTS: readonly Moment[] = [
  { text: "waits for the kettle", motion: "she shifts her weight a little", captures: ["mirror-hidden", "mirror", "timer"], twoHanded: false },
  { text: "slices fruit on a cutting board", motion: "she slices slowly", captures: ["friend"], twoHanded: true, gaze: "focus" },
  { text: "laughs at something on her phone", motion: "she laughs a little at her phone", captures: ["friend"], twoHanded: false, phone: true, gaze: "own", expression: true },
  { text: "looks back over her shoulder", motion: "she turns her head a little more", captures: ["timer"], twoHanded: false, angle: "three-quarter", gaze: "own" },
  { text: "brushes her hair", motion: "she brushes slowly", captures: ["mirror"], twoHanded: false, hair: "own", messyOk: true },
];

const ROOM: BankPlace = {
  name: "her small kitchen",
  at: "in her small kitchen",
  times: ["morning", "evening"],
  room: true,
  lamp: true,
  mirror: true,
  details: ["a kettle on the counter", "a fruit bowl"],
  moments: MOMENTS,
};

const STREET: BankPlace = {
  name: "a narrow old-town street",
  at: "on a narrow old-town street",
  times: ["morning"],
  details: ["a bicycle against a wall", "some flower pots on a windowsill"],
  moments: [
    { text: "holds a takeaway coffee", motion: "she lifts the cup a little", captures: ["friend", "selfie", "candid"], twoHanded: false, outdoor: true },
    { text: "walks past old stone houses", motion: "she keeps walking slowly", captures: ["friend", "candid"], twoHanded: false, outdoor: true },
    { text: "eats a gelato from a cone", motion: "she takes a small bite", captures: ["friend", "selfie"], twoHanded: false, outdoor: true },
    { text: "walks away down the street", motion: "she keeps walking slowly", captures: ["friend", "candid"], twoHanded: false, angle: "back", outdoor: true },
  ],
};

const BANK: CategoryBank = {
  places: [ROOM, STREET],
  outfits: [{ text: "a grey lounge set" }, { text: "a cozy hoodie" }, { text: "grey lounge shorts and a fitted tee", showsLegs: true }],
  legwear: { items: ["white knee-high socks", "sheer black tights"], share: 0.4 },
  captureDeck: ["mirror-hidden", "mirror", "timer", "friend", "selfie", "candid"],
};

const plain: Moment = { text: "waits by the window", motion: "she shifts her weight a little", captures: ["timer", "friend"], twoHanded: false };
const withMoment = (moment: Moment): CategoryBank => ({ ...BANK, places: [{ ...ROOM, moments: [...MOMENTS, moment] }, STREET] });
const withRoom = (place: Partial<BankPlace>): CategoryBank => ({ ...BANK, places: [{ ...ROOM, ...place }, STREET] });
const withStreet = (place: Partial<BankPlace>): CategoryBank => ({ ...BANK, places: [ROOM, { ...STREET, ...place }] });

/** The rule ids a bank breaks (each problem is `[rule] text`). */
const rulesOf = (problems: readonly string[]): string[] => [...new Set(problems.map((p) => /^\[([a-z-]+)\]/.exec(p)?.[1] ?? p))];

describe("a category bank", () => {
  test("the fixture is valid (the rows below each break one rule of it)", () => {
    expect(categoryBankProblems(BANK, "home")).toEqual([]);
    expect(categoryBankProblems(BANK, "glamour")).toEqual([]);
  });

  test("the pinned verbs are third-person present forms", () => {
    for (const verb of MOMENT_VERBS) expect(verb).toMatch(/^[a-z]+s$/);
    expect(new Set(MOMENT_VERBS).size).toBe(MOMENT_VERBS.length);
  });

  const MOMENT_ROWS: Array<[string, Moment, string]> = [
    ["a moment that does not start with a pinned verb", { ...plain, text: "waiting for the kettle" }, BANK_RULE.momentVerb],
    ["a moment that is not a verb phrase at all", { ...plain, text: "a quiet moment" }, BANK_RULE.momentVerb],
    ["a moment that names «she»", { ...plain, text: "waits while she yawns" }, BANK_RULE.momentShe],
    ["a moment over the pool text bound", { ...plain, text: "waits for the kettle to boil on the stove" }, BANK_RULE.text],
    ["a moment with a youth word", { ...plain, text: "holds a tiny cup" }, BANK_RULE.youth],
    ["a moment with a youth prop", { ...plain, text: "holds a plush toy" }, BANK_RULE.youthProp],
    ["a moment that names a hair colour", { ...plain, text: "brushes her blonde hair", hair: "own" }, BANK_RULE.hairColour],
    ["a phone flag on a moment that names no phone", { ...plain, phone: true, gaze: "own" }, BANK_RULE.momentPhone],
    ["a moment that names her phone without the flag", { ...plain, text: "scrolls through her phone", gaze: "own" }, BANK_RULE.momentPhone],
    ["a phone moment without its own gaze", { ...plain, text: "scrolls through her phone", phone: true }, BANK_RULE.phoneGaze],
    ["a moment that says selfie", { ...plain, text: "takes a quick selfie" }, BANK_RULE.selfie],
    ["a moment that names her hair without the own-hair tag", { ...plain, text: "tucks her hair behind her ear" }, BANK_RULE.momentHair],
    ["an own-hair tag on a moment that names no hair", { ...plain, hair: "own" }, BANK_RULE.momentHair],
    ["a moment that names a camera", { ...plain, text: "smiles at the camera", gaze: "viewer" }, BANK_RULE.camera],
    ["a moment that looks at the viewer without the viewer tag", { ...plain, text: "smiles at the viewer" }, BANK_RULE.momentViewer],
    ["a viewer tag on a moment that names no viewer", { ...plain, gaze: "viewer" }, BANK_RULE.momentViewer],
    ["a moment that looks somewhere without carrying its gaze", { ...plain, text: "looks out of the window" }, BANK_RULE.momentGaze],
    ["a back moment that looks at the viewer", { ...plain, text: "turns to the viewer", gaze: "viewer", angle: "back" }, BANK_RULE.backViewer],
    ["a moment that names a mirror and fits a friend's photo", { ...plain, text: "sits on the floor by the mirror", captures: ["mirror", "friend"] }, BANK_RULE.mirrorWord],
    ["a moment with no capture", { ...plain, captures: [] }, BANK_RULE.captures],
    ["a moment with a capture twice", { ...plain, captures: ["timer", "timer"] }, BANK_RULE.captures],
    ["a two-handed moment on a hand-held capture", { ...plain, twoHanded: true, captures: ["selfie", "timer"] }, BANK_RULE.captures],
    ["a phone moment on a hand-held capture", { ...plain, text: "scrolls through her phone", phone: true, gaze: "own", captures: ["above"] }, BANK_RULE.captures],
    ["a legs capture on a moment that is not a legs moment", { ...plain, captures: ["pov-legs"] }, BANK_RULE.legsCapture],
    ["a moment pinned to an outfit the category does not have", { ...plain, outfits: ["cotton shorts and a tee"] }, BANK_RULE.pinnedOutfit],
    ["a motion over the pool text bound", { ...plain, motion: "she slowly lifts her hips behind her and lowers them" }, BANK_RULE.text],
    ["a motion that does not start with «she» or «her»", { ...plain, motion: "slowly she sips" }, BANK_RULE.motionGrammar],
    ["a motion that is not small or slow", { ...plain, motion: "she jumps up" }, BANK_RULE.motionGrammar],
    ["a motion of two movements («then»)", { ...plain, motion: "she sips then slowly smiles" }, BANK_RULE.motionGrammar],
    ["a motion of three movements", { ...plain, motion: "she sips and smiles and waves a bit" }, BANK_RULE.motionGrammar],
    ["a motion that names the camera", { ...plain, motion: "she leans slowly toward the camera" }, BANK_RULE.camera],
    ["a motion that zooms or cuts", { ...plain, motion: "she sips as it zooms in slowly" }, BANK_RULE.motionStaging],
    ["a motion that brings in a phone the moment does not use", { ...plain, motion: "she checks her phone slowly" }, BANK_RULE.motionPhone],
    ["a motion with a youth word", { ...plain, motion: "she sips like a girl, slowly" }, BANK_RULE.youth],
    ["a start pose over the pool text bound", { ...plain, startPose: "lying flat on her stomach with her hips down" }, BANK_RULE.text],
    ["a start pose with a youth prop", { ...plain, startPose: "holding a teddy bear" }, BANK_RULE.youthProp],
    ["a timer moment that holds something (its line: «both of her hands are empty», I5.32)", { ...plain, text: "holds a takeaway coffee" }, BANK_RULE.timerHands],
    ["a timer moment that sips a drink", { ...plain, text: "sips her coffee" }, BANK_RULE.timerHands],
    ["a timer moment with her keys", { ...plain, text: "waits by the door with her keys" }, BANK_RULE.timerHands],
    ["a close selfie from above while she sits (its line: «as she lies there»)", { ...plain, text: "sits cross-legged on the bed", captures: ["above"] }, BANK_RULE.aboveLying],
    ["a moment that laughs without the expression tag (a cue would contradict it)", { ...plain, text: "laughs on her way inside" }, BANK_RULE.momentExpression],
    ["a moment that smiles without the expression tag", { ...plain, text: "smiles across the table", gaze: "own" }, BANK_RULE.momentExpression],
    ["an expression tag on a moment that shows none", { ...plain, expression: true }, BANK_RULE.momentExpression],
    ["a feet-up moment without the no-legwear tag (plan r1.4: Grok refused legs up in tights)", { ...plain, text: "lies on her stomach, feet raised" }, BANK_RULE.noLegwear],
    ["feet on a railing without the no-legwear tag", { ...plain, text: "sits with her feet on the railing" }, BANK_RULE.noLegwear],
  ];

  test.each(MOMENT_ROWS)("refuses %s", (_name, moment, rule) => {
    expect(rulesOf(categoryBankProblems(withMoment(moment), "home"))).toContain(rule);
  });

  test("refuses a moment without a motion (I5.35: every moment carries one)", () => {
    const { motion: _motion, ...noMotion } = plain;
    expect(rulesOf(categoryBankProblems({ ...BANK, places: [{ ...ROOM, moments: [...MOMENTS, noMotion] }, STREET] }, "home"))).toContain(BANK_RULE.shape);
  });

  test("a motion may name her phone when the moment uses it", () => {
    const phone: Moment = { ...plain, text: "scrolls through her phone", phone: true, gaze: "own", motion: "she scrolls her phone slowly", captures: ["friend"] };
    expect(categoryBankProblems(withMoment(phone), "home")).toEqual([]);
  });

  test("a moment may pin outfits of its category, name a start pose, stand by an object and be a legs moment with a legs capture", () => {
    const rich: Moment[] = [
      { ...plain, outfits: ["grey lounge shorts and a fitted tee"], startPose: "lying flat on her stomach" },
      { ...plain, text: "leans on the lamppost", object: true },
      { ...plain, text: "stretches her legs out on the bed", captures: ["pov-legs", "mirror-hidden"], legs: { framing: "legs" } },
      { ...plain, text: "lies on her back, legs up", noLegwear: true },
      { ...plain, text: "sits on the rug in her slippers", noLegwear: true },
    ];
    expect(categoryBankProblems({ ...BANK, places: [{ ...ROOM, moments: [...MOMENTS, ...rich] }, STREET] }, "home")).toEqual([]);
  });

  const PLACE_ROWS: Array<[string, CategoryBank, string]> = [
    ["a place with one detail", withStreet({ details: ["a bicycle against a wall"] }), BANK_RULE.details],
    ["a place with four details", withStreet({ details: ["a bicycle against a wall", "a cat on a step", "a red door", "a lamp post"] }), BANK_RULE.details],
    ["a detail that is not a noun phrase with its article", withRoom({ details: ["makeup on the counter", "a fruit bowl"] }), BANK_RULE.detailGrammar],
    ["a detail over the pool text bound", withStreet({ details: ["a bicycle leaning against the old wall", "a cat"] }), BANK_RULE.text],
    ["a detail that names a mirror", withRoom({ details: ["a full-length mirror", "a fruit bowl"] }), BANK_RULE.mirrorWord],
    ["a locative phrase without its preposition", withRoom({ at: "her small kitchen" }), BANK_RULE.at],
    ["a place name that names a mirror", withRoom({ name: "her hallway mirror", at: "in her hallway" }), BANK_RULE.mirrorWord],
    ["a locative phrase that names a mirror", withRoom({ at: "at the mirror in her kitchen" }), BANK_RULE.mirrorWord],
    ["a place name over the pool text bound", withRoom({ name: "her small kitchen with the old blue cabinets" }), BANK_RULE.text],
    ["a place with three moments", withStreet({ moments: STREET.moments.slice(0, 3) }), BANK_RULE.moments],
    ["a place with a moment twice", withStreet({ moments: [...STREET.moments, { ...plain, text: "holds a takeaway coffee" }] }), BANK_RULE.duplicate],
    ["a messy-room moment outside a room", withStreet({ moments: [...STREET.moments, { ...plain, messyOk: true }] }), BANK_RULE.messyOk],
    ["a mirror capture at a place without a mirror", withStreet({ moments: [...STREET.moments, { ...plain, captures: ["mirror"] }] }), BANK_RULE.mirrorPlace],
    ["a place at the stored «studio lighting» time", withStreet({ times: ["studio lighting"] }), BANK_RULE.times],
    ["a place with no time", withStreet({ times: [] }), BANK_RULE.times],
    ["two places of one name", { ...BANK, places: [ROOM, { ...STREET, name: ROOM.name }] }, BANK_RULE.duplicate],
    ["a deck capture no moment takes", { ...BANK, captureDeck: [...BANK.captureDeck, "prone"] }, BANK_RULE.deckCoverage],
    ["a legs capture in the deck (5a.2c deals them apart)", { ...BANK, captureDeck: [...BANK.captureDeck, "pov-legs"] }, BANK_RULE.deck],
    ["an empty deck", { ...BANK, captureDeck: [] }, BANK_RULE.shape],
    ["an outfit with a youth word", { ...BANK, outfits: [{ text: "a schoolgirl skirt" }] }, BANK_RULE.youth],
    ["an outfit with a youth prop", { ...BANK, outfits: [{ text: "a hoodie with a plush toy" }] }, BANK_RULE.youthProp],
    ["an outfit over the pool text bound", { ...BANK, outfits: [{ text: "an oversized cream knit sweater and jeans" }] }, BANK_RULE.text],
    ["an outfit given twice", { ...BANK, outfits: [...BANK.outfits, { text: "a cozy hoodie" }] }, BANK_RULE.duplicate],
    ["denim shorts (the owner: never)", { ...BANK, outfits: [...BANK.outfits, { text: "a tee and denim shorts", showsLegs: true }] }, BANK_RULE.denim],
    ["a denim skirt (the owner: never)", { ...BANK, outfits: [...BANK.outfits, { text: "a crop top and a denim mini skirt", showsLegs: true }] }, BANK_RULE.denim],
    ["jean shorts (the owner: never)", { ...BANK, outfits: [...BANK.outfits, { text: "a tank top and jean shorts", showsLegs: true }] }, BANK_RULE.denim],
    ["legwear with a youth prop (K-17: striped thigh-highs stay out)", { ...BANK, legwear: { items: ["striped thigh-highs"], share: 0.4 } }, BANK_RULE.youthProp],
    ["legwear with no item", { ...BANK, legwear: { items: [], share: 0.4 } }, BANK_RULE.legwear],
    ["legwear on no slot", { ...BANK, legwear: { items: ["sheer black tights"], share: 0 } }, BANK_RULE.legwear],
    ["legwear on more than every slot", { ...BANK, legwear: { items: ["sheer black tights"], share: 1.5 } }, BANK_RULE.legwear],
    ["legwear with no outfit that shows her legs", { ...BANK, outfits: [{ text: "a grey lounge set" }] }, BANK_RULE.legwear],
  ];

  test.each(PLACE_ROWS)("refuses %s", (_name, bank, rule) => {
    expect(rulesOf(categoryBankProblems(bank, "home"))).toContain(rule);
  });

  test("refuses a deck mirror capture when no mirror place has a moment for it", () => {
    const noMirrorPlace: CategoryBank = { ...BANK, places: [{ ...ROOM, mirror: undefined, moments: MOMENTS.filter((m) => !m.captures.some((c) => c === "mirror" || c === "mirror-hidden")) }, STREET] };
    expect(rulesOf(categoryBankProblems(noMirrorPlace, "home"))).toContain(BANK_RULE.deckCoverage);
  });

  // K-17 (the owner's references reverse the old curation): these pass now; striped thigh-highs, plush toys, gaming props, pigtails, two braids and
  // space buns stay out (the rows above and the hairstyle rows below).
  test("K-17: knee-high socks, thigh-high socks and a pleated mini skirt are allowed", () => {
    const bank: CategoryBank = {
      ...BANK,
      outfits: [...BANK.outfits, { text: "a pleated mini skirt and fitted top", showsLegs: true }],
      legwear: { items: ["white knee-high socks", "black knee-high socks", "thigh-high socks", "sheer black tights"], share: 0.4 },
    };
    expect(categoryBankProblems(bank, "home")).toEqual([]);
  });

  test("Glamour is never on a bed (the owner's «вечер выхода»), and only Glamour is held to it", () => {
    const bedroom = withStreet({ name: "her bedroom before going out", at: "in her bedroom" });
    const bedMoment = withMoment({ ...plain, text: "sits on the edge of the bed" });
    expect(rulesOf(categoryBankProblems(bedroom, "glamour"))).toContain(BANK_RULE.glamourBed);
    expect(rulesOf(categoryBankProblems(bedMoment, "glamour"))).toContain(BANK_RULE.glamourBed);
    expect(categoryBankProblems(bedroom, "home")).toEqual([]);
    expect(categoryBankProblems(bedMoment, "home")).toEqual([]);
  });

  test("a malformed value is refused, never thrown", () => {
    expect(categoryBankProblems({ places: "none" }, "home").length).toBeGreaterThan(0);
    expect(categoryBankProblems(null, "home").length).toBeGreaterThan(0);
    expect(categoryBankProblems({ ...BANK, captureDeck: ["photographer"] }, "home").length).toBeGreaterThan(0);
  });
});

describe("the gaze bank", () => {
  const GAZE: readonly Gaze[] = [
    { text: "looking straight at the viewer", kind: "viewer" },
    { text: "looking off to the side", kind: "away" },
    { text: "glancing down", kind: "down" },
    { text: "her eyes on her hands", kind: "hands" },
    { text: "her eyes on her phone in the mirror", kind: "mirror", phone: true },
    { text: "checking her reflection", kind: "mirror" },
    { text: "giving the viewer a playful look", kind: "viewer", level: "flirty" },
  ];

  test("the fixture is valid", () => {
    expect(gazeBankProblems(GAZE)).toEqual([]);
  });

  const ROWS: Array<[string, Gaze, string]> = [
    ["a gaze that does not start as a gaze", { text: "she looks at the viewer", kind: "viewer" }, BANK_RULE.gazeGrammar],
    ["a gaze that names a camera", { text: "looking into the camera", kind: "viewer" }, BANK_RULE.camera],
    ["a gaze that names a lens", { text: "looking at the lens", kind: "viewer" }, BANK_RULE.camera],
    ["a gaze that names her phone without the flag", { text: "her eyes on her phone in the mirror", kind: "mirror" }, BANK_RULE.gazePhone],
    ["a phone flag on a gaze that names no phone", { text: "checking her reflection", kind: "mirror", phone: true }, BANK_RULE.gazePhone],
    ["a phone gaze that is not a mirror gaze", { text: "looking down at her phone", kind: "down", phone: true }, BANK_RULE.gazePhone],
    ["a phone gaze that does not say «in the mirror»", { text: "looking into the phone", kind: "mirror", phone: true }, BANK_RULE.gazePhone],
    ["a gaze that says selfie", { text: "checking her selfie", kind: "mirror" }, BANK_RULE.selfie],
    ["a viewer gaze that names no viewer", { text: "looking straight ahead", kind: "viewer" }, BANK_RULE.gazeViewer],
    ["an away gaze that names the viewer", { text: "looking past the viewer", kind: "away" }, BANK_RULE.gazeViewer],
    ["a gaze with a youth word", { text: "looking like a young girl", kind: "away" }, BANK_RULE.youth],
    ["a gaze over the pool text bound", { text: "looking at the viewer from under her lashes", kind: "viewer" }, BANK_RULE.text],
  ];

  test.each(ROWS)("refuses %s", (_name, gaze, rule) => {
    expect(rulesOf(gazeBankProblems([...GAZE, gaze]))).toContain(rule);
  });

  test("refuses a gaze given twice", () => {
    expect(rulesOf(gazeBankProblems([...GAZE, { text: "glancing down", kind: "down" }]))).toContain(BANK_RULE.duplicate);
  });
});

describe("the cue bank", () => {
  const CUES: readonly Cue[] = [{ text: "a relaxed smile" }, { text: "mid-laugh" }, { text: "one eyebrow raised", level: "flirty" }, { text: "a finger near her lips", captures: ["above", "prone"] }];

  test("the fixture is valid", () => {
    expect(cueBankProblems(CUES)).toEqual([]);
  });

  const ROWS: Array<[string, Cue, string]> = [
    ["a cue that is not a noun phrase or «mid-…»", { text: "smiling softly" }, BANK_RULE.cueGrammar],
    ["a sultry cue", { text: "a sultry smile" }, BANK_RULE.cueWord],
    ["a seductive cue", { text: "a seductive look", level: "flirty" }, BANK_RULE.cueWord],
    ["a sexy cue", { text: "a sexy pout", level: "flirty" }, BANK_RULE.cueWord],
    ["a cue that carries a gaze", { text: "a smile at the viewer" }, BANK_RULE.cueGaze],
    ["a cue with a youth word", { text: "an innocent smile" }, BANK_RULE.youth],
    ["a cue limited to no capture", { text: "a slight pout", captures: [] }, BANK_RULE.captures],
  ];

  test.each(ROWS)("refuses %s", (_name, cue, rule) => {
    expect(rulesOf(cueBankProblems([...CUES, cue]))).toContain(rule);
  });
});

describe("the hairstyle bank", () => {
  const HAIR: readonly Hairstyle[] = [
    { text: "tucked behind her ears", lengths: ["bob", "shoulder", "long"], tied: false },
    { text: "in a high ponytail", lengths: ["shoulder", "long"], tied: true },
    { text: "loose under a baseball cap", lengths: ["bob", "shoulder", "long"], tied: false, cap: true },
  ];

  test("the fixture is valid", () => {
    expect(hairBankProblems(HAIR)).toEqual([]);
  });

  const ROWS: Array<[string, Hairstyle, string]> = [
    ["a style that does not read after «Today her hair is»", { text: "she wears a bun", lengths: ["long"], tied: true }, BANK_RULE.hairGrammar],
    ["a style that names a hair colour", { text: "in a blonde braid", lengths: ["long"], tied: true }, BANK_RULE.hairColour],
    ["a style that names a colour at all", { text: "in a black claw clip", lengths: ["long"], tied: true }, BANK_RULE.hairColour],
    ["a style with a dye word", { text: "in a ponytail with highlights", lengths: ["long"], tied: true }, BANK_RULE.hairColour],
    ["pigtails", { text: "in pigtails", lengths: ["long"], tied: true }, BANK_RULE.youthProp],
    ["two braids", { text: "in two braids", lengths: ["long"], tied: true }, BANK_RULE.youthProp],
    ["space buns", { text: "in space buns", lengths: ["long"], tied: true }, BANK_RULE.youthProp],
    ["a tied cap", { text: "in a ponytail under a cap", lengths: ["long"], tied: true, cap: true }, BANK_RULE.hairCap],
    ["a style for no length", { text: "in a low bun", lengths: [], tied: true }, BANK_RULE.hairLengths],
  ];

  test.each(ROWS)("refuses %s", (_name, style, rule) => {
    expect(rulesOf(hairBankProblems([...HAIR, style]))).toContain(rule);
  });
});
