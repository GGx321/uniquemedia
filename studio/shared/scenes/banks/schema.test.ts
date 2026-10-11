import { describe, expect, test } from "bun:test";
import { BANK_RULE, categoryBankProblems, cueBankProblems, gazeBankProblems, hairBankProblems, MOMENT_VERBS } from "./schema";
import type { BankPlace, CategoryBank, Cue, Gaze, Hairstyle, Moment } from "./types";

// 5a.2 (S5.6a, I5.21): the banks are validated with zod when they load, so a malformed bank is a test failure, never a production surprise. A valid
// fixture passes; then one row per rule breaks exactly that rule and must be refused with it. The engine-only word lists (revealing, the paper and
// staging lists) are swept in engine/scenes/banks.sweep.test.ts, which may import the engine.

const MOMENTS: readonly Moment[] = [
  { text: "waits for the kettle", twoHanded: false },
  { text: "slices fruit on a cutting board", twoHanded: true, gaze: "focus" },
  { text: "laughs at something on her phone", twoHanded: false, phone: true, gaze: "own" },
  { text: "looks back over her shoulder", twoHanded: false, angle: "three-quarter", gaze: "own" },
  { text: "brushes her hair", twoHanded: false, hair: "own", messyOk: true },
];

const ROOM: BankPlace = {
  name: "her small kitchen",
  at: "in her small kitchen",
  times: ["morning", "midday"],
  room: true,
  details: ["a kettle on the counter", "a fruit bowl"],
  moments: MOMENTS,
};

const STREET: BankPlace = {
  name: "a narrow old-town street",
  at: "on a narrow old-town street",
  times: ["morning"],
  mirror: true,
  details: ["a bicycle against a wall", "some flower pots on a windowsill"],
  moments: [
    { text: "holds a takeaway coffee", twoHanded: false, outdoor: true },
    { text: "walks past old stone houses", twoHanded: false, outdoor: true },
    { text: "eats a gelato from a cone", twoHanded: false, outdoor: true },
    { text: "walks away down the street", twoHanded: false, angle: "back", outdoor: true },
  ],
};

