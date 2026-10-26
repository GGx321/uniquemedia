import type { CategoryBank, Outfit } from "../types";
import {
  armsUpOutfits,
  SHEER_SET,
  BATH_FOAM,
  BATH_TOWEL,
  BEDSHEET,
  BEDSHEET_PIN,
  BLACK_LACE,
  BODYSUIT,
  COTTON_SET,
  FOAM_PIN,
  LACE_THONG_SET,
  OPEN_SHIRT,
  SATIN_CAMI,
  SATIN_MIDI,
  SATIN_ROBE,
  SATIN_SLIP,
  TANK_AND_BRIEFS,
  TEE_AND_PANTIES,
  TOWEL_PIN,
  WHITE_LACE,
} from "./outfits";

// «Дом» at «Смелая» (5a.4, S5.BA2, plan s5a4 §5.2): everyday home life in underwear. She shoots herself, as in «Дом» (I5.32): on a timer in her kitchen and on her sofa, in
// the mirror of her bedroom and her bathroom (a third of the frames with the phone over her face), from above and on her stomach on her bed. Never a friend. P-BA drew the
// towel after a shower (B1), the bath foam (B2) and the lace set in the bedroom mirror with the kept sentence (K1); the bedsheet is nightwear's, drawn in P-5a3. The implied
// covers are a Studio-created avatar's only (`tier: "implied"`, I5.74).

const OUTFITS: readonly Outfit[] = [
  TEE_AND_PANTIES,
  COTTON_SET,
  TANK_AND_BRIEFS,
  SATIN_CAMI,
  BLACK_LACE,
  WHITE_LACE,
  SATIN_SLIP,
  SATIN_MIDI,
  SATIN_ROBE,
  SHEER_SET,
  BODYSUIT,
  LACE_THONG_SET,
  OPEN_SHIRT,
  BATH_TOWEL,
  BEDSHEET,
  BATH_FOAM,
];

/** With her arms up she wears what stays over her chest: every general outfit but the open shirt. */
const ARMS_UP = armsUpOutfits(OUTFITS);
/** On her stomach on the bed: the sets P-BA and P-5a3 drew prone (a bra and briefs, a lace set, the lace bra and thong), and the satin cami and shorts. */
const PRONE = [TEE_AND_PANTIES.text, COTTON_SET.text, SATIN_CAMI.text, BLACK_LACE.text, WHITE_LACE.text, LACE_THONG_SET.text, BODYSUIT.text];
/** A legs frame: three satin (the cami and shorts is the plain one) and plain cotton (P-BA L1); never lace, never a mini. */
const LEGS = [SATIN_CAMI.text, SATIN_MIDI.text, SATIN_ROBE.text, TEE_AND_PANTIES.text, TANK_AND_BRIEFS.text];

