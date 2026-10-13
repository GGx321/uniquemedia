import { describe, expect, test } from "bun:test";
import { boldWordsIn, COVERS_HER, lingerieWordsIn, stockingWordsIn, swimwearWordsIn, withoutBoldExemptLook } from "./boldRules";
import { BANKS, validateBanks } from "./index";
import { BANK_RULE, boldBankProblems, boldOnlyHereProblems, categoryBankProblems } from "./schema";
import type { BankPlace, CategoryBank, Moment, Outfit } from "./types";

// 5a.3 (S5.9b2, plan s5a3 §6.4): the two «Смелая» banks validate against a schema of their own, chosen by category; the five built-ins keep theirs, which refuses every
// «Смелая»-only field. A valid «Смелая» fixture passes; then one row per «Смелая» rule breaks exactly that rule and must be refused with it (each a negative control).
// The «Смелая» vocabulary (lingerie, swimwear, stockings, satin, the babydoll) lives in banks/boldRules.ts and appears in no other bank.

const LINGERIE_COVER = "The lace is lined and opaque: her bra fully covers her breasts and her panties fully cover her.";

const MOMENTS: readonly Moment[] = [
  { text: "stands by the window", motion: "she shifts her weight a little", captures: ["mirror-hidden", "mirror", "timer"], twoHanded: false },
  { text: "leans on the doorframe", motion: "she shifts her shoulder slowly", captures: ["mirror", "timer"], twoHanded: false, level: "flirty" },
  { text: "stands with one hand on her hip", motion: "she turns her hips a little", captures: ["mirror-hidden", "mirror"], twoHanded: false, level: "bold", route: "seedream" },
  {
    text: "pulls her jeans up over her panties",
    motion: "she tugs the waistband up slowly",
    captures: ["mirror-hidden"],
    twoHanded: false,
    angle: "three-quarter",
    mirrorBack: true,
    level: "bold",
    route: "seedream",
    outfits: ["a crop top and jeans"],
    coverage: "Her panties fully cover her bottom, and her crop top covers her chest.",
  },
];

const ROOM: BankPlace = {
  name: "her small bedroom",
  at: "in her small bedroom",
  times: ["evening", "night"],
  room: true,
  lamp: true,
  mirror: true,
  details: ["a bedside lamp", "a plain wall behind her"],
  moments: MOMENTS,
};

const OUTFITS: readonly Outfit[] = [
  { text: "cotton pajama shorts and a tee", showsLegs: true },
  { text: "a long cotton nightshirt", showsLegs: true },
  { text: "a satin cami and satin shorts", showsLegs: true, level: "flirty", route: "seedream", coverage: "Her cami and shorts are opaque satin." },
  { text: "a black lace bra and panties", showsLegs: true, level: "bold", route: "seedream", coverage: LINGERIE_COVER },
  { text: "a white lace bra and panties", showsLegs: true, level: "bold", route: "seedream", coverage: LINGERIE_COVER },
  { text: "a lace bodysuit", showsLegs: true, level: "bold", route: "seedream", coverage: "Her bodysuit is lined and opaque over her chest and fully covers her hips." },
  { text: "a sheer babydoll over a lace set", showsLegs: true, level: "bold", route: "seedream", coverage: "Under her sheer babydoll, her lace bra and panties are lined and opaque and fully cover her." },
  { text: "a crop top and jeans", pinOnly: true, level: "bold", route: "seedream" },
];

const BOLD: CategoryBank = {
  bold: true,
  places: [ROOM],
  outfits: OUTFITS,
  legwear: { items: ["thigh-high socks"], share: 0.3, bold: { items: ["sheer black stockings"], share: 0.5, route: "seedream", outfits: ["a satin cami and satin shorts", "a black lace bra and panties"] } },
  captureDeck: ["mirror-hidden", "mirror", "timer"],
};

const plain: Moment = { text: "sits on the rug", motion: "she leans back a little", captures: ["timer"], twoHanded: false };
const withMoment = (moment: Moment): CategoryBank => ({ ...BOLD, places: [{ ...ROOM, moments: [...MOMENTS, moment] }] });
const withOutfits = (outfits: readonly Outfit[]): CategoryBank => ({ ...BOLD, outfits });
const replacing = (text: string, outfit: Outfit): CategoryBank => withOutfits(OUTFITS.map((o) => (o.text === text ? outfit : o)));

/** The legs moment of a fixture row: a look down her own legs, pinning four outfits across the levels. */
const LEGS: Moment = {
  text: "lies with her legs crossed",
  motion: "she crosses and uncrosses her ankles slowly",
  captures: ["pov-legs"],
  twoHanded: false,
  legs: { framing: "legs" },
  outfits: ["cotton pajama shorts and a tee", "a long cotton nightshirt", "a satin cami and satin shorts", "a satin midi nightdress"],
};
const MIDI: Outfit = { text: "a satin midi nightdress", showsLegs: true, level: "flirty", route: "seedream", coverage: "Her nightdress is opaque satin." };
const withLegs = (legs: Moment): CategoryBank => ({ ...withMoment(legs), outfits: [...OUTFITS, MIDI] });