const BANK: CategoryBank = { places: [ROOM, STREET], outfits: ["a grey lounge set", "a cozy hoodie"], shotDeck: ["friend", "selfie", "mirror", "candid", "friend"] };

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
    ["a moment that does not start with a pinned verb", { text: "waiting for the kettle", twoHanded: false }, BANK_RULE.momentVerb],
    ["a moment that is not a verb phrase at all", { text: "a quiet moment", twoHanded: false }, BANK_RULE.momentVerb],
    ["a moment that names «she»", { text: "waits while she yawns", twoHanded: false }, BANK_RULE.momentShe],
    ["a moment over the pool text bound", { text: "waits for the kettle to boil on the stove", twoHanded: false }, BANK_RULE.text],
    ["a moment with a youth word", { text: "holds a tiny cup", twoHanded: false }, BANK_RULE.youth],
    ["a moment with a youth prop", { text: "holds a plush toy", twoHanded: false }, BANK_RULE.youthProp],
    ["a moment that names a hair colour", { text: "brushes her blonde hair", twoHanded: false, hair: "own" }, BANK_RULE.hairColour],
    ["a phone flag on a moment that names no phone", { text: "waits for the coffee", twoHanded: false, phone: true, gaze: "own" }, BANK_RULE.momentPhone],
    ["a moment that names her phone without the flag", { text: "scrolls through her phone", twoHanded: false, gaze: "own" }, BANK_RULE.momentPhone],
    ["a phone moment without its own gaze", { text: "scrolls through her phone", twoHanded: false, phone: true }, BANK_RULE.phoneGaze],
    ["a moment that says selfie", { text: "takes a quick selfie", twoHanded: false }, BANK_RULE.selfie],
    ["a moment that names her hair without the own-hair tag", { text: "tucks her hair behind her ear", twoHanded: false }, BANK_RULE.momentHair],
    ["an own-hair tag on a moment that names no hair", { text: "sips her coffee", twoHanded: false, hair: "own" }, BANK_RULE.momentHair],
    ["a moment that names a camera", { text: "smiles at the camera", twoHanded: false, gaze: "viewer" }, BANK_RULE.camera],
    ["a moment that looks at the viewer without the viewer tag", { text: "smiles at the viewer", twoHanded: false }, BANK_RULE.momentViewer],
    ["a moment that looks somewhere without carrying its gaze", { text: "looks out of the window", twoHanded: false }, BANK_RULE.momentGaze],
    ["a viewer tag on a moment that names no viewer", { text: "sips her coffee", twoHanded: false, gaze: "viewer" }, BANK_RULE.momentViewer],
    ["a back moment that looks at the viewer", { text: "turns to the viewer", twoHanded: false, gaze: "viewer", angle: "back" }, BANK_RULE.backViewer],
    ["a legs moment that names no footwear", { text: "stretches her legs out", twoHanded: false, legs: { framing: "legs", shots: ["friend"] } }, BANK_RULE.legsFootwear],
    ["a legs moment with bare feet", { text: "slips off her heels, barefoot", twoHanded: false, legs: { framing: "legs", shots: ["friend"] } }, BANK_RULE.legsFootwear],
    ["a legs moment with no shot", { text: "laces up her sneakers", twoHanded: true, legs: { framing: "legs", shots: [] } }, BANK_RULE.legsShots],
    ["a moment that names a mirror and may land on any shot", { text: "sits on the floor by the mirror", twoHanded: false }, BANK_RULE.mirrorWord],
    ["a mirror moment that may land on a friend's snap", { text: "sits on the floor by the mirror", twoHanded: false, captures: ["mirror", "friend"] }, BANK_RULE.mirrorWord],
    ["a moment limited to no capture", { text: "leans on the wall", twoHanded: false, captures: [] }, BANK_RULE.captures],
  ];

  test.each(MOMENT_ROWS)("refuses %s", (_name, moment, rule) => {
    expect(rulesOf(categoryBankProblems(withMoment(moment), "home"))).toContain(rule);
  });

  const PLACE_ROWS: Array<[string, CategoryBank, string]> = [
    ["a place with one detail", withStreet({ details: ["a bicycle against a wall"] }), BANK_RULE.details],
    ["a place with four details", withStreet({ details: ["a bicycle against a wall", "a cat on a step", "a red door", "a lamp post"] }), BANK_RULE.details],
    ["a detail that is not a noun phrase with its article", withRoom({ details: ["makeup on the counter", "a fruit bowl"] }), BANK_RULE.detailGrammar],
    ["a detail over the pool text bound", withStreet({ details: ["a bicycle leaning against the old wall", "a cat"] }), BANK_RULE.text],
    ["a locative phrase without its preposition", withRoom({ at: "her small kitchen" }), BANK_RULE.at],
    ["a place name that names a mirror", withRoom({ name: "her hallway mirror", at: "in her hallway" }), BANK_RULE.mirrorWord],
    ["a locative phrase that names a mirror", withRoom({ at: "at the mirror in her kitchen" }), BANK_RULE.mirrorWord],
    ["a place with three moments", withStreet({ moments: STREET.moments.slice(0, 3) }), BANK_RULE.moments],
    [
      "a place where no moment fits every shot and pose",
      withStreet({
        moments: [
          { text: "carries two shopping bags", twoHanded: true, outdoor: true },
          { text: "checks a map on her phone", twoHanded: false, phone: true, gaze: "own", outdoor: true },
          { text: "walks away down the street", twoHanded: false, angle: "back", outdoor: true },
          { text: "turns to the viewer and waves", twoHanded: false, gaze: "viewer", outdoor: true },
        ],
      }),
      BANK_RULE.anyShot,
    ],
    ["a place with a moment twice", withStreet({ moments: [...STREET.moments, { text: "holds a takeaway coffee", twoHanded: false }] }), BANK_RULE.duplicate],
    ["a messy-room moment outside a room", withStreet({ moments: [...STREET.moments, { text: "sits on the kerb", twoHanded: false, messyOk: true }] }), BANK_RULE.messyOk],
    ["a place at the stored «studio lighting» time", withStreet({ times: ["studio lighting"] }), BANK_RULE.times],
    ["a place with no time", withStreet({ times: [] }), BANK_RULE.times],
    ["two places of one name", { ...BANK, places: [ROOM, { ...STREET, name: ROOM.name }] }, BANK_RULE.duplicate],
    ["a mirror in the deck with no mirror place", { ...BANK, places: [ROOM, { ...STREET, mirror: undefined }] }, BANK_RULE.mirrorPlace],
    ["an outfit with a youth word", { ...BANK, outfits: ["a schoolgirl skirt"] }, BANK_RULE.youth],
    ["an outfit with a youth prop", { ...BANK, outfits: ["a pleated mini skirt"] }, BANK_RULE.youthProp],
    ["an outfit over the pool text bound", { ...BANK, outfits: ["an oversized cream knit sweater and jeans"] }, BANK_RULE.text],
  ];

  test.each(PLACE_ROWS)("refuses %s", (_name, bank, rule) => {
    expect(rulesOf(categoryBankProblems(bank, "home"))).toContain(rule);
  });

  test("Glamour is never on a bed (the owner's «вечер выхода»), and only Glamour is held to it", () => {
    const bedroom = withStreet({ name: "her bedroom before going out", at: "in her bedroom" });
    const bedMoment = withMoment({ text: "sits on the edge of the bed", twoHanded: false });
    expect(rulesOf(categoryBankProblems(bedroom, "glamour"))).toContain(BANK_RULE.glamourBed);
    expect(rulesOf(categoryBankProblems(bedMoment, "glamour"))).toContain(BANK_RULE.glamourBed);
    expect(categoryBankProblems(bedroom, "home")).toEqual([]);
    expect(categoryBankProblems(bedMoment, "home")).toEqual([]);
  });

  // The owner's style references (2026-10-11): the bank carries hooks the probe's content will fill. A moment may name the captures it fits (the stored
  // shots and the new kinds), its posture, and a place the lights it fits; a category may carry legwear. None of them is drawn yet.
  test("carries the reference hooks: captures, posture, lights, legwear", () => {
    const hooked: CategoryBank = {
      ...withMoment({ text: "sits on the floor by the mirror", twoHanded: false, captures: ["mirror", "mirror-face-hidden"], posture: "sitting" }),
      legwear: [{ text: "sheer black tights", status: "probe" }],
    };
    const lit: CategoryBank = { ...hooked, places: hooked.places.map((p) => ({ ...p, lights: ["evening-lamp"] })) };
    expect(categoryBankProblems(lit, "home")).toEqual([]);
  });

  test("refuses a light the light bank does not have", () => {
    expect(rulesOf(categoryBankProblems(withRoom({ lights: ["disco-ball"] }), "home"))).toContain(BANK_RULE.lightRef);
  });

  test("refuses legwear with a youth prop (I5.29: knee socks, striped thigh-highs)", () => {
    expect(rulesOf(categoryBankProblems({ ...BANK, legwear: [{ text: "white knee socks", status: "probe" }] }, "home"))).toContain(BANK_RULE.youthProp);
    expect(rulesOf(categoryBankProblems({ ...BANK, legwear: [{ text: "striped thigh-highs", status: "probe" }] }, "home"))).toContain(BANK_RULE.youthProp);
  });

  test("a moment that fits only a capture not drawn yet does not count as the place's moment for every shot", () => {
    const onlyHooked: Moment[] = [
      { text: "carries two shopping bags", twoHanded: true },
      { text: "lies on the bed, legs up", twoHanded: false, captures: ["selfie-above"], posture: "lying" },
      { text: "walks away down the street", twoHanded: false, angle: "back" },
      { text: "checks a map on her phone", twoHanded: false, phone: true, gaze: "own" },
    ];
    expect(rulesOf(categoryBankProblems(withStreet({ moments: onlyHooked }), "home"))).toContain(BANK_RULE.anyShot);
  });

  test("a malformed value is refused, never thrown", () => {
    expect(categoryBankProblems({ places: "none" }, "home").length).toBeGreaterThan(0);
    expect(categoryBankProblems(null, "home").length).toBeGreaterThan(0);
  });
});

describe("the gaze bank", () => {
  const GAZE: readonly Gaze[] = [
    { text: "looking straight at the viewer", kind: "viewer" },
    { text: "looking off to the side", kind: "away" },
    { text: "glancing down", kind: "down" },
    { text: "her eyes on what her hands are doing", kind: "hands" },
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
  ];

  test.each(ROWS)("refuses %s", (_name, gaze, rule) => {
    expect(rulesOf(gazeBankProblems([...GAZE, gaze]))).toContain(rule);
  });

  test("refuses a gaze given twice", () => {
    expect(rulesOf(gazeBankProblems([...GAZE, GAZE[0] as Gaze]))).toContain(BANK_RULE.duplicate);
  });
});

describe("the cue bank", () => {
  const CUES: readonly Cue[] = [{ text: "a relaxed smile" }, { text: "mid-laugh" }, { text: "one eyebrow raised", level: "flirty" }];

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
