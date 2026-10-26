import { describe, expect, test } from "bun:test";
import { tierOfGarment } from "./boldRules";
import { BANKS } from "./index";
import { BANK_RULE, boldAnyProblems, boldBankProblems, type BoldAnyKind } from "./schema";
import type { BankPlace, CategoryBank, Moment, Outfit } from "./types";

// 5a.4 (S5.BA2, plan s5a4 §5.1.1, §5.2, §5.4, §5.5, §8 BA2; r2.1 N3, r2.2 P6): the rules «Смелая» on every category adds. A valid fixture passes; then each rule has a row that
// breaks exactly it (a negative control), and the rows that must pass (a passing beach with its water places, a villa's pool whose every moment pins swimwear, a towel with its
// descriptive open coverage, underwear joining satin on a legs frame now that L1 drew).

const LACE = "The lace is lined and opaque: her bra fully covers her breasts and her panties fully cover her.";
const THONG = "The lace is lined and opaque: her bra fully covers her breasts and her thong fully covers her in front.";
const BIKINI = "Her bikini top fully covers her breasts, and her bikini bottoms fully cover her.";
const SWIMSUIT = "Her swimsuit fully covers her chest and her hips.";
/** P-BA V2 drew the sheet with this sentence; the sheet has no open item in the probe, so every avatar says it (P5). */
const SHEET = "The white sheet is pulled up to her chest and fully covers her breasts and her hips.";
const TOWEL = "The towel is wrapped around her and tucked in above her chest, and it fully covers her down to her thighs.";
/** P-BA B1 drew the towel with this sentence on Anna (a Studio-created avatar). */
const TOWEL_OPEN = "The towel is wrapped around her, tucked in above her chest.";

const SWIMWEAR = ["a one-piece swimsuit", "a black bikini", "a red triangle bikini"];
const LEGS_PINS = ["a satin cami and satin shorts", "a satin midi nightdress", "a short tied satin robe", "a tee and cotton panties"];

const OUTFITS: readonly Outfit[] = [
  { text: "a tee and cotton panties", showsLegs: true, route: "seedream", coverage: "Her tee covers her chest, and her panties fully cover her." },
  { text: "a satin cami and satin shorts", showsLegs: true, route: "seedream", coverage: "Her cami and shorts are opaque satin." },
  { text: "a black lace bra and panties", showsLegs: true, level: "flirty", route: "seedream", coverage: LACE },
  { text: "a satin midi nightdress", showsLegs: true, level: "flirty", route: "seedream", coverage: "Her nightdress is opaque satin." },
  { text: "a short tied satin robe", showsLegs: true, level: "flirty", route: "seedream", coverage: "Her robe is tied and closed over her chest." },
  { text: "a lace bodysuit", showsLegs: true, level: "bold", route: "seedream", coverage: "Her bodysuit is lined and opaque over her chest and fully covers her hips." },
  { text: "a sheer babydoll over a lace set", showsLegs: true, level: "bold", route: "seedream", coverage: "Under her sheer babydoll, her lace bra and panties are lined and opaque and fully cover her." },
  { text: "a white lace bra and a thong", showsLegs: true, level: "bold", route: "seedream", coverage: THONG },
  {
    text: "an open white shirt and panties",
    showsLegs: true,
    level: "bold",
    route: "seedream",
    coverage: "The shirt's two edges fall over her chest and fully cover both breasts, leaving only a narrow gap of skin down the middle; her panties fully cover her.",
  },
  { text: "only the white bedsheet", pinOnly: true, level: "bold", route: "seedream", tier: "implied" },
  // Swimwear in a bank with a room: worn only where a water place's moment pins it, so it leaves the general draw; and with no legwear by the pool.
  { text: "a one-piece swimsuit", pinOnly: true, route: "seedream", coverage: SWIMSUIT },
  { text: "a black bikini", pinOnly: true, level: "flirty", route: "seedream", coverage: BIKINI },
  { text: "a red triangle bikini", pinOnly: true, level: "bold", route: "seedream", coverage: BIKINI },
];

const SHEET_MOMENT: Moment = {
  text: "lies with the sheet up to her chest",
  motion: "she pulls the sheet a little higher",
  captures: ["above"],
  twoHanded: false,
  level: "bold",
  route: "seedream",
  tier: "implied",
  outfits: ["only the white bedsheet"],
  coverage: SHEET,
  openCoverage: SHEET,
};