/** A swimwear outfit and a water moment that pins it (the positive control of the water rule). */
const BIKINI: Outfit = { text: "a black bikini", showsLegs: true, level: "flirty", route: "seedream", coverage: "Her bikini top fully covers her breasts, and her bikini bottoms fully cover her." };
const WADES: Moment = { text: "stands waist-deep, looking back", motion: "she turns her head a little further", captures: ["timer"], twoHanded: false, angle: "three-quarter", gaze: "own", water: true, level: "flirty", outfits: ["a black bikini"] };
const withWater = (moment: Moment, outfits: readonly Outfit[] = [...OUTFITS, BIKINI]): CategoryBank => ({ ...withMoment(moment), outfits });
/** Review of S5.9b2: with her arms up the open shirt does not stay closed over her chest, so an arms-up moment never wears it. */
const OPEN_SHIRT: Outfit = {
  text: "an open white shirt and panties",
  showsLegs: true,
  level: "bold",
  route: "seedream",
  coverage: "The shirt's two edges fall over her chest and fully cover both breasts, leaving only a narrow gap of skin down the middle; her panties fully cover her.",
};
const ARMS_UP: Moment = { ...plain, text: "stretches after waking up", motion: "she stretches her arms up slowly", captures: ["timer"] };
const withArmsUp = (moment: Moment): CategoryBank => ({ ...withMoment(moment), outfits: [...OUTFITS, OPEN_SHIRT] });
/** S5.R4: a cropped tee rides up with her arms raised, as the open shirt falls open. */
const CROPPED_TEE: Outfit = { text: "a cropped tee and cotton panties", showsLegs: true, level: "bold", route: "seedream", coverage: "Her tee covers her chest, and her panties fully cover her." };
const withCroppedTee = (moment: Moment): CategoryBank => ({ ...withMoment(moment), outfits: [...OUTFITS, CROPPED_TEE] });
/** S5.9c round 3: a place at the edge of the sea, whose every moment is wet; and a strap action with the outfits that do and do not have straps. */
const EDGE: BankPlace = { name: "the water's edge", at: "at the edge of the sea", times: ["midday"], details: ["a driftwood log", "a few seashells"], moments: [] };
const WET = (text: string, motion: string): Moment => ({ ...WADES, text, motion, angle: undefined, gaze: undefined });
const EDGE_FILLERS: readonly Moment[] = [WET("steps into the water", "she steps in slowly"), WET("stands in the shallows", "she shifts her weight a little"), WET("stands waist-deep", "she rocks a little in place")];
const withEdge = (moment: Moment, outfits: readonly Outfit[] = [...OUTFITS, BIKINI]): CategoryBank => ({ ...BOLD, outfits, places: [ROOM, { ...EDGE, moments: [moment, ...EDGE_FILLERS] }] });
const STRAPLESS: Outfit = { text: "a strapless bandeau bikini", showsLegs: true, level: "bold", route: "seedream", coverage: "Her bikini top fully covers her breasts, and her bikini bottoms fully cover her." };
const SWEATSHIRT: Outfit = { text: "bikini bottoms and a sweatshirt", showsLegs: true, level: "flirty", route: "seedream", coverage: "Her sweatshirt covers her chest, and her bikini bottoms fully cover her." };
const STRAP: Moment = { ...plain, text: "adjusts the strap on her shoulder", motion: "she slides the strap up a little", level: "flirty", outfits: ["a satin cami and satin shorts", "a black lace bra and panties"] };
const withStraps = (moment: Moment, outfits: readonly Outfit[] = [...OUTFITS, STRAPLESS]): CategoryBank => ({ ...withMoment(moment), outfits });
const SARONG: Outfit = { text: "a bikini and a sarong", showsLegs: true, route: "seedream", coverage: "Her bikini top fully covers her breasts, and her bikini bottoms fully cover her." };

/** The rule ids a bank breaks (each problem is `[rule] text`). */
const rulesOf = (problems: readonly string[]): string[] => [...new Set(problems.map((p) => /^\[([a-z-]+)\]/.exec(p)?.[1] ?? p))];

// S5.R4 round 2 (re-review, LOW): what reads as a cover over her, both ways. A blanket she lies or sits on covers nothing; pulling the covers up or snuggling into the duvet does.
// The sheet she holds to her chest is the bedsheet moment's outfit, never a cover over one.
describe("COVERS_HER: a moment under a cover", () => {
  test.each([
    "lies curled up under the duvet",
    "curls up with a blanket",
    "she pulls the blanket a little closer",
    "she pulls the duvet up a little",
    "she pulls the covers up",
    "snuggles into the duvet",
    "sits wrapped in a blanket",
    "dozes under the sheets",
    // S5.R4 round 3: a cover laid over her.
    "sits back, the blanket over her legs",
  ])("«%s» is under a cover", (text) => {
    expect(COVERS_HER.test(text)).toBe(true);
  });

  test.each([
    "sits on a picnic blanket",
    "lies on the blanket",
    "stretches out on the duvet",
    "lies holding the sheet to her chest",
    "she pulls the sheet a little higher",
    "sits with her legs tucked under her",
    // S5.R4 round 3: a cover word that is not the head of its phrase covers nothing.
    "sits with a throw pillow",
    "poses with a quilted jacket",
    "stands in her plaid shirt",
  ])("«%s» is not", (text) => {
    expect(COVERS_HER.test(text)).toBe(false);
  });
});

