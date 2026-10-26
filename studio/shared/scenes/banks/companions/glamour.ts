import type { CategoryBank, Outfit } from "../types";
import {
  SHEER_SET,
  BATH_TOWEL,
  BLACK_BRA_AND_BRIEFS,
  BLACK_LACE,
  BLACK_THONG_SET,
  BODYSUIT,
  CAMI_AND_PANTIES,
  HOTEL_SHEET,
  HOTEL_SHEET_PIN,
  LACE_THONG_SET,
  SATIN_CAMI,
  SATIN_MIDI,
  SATIN_ROBE,
  SATIN_SLIP,
  TOWEL_PIN,
  WHITE_LACE,
} from "./outfits";

// «Гламур» at «Смелая» (5a.4, S5.BA2, plan s5a4 §5.2): getting ready, and the hotel room after the evening, never the evening out itself (I5.72). At her vanity table and in her
// bedroom before she goes out, in her hotel room when she is back with her heels off and the dress over the chair, and on the hotel bed the morning after. She shoots herself:
// in the mirror, on a timer, from above and on her stomach. P-BA drew the lace bodysuit with thigh-high stockings at the vanity (G1) and the sheer set after the evening (G2),
// both without their coverage. G1 had both hands busy (the phone and the perfume), so at the mirror her other hand holds nothing.

const OUTFITS: readonly Outfit[] = [
  SATIN_CAMI,
  BLACK_BRA_AND_BRIEFS,
  CAMI_AND_PANTIES,
  BLACK_LACE,
  WHITE_LACE,
  SATIN_SLIP,
  SATIN_MIDI,
  SATIN_ROBE,
  SHEER_SET,
  BODYSUIT,
  LACE_THONG_SET,
  BLACK_THONG_SET,
  HOTEL_SHEET,
  BATH_TOWEL,
];

/** On her stomach: the sets, the satin cami and shorts. */
const PRONE = [SATIN_CAMI.text, BLACK_BRA_AND_BRIEFS.text, CAMI_AND_PANTIES.text, BLACK_LACE.text, WHITE_LACE.text, LACE_THONG_SET.text, BLACK_THONG_SET.text];
/** A legs frame: three satin (the cami and shorts is the plain one) and plain cotton (P-BA L1); never lace, never a mini. */
const LEGS = [SATIN_CAMI.text, SATIN_MIDI.text, SATIN_ROBE.text, CAMI_AND_PANTIES.text];

