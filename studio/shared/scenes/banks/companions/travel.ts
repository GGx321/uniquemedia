import type { CategoryBank, Outfit } from "../types";
import {
  SHEER_SET,
  BATH_TOWEL,
  BLACK_BIKINI,
  BLACK_LACE,
  BLACK_THONG_SET,
  BODYSUIT,
  CAMI_AND_PANTIES,
  COTTON_SET,
  HOTEL_SHEET,
  HOTEL_SHEET_PIN,
  LACE_THONG_SET,
  ONE_PIECE,
  pinned,
  SATIN_CAMI,
  SATIN_MIDI,
  SATIN_ROBE,
  SPORTY_BIKINI,
  STRING_BIKINI,
  TOWEL_PIN,
  TRIANGLE_BIKINI,
  WHITE_LACE,
} from "./outfits";

// «Виды» at «Смелая» (5a.4, S5.BA2, plan s5a4 §5.2): the view from somewhere private. The balcony of her hotel room over the rooftops, its window, its bed with the view, the
// terrace of her villa and the villa's own pool (I5.72). She shoots herself on a timer, a selfie, from above and on her stomach on the bed; a friend only on the terrace and at the
// pool, never indoors. At the pool, a water place, every moment pins swimwear, its lounger included (r2.1 N3), and swimwear is worn nowhere else. P-BA drew the lace set on
// the balcony without its coverage (V1) and the hotel sheet with its kept sentence (V2).

const OUTFITS: readonly Outfit[] = [
  COTTON_SET,
  CAMI_AND_PANTIES,
  SATIN_CAMI,
  BLACK_LACE,
  WHITE_LACE,
  SATIN_MIDI,
  SATIN_ROBE,
  SHEER_SET,
  BODYSUIT,
  LACE_THONG_SET,
  BLACK_THONG_SET,
  pinned(ONE_PIECE),
  pinned(SPORTY_BIKINI),
  pinned(BLACK_BIKINI),
  pinned(STRING_BIKINI),
  pinned(TRIANGLE_BIKINI),
  HOTEL_SHEET,
  BATH_TOWEL,
];

/** At the villa's pool she wears swimwear only, a cut of every level; nothing over it in the water. */
const SWIMWEAR = [ONE_PIECE.text, SPORTY_BIKINI.text, BLACK_BIKINI.text, STRING_BIKINI.text, TRIANGLE_BIKINI.text];
/** On her stomach on the hotel bed: the sets drawn prone, and the satin cami and shorts. */
const PRONE = [COTTON_SET.text, CAMI_AND_PANTIES.text, SATIN_CAMI.text, BLACK_LACE.text, WHITE_LACE.text, LACE_THONG_SET.text, BLACK_THONG_SET.text];
/** A legs frame: three satin (the cami and shorts is the plain one) and plain cotton (P-BA L1); never lace, never a mini. */
const LEGS = [SATIN_CAMI.text, SATIN_MIDI.text, SATIN_ROBE.text, COTTON_SET.text, CAMI_AND_PANTIES.text];