const LEGS: Moment = { text: "lies with her legs crossed", motion: "she slides one ankle over the other slowly", captures: ["pov-legs"], twoHanded: false, legs: { framing: "legs" }, outfits: LEGS_PINS };

const ROOM: BankPlace = {
  name: "her small bedroom",
  at: "in her small bedroom",
  times: ["evening", "night"],
  room: true,
  lamp: true,
  mirror: true,
  details: ["a bedside lamp", "a plain wall behind her"],
  moments: [
    { text: "stands by the window", motion: "she shifts her weight a little", captures: ["mirror-hidden", "mirror", "timer"], twoHanded: false },
    { text: "leans on the doorframe", motion: "she shifts her shoulder slowly", captures: ["mirror", "timer"], twoHanded: false, level: "flirty" },
    { text: "stands with one hand on her hip", motion: "she turns her hips a little", captures: ["mirror-hidden", "mirror"], twoHanded: false, level: "bold", route: "seedream" },
    { text: "lies back on the pillows", motion: "she slowly turns her head", captures: ["above"], twoHanded: false },
    SHEET_MOMENT,
    LEGS,
  ],
};

const POOL: BankPlace = {
  name: "the villa's pool",
  at: "by the villa's own pool",
  times: ["midday", "golden hour"],
  water: true,
  details: ["two palm trees", "a striped umbrella"],
  moments: [
    { text: "sits on the side, toes in the water", motion: "she swirls her toes slowly", captures: ["timer"], twoHanded: false, water: true, outfits: SWIMWEAR, outdoor: true },
    { text: "lies back on a sun lounger", motion: "she tilts her face up a little", captures: ["timer"], twoHanded: false, outfits: SWIMWEAR, outdoor: true },
    { text: "leans on the side in the water", motion: "she kicks her feet slowly", captures: ["timer"], twoHanded: true, water: true, outfits: SWIMWEAR, outdoor: true },
    { text: "sits on a lounger, knees together", motion: "she sways her knees a little", captures: ["timer"], twoHanded: false, level: "bold", route: "seedream", outfits: SWIMWEAR, outdoor: true },
  ],
};

const FIXTURE: CategoryBank = {
  bold: true,
  places: [ROOM, POOL],
  outfits: OUTFITS,
  legwear: {
    items: ["thigh-high socks"],
    share: 0.3,
    bold: { items: ["sheer black stockings"], share: 0.5, route: "seedream", outfits: ["a satin cami and satin shorts", "a satin midi nightdress", "a black lace bra and panties"] },
  },
  captureDeck: ["mirror-hidden", "mirror", "timer", "above"],
};

const rulesOf = (problems: readonly string[]): string[] => [...new Set(problems.map((p) => /^\[([a-z-]+)\]/.exec(p)?.[1] ?? p))];
const problems = (bank: CategoryBank, kind: BoldAnyKind = "nightwear", others: readonly CategoryBank[] = []): string[] => boldAnyProblems(bank, kind, others);

const withOutfits = (outfits: readonly Outfit[]): CategoryBank => ({ ...FIXTURE, outfits });
const replacing = (text: string, outfit: Outfit): CategoryBank => withOutfits(OUTFITS.map((o) => (o.text === text ? outfit : o)));
const roomWith = (moments: readonly Moment[]): BankPlace => ({ ...ROOM, moments });
const withRoomMoment = (text: string, moment: Moment): CategoryBank => ({ ...FIXTURE, places: [roomWith(ROOM.moments.map((m) => (m.text === text ? moment : m))), POOL] });
const withPoolMoment = (text: string, moment: Moment): CategoryBank => ({ ...FIXTURE, places: [ROOM, { ...POOL, moments: POOL.moments.map((m) => (m.text === text ? moment : m)) }] });
const withPlaces = (places: readonly BankPlace[]): CategoryBank => ({ ...FIXTURE, places });

/** Beach as shipped: its five places are water places (S5.BA2). */
const BEACH_AT_THE_WATER: CategoryBank = { ...BANKS.beach, places: BANKS.beach.places.map((p) => ({ ...p, water: true })) };