export const GLAMOUR_BOLD: CategoryBank = {
  bold: true,
  places: [
    {
      name: "her vanity table",
      at: "at the vanity table in her bedroom",
      room: true,
      lamp: true,
      mirror: true,
      details: ["a jewellery box on the dresser", "a dress hung on the wardrobe"],
      times: ["evening", "night"],
      moments: [
        { text: "stands with a hand on her waist", motion: "she shifts her weight a little", captures: ["mirror-hidden", "mirror"], twoHanded: false },
        { text: "sweeps her hair back, getting ready", motion: "she smooths her hair back slowly", captures: ["mirror-hidden", "mirror"], twoHanded: false, hair: "own" },
        // P-BA G1, reworded: one hand on the phone, the other free (the probe drew it with perfume in her other hand).
        { text: "turns side-on, getting ready", motion: "she tilts her head to one side a little", captures: ["mirror"], twoHanded: false, level: "flirty" },
        { text: "leans in close to the mirror", motion: "she leans in a little closer", captures: ["mirror"], twoHanded: false, level: "flirty" },
        { text: "sits on the stool, legs crossed", motion: "she bounces her crossed foot slowly", captures: ["mirror-hidden", "mirror"], twoHanded: false, level: "bold", route: "seedream" },
        { text: "turns, glancing back at the mirror", motion: "she turns her shoulder a little", captures: ["mirror"], twoHanded: false, angle: "three-quarter", gaze: "own", level: "bold", route: "seedream" },
        { text: "sits down after a shower", motion: "she settles onto the stool slowly", captures: ["mirror-hidden", "mirror"], twoHanded: false, ...TOWEL_PIN },
        { text: "sits on the stool, one knee up", motion: "she lowers her knee a little", captures: ["mirror-hidden"], twoHanded: false, outfits: LEGS, legs: { framing: "legs" } },
      ],
    },
    {
      name: "her bedroom",
      at: "in her bedroom",
      room: true,
      lamp: true,
      mirror: true,
      details: ["a dress laid out on the chair", "a bedside lamp"],
      times: ["evening", "night"],
      moments: [
        { text: "stands by the wardrobe, deciding", motion: "she taps her chin a little", captures: ["mirror-hidden", "mirror"], twoHanded: false, gaze: "focus" },
        { text: "sits at the foot of the bed", motion: "she swings one foot a little", captures: ["mirror-hidden", "mirror", "timer"], twoHanded: false },
        { text: "stands by the bed, almost ready", motion: "she rolls her shoulders back a little", captures: ["mirror-hidden", "mirror"], twoHanded: false },
        { text: "leans on the wardrobe, one foot up", motion: "she taps her raised foot slowly", captures: ["mirror-hidden", "mirror"], twoHanded: false, level: "flirty", noLegwear: true },
        { text: "stands side-on, one heel raised", motion: "she lifts her heel a little higher", captures: ["mirror-hidden"], twoHanded: false, angle: "three-quarter", mirrorBack: true, level: "bold", route: "seedream" },
        { text: "steps into her heels", motion: "she slides her foot in slowly", captures: ["mirror-hidden"], twoHanded: false, outfits: LEGS, legs: { framing: "legs" } },
      ],
    },
    {
      name: "her hotel room after the evening",
      at: "in her hotel room after an evening out",
      room: true,
      lamp: true,
      details: ["a dress over the back of a chair", "a clutch on the nightstand"],
      times: ["night"],
      moments: [
        { text: "sits in the armchair, legs crossed", motion: "she sways her crossed foot slowly", captures: ["timer"], twoHanded: false },
        { text: "stands by the window, unwinding", motion: "she lets her shoulders drop slowly", captures: ["timer"], twoHanded: false },
        // C3′: from behind she does something the frame can read.
        { text: "takes off her earrings, facing away", motion: "she tilts her head a little", captures: ["timer"], twoHanded: true, angle: "back" },
        { text: "lies across the bed, still in heels", motion: "she kicks one heel off slowly", captures: ["above"], twoHanded: false, messyOk: true },
        // P-BA G2: drawn in the sheer set over lace without its coverage.
        { text: "sits on the bed, heels kicked off", motion: "she stretches her feet out slowly", captures: ["timer"], twoHanded: false, level: "flirty" },
        { text: "leans back against the door", motion: "she lets her head rest back slowly", captures: ["timer"], twoHanded: false, level: "bold", route: "seedream" },
        { text: "lies on her stomach, heels off", motion: "she swings her bare feet slowly", captures: ["prone"], twoHanded: false, level: "bold", route: "seedream", outfits: PRONE, noLegwear: true },
        { text: "sits back with her ankles crossed", motion: "she taps her ankles together slowly", captures: ["pov-legs"], twoHanded: false, outfits: LEGS, legs: { framing: "legs" } },
      ],
    },
    {
      name: "the hotel bed the morning after",
      at: "on the hotel bed the morning after",
      room: true,
      details: ["her dress lying on the floor", "a glass of water on the nightstand"],
      times: ["morning"],
      moments: [
        { text: "rests her head on her arm", motion: "she slowly opens her eyes", captures: ["above"], twoHanded: false },
        { text: "lies on her side, smiling sleepily", motion: "she smiles a little wider", captures: ["above"], twoHanded: false, expression: true },
        { text: "lies prone, one arm over the edge", motion: "she lets her hand dangle a little", captures: ["prone"], twoHanded: false, outfits: PRONE, noLegwear: true },
        { text: "lies back, hair in a mess", motion: "she pushes her hair back slowly", captures: ["above"], twoHanded: false, hair: "own", level: "flirty", messyOk: true },
        { text: "lies prone, legs swinging behind", motion: "her feet swing slowly behind her", captures: ["prone"], twoHanded: false, level: "flirty", outfits: PRONE, noLegwear: true },
        { text: "lies back, one leg over the other", motion: "she slides her foot down slowly", captures: ["above"], twoHanded: false, level: "bold", route: "seedream" },
        // P-BA V2's sheet in the hotel bed, with its kept sentence.
        { text: "lies back after a late night", motion: "she turns her face into the pillow slowly", captures: ["above"], twoHanded: false, ...HOTEL_SHEET_PIN },
        { text: "stretches her legs out, toes up", motion: "she points her toes slowly", captures: ["pov-legs"], twoHanded: false, outfits: LEGS, legs: { framing: "legs" } },
      ],
    },
  ],
  outfits: OUTFITS,
  legwear: {
    items: ["sheer black tights"],
    share: 0.3,
    // P-BA G1: the lace bodysuit drew with black thigh-high stockings; the stockings go with the satin and the lace.
    bold: {
      items: ["black thigh-high stockings", "sheer black stockings", "white lace-top stockings"],
      share: 0.5,
      route: "seedream",
      outfits: [SATIN_CAMI.text, SATIN_SLIP.text, SATIN_MIDI.text, SATIN_ROBE.text, BLACK_LACE.text, WHITE_LACE.text, BODYSUIT.text, SHEER_SET.text, LACE_THONG_SET.text, BLACK_THONG_SET.text],
    },
  },
  // She shoots herself: 3 mirrors of 10, 2 phone-over-face mirror frames, 2 timers, 2 from above, 1 prone. Never a friend.
  captureDeck: ["mirror", "mirror-hidden", "timer", "above", "mirror", "prone", "mirror-hidden", "timer", "above", "mirror"],
};
