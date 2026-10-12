import type { CategoryBank } from "./types";

// «Пляж и бассейн» (`beach`, 5a.3, plan s5a3 §6.3, answer (a) of the owner), a «Смелая» bank: drawn only under «Подача: Смелая». At the beach and the pool she
// mostly asks someone (a friend three times in six, a candid), sometimes a selfie or the phone on a timer (I5.32); she lies on her stomach only on her bed, so
// never here. Swimwear on every frame: every outfit is swimwear, drawn on Seedream at 2K (Grok refused bikinis 2/2) with its coverage sentence, and every moment
// in the water or at its edge pins it (M6); the level picks the cut, the pose and the gaze. The beach probe drew the compositions (4/4, «Пляж тоже хороший»):
// waist-deep looking back, looking back over her shoulder at the rooftop pool, from behind on the rocks; P-5a3 #5 drew the waist-deep frame in a bikini and a
// straw hat. Every moment but the legs ones is outdoors, so a cap may go to one of them.

const BIKINI = "Her bikini top fully covers her breasts, and her bikini bottoms fully cover her.";
const SWIMSUIT = "Her swimsuit fully covers her chest and her hips.";

/** In the water she wears a swimsuit or a bikini of every level: no shirt, sweatshirt, sarong or hat in the sea. */
const IN_THE_WATER = ["a one-piece swimsuit", "a sporty bikini", "a black bikini", "a white bikini", "a white string bikini", "a red triangle bikini", "a strapless bandeau bikini", "a high-leg black swimsuit"];
/** A legs frame (M5): six cuts over the three levels, none a mini or a dress. */
const LEGS = ["a one-piece swimsuit", "a bikini and a sarong", "a black bikini", "a white bikini", "a white string bikini", "a red triangle bikini"];

export const BEACH: CategoryBank = {
  bold: true,
  places: [
    {
      name: "the beach",
      at: "on a sandy beach",
      details: ["a canvas tote bag", "a striped umbrella", "some small waves behind her"],
      times: ["morning", "midday", "golden hour"],
      moments: [
        { text: "sits on the sand, knees up", motion: "she slowly rests her chin on her knees", captures: ["friend", "selfie", "timer"], twoHanded: false, outdoor: true },
        { text: "shades her eyes with one hand", motion: "she lowers her hand slowly and smiles", captures: ["friend"], twoHanded: false, gaze: "own", outdoor: true },
        { text: "lowers her sunglasses a little", motion: "she slowly peeks over her sunglasses", captures: ["selfie", "friend"], twoHanded: false, level: "flirty", outdoor: true },
        { text: "wrings out her wet hair", motion: "she squeezes her hair slowly", captures: ["friend", "candid"], twoHanded: true, hair: "own", water: true, outfits: IN_THE_WATER, outdoor: true },
        // «Ножки» (S5.8a, M5): her own look down along her legs.
        { text: "sits on the sand, legs out", motion: "she slowly buries her toes in the sand", captures: ["pov-legs"], twoHanded: false, outfits: LEGS, legs: { framing: "legs" } },
        { text: "crosses her ankles on the towel", motion: "she crosses and uncrosses her ankles slowly", captures: ["pov-legs"], twoHanded: false, outfits: LEGS, legs: { framing: "legs" } },
      ],
    },
    {
      name: "the water's edge",
      at: "at the edge of the sea",
      details: ["some wet sand", "a few seashells"],
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
        { text: "laughs as a wave reaches her", motion: "she laughs and steps back a little", captures: ["friend", "candid"], twoHanded: false, expression: true, water: true, outfits: IN_THE_WATER, outdoor: true },
        { text: "steps out of the water", motion: "she keeps walking slowly", captures: ["friend", "candid"], twoHanded: false, water: true, outfits: IN_THE_WATER, outdoor: true },
      ],
    },
    {
      name: "a hotel pool",
      at: "by a hotel pool",
      details: ["a folded towel", "two palm trees", "a glass of iced tea"],
      times: ["morning", "midday"],
      moments: [
        { text: "lies back on a sun lounger", motion: "she tilts her face to the sun a little", captures: ["friend", "timer"], twoHanded: false, outdoor: true },
        { text: "sits on the edge, feet in the water", motion: "she swirls her feet slowly", captures: ["friend", "selfie", "candid"], twoHanded: false, water: true, outfits: IN_THE_WATER, outdoor: true },
        { text: "leans on the edge in the water", motion: "she kicks her feet slowly behind her", captures: ["friend", "timer"], twoHanded: true, water: true, outfits: IN_THE_WATER, outdoor: true },
        { text: "stretches her legs on the lounger", motion: "she points and flexes her toes slowly", captures: ["pov-legs"], twoHanded: false, outfits: LEGS, legs: { framing: "legs" } },
      ],
    },
    {
      name: "a rooftop pool",
      at: "by a rooftop pool",
      details: ["the city skyline behind her", "a low white daybed"],
      times: ["midday", "golden hour"],
      moments: [
        { text: "leans on the glass railing", motion: "her hair lifts a little in the wind", captures: ["friend", "selfie"], twoHanded: false, level: "flirty", outdoor: true },
        // The beach probe: looking back over her shoulder at the rooftop pool.
        { text: "looks back over her shoulder", motion: "she turns her head a little further", captures: ["friend"], twoHanded: false, angle: "three-quarter", gaze: "own", level: "bold", route: "seedream", outdoor: true },
        { text: "sips a cold drink by the water", motion: "she lowers the glass a little", captures: ["friend", "selfie", "candid"], twoHanded: false, outdoor: true },
        { text: "dangles her feet in the water", motion: "she swirls her feet slowly", captures: ["pov-legs"], twoHanded: false, water: true, outfits: LEGS, legs: { framing: "legs" } },
      ],
    },
    {
      name: "the rocks by the sea",
      at: "on the rocks by the sea",
      details: ["the warm evening sky", "a few gulls overhead"],
      times: ["golden hour", "evening"],
      moments: [
        // The beach probe: from behind on the rocks.
        { text: "sits facing the sunset", motion: "her hair lifts a little in the wind", captures: ["friend", "timer"], twoHanded: false, angle: "back", outdoor: true },
        { text: "sits with her knees drawn up", motion: "she slowly rests her cheek on her knees", captures: ["friend", "selfie"], twoHanded: false, outdoor: true },
        { text: "leans back on her hands", motion: "she tilts her head back a little", captures: ["friend", "timer", "candid"], twoHanded: true, outdoor: true },
        { text: "looks out over the water", motion: "she turns her head slowly", captures: ["friend", "candid"], twoHanded: false, gaze: "own", angle: "profile", outdoor: true },
      ],
    },
  ],
  outfits: [
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
    { text: "a high-leg black swimsuit", showsLegs: true, level: "bold", route: "seedream", coverage: SWIMSUIT },
  ],
  // She mostly asks someone (I5.32): a friend three times in six, a selfie, a timer, a candid.
  captureDeck: ["friend", "selfie", "friend", "timer", "friend", "candid"],
};