describe("the fixture and the passing rows", () => {
  test("the fixture is valid under the 5a.3 rules and the 5a.4 ones", () => {
    expect(boldBankProblems(FIXTURE)).toEqual([]);
    expect(problems(FIXTURE)).toEqual([]);
  });

  test("bold-floor and water pass beach as shipped, its 12 general swimwear outfits at its five water places", () => {
    expect(BEACH_AT_THE_WATER.outfits.filter((o) => o.pinOnly !== true)).toHaveLength(12);
    expect(problems(BEACH_AT_THE_WATER, "beach")).toEqual([]);
  });

  test("a villa's pool whose every moment, the lounger included, pins swimwear passes (r2.1 N3)", () => {
    expect(POOL.moments.every((m) => (m.outfits ?? []).every((o) => SWIMWEAR.includes(o)))).toBe(true);
    expect(rulesOf(problems(FIXTURE))).not.toContain(BANK_RULE.boldFloor);
  });

  test("an implied towel says its descriptive open coverage (P-BA B1), shorter than its kept one", () => {
    const towel: Moment = { ...SHEET_MOMENT, text: "lies back, wrapped in a towel", motion: "she tucks the towel in a little", outfits: ["only a white bath towel"], coverage: TOWEL, openCoverage: TOWEL_OPEN };
    const bank = { ...withRoomMoment(SHEET_MOMENT.text, towel), outfits: [...OUTFITS.filter((o) => o.text !== "only the white bedsheet"), { text: "only a white bath towel", pinOnly: true as const, level: "bold" as const, route: "seedream" as const, tier: "implied" as const }] };
    expect(problems(bank)).toEqual([]);
  });

  test("plain underwear joins satin on a legs frame (P-BA L1 drew the sports set; plain cotton too), lace stays out", () => {
    expect(LEGS.outfits).toContain("a tee and cotton panties");
    expect(rulesOf(problems(FIXTURE))).not.toContain(BANK_RULE.boldLegs);
  });

  test.each<[string]>([["on her balcony"], ["on the balcony of her hotel room, over the rooftops"], ["by the window of her hotel room"], ["on the terrace of her villa"], ["by the villa's own pool"]])(
    "bold-private takes a private place that is not a room: «%s»",
    (at) => {
      const place: BankPlace = { ...POOL, name: "the spot", at, water: undefined, moments: POOL.moments.map((m) => ({ ...m, water: undefined, text: m.text.replace(/in the water|toes in the water/, "on the step") })) };
      expect(rulesOf(problems(withPlaces([ROOM, place]), "nightwear"))).not.toContain(BANK_RULE.boldPrivate);
    },
  );
});

describe("the tier table (r2.2 P6)", () => {
  test.each<[string, "ordinary" | "flirty" | "bold"]>([
    ["a sports bra and a thong", "bold"],
    ["a black lace bra and panties", "flirty"],
    ["a satin cami and satin shorts", "ordinary"],
    ["a sheer babydoll over a lace set", "bold"],
    ["a one-piece swimsuit", "ordinary"],
    ["a white string bikini", "bold"],
    ["a lace bodysuit", "bold"],
    ["an open white shirt and panties", "bold"],
    ["a white lace bra and a thong", "bold"],
    ["a lace bralette and briefs", "flirty"],
    ["a satin slip nightdress", "flirty"],
    ["a short tied satin robe", "flirty"],
    ["a tee and cotton panties", "ordinary"],
    ["a cropped tee and cotton panties", "ordinary"],
    ["a cotton bra and briefs", "ordinary"],
    ["a black bra and briefs", "ordinary"],
    ["a black bra and jeans", "ordinary"],
    ["a crop top, panties and jeans", "ordinary"],
    ["a sports bra and seamless briefs", "ordinary"],
    ["a black bikini", "flirty"],
    ["bikini bottoms and a sweatshirt", "flirty"],
    ["a bikini and a sarong", "ordinary"],
    ["a bikini under a linen shirt", "ordinary"],
    ["a sporty bikini", "ordinary"],
    ["a strapless bandeau bikini", "bold"],
    ["a high-leg black swimsuit", "bold"],
  ])("«%s» is %s", (text, tier) => {
    expect(tierOfGarment({ text })).toBe(tier);
  });

  test("an implied cover is bold, and a garment the table does not know has no tier", () => {
    expect(tierOfGarment({ text: "only the white bedsheet", tier: "implied" })).toBe("bold");
    expect(tierOfGarment({ text: "silk pajamas" })).toBeNull();
    expect(tierOfGarment({ text: "grey jersey lounge shorts and a tee" })).toBeNull();
  });

  test("beach as shipped passes the tier table", () => {
    expect(rulesOf(problems(BEACH_AT_THE_WATER, "beach"))).not.toContain(BANK_RULE.tierTable);
  });
});

