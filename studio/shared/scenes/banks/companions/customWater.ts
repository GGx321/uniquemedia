import type { CategoryBank, Outfit } from "../types";
import {
  BANDEAU_BIKINI,
  BLACK_BIKINI,
  BLACK_ONE_PIECE,
  HIGH_LEG,
  ONE_PIECE,
  SPORTY_BIKINI,
  STRAW_HAT_BIKINI,
  STRING_BIKINI,
  TRIANGLE_BIKINI,
  WHITE_BIKINI,
} from "./outfits";

// «by the water» (5a.4, S5.BA2, plan s5a4 §5.3.1): a custom category at «Смелая» at the world's own water place (a beach, a hotel pool, a yacht at anchor: the place's head noun,
// S5.BA3). Generic sun and water moments the bold writer sets there, in swimwear only: every place is a water place (r2.1 N3), so its general draw is the beach bank's cuts and
// lingerie never reaches it; no implied cover. She mostly asks someone: a friend, a candid, sometimes a selfie or a timer. P-BA drew the red triangle bikini, her feet in the
// water, in the world «a yacht at anchor in a bay» without its coverage (C3).

const OUTFITS: readonly Outfit[] = [ONE_PIECE, BLACK_ONE_PIECE, SPORTY_BIKINI, BLACK_BIKINI, WHITE_BIKINI, STRAW_HAT_BIKINI, STRING_BIKINI, TRIANGLE_BIKINI, BANDEAU_BIKINI, HIGH_LEG];

/** In the water she wears a cut of every level and nothing over it (the bank holds no cover-up). */
const IN_THE_WATER = OUTFITS.map((o) => o.text);

export const CUSTOM_WATER: CategoryBank = {
  bold: true,
  places: [
    {
      name: "a lounger by the water",
      at: "on a sun lounger by the water",
      water: true,
      details: ["a folded towel beside her", "the blue sky above her"],
      times: ["morning", "midday", "golden hour"],
      moments: [
        { text: "lies back, soaking up the heat", motion: "she tilts her face up a little", captures: ["friend", "selfie", "timer"], twoHanded: false, outdoor: true },
        { text: "sits up, hugging one knee", motion: "she rests her cheek a little lower", captures: ["friend", "timer", "candid"], twoHanded: true, outdoor: true },
        { text: "sits on the end, legs crossed", motion: "she sways her crossed foot slowly", captures: ["friend", "selfie", "timer"], twoHanded: false, level: "flirty", outdoor: true },
        { text: "lies back, one knee raised", motion: "she lets her knee fall a little", captures: ["friend", "timer"], twoHanded: false, level: "bold", route: "seedream", outfits: IN_THE_WATER, outdoor: true },
      ],
    },
    {
      name: "a sunny spot by the water",
      at: "in a sunny spot at the edge",
      water: true,
      details: ["a folded towel on the boards", "the bright sky behind her"],
      times: ["midday", "golden hour"],
      moments: [
        // P-BA C3: drawn in the red triangle bikini without its coverage.
        { text: "sits with her feet in the water", motion: "she moves her feet slowly", captures: ["friend", "timer", "candid"], twoHanded: false, level: "flirty", water: true, outfits: IN_THE_WATER, outdoor: true },
        { text: "slips one foot into the water", motion: "she draws a small circle with her toes", captures: ["friend", "candid"], twoHanded: false, water: true, outfits: IN_THE_WATER, outdoor: true },
        { text: "shades her eyes, ankle-deep", motion: "she lowers her hand slowly", captures: ["friend", "selfie", "timer"], twoHanded: false, gaze: "own", water: true, outfits: IN_THE_WATER, outdoor: true },
        { text: "sits on the side, leaning back", motion: "she leans back a little further", captures: ["friend", "selfie", "timer", "candid"], twoHanded: false, outdoor: true },
        { text: "kneels at the edge, leaning back", motion: "she straightens up a little", captures: ["friend", "timer"], twoHanded: false, level: "bold", route: "seedream", outdoor: true },
      ],
    },
    {
      name: "in the water",
      at: "in the water, waist-deep",
      water: true,
      details: ["the sunlit surface around her", "some small ripples"],
      times: ["midday", "golden hour"],
      moments: [
        { text: "laughs, splashing a little", motion: "she laughs and sways a little", captures: ["friend", "candid"], twoHanded: false, angle: "three-quarter", expression: true, water: true, outfits: IN_THE_WATER, outdoor: true },
        { text: "sweeps her wet hair back", motion: "she presses her hair back slowly", captures: ["friend", "selfie", "candid"], twoHanded: false, hair: "own", water: true, outfits: IN_THE_WATER, outdoor: true },
        // From behind, her arms out on the water (C3′).
        { text: "stands, arms out, facing away", motion: "she sweeps her hands through slowly", captures: ["friend", "timer"], twoHanded: true, angle: "back", water: true, outfits: IN_THE_WATER, outdoor: true },
        { text: "lies back, floating", motion: "she drifts a little", captures: ["friend", "candid"], twoHanded: true, level: "flirty", water: true, outfits: IN_THE_WATER, outdoor: true },
        { text: "stands tall, hands in her hair", motion: "she lifts her elbows a little", captures: ["friend", "timer"], twoHanded: true, hair: "own", level: "bold", route: "seedream", water: true, outfits: IN_THE_WATER, outdoor: true },
      ],
    },
    {
      name: "a railing over the water",
      at: "by a railing over the water",
      water: true,
      details: ["the open horizon", "a coiled rope by her feet"],
      times: ["morning", "golden hour"],
      moments: [
        { text: "leans out, chin on her hand", motion: "her hair lifts a little in the wind", captures: ["friend", "selfie", "candid"], twoHanded: false, handAtFace: true, outdoor: true },
        // Side-on, her hands on the railing (C3′).
        { text: "rests both hands on the rail", motion: "she leans out a little and back", captures: ["friend", "candid"], twoHanded: true, angle: "profile", outdoor: true },
        { text: "sits on the deck, legs out", motion: "she crosses her ankles slowly", captures: ["friend", "timer", "selfie"], twoHanded: false, outdoor: true },
        { text: "leans back against the rail", motion: "she lifts her chin a little", captures: ["friend", "timer"], twoHanded: false, level: "flirty", outdoor: true },
        { text: "stretches up at the rail, side-on", motion: "she reaches a little higher", captures: ["friend", "timer"], twoHanded: true, angle: "profile", level: "bold", route: "seedream", outdoor: true },
      ],
    },
  ],
  outfits: OUTFITS,
  // She mostly asks someone (I5.32): a friend three times in six, a selfie, a timer, a candid.
  captureDeck: ["friend", "selfie", "friend", "timer", "friend", "candid"],
};