describe("the «Смелая» vocabulary (banks/boldRules.ts)", () => {
  test("names lingerie, swimwear, stockings, satin and the babydoll, by whole word", () => {
    expect(boldWordsIn("a black lace bra and panties")).toEqual(["bra", "panties"]);
    expect(boldWordsIn("a white string bikini")).toEqual(["bikini"]);
    expect(boldWordsIn("sheer black stockings")).toEqual(["stockings"]);
    expect(boldWordsIn("a satin cami and satin shorts")).toEqual(["satin", "satin"]);
    expect(boldWordsIn("a sheer babydoll over a lace set")).toEqual(["babydoll"]);
    expect(boldWordsIn("a one-piece swimsuit")).toEqual(["swimsuit"]);
    expect(boldWordsIn("a lace bodysuit")).toEqual(["bodysuit"]);
  });

  test("leaves the everyday words alone: a bracelet, a zebra, a briefcase, a bralette-free tee, sheer tights", () => {
    expect(boldWordsIn("a briefcase and a bracelet, a zebra print scarf, sheer black tights, thigh-high socks")).toEqual([]);
  });

  test("tells lingerie, swimwear and stockings apart", () => {
    expect(lingerieWordsIn("a black bra and briefs")).toEqual(["bra", "briefs"]);
    expect(lingerieWordsIn("a black bikini")).toEqual([]);
    expect(swimwearWordsIn("a bikini and a sarong")).toEqual(["bikini"]);
    expect(swimwearWordsIn("a satin cami")).toEqual([]);
    expect(stockingWordsIn("white lace-top stockings")).toEqual(["stockings"]);
  });

  test("the satin nightwear phrases are taken out for the soft look list, and only they: «satin» alone stays", () => {
    expect(withoutBoldExemptLook("a satin slip nightdress")).not.toMatch(/satin/);
    expect(withoutBoldExemptLook("a satin midi nightdress")).not.toMatch(/satin/);
    expect(withoutBoldExemptLook("a satin cami and satin shorts")).not.toMatch(/satin/);
    expect(withoutBoldExemptLook("a short tied satin robe")).not.toMatch(/satin/);
    expect(withoutBoldExemptLook("satin pajamas")).toMatch(/satin/);
    expect(withoutBoldExemptLook("a satin dress")).toMatch(/satin/);
  });
});