export const HOME_BOLD: CategoryBank = {
  bold: true,
  places: [
    {
      name: "her kitchen",
      at: "in her kitchen",
      room: true,
      lamp: true,
      details: ["a kettle on the stove", "a fruit bowl on the table"],
      times: ["morning", "evening"],
      moments: [
        { text: "leans back against the counter", motion: "she shifts her weight a little", captures: ["timer"], twoHanded: false },
        { text: "stands at the open fridge", motion: "she leans in a little closer", captures: ["timer"], twoHanded: false },
        // From behind she does something the frame can read (C3′): a stretch up to the shelf, in what stays over her chest.
        { text: "stretches up to the top shelf", motion: "she reaches a little higher", captures: ["timer"], twoHanded: false, angle: "back", outfits: ARMS_UP },
        { text: "sits on the counter, legs crossed", motion: "she swings one foot slowly", captures: ["timer"], twoHanded: false, level: "flirty" },
        { text: "leans on the counter, one hip out", motion: "she sways her hip a little", captures: ["timer"], twoHanded: false, level: "bold", route: "seedream" },
      ],
    },
    {
      name: "her sofa",
      at: "on her sofa",
      room: true,
      lamp: true,
      details: ["a floor lamp", "a plant by the window"],
      times: ["morning", "evening", "night"],
      moments: [
        { text: "curls up in the corner", motion: "she settles a little deeper", captures: ["timer"], twoHanded: false },
        { text: "lies back, head on the armrest", motion: "she slowly turns her head", captures: ["above", "timer"], twoHanded: false },
        { text: "lies back, one arm over her head", motion: "she curls her fingers slowly", captures: ["above"], twoHanded: false, level: "flirty" },
        { text: "sits sideways, legs over the arm", motion: "she bounces one foot a little", captures: ["timer"], twoHanded: false, level: "flirty" },
        { text: "lies on her side, hand on her hip", motion: "she turns her hips a little", captures: ["above", "timer"], twoHanded: false, level: "bold", route: "seedream" },
        // «Ножки»: her own look down along her legs.
        { text: "dangles one foot off the armrest", motion: "she sways her foot slowly", captures: ["pov-legs"], twoHanded: false, outfits: LEGS, legs: { framing: "legs" } },
      ],
    },
    {
      name: "her bedroom",
      at: "in her bedroom",
      room: true,
      lamp: true,
      mirror: true,
      details: ["a chair with her clothes on it", "a plant on the windowsill", "a bedside lamp"],
      times: ["morning", "evening", "night"],
      moments: [
        // P-BA K1: drawn with the kept sentence.
        { text: "stands by the open wardrobe", motion: "she slides a hanger along slowly", captures: ["mirror-hidden", "mirror"], twoHanded: false },
        { text: "checks her outfit from the side", motion: "she turns a little to one side", captures: ["mirror-hidden", "mirror"], twoHanded: false, gaze: "own" },
        { text: "sweeps her hair over one shoulder", motion: "she smooths her hair down slowly", captures: ["mirror-hidden", "mirror"], twoHanded: false, hair: "own" },
        { text: "leans on the wardrobe door", motion: "she leans her head back a little", captures: ["mirror-hidden", "mirror"], twoHanded: false, level: "flirty" },
        { text: "sits on the end of the bed", motion: "she swings her crossed foot a bit", captures: ["mirror-hidden", "mirror", "timer"], twoHanded: false, level: "flirty" },
        // Back to the mirror, only her reflection.
        { text: "turns her back to the mirror", motion: "she turns her head a little more", captures: ["mirror-hidden"], twoHanded: false, angle: "three-quarter", mirrorBack: true, level: "bold", route: "seedream" },
        { text: "stands side-on, one knee bent", motion: "she shifts onto her back foot slowly", captures: ["mirror-hidden", "mirror"], twoHanded: false, level: "bold", route: "seedream" },
        { text: "stands on tiptoe at the wardrobe", motion: "she lifts her heels a little higher", captures: ["mirror-hidden"], twoHanded: false, outfits: LEGS, legs: { framing: "legs" } },
      ],
    },
    {
      name: "her bed",
      at: "on her bed",
      room: true,
      lamp: true,
      details: ["a glass of water on the nightstand", "a bedside lamp"],
      times: ["morning", "evening", "night"],
      moments: [
        { text: "lies back on the pillows", motion: "she blinks slowly and smiles", captures: ["above"], twoHanded: false, messyOk: true },
        { text: "lies on her side, knees together", motion: "she draws her knees up a little", captures: ["above"], twoHanded: false },
        { text: "lies prone, chin on her fist", motion: "she swings her feet a little", captures: ["prone"], twoHanded: false, handAtFace: true, outfits: PRONE, noLegwear: true },
        { text: "lies prone, glancing at her heels", motion: "she turns her head a little further", captures: ["over-shoulder"], twoHanded: false, angle: "three-quarter", gaze: "own", outfits: PRONE, noLegwear: true },
        { text: "lies back, hair spread out", motion: "she slowly tilts her head back", captures: ["above"], twoHanded: false, hair: "own", level: "flirty" },
        { text: "lies prone, legs crossed behind", motion: "she crosses her ankles slowly", captures: ["prone"], twoHanded: false, level: "flirty", outfits: PRONE, noLegwear: true },
        { text: "lies back, one arm under her head", motion: "she tilts her chin up a little", captures: ["above"], twoHanded: false, level: "bold", route: "seedream" },
        { text: "lies prone, one foot raised", motion: "her raised foot sways slowly", captures: ["over-shoulder"], twoHanded: false, angle: "three-quarter", level: "bold", route: "seedream", outfits: PRONE, noLegwear: true },
        // The bedsheet (P-5a3 #2 drew it): her near hand holds the phone and her other hand is free, so the sheet is pulled up, never held.
        { text: "lies back after a slow morning", motion: "she pulls the sheet a little higher", captures: ["above"], twoHanded: false, ...BEDSHEET_PIN },
        { text: "lies back, legs crossed at the knee", motion: "she bounces her top foot slowly", captures: ["pov-legs"], twoHanded: false, outfits: LEGS, legs: { framing: "legs" } },
        { text: "lies with one knee raised", motion: "she lowers her knee a little", captures: ["pov-legs"], twoHanded: false, outfits: LEGS, legs: { framing: "legs" } },
      ],
    },
    {
      name: "her bathroom",
      at: "in her bathroom",
      room: true,
      mirror: true,
      details: ["a fluffy rug on the floor", "a bottle of lotion on the shelf", "a small plant by the window"],
      times: ["morning", "evening", "night"],
      moments: [
        // P-BA B1: the towel after a shower, drawn with its descriptive open sentence.
        { text: "stands by the sink after a shower", motion: "she tucks the towel in a little tighter", captures: ["mirror-hidden", "mirror"], twoHanded: false, ...TOWEL_PIN },
        // P-BA B2: the bath foam up to her shoulders, drawn with the kept sentence.
        { text: "lies back in the bath, hair up", motion: "she sinks a little lower in the foam", captures: ["above"], twoHanded: false, hair: "own", ...FOAM_PIN },
        { text: "leans on the sink, getting ready", motion: "she leans in a little", captures: ["mirror-hidden", "mirror"], twoHanded: false },
        { text: "wipes the fog off the mirror", motion: "she wipes a small circle slowly", captures: ["mirror"], twoHanded: false, gaze: "focus" },
        { text: "puts her hair up in a clip", motion: "she pins her hair up slowly", captures: ["mirror-hidden", "mirror"], twoHanded: false, hair: "own" },
        { text: "rests her hip on the sink", motion: "she tilts her head a little", captures: ["mirror-hidden", "mirror"], twoHanded: false, level: "flirty" },
        { text: "stands side-on by the shower", motion: "she rolls one shoulder back slowly", captures: ["mirror-hidden"], twoHanded: false, angle: "three-quarter", mirrorBack: true, level: "bold", route: "seedream" },
        { text: "steps out of the shower", motion: "she takes a small step forward", captures: ["mirror-hidden"], twoHanded: false, outfits: LEGS, legs: { framing: "legs" } },
      ],
    },
  ],
  outfits: OUTFITS,
  legwear: {
    items: ["thigh-high socks", "sheer black tights"],
    share: 0.3,
    // The stockings go with the satin and the lace, never with plain cotton; a bold legs frame is satin with stockings (P-5a3 #6).
    bold: {
      items: ["black thigh-high stockings", "sheer black stockings", "white lace-top stockings"],
      share: 0.5,
      route: "seedream",
      outfits: [SATIN_CAMI.text, SATIN_SLIP.text, SATIN_MIDI.text, SATIN_ROBE.text, BLACK_LACE.text, WHITE_LACE.text, BODYSUIT.text, SHEER_SET.text, LACE_THONG_SET.text],
    },
  },
  // She shoots herself (I5.32), never a friend: 3 phone-over-face mirror frames of 12, 2 mirrors, 2 from above, 1 prone, 1 over her shoulder, 3 timers.
  captureDeck: ["mirror-hidden", "timer", "mirror", "above", "mirror-hidden", "prone", "timer", "mirror", "above", "mirror-hidden", "over-shoulder", "timer"],
};