describe("each 5a.4 rule refuses the row that breaks it", () => {
  const coverless = (o: Outfit): Outfit => ({ ...o });
  const ROWS: Array<[string, CategoryBank, BoldAnyKind, string]> = [
    // bold-floor (I5.71, r2.1 N3)
    ["«silk pajamas» in the general draw", withOutfits([...OUTFITS, { text: "silk pajamas", route: "seedream", level: "bold", coverage: "Her pajamas are opaque." }]), "nightwear", BANK_RULE.boldFloor],
    ["a swimwear outfit in the general draw of a bank that has a room", replacing("a black bikini", { text: "a black bikini", level: "flirty", route: "seedream", coverage: BIKINI }), "nightwear", BANK_RULE.boldFloor],
    ["a lingerie outfit pinned at a water place", withPoolMoment("lies back on a sun lounger", { ...POOL.moments[1] as Moment, outfits: [...SWIMWEAR, "a black lace bra and panties"] }), "nightwear", BANK_RULE.boldFloor],
    ["a lounger at the villa's pool that pins no swimwear (the general draw's lingerie would reach it)", withPoolMoment("lies back on a sun lounger", { ...POOL.moments[1] as Moment, outfits: undefined }), "nightwear", BANK_RULE.boldFloor],
    ["a room's moment that pins swimwear (swimwear is worn at the water only)", withRoomMoment("stands by the window", { ...ROOM.moments[0] as Moment, outfits: ["a tee and cotton panties", "a black bikini"] }), "nightwear", BANK_RULE.boldFloor],
    // water-place
    ["a place whose phrase names a pool, without the water tag", withPlaces([ROOM, { ...POOL, water: undefined }]), "nightwear", BANK_RULE.waterPlace],
    ["a room tagged as a water place", withPlaces([{ ...ROOM, water: true }, POOL]), "nightwear", BANK_RULE.waterPlace],
    ["beach, its places without the water tag", { ...BANKS.beach, places: BANKS.beach.places.map((p) => ({ ...p, water: undefined })) }, "beach", BANK_RULE.waterPlace],
    // bold-all-seedream
    ["an outfit on the owner's model", withOutfits([...OUTFITS, { text: "a grey hoodie and cotton briefs", showsLegs: true }]), "nightwear", BANK_RULE.boldAllSeedream],
    // open-coverage
    ["an open coverage on an item with no kept one", withRoomMoment("stands by the window", { ...ROOM.moments[0] as Moment, openCoverage: "Her tee is soft." }), "nightwear", BANK_RULE.openCoverage],
    ["an open coverage longer than its kept one", replacing("a lace bodysuit", { ...coverless(OUTFITS[5] as Outfit), openCoverage: "Her lace bodysuit is lined over her chest and sits smooth over her hips and her waist." }), "nightwear", BANK_RULE.openCoverage],
    ["an open coverage that says an exposure word", replacing("a lace bodysuit", { ...coverless(OUTFITS[5] as Outfit), openCoverage: "Her sheer lace bodysuit hugs her hips." }), "nightwear", BANK_RULE.openCoverage],
    ["an open coverage that negates", replacing("a lace bodysuit", { ...coverless(OUTFITS[5] as Outfit), openCoverage: "Nothing covers her hips." }), "nightwear", BANK_RULE.openCoverage],
    ["an open coverage of two sentences", replacing("a lace bodysuit", { ...coverless(OUTFITS[5] as Outfit), openCoverage: "Her bodysuit is lace. It is black." }), "nightwear", BANK_RULE.openCoverage],
    ["the sheet saying a shorter open coverage (P-BA drew it with the kept one only)", withRoomMoment(SHEET_MOMENT.text, { ...SHEET_MOMENT, openCoverage: "The white sheet is pulled up to her chest." }), "nightwear", BANK_RULE.openCoverage],
    ["the sheet with no open coverage (an implied cover says what covers her to every avatar)", withRoomMoment(SHEET_MOMENT.text, { ...SHEET_MOMENT, openCoverage: undefined }), "nightwear", BANK_RULE.openCoverage],
    // implied
    ["an implied outfit at flirty", replacing("only the white bedsheet", { text: "only the white bedsheet", pinOnly: true, level: "flirty", route: "seedream", tier: "implied" }), "nightwear", BANK_RULE.implied],
    ["an implied outfit in the general draw", replacing("only the white bedsheet", { text: "only the white bedsheet", level: "bold", route: "seedream", tier: "implied", coverage: SHEET }), "nightwear", BANK_RULE.implied],
    ["an implied moment that pins an outfit that is not implied", withRoomMoment(SHEET_MOMENT.text, { ...SHEET_MOMENT, outfits: ["only the white bedsheet", "a lace bodysuit"] }), "nightwear", BANK_RULE.implied],
    ["a moment that is not implied pinning the implied outfit", withRoomMoment(SHEET_MOMENT.text, { ...SHEET_MOMENT, tier: undefined }), "nightwear", BANK_RULE.implied],
    ["an implied moment below bold", withRoomMoment(SHEET_MOMENT.text, { ...SHEET_MOMENT, level: "flirty" }), "nightwear", BANK_RULE.implied],
    // bold-levels, without the implied items: a capture whose only bold answer is the implied cover leaves an imported avatar's bold slot with nothing.
    [
      "an above frame whose only bold answer is the sheet",
      withRoomMoment("lies back on the pillows", { text: "lies curled up under the duvet", motion: "she pulls the duvet up a little", captures: ["above"], twoHanded: false, outfits: ["a tee and cotton panties", "a satin cami and satin shorts"] }),
      "nightwear",
      BANK_RULE.boldLevels,
    ],
    // bold-private (I5.72)
    ["a place at a cafe terrace in town", withPlaces([ROOM, { ...POOL, name: "the cafe terrace", at: "on a cafe terrace in town", water: undefined, moments: POOL.moments.map((m) => ({ ...m, water: undefined, text: m.text.replace(/in the water|toes in the water/, "on the step") })) }]), "nightwear", BANK_RULE.boldPrivate],
    ["a place on a park bench", withPlaces([ROOM, { ...POOL, name: "a park bench", at: "on a park bench", water: undefined, moments: POOL.moments.map((m) => ({ ...m, water: undefined, text: m.text.replace(/in the water|toes in the water/, "on the step") })) }]), "companion", BANK_RULE.boldPrivate],
    // moment-unique
    ["a moment given twice over two places", withPlaces([ROOM, { ...POOL, moments: [...POOL.moments, { ...(ROOM.moments[3] as Moment), captures: ["timer"] }] }]), "companion", BANK_RULE.momentUnique],
    ["a moment of the beach bank", withPoolMoment("lies back on a sun lounger", { ...(POOL.moments[1] as Moment), text: "lies back on a sun lounger" }), "companion", BANK_RULE.momentUnique],
    // companion-size
    ["a companion of two places and ten moments", FIXTURE, "companion", BANK_RULE.companionSize],
    ["a «rooms» bank of ten moments", FIXTURE, "rooms", BANK_RULE.companionSize],
    ["a «by the water» bank with a legs moment and an implied cover", FIXTURE, "water", BANK_RULE.companionSize],
    // tier-table
    ["a lace set at bold", replacing("a black lace bra and panties", { ...(OUTFITS[2] as Outfit), level: "bold" }), "nightwear", BANK_RULE.tierTable],
    ["a thong at flirty", replacing("a white lace bra and a thong", { ...(OUTFITS[7] as Outfit), level: "flirty" }), "nightwear", BANK_RULE.tierTable],
    ["a garment the table does not know", withOutfits([...OUTFITS, { text: "a grey hoodie and cotton briefs", showsLegs: true, route: "seedream", level: "bold", coverage: "Her hoodie covers her." }]), "nightwear", BANK_RULE.tierTable],
    // bold-legs (the satin legs frame of the companions and nightwear)
    ["a legs moment with fewer than three satin outfits", withRoomMoment(LEGS.text, { ...LEGS, outfits: ["a satin cami and satin shorts", "a satin midi nightdress", "a tee and cotton panties", "a black bra and briefs"] }), "nightwear", BANK_RULE.boldLegs],
    ["a legs moment with no ordinary satin outfit", withRoomMoment(LEGS.text, { ...LEGS, outfits: ["a satin midi nightdress", "a short tied satin robe", "a satin slip nightdress", "a tee and cotton panties"] }), "nightwear", BANK_RULE.boldLegs],
    ["a legs moment that pins lace (lace stays out after L1)", withRoomMoment(LEGS.text, { ...LEGS, outfits: [...LEGS_PINS, "a black lace bra and panties"] }), "nightwear", BANK_RULE.boldLegs],
  ];

  test.each(ROWS)("%s", (_name, bank, kind, rule) => {
    const others = rule === BANK_RULE.momentUnique ? [BANKS.beach] : [];
    expect(rulesOf(problems(bank, kind, others))).toContain(rule);
  });
});