describe("a «Смелая» bank", () => {
  test("the fixture is valid (the rows below each break one rule of it)", () => {
    expect(boldBankProblems(BOLD)).toEqual([]);
  });

  test("a legs moment over the levels and a water moment in swimwear are valid too (the positive controls of bold-legs and water)", () => {
    expect(boldBankProblems(withLegs(LEGS))).toEqual([]);
    // S5.R4 round 3: by the mirror, the phone over her face.
    expect(boldBankProblems(withLegs({ ...LEGS, captures: ["mirror-hidden"] }))).toEqual([]);
    expect(boldBankProblems(withWater(WADES))).toEqual([]);
  });

  test("an arms-up moment that pins outfits other than the open shirt is valid, in a bank that has the shirt (the positive control of bold-arms-up)", () => {
    expect(boldBankProblems(withArmsUp({ ...ARMS_UP, outfits: ["cotton pajama shorts and a tee", "a satin cami and satin shorts", "a black lace bra and panties"] }))).toEqual([]);
  });

  test("a moment that stretches her legs is no arms-up moment: it may draw the open shirt, in a bank that has it (the arms-up pattern is about arms)", () => {
    expect(boldBankProblems(withArmsUp({ ...plain, text: "stretches her legs on the rug", motion: "she points and flexes her toes slowly" }))).toEqual([]);
    expect(boldBankProblems(withArmsUp({ ...plain, text: "stretches her feet out", motion: "she wiggles her toes a little" }))).toEqual([]);
  });

  test("the text and the motion are read apart for arms up: a stretch in the text is not cancelled by the toes in the motion", () => {
    expect(rulesOf(boldBankProblems(withArmsUp({ ...plain, text: "stretches out on the bed", motion: "she points her toes slowly" })))).toContain(BANK_RULE.boldArmsUp);
  });

  test("a strap action that pins only outfits with straps is valid, and so is a wet moment at the edge of the sea (the positive controls of strap and water)", () => {
    expect(boldBankProblems(withStraps(STRAP))).toEqual([]);
    expect(boldBankProblems(withEdge({ ...WADES, text: "stretches her arms out, knee-deep", gaze: undefined, angle: "profile", outfits: ["a black bikini"] }))).toEqual([]);
  });

  // S5.R4: the negative control of bold-covered. A covering moment that pins only what is not bold is valid; a moment on the duvet, not under it, covers nothing.
  test("a moment under a cover that pins only ordinary and flirty outfits is valid, and a moment on the duvet is no covering one", () => {
    expect(boldBankProblems(withMoment({ ...plain, text: "lies curled up under the duvet", outfits: ["cotton pajama shorts and a tee", "a satin cami and satin shorts"] }))).toEqual([]);
    expect(boldBankProblems(withMoment({ ...plain, text: "sits on the duvet" }))).toEqual([]);
  });

  test("an arms-up moment is valid in a bank with no open shirt, pinned or not", () => {
    expect(boldBankProblems(withMoment(ARMS_UP))).toEqual([]);
  });

  // S5.R4 round 3: a «Смелая» moment may say details of its own; the five's schema has no such field.
  test("a moment outside a room may say 2 or 3 details of its own; the five's schema refuses the field", () => {
    const own: Moment = { ...WADES, text: "stands in the shallows, smiling", motion: "she smiles a little", gaze: undefined, angle: undefined, expression: true, details: ["some wet sand", "a little white foam"] };
    expect(boldBankProblems(withEdge(own))).toEqual([]);
    expect(categoryBankProblems({ ...BANKS.home, places: BANKS.home.places.map((p, i) => (i === 0 ? { ...p, moments: p.moments.map((m, j) => (j === 0 ? { ...m, details: ["a kettle", "a mug"] } : m)) } : p)) }, "home").join("\n")).toMatch(/\[shape\].*Unrecognized key: "details"/);
  });

  test("holds the babydoll garment name, which the youth rule refuses everywhere else (answer (b))", () => {
    expect(rulesOf(categoryBankProblems({ ...BANKS.home, outfits: [...BANKS.home.outfits, { text: "a sheer babydoll over a lace set" }] }, "home"))).toContain(BANK_RULE.youth);
    expect(boldBankProblems(BOLD)).toEqual([]);
  });

  const ROWS: Array<[string, CategoryBank, string]> = [
    // bold-route
    ["a lingerie outfit with no route", replacing("a lace bodysuit", { text: "a lace bodysuit", showsLegs: true, level: "bold", coverage: "Her bodysuit is lined and opaque over her chest and fully covers her hips." }), BANK_RULE.boldRoute],
    ["a satin outfit with no route", replacing("a satin cami and satin shorts", { text: "a satin cami and satin shorts", showsLegs: true, level: "flirty", coverage: "Her cami and shorts are opaque satin." }), BANK_RULE.boldRoute],
    ["a bold outfit with no «Смелая» word and no route", withOutfits([...OUTFITS, { text: "an open white shirt", showsLegs: true, level: "bold", coverage: "Her shirt covers her chest." }]), BANK_RULE.boldRoute],
    ["a route on an ordinary cotton outfit", replacing("a long cotton nightshirt", { text: "a long cotton nightshirt", showsLegs: true, route: "seedream", coverage: "Her nightshirt covers her." }), BANK_RULE.boldRoute],
    ["a bold moment with no route", withMoment({ ...plain, level: "bold" }), BANK_RULE.boldRoute],
    ["a moment that names a «Смелая» garment with no route", withMoment({ ...plain, text: "sits on the rug in her panties", level: "bold" }), BANK_RULE.boldRoute],
    // bold-coverage
    ["a Seedream outfit with no coverage", replacing("a lace bodysuit", { text: "a lace bodysuit", showsLegs: true, level: "bold", route: "seedream" }), BANK_RULE.boldCoverage],
    ["a pin-only Seedream outfit pinned by a moment with no coverage", withMoment({ ...plain, text: "sits on the rug", level: "bold", route: "seedream", outfits: ["a crop top and jeans"] }), BANK_RULE.boldCoverage],
    ["a coverage sentence over 200 characters", replacing("a lace bodysuit", { text: "a lace bodysuit", showsLegs: true, level: "bold", route: "seedream", coverage: `Her bodysuit is lined and opaque over her chest and fully covers her hips${", and it stays opaque".repeat(8)}.` }), BANK_RULE.boldCoverage],
    ["a coverage of two sentences", replacing("a lace bodysuit", { text: "a lace bodysuit", showsLegs: true, level: "bold", route: "seedream", coverage: "Her bodysuit is lined. It fully covers her hips." }), BANK_RULE.boldCoverage],
    ["a coverage with no closing period", replacing("a lace bodysuit", { text: "a lace bodysuit", showsLegs: true, level: "bold", route: "seedream", coverage: "Her bodysuit is lined and opaque" }), BANK_RULE.boldCoverage],
    ["a negated coverage (it names what must not show)", replacing("a lace bodysuit", { text: "a lace bodysuit", showsLegs: true, level: "bold", route: "seedream", coverage: "Her bodysuit is not see-through." }), BANK_RULE.boldCoverage],
    ["a coverage «without» a garment", replacing("a lace bodysuit", { text: "a lace bodysuit", showsLegs: true, level: "bold", route: "seedream", coverage: "She wears it without anything under it." }), BANK_RULE.boldCoverage],
    ["a coverage on an item that is not drawn on Seedream", replacing("a long cotton nightshirt", { text: "a long cotton nightshirt", showsLegs: true, coverage: "Her nightshirt covers her." }), BANK_RULE.boldCoverage],
    ["a coverage that is not plain ASCII", replacing("a lace bodysuit", { text: "a lace bodysuit", showsLegs: true, level: "bold", route: "seedream", coverage: "Her bodysuit is lined — and opaque." }), BANK_RULE.boldCoverage],
    // bold-levels
    ["fewer than four bold outfits", withOutfits(OUTFITS.filter((o) => o.text !== "a lace bodysuit" && o.text !== "a sheer babydoll over a lace set")), BANK_RULE.boldLevels],
    ["no ordinary outfit, so an ordinary slot has nothing to wear", withOutfits(OUTFITS.filter((o) => o.level !== undefined)), BANK_RULE.boldLevels],
    // S5.9c round 2: a moment of a level pins an outfit a slot of that level may wear, or the planner throws at compose (fit.ts `pinnedAt`).
    ["an ordinary moment that pins only a bold outfit (an ordinary slot has nothing to wear in it)", withMoment({ ...plain, text: "sits on the floor", outfits: ["a black lace bra and panties"] }), BANK_RULE.boldLevels],
    ["a flirty moment that pins only bold outfits", withMoment({ ...plain, text: "sits on the floor", level: "flirty", outfits: ["a black lace bra and panties", "a lace bodysuit"] }), BANK_RULE.boldLevels],
    ["a legs moment that pins only flirty and bold outfits (an ordinary legs slot has nothing to wear)", withLegs({ ...LEGS, outfits: ["a satin cami and satin shorts", "a satin midi nightdress", "a lace bodysuit", "a black lace bra and panties"] }), BANK_RULE.boldLevels],
    // bold-legs
    ["a legs moment that pins three outfits", withLegs({ ...LEGS, outfits: LEGS.outfits?.slice(0, 3) ?? [] }), BANK_RULE.boldLegs],
    ["a legs moment that pins no ordinary outfit (an ordinary legs slot has nothing to wear)", withLegs({ ...LEGS, outfits: ["a satin cami and satin shorts", "a satin midi nightdress", "a black lace bra and panties", "a white lace bra and panties"] }), BANK_RULE.boldLegs],
    ["a legs moment that pins lingerie (P-5a3 #6: refused; a bold legs slot is satin and stockings)", withLegs({ ...LEGS, outfits: [...(LEGS.outfits ?? []), "a black lace bra and panties"] }), BANK_RULE.boldLegs],
    ["a low-feet moment (no friend crouches at her feet in a «Смелая» bank)", withLegs({ ...LEGS, captures: ["pov-legs", "low-feet"] }), BANK_RULE.boldLegs],
    // S5.R4 round 3 (re-review, HIGH): a «Смелая» legs frame by the mirror hides her face (plan s5a3 §6.2): the plain mirror selfie showed it, and the face gate only marks a legs
    // frame, never judges it. (Round 2 had it the other way round; the assembler now gives the phone-over-face legs frame a pose phrase that says nothing of her face.)
    ["a legs moment on the plain mirror selfie, her face clear", withLegs({ ...LEGS, captures: ["mirror"] }), BANK_RULE.boldLegs],
    // bold-arms-up (review of S5.9b2)
    ["an arms-up moment that pins no outfit, so it can draw the open shirt", withArmsUp(ARMS_UP), BANK_RULE.boldArmsUp],
    ["an arms-up moment that pins the open shirt", withArmsUp({ ...ARMS_UP, outfits: ["cotton pajama shorts and a tee", OPEN_SHIRT.text] }), BANK_RULE.boldArmsUp],
    ["a moment whose motion stretches her arms up, pinning nothing", withArmsUp({ ...plain, text: "stands by the bed", motion: "she stretches slowly and smiles" }), BANK_RULE.boldArmsUp],
    // S5.R4: a cropped tee or a crop top rides up with her arms raised (the review: «lies back with her arms up» in «a cropped tee and cotton panties», 24 frames).
    ["an arms-up moment that pins no outfit, in a bank whose general draw has a cropped tee", withCroppedTee(ARMS_UP), BANK_RULE.boldArmsUp],
    ["an arms-up moment that pins a cropped tee", withCroppedTee({ ...ARMS_UP, outfits: ["cotton pajama shorts and a tee", CROPPED_TEE.text] }), BANK_RULE.boldArmsUp],
    ["an arms-up moment that pins a crop top", withMoment({ ...ARMS_UP, outfits: ["cotton pajama shorts and a tee", "a crop top and jeans"] }), BANK_RULE.boldArmsUp],
    // bold-covered (S5.R4): under a duvet or a blanket a bold outfit is hidden, and the 2K frame is paid for nothing.
    ["a moment under the duvet that pins no outfit, so a bold slot draws lingerie under it", withMoment({ ...plain, text: "lies curled up under the duvet" }), BANK_RULE.boldCovered],
    ["a moment with a blanket that pins a bold outfit", withMoment({ ...plain, text: "curls up with a blanket", outfits: ["a long cotton nightshirt", "a black lace bra and panties"] }), BANK_RULE.boldCovered],
    ["a moment whose motion pulls a blanket over her, pinning nothing", withMoment({ ...plain, motion: "she pulls the blanket a little closer" }), BANK_RULE.boldCovered],
    // S5.R4 round 2: a bold slot takes no moment under a cover (engine/scenes/fit.ts), so a capture whose only moment at «Смелая» is one has nothing for a bold slot.
    [
      "a timer frame whose only moment is under a cover (a bold slot takes none)",
      {
        ...BOLD,
        places: [
          {
            ...ROOM,
            moments: [
              ...MOMENTS.map((m) => ({ ...m, captures: m.captures.filter((c) => c !== "timer") })),
              { ...plain, text: "curls up with a blanket", outfits: ["cotton pajama shorts and a tee", "a satin cami and satin shorts"] },
            ],
          },
        ],
      },
      BANK_RULE.boldLevels,
    ],
    // S5.R4 round 3: a moment's own details are held to the place details' rules.
    ["a moment of a room with details of its own (a room says them in its room phrase)", withMoment({ ...plain, details: ["a bedside lamp", "a plain wall behind her"] }), BANK_RULE.details],
    ["a moment with one detail of its own", withEdge({ ...WADES, text: "stands in the shallows, smiling", motion: "she smiles a little", gaze: undefined, angle: undefined, expression: true, details: ["some wet sand"] }), BANK_RULE.details],
    ["a moment's own detail that names its place's phrase again", withEdge({ ...WADES, text: "stands in the shallows, smiling", motion: "she smiles a little", gaze: undefined, angle: undefined, expression: true, details: ["some wet sand", "the sea behind her"] }), BANK_RULE.detailRepeat],
    ["a moment's own detail that does not open with an article", withEdge({ ...WADES, text: "stands in the shallows, smiling", motion: "she smiles a little", gaze: undefined, angle: undefined, expression: true, details: ["wet sand", "a little white foam"] }), BANK_RULE.detailGrammar],
    // water
    ["a water moment that pins no outfit", withWater({ ...WADES, outfits: undefined }), BANK_RULE.water],
    ["a water moment that pins an outfit that is not swimwear", withWater({ ...WADES, outfits: ["a black bikini", "a long cotton nightshirt"] }), BANK_RULE.water],
    // Review round 2: in the water nothing is worn over the swimwear, a legs moment's feet in the water included.
    ["a water moment that pins a bikini under a sarong", withWater({ ...WADES, outfits: ["a black bikini", SARONG.text] }, [...OUTFITS, BIKINI, SARONG]), BANK_RULE.water],
    [
      "a legs moment in the water that pins a bikini under a sarong",
      withWater({ ...LEGS, text: "dangles her feet in the water", water: true, outfits: [BIKINI.text, SARONG.text] }, [...OUTFITS, BIKINI, SARONG, MIDI]),
      BANK_RULE.water,
    ],
    ["a moment in the water without the water tag", withWater({ ...WADES, water: undefined }), BANK_RULE.water],
    ["a moment of feet in the water without the water tag", withMoment({ ...plain, text: "sits with her feet in the water" }), BANK_RULE.water],
    // S5.9c round 3: «along the edge» of a pool reads as in it, and a place at the edge of the sea is wet whatever its moment says.
    ["a moment along the edge of a pool without the water tag", withMoment({ ...plain, text: "stretches one arm along the edge" }), BANK_RULE.water],
    ["a dry moment at the edge of the sea (the prompt would say «at the edge of the sea … in a sweatshirt»)", withEdge({ ...plain, text: "fixes her hair with one hand", hair: "own" }), BANK_RULE.water],
    // strap: an action on a strap never meets an outfit without shoulder straps.
    ["a strap action that pins no outfit (the general draw has strapless ones)", withStraps({ ...STRAP, outfits: undefined }), BANK_RULE.strap],
    ["a strap action that pins a strapless outfit", withStraps({ ...STRAP, outfits: ["a satin cami and satin shorts", STRAPLESS.text] }), BANK_RULE.strap],
    ["a strap action in the motion only, pinning nothing", withStraps({ ...STRAP, text: "adjusts her top", outfits: undefined }), BANK_RULE.strap],
    ["a strap action in the motion only, pinning a strapless outfit", withStraps({ ...STRAP, text: "adjusts her top", outfits: ["a satin cami and satin shorts", STRAPLESS.text] }), BANK_RULE.strap],
    ["a strap action that pins a tube top", withStraps({ ...STRAP, outfits: ["a satin cami and satin shorts", "a white tube top and a sarong"] }, [...OUTFITS, { ...SWEATSHIRT, text: "a white tube top and a sarong" }]), BANK_RULE.strap],
    ["a strap action that pins an off-shoulder top", withStraps({ ...STRAP, outfits: ["a satin cami and satin shorts", "an off-shoulder top and a sarong"] }, [...OUTFITS, { ...SWEATSHIRT, text: "an off-shoulder top and a sarong" }]), BANK_RULE.strap],
    ["a strap action that pins a hoodie", withStraps({ ...STRAP, outfits: ["a satin cami and satin shorts", "a hoodie and a sarong"] }, [...OUTFITS, { ...SWEATSHIRT, text: "a hoodie and a sarong" }]), BANK_RULE.strap],
    // water, class closers: the place's own words, a depth other than waist-deep, and a wade said only in the motion.
    ["a dry moment at a place that is in the shallows", { ...BOLD, places: [ROOM, { ...EDGE, name: "a sandbar", at: "in the shallows", moments: [["sits on a log", "she leans back a little"], ["stands by a post", "she shifts her weight a little"], ["leans on a post", "she rocks a little in place"], ["sits on a bench", "she swings one foot slowly"]].map(([text = "", motion = ""]) => ({ ...plain, text, motion })) }] }, BANK_RULE.water],
    ["a moment knee-deep without the water tag", withMoment({ ...plain, text: "stands knee-deep" }), BANK_RULE.water],
    ["a moment ankle-deep without the water tag", withMoment({ ...plain, text: "stands ankle-deep" }), BANK_RULE.water],
    ["a moment that wades into the water only in its motion", withMoment({ ...plain, text: "stands facing the horizon", motion: "she wades into the water slowly" }), BANK_RULE.water],
    ["a strap action that pins a bikini with a sweatshirt and no top", withStraps({ ...STRAP, outfits: ["a satin cami and satin shorts", "bikini bottoms and a sweatshirt"] }, [...OUTFITS, STRAPLESS, SWEATSHIRT]), BANK_RULE.strap],
    // legwear
    ["stockings among the ordinary legwear", { ...BOLD, legwear: { items: ["thigh-high socks", "sheer black stockings"], share: 0.3, bold: { items: ["sheer black stockings"], share: 0.5, route: "seedream", outfits: ["a satin cami and satin shorts", "a black lace bra and panties"] } } }, BANK_RULE.legwear],
    ["socks among the bold legwear (it holds the stockings)", { ...BOLD, legwear: { items: ["thigh-high socks"], share: 0.3, bold: { items: ["white knee-high socks"], share: 0.5, route: "seedream", outfits: ["a satin cami and satin shorts", "a black lace bra and panties"] } } }, BANK_RULE.legwear],
    ["bold legwear on no slot", { ...BOLD, legwear: { items: ["thigh-high socks"], share: 0.3, bold: { items: ["sheer black stockings"], share: 0, route: "seedream", outfits: ["a satin cami and satin shorts", "a black lace bra and panties"] } } }, BANK_RULE.legwear],
    ["bold legwear with no item", { ...BOLD, legwear: { items: ["thigh-high socks"], share: 0.3, bold: { items: [], share: 0.5, route: "seedream", outfits: ["a satin cami and satin shorts", "a black lace bra and panties"] } } }, BANK_RULE.legwear],
    // Review round 2, MEDIUM 4: the stockings go with the outfits the bold legwear names, and those are Seedream outfits that show her legs, never the cotton nightwear.
    ["stockings that go with the cotton nightwear", { ...BOLD, legwear: { items: ["thigh-high socks"], share: 0.3, bold: { items: ["sheer black stockings"], share: 0.5, route: "seedream", outfits: ["cotton pajama shorts and a tee"] } } }, BANK_RULE.legwear],
    ["stockings that go with an outfit the bank does not have", { ...BOLD, legwear: { items: ["thigh-high socks"], share: 0.3, bold: { items: ["sheer black stockings"], share: 0.5, route: "seedream", outfits: ["a satin slip nightdress"] } } }, BANK_RULE.legwear],
    ["stockings that go with no outfit", { ...BOLD, legwear: { items: ["thigh-high socks"], share: 0.3, bold: { items: ["sheer black stockings"], share: 0.5, route: "seedream", outfits: [] } } }, BANK_RULE.legwear],
    // A bank written before the field: malformed on purpose, so its type is widened here.
    ["bold legwear that names no outfit at all", { ...BOLD, legwear: { items: ["thigh-high socks"], share: 0.3, bold: { items: ["sheer black stockings"], share: 0.5, route: "seedream" } } } as unknown as CategoryBank, BANK_RULE.shape],
    ["a legs moment that pins no outfit the stockings go with (a bold legs slot would wear none)", { ...withLegs(LEGS), legwear: { items: ["thigh-high socks"], share: 0.3, bold: { items: ["sheer black stockings"], share: 0.5, route: "seedream", outfits: ["a black lace bra and panties"] } } }, BANK_RULE.boldLegs],
    ["stockings in an outfit (they are the bold legwear's only)", withOutfits([...OUTFITS, { text: "a slip and black stockings", showsLegs: true, level: "bold", route: "seedream", coverage: "Her slip is opaque." }]), BANK_RULE.legwear],
    // the shape
    ["a bank that is not marked «Смелая»", { ...BOLD, bold: undefined }, BANK_RULE.shape],
    ["a route other than Seedream", replacing("a lace bodysuit", { text: "a lace bodysuit", showsLegs: true, level: "bold", route: "grok" as "seedream", coverage: "Her bodysuit is opaque." }), BANK_RULE.shape],
    ["a level past bold", withMoment({ ...plain, level: "explicit" as "bold", route: "seedream" }), BANK_RULE.shape],
    // main's C3′ load rules hold the «Смелая» banks too (the rebase onto fix/c3-prompts: bottom-fabric, away-action with the walk-away ban, back-glance)
    ["shorts named without their fabric", withOutfits([...OUTFITS, { text: "a satin cami and shorts", showsLegs: true, level: "flirty", route: "seedream", coverage: "Her cami and shorts are opaque satin." }]), BANK_RULE.bottomFabric],
    ["a moment from behind that names no action", withMoment({ ...plain, text: "sits facing the window", angle: "back" }), BANK_RULE.awayAction],
    ["a moment from behind that walks away", withMoment({ ...plain, text: "walks away, hands in her pockets", angle: "back" }), BANK_RULE.awayAction],
    ["a glance back over her shoulder seen from behind", withMoment({ ...plain, text: "looks back over her shoulder", angle: "back", gaze: "own" }), BANK_RULE.backGlance],
    // the common rules hold here too
    ["a youth word in an outfit", withOutfits([...OUTFITS, { text: "a schoolgirl set", level: "bold", route: "seedream", coverage: "It covers her." }]), BANK_RULE.youth],
    ["«baby» next to the exempt garment", withOutfits([...OUTFITS, { text: "a baby blue babydoll", level: "bold", route: "seedream", coverage: "Her babydoll is opaque." }]), BANK_RULE.youth],
    ["denim shorts", withOutfits([...OUTFITS, { text: "a bra and denim shorts", showsLegs: true, level: "bold", route: "seedream", coverage: "Her bra fully covers her breasts." }]), BANK_RULE.denim],
    ["a moment over the pool text bound", withMoment({ ...plain, text: "sits on the rug by the bed for a long while" }), BANK_RULE.text],
    ["a deck capture no ordinary moment takes", { ...BOLD, captureDeck: [...BOLD.captureDeck, "prone"] }, BANK_RULE.deckCoverage],
  ];

  test.each(ROWS)("refuses %s", (_name, bank, rule) => {
    expect(rulesOf(boldBankProblems(bank))).toContain(rule);
  });

  test("a malformed value is refused, never thrown", () => {
    expect(boldBankProblems(null).length).toBeGreaterThan(0);
    expect(boldBankProblems({ ...BOLD, places: "none" }).length).toBeGreaterThan(0);
  });
});