export const TRAVEL_BOLD: CategoryBank = {
  bold: true,
  places: [
    {
      name: "the hotel balcony",
      at: "on the balcony of her hotel room, over the rooftops",
      details: ["a coffee cup on the little table", "two potted lemon trees", "the city spread out below her"],
      times: ["morning", "golden hour", "evening"],
      moments: [
        // C3′: from behind she does something the frame can read, her elbows on the railing.
        { text: "rests her elbows on the railing", motion: "her hair lifts a little in the wind", captures: ["timer"], twoHanded: true, angle: "back" },
        { text: "stands at the railing in the breeze", motion: "she rises on her toes a little", captures: ["timer", "selfie"], twoHanded: false },
        { text: "sits with her knees up on the chair", motion: "she hugs her knees a little closer", captures: ["timer"], twoHanded: false },
        { text: "sweeps her hair out of her face", motion: "she tucks a strand back slowly", captures: ["timer", "selfie"], twoHanded: false, hair: "own" },
        // P-BA V1: drawn in the lace set without its coverage.
        { text: "sits by the railing, legs crossed", motion: "she shifts in her seat a little", captures: ["timer", "selfie"], twoHanded: false, level: "flirty" },
        { text: "leans back on the railing", motion: "she arches her back a little", captures: ["timer", "selfie"], twoHanded: false, level: "bold", route: "seedream" },
        { text: "stretches her legs out on the chair", motion: "she points her toes slowly", captures: ["pov-legs"], twoHanded: false, outfits: LEGS, legs: { framing: "legs" } },
      ],
    },
    {
      name: "the hotel room window",
      at: "by the window of her hotel room",
      room: true,
      details: ["a small armchair in the corner", "a vase of fresh flowers"],
      times: ["morning", "evening"],
      moments: [
        { text: "leans a shoulder on the frame", motion: "she leans her shoulder in a little", captures: ["timer"], twoHanded: false },
        { text: "stretches up, facing the city", motion: "she stretches a little further", captures: ["timer"], twoHanded: true, angle: "back", gaze: "own" },
        { text: "sits on the windowsill, knees up", motion: "she rocks her knees a little", captures: ["timer"], twoHanded: false, level: "flirty" },
        { text: "stands with one hand on the frame", motion: "she slides her hand down slowly", captures: ["timer"], twoHanded: false, level: "bold", route: "seedream" },
        // A hotel towel after the shower, at the window with the view; on a timer, so the moment names nothing she holds.
        { text: "looks out after a shower", motion: "she rolls her shoulders back slowly", captures: ["timer"], twoHanded: false, gaze: "own", ...TOWEL_PIN },
        { text: "stands on tiptoe on the rug", motion: "she lifts her heels a little", captures: ["pov-legs"], twoHanded: false, outfits: LEGS, legs: { framing: "legs" } },
      ],
    },
    {
      name: "the hotel bed",
      at: "on the bed in her hotel room, by a window over the city",
      room: true,
      lamp: true,
      details: ["a breakfast tray on the side table", "her suitcase on the luggage rack"],
      times: ["morning", "night"],
      moments: [
        { text: "lies on her side, facing the view", motion: "she slowly closes her eyes", captures: ["above"], twoHanded: false, gaze: "own" },
        { text: "lies diagonally, one arm out", motion: "she turns her head a little", captures: ["above"], twoHanded: false, messyOk: true },
        { text: "lies prone, chin on her folded arms", motion: "she kicks one foot up slowly", captures: ["prone"], twoHanded: false, handAtFace: true, outfits: PRONE, noLegwear: true },
        { text: "lies back, a hand in her hair", motion: "she runs her fingers through slowly", captures: ["above"], twoHanded: false, hair: "own", level: "flirty" },
        { text: "lies on her stomach, ankles crossed", motion: "she taps her feet together slowly", captures: ["prone"], twoHanded: false, level: "flirty", outfits: PRONE, noLegwear: true },
        { text: "lies back, one knee bent up", motion: "she lets her knee fall a little", captures: ["above"], twoHanded: false, level: "bold", route: "seedream" },
        { text: "lies prone, propped on her elbows", motion: "she sways her hips a little", captures: ["prone"], twoHanded: false, level: "bold", route: "seedream", outfits: PRONE, noLegwear: true },
        // P-BA V2: the white hotel sheet, drawn with its kept sentence.
        { text: "lies back on the big pillows", motion: "she slowly turns her head on the pillow", captures: ["above"], twoHanded: false, ...HOTEL_SHEET_PIN },
        { text: "lies back with her ankles crossed", motion: "she crosses her ankles the other way slowly", captures: ["pov-legs"], twoHanded: false, outfits: LEGS, legs: { framing: "legs" } },
      ],
    },
    {
      name: "the villa terrace",
      at: "on the terrace of her villa, over the hills",
      details: ["a striped cushion on the bench", "some potted olive trees", "a jug of iced tea on the table"],
      times: ["morning", "midday", "golden hour"],
      moments: [
        { text: "sits on the low stone wall", motion: "she swings one foot a little", captures: ["friend", "timer", "selfie"], twoHanded: false, outdoor: true },
        { text: "stretches in the morning sun", motion: "she reaches a little higher", captures: ["friend", "timer", "candid"], twoHanded: true, outdoor: true },
        { text: "rests both hands on the wall", motion: "she leans out a little and back", captures: ["friend", "timer", "candid"], twoHanded: true, angle: "profile", outdoor: true },
        { text: "lies on a lounger, eyes closed", motion: "she tilts her face up a little", captures: ["friend", "timer", "selfie"], twoHanded: false, gaze: "own", outdoor: true },
        { text: "picks a grape from the bunch", motion: "she lifts the grape a little", captures: ["friend", "candid"], twoHanded: false, gaze: "focus", outdoor: true },
        { text: "sits on the edge of a lounger", motion: "she leans forward a little", captures: ["friend", "timer", "selfie"], twoHanded: false, level: "flirty", outdoor: true },
        { text: "leans back against the stone wall", motion: "she lifts her chin a little", captures: ["friend", "timer"], twoHanded: false, level: "bold", route: "seedream", outdoor: true },
        { text: "lifts one foot off the stone wall", motion: "she lowers her foot slowly", captures: ["pov-legs"], twoHanded: false, outfits: LEGS, legs: { framing: "legs" } },
      ],
    },
    {
      name: "the villa's pool",
      at: "by the pool of her villa",
      water: true,
      details: ["two palm trees", "a striped umbrella", "a folded towel on a chair"],
      times: ["morning", "midday", "golden hour"],
      moments: [
        { text: "sits on the edge, toes in the water", motion: "she swirls her toes slowly", captures: ["friend", "timer", "candid"], twoHanded: false, water: true, outfits: SWIMWEAR, outdoor: true },
        // r2.1 N3: a lounger by the pool is no water moment, and it still pins swimwear.
        { text: "lies back on a lounger", motion: "she lifts one knee a little", captures: ["friend", "timer", "selfie"], twoHanded: false, outfits: SWIMWEAR, outdoor: true },
        { text: "leans on the side in the water", motion: "she kicks her feet slowly behind her", captures: ["friend", "timer", "candid"], twoHanded: true, water: true, outfits: SWIMWEAR, outdoor: true },
        { text: "stands waist-deep, arms on the side", motion: "she sways a little in the water", captures: ["friend", "timer"], twoHanded: true, level: "flirty", water: true, outfits: SWIMWEAR, outdoor: true },
        { text: "sits on the steps in the water", motion: "she swishes her hand slowly", captures: ["friend", "timer", "candid"], twoHanded: false, level: "flirty", water: true, outfits: SWIMWEAR, outdoor: true },
        { text: "lies back on the warm stone", motion: "she stretches one leg out slowly", captures: ["friend", "timer"], twoHanded: false, level: "bold", route: "seedream", outfits: SWIMWEAR, outdoor: true },
      ],
    },
  ],
  outfits: OUTFITS,
  legwear: {
    items: ["thigh-high socks", "sheer black tights"],
    share: 0.3,
    bold: {
      items: ["black thigh-high stockings", "sheer black stockings", "white lace-top stockings"],
      share: 0.5,
      route: "seedream",
      outfits: [SATIN_CAMI.text, SATIN_MIDI.text, SATIN_ROBE.text, BLACK_LACE.text, WHITE_LACE.text, BODYSUIT.text, SHEER_SET.text, LACE_THONG_SET.text],
    },
  },
  // A timer, a selfie and her own close frames indoors; a friend and a candid only on the terrace and at the pool.
  captureDeck: ["timer", "selfie", "above", "friend", "timer", "prone", "selfie", "friend", "above", "candid", "timer", "friend"],
};
