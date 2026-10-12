import { NO_STRAPS } from "./boldRules";
import type { CategoryBank, Outfit } from "./types";

// «Пляж и бассейн» (`beach`, 5a.3, plan s5a3 §6.3, answer (a) of the owner), a «Смелая» bank: drawn only under «Подача: Смелая». At the beach and the pool she
// mostly asks someone (a friend three times in six, a candid), sometimes a selfie or the phone on a timer (I5.32); she lies on her stomach only on her bed, so
// never here. Swimwear on every frame: every outfit is swimwear, drawn on Seedream at 2K (Grok refused bikinis 2/2) with its coverage sentence, and every moment
// in the water or at its edge pins it (M6); the level picks the cut, the pose and the gaze. The beach probe drew the compositions (4/4, «Пляж тоже хороший»):
// waist-deep looking back, looking back over her shoulder at the rooftop pool, from behind on the rocks; P-5a3 #5 drew the waist-deep frame in a bikini and a
// straw hat. Every moment but the legs ones is outdoors, so a cap may go to one of them.

const BIKINI = "Her bikini top fully covers her breasts, and her bikini bottoms fully cover her.";
const SWIMSUIT = "Her swimsuit fully covers her chest and her hips.";
/** Review round 2: a high-leg cut shows her hips, so its sentence says what it does cover. */
const HIGH_LEG = "Her swimsuit fully covers her chest and her bottom.";

/**
 * In the water she wears a swimsuit or a bikini of every level: no shirt, sweatshirt or sarong in the sea. A hat is no garment over the swimwear, and the waist-deep moment adds the
 * bikini and straw hat P-5a3 #5 drew her in.
 */
const IN_THE_WATER = ["a one-piece swimsuit", "a sporty bikini", "a black bikini", "a white bikini", "a white string bikini", "a red triangle bikini", "a strapless bandeau bikini", "a high-leg black swimsuit"];
/** A legs frame (M5): six cuts over the three levels, none a mini or a dress. */
const LEGS = ["a one-piece swimsuit", "a bikini and a sarong", "a black bikini", "a white bikini", "a white string bikini", "a red triangle bikini"];
/** Her feet in the water (review round 2): swimwear only, no sarong. */
const LEGS_IN_THE_WATER = ["a one-piece swimsuit", "a sporty bikini", "a black bikini", "a white bikini", "a white string bikini", "a red triangle bikini"];

/** The bank's outfits: swimwear on every frame, the level picks the cut. */
const OUTFITS: readonly Outfit[] = [
  { text: "a one-piece swimsuit", showsLegs: true, route: "seedream", coverage: SWIMSUIT },
  { text: "a sporty bikini", showsLegs: true, route: "seedream", coverage: BIKINI },
  { text: "a bikini and a sarong", showsLegs: true, route: "seedream", coverage: "Her bikini top fully covers her breasts, and her bikini bottoms fully cover her; the sarong is tied at her hips." },
  { text: "a bikini under a linen shirt", showsLegs: true, route: "seedream", coverage: "Her linen shirt hangs open over her bikini, which fully covers her breasts and her hips." },
  { text: "a black bikini", showsLegs: true, level: "flirty", route: "seedream", coverage: BIKINI },
  { text: "a white bikini", showsLegs: true, level: "flirty", route: "seedream", coverage: BIKINI },
  // The beach probe: good.
  { text: "a bikini and a straw hat", showsLegs: true, level: "flirty", route: "seedream", coverage: BIKINI },
  { text: "bikini bottoms and a sweatshirt", showsLegs: true, level: "flirty", route: "seedream", coverage: "Her sweatshirt covers her chest, and her bikini bottoms fully cover her." },
  { text: "a white string bikini", showsLegs: true, level: "bold", route: "seedream", coverage: BIKINI },
  { text: "a red triangle bikini", showsLegs: true, level: "bold", route: "seedream", coverage: BIKINI },
  { text: "a strapless bandeau bikini", showsLegs: true, level: "bold", route: "seedream", coverage: BIKINI },
  { text: "a high-leg black swimsuit", showsLegs: true, level: "bold", route: "seedream", coverage: HIGH_LEG },
];

/** Outfits with shoulder straps: the only ones an action on a strap meets (derived, so a strapless cut added to the bank never reaches it). */
const STRAPPED: readonly string[] = OUTFITS.filter((o) => !NO_STRAPS.test(o.text)).map((o) => o.text);