describe("the five built-ins keep their own schema, which refuses every «Смелая»-only field (negative controls)", () => {
  const home = BANKS.home;
  const firstPlace = home.places[0] as BankPlace;
  const withHomeMoment = (patch: Partial<Moment>): CategoryBank => ({ ...home, places: [{ ...firstPlace, moments: firstPlace.moments.map((m, i) => (i === 0 ? { ...m, ...patch } : m)) }, ...home.places.slice(1)] });
  const withHomeOutfit = (patch: Partial<Outfit>): CategoryBank => ({ ...home, outfits: home.outfits.map((o, i) => (i === 0 ? { ...o, ...patch } : o)) });

  test("the five pass their schema as they are", () => {
    for (const [category, bank] of Object.entries(BANKS)) if (bank.bold !== true) expect(categoryBankProblems(bank, category as "home"), category).toEqual([]);
  });

  test.each<[string, CategoryBank]>([
    ["a bold moment", withHomeMoment({ level: "bold" })],
    ["a moment's route", withHomeMoment({ route: "seedream" })],
    ["a moment's coverage", withHomeMoment({ coverage: "It covers her." })],
    ["a water moment", withHomeMoment({ water: true })],
    ["an outfit's level", withHomeOutfit({ level: "flirty" })],
    ["an outfit's route", withHomeOutfit({ route: "seedream" })],
    ["an outfit's coverage", withHomeOutfit({ coverage: "It covers her." })],
    ["the «Смелая» mark", { ...home, bold: true }],
    ["bold legwear", { ...home, legwear: { items: ["thigh-high socks"], share: 0.4, bold: { items: ["sheer black stockings"], share: 0.5, route: "seedream", outfits: ["a crop top and pajama shorts"] } } }],
  ])("refuses %s", (_name, bank) => {
    expect(rulesOf(categoryBankProblems(bank, "home"))).toContain(BANK_RULE.shape);
  });
});

describe("bold-only-here: the «Смелая» vocabulary appears in no ordinary bank", () => {
  const home = BANKS.home;
  const firstPlace = home.places[0] as BankPlace;

  test("the five name none of it", () => {
    for (const [category, bank] of Object.entries(BANKS)) if (bank.bold !== true) expect(boldOnlyHereProblems(bank), category).toEqual([]);
  });

  test.each<[string, CategoryBank]>([
    ["a satin outfit", { ...home, outfits: [...home.outfits, { text: "a satin cami and satin shorts" }] }],
    ["a bikini in a moment", { ...home, places: [{ ...firstPlace, moments: [...firstPlace.moments, { text: "packs her bikini", motion: "she folds it slowly", captures: ["timer"], twoHanded: false }] }, ...home.places.slice(1)] }],
    ["stockings in a motion", { ...home, places: [{ ...firstPlace, moments: [...firstPlace.moments, { text: "sits on the rug", motion: "she smooths her stockings slowly", captures: ["timer"], twoHanded: false }] }, ...home.places.slice(1)] }],
    ["panties in a detail", { ...home, places: [{ ...firstPlace, details: ["a pair of panties on the chair", "a bedside lamp"] }, ...home.places.slice(1)] }],
    ["a babydoll among the legwear", { ...home, legwear: { items: ["a babydoll", "thigh-high socks"], share: 0.4 } }],
  ])("refuses %s in an ordinary bank", (_name, bank) => {
    expect(rulesOf(boldOnlyHereProblems(bank))).toEqual([BANK_RULE.boldOnlyHere]);
  });

  test("validateBanks holds the five to it", () => {
    expect(() => validateBanks({ banks: { ...BANKS, home: { ...home, outfits: [...home.outfits, { text: "a black bikini" }] } } })).toThrow(/home: \[bold-only-here\]/);
  });
});