export const BEACH: CategoryBank = {
  bold: true,
  places: [
    {
      name: "the beach",
      at: "on a sandy beach",
      // S5.R4: a detail is said «…, with {detail}.», so an object she could hold sits in the place, never in her hands (the owner's «зачем?» of a bag).
      details: ["a canvas tote bag beside her", "a striped umbrella planted nearby", "some small waves behind her"],
      times: ["morning", "midday", "golden hour"],
      moments: [
        { text: "brushes sand off her legs", motion: "she brushes the sand off slowly", captures: ["friend", "selfie", "timer", "candid"], twoHanded: false, outdoor: true },
        { text: "lies back on her elbows", motion: "she tilts her head back a little", captures: ["friend", "timer", "candid"], twoHanded: true, level: "bold", route: "seedream", outdoor: true },
        { text: "shades her eyes with one hand", motion: "she lowers her hand slowly and smiles", captures: ["friend", "selfie", "timer", "candid"], twoHanded: false, gaze: "own", outdoor: true },
        // S5.9c round 2: every place holds a moment in profile, so the plan's away frames (a flirty or bold slot never turns its back) go round the places instead of falling on one.
        { text: "ties her hair in a loose knot", motion: "she gathers her hair up slowly", captures: ["friend", "candid"], twoHanded: true, hair: "own", angle: "profile", outdoor: true },
        { text: "lowers her sunglasses a little", motion: "she slowly peeks over her sunglasses", captures: ["selfie", "friend"], twoHanded: false, level: "flirty", outdoor: true },
        { text: "wrings out her wet hair", motion: "she squeezes her hair slowly", captures: ["friend", "timer", "candid"], twoHanded: true, hair: "own", water: true, outfits: IN_THE_WATER, outdoor: true },
        // «Ножки» (S5.8a, M5): her own look down along her legs.
        { text: "sits on the sand, legs out", motion: "she slowly buries her toes in the sand", captures: ["pov-legs"], twoHanded: false, outfits: LEGS, legs: { framing: "legs" } },
        { text: "crosses her ankles on the towel", motion: "she crosses and uncrosses her ankles slowly", captures: ["pov-legs"], twoHanded: false, outfits: LEGS, legs: { framing: "legs" } },
      ],
    },
    {
      name: "the water's edge",
      at: "at the edge of the sea",
      details: ["some wet sand", "a few seashells in the sand"],
      times: ["morning", "midday", "golden hour"],
      moments: [
        { text: "walks along the shore", motion: "she walks on slowly, the water at her feet", captures: ["friend", "candid"], twoHanded: false, water: true, outfits: IN_THE_WATER, outdoor: true },
        // The beach probe and P-5a3 #5 (a bikini and a straw hat): drawn.
        {
          text: "stands waist-deep, looking back",
          motion: "she turns her head a little further and smiles",
          captures: ["friend"],
          twoHanded: false,
          angle: "three-quarter",
          gaze: "own",
          level: "flirty",
          water: true,
          outfits: [...IN_THE_WATER, "a bikini and a straw hat"],
          outdoor: true,
        },
        { text: "stretches her arms out, knee-deep", motion: "she breathes in slowly and smiles", captures: ["friend", "candid"], twoHanded: true, angle: "profile", water: true, outfits: IN_THE_WATER, outdoor: true },
        { text: "laughs as a wave reaches her", motion: "she laughs and steps back a little", captures: ["friend", "candid"], twoHanded: false, expression: true, water: true, outfits: IN_THE_WATER, outdoor: true },
        { text: "steps out of the water", motion: "she keeps walking slowly", captures: ["friend", "candid"], twoHanded: false, water: true, outfits: IN_THE_WATER, outdoor: true },
        // S5.R4: seven legs moments, so the six legs slots of a 20-photo run at «Ножки» 30 % never repeat one (with four, two came twice in every run).
        { text: "lets the waves wash over her feet", motion: "she wiggles her toes in the foam slowly", captures: ["pov-legs"], twoHanded: false, water: true, outfits: LEGS_IN_THE_WATER, legs: { framing: "legs" } },
      ],
    },
    {
      name: "a hotel pool",
      at: "by a hotel pool",
      details: ["a folded towel on a deck chair", "two palm trees", "a glass of iced tea on a side table"],
      times: ["morning", "midday"],
      moments: [
        { text: "lies back on a sun lounger", motion: "she tilts her face to the sun a little", captures: ["friend", "selfie", "timer", "candid"], twoHanded: false, outdoor: true },
        { text: "sits on the lounger, legs crossed", motion: "she sways her crossed foot slowly", captures: ["friend", "selfie", "timer", "candid"], twoHanded: false, level: "bold", route: "seedream", outdoor: true },
        { text: "sits on the edge, feet in the water", motion: "she swirls her feet slowly", captures: ["friend", "selfie", "timer", "candid"], twoHanded: false, water: true, outfits: IN_THE_WATER, outdoor: true },
        { text: "stretches one arm along the edge", motion: "she slides her hand along the tiles slowly", captures: ["friend", "candid"], twoHanded: false, angle: "profile", water: true, outfits: IN_THE_WATER, outdoor: true },
        { text: "leans on the edge in the water", motion: "she kicks her feet slowly behind her", captures: ["friend", "timer", "candid"], twoHanded: true, water: true, outfits: IN_THE_WATER, outdoor: true },
        { text: "stretches her legs on the lounger", motion: "she points and flexes her toes slowly", captures: ["pov-legs"], twoHanded: false, outfits: LEGS, legs: { framing: "legs" } },
      ],
    },
    {
      name: "a rooftop pool",
      at: "by a rooftop pool",
      details: ["the city skyline behind her", "a low white daybed"],
      times: ["midday", "golden hour"],
      moments: [
        { text: "leans on the glass railing", motion: "her hair lifts a little in the wind", captures: ["friend", "selfie", "candid"], twoHanded: false, level: "flirty", outdoor: true },
        { text: "adjusts the strap on her shoulder", motion: "she slides the strap up a little", captures: ["friend", "candid"], twoHanded: false, angle: "profile", outfits: STRAPPED, outdoor: true },
        // The beach probe: looking back over her shoulder at the rooftop pool.
        { text: "looks back over her shoulder", motion: "she turns her head a little further", captures: ["friend", "timer"], twoHanded: false, angle: "three-quarter", gaze: "own", level: "bold", route: "seedream", outdoor: true },
        { text: "sips a cold drink by the water", motion: "she lowers the glass a little", captures: ["friend", "selfie", "candid"], twoHanded: false, outdoor: true },
        { text: "dangles her feet in the water", motion: "she dips her toes in the water slowly", captures: ["pov-legs"], twoHanded: false, water: true, outfits: LEGS_IN_THE_WATER, legs: { framing: "legs" } },
        { text: "lies back, ankles crossed", motion: "she rocks her crossed feet a little", captures: ["pov-legs"], twoHanded: false, outfits: LEGS, legs: { framing: "legs" } },
      ],
    },
    {
      name: "the rocks by the sea",
      at: "on the rocks by the sea",
      details: ["the warm evening sky", "a few gulls overhead"],
      times: ["golden hour", "evening"],
      moments: [
        // The beach probe: from behind on the rocks. C3′ (the owner: «просто стоит спиной без какой-либо позы»): she hugs her knees, an action the frame can read.
        { text: "sits hugging her knees", motion: "her hair stirs in the wind a little", captures: ["friend", "timer"], twoHanded: true, angle: "back", outdoor: true },
        { text: "sits cross-legged on a towel", motion: "she leans back a little", captures: ["friend", "selfie", "candid"], twoHanded: false, outdoor: true },
        // S5.R4: she watches the dusk, so the moment carries its own gaze (without it the template added «looking up at the viewer» to «watching dusk fall»).
        { text: "sits on a ledge, watching dusk fall", motion: "she watches the light fade slowly", captures: ["friend", "selfie", "timer", "candid"], twoHanded: false, gaze: "own", outdoor: true },
        { text: "leans back on her hands", motion: "she leans her head back a little", captures: ["friend", "timer", "candid"], twoHanded: true, outdoor: true },
        { text: "tucks her hair back in the breeze", motion: "she tucks a strand back slowly", captures: ["friend", "candid"], twoHanded: false, hair: "own", angle: "profile", outdoor: true },
        { text: "sits with her hands clasped", motion: "she rolls her shoulders back a little", captures: ["friend", "timer", "candid"], twoHanded: true, angle: "profile", outdoor: true },
        { text: "sits with her legs stretched out", motion: "she flexes her feet slowly", captures: ["pov-legs"], twoHanded: false, outfits: LEGS, legs: { framing: "legs" } },
      ],
    },
  ],
  outfits: OUTFITS,
  // She mostly asks someone (I5.32): a friend three times in six, a selfie, a timer, a candid.
  captureDeck: ["friend", "selfie", "friend", "timer", "friend", "candid"],
};
