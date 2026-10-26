import type { CategoryBank, Outfit } from "../types";
import {
  armsUpOutfits,
  BATH_TOWEL,
  BLACK_LACE,
  BLACK_THONG_SET,
  BODYSUIT,
  BRA_AND_JEANS,
  CAMI_AND_PANTIES,
  LACE_AND_JEANS,
  LACE_BRALETTE,
  LACE_THONG_SET,
  OPEN_SHIRT,
  pinned,
  SATIN_CAMI,
  SATIN_MIDI,
  SATIN_ROBE,
  TEE_AND_PANTIES,
  TOWEL_PIN,
} from "./outfits";

// «Улица» at «Смелая» (the stored id `photoshoot` stays, I5.33; 5a.4, S5.BA2, plan s5a4 §5.2): before and after the walk, never in the street (I5.72). Half-dressed in her
// hallway before she heads out, getting dressed in her bedroom, the hotel room after a day in the city with her shopping bags, the hotel window at night, and her hallway bench as
// she takes her boots off. She shoots herself: in the mirror, on a timer, from above and on her stomach on the hotel bed. P-BA drew the black bra and jeans in the hallway
// mirror without its coverage (S1) and the white lace bra and thong prone on the hotel bed (S2). The implied cover is the towel; the bare back stays «Фитнес»'s prone bed form
// (P-BA F2 decided that form only).

// Review M2 (§5.2, §5.9 «Улица»: белье): the satin is the legs frames' alone (pinned), so the general draw is plain underwear, the jeans and lace.
const OUTFITS: readonly Outfit[] = [
  BRA_AND_JEANS,
  TEE_AND_PANTIES,
  CAMI_AND_PANTIES,
  pinned(SATIN_CAMI),
  LACE_AND_JEANS,
  BLACK_LACE,
  LACE_BRALETTE,
  pinned(SATIN_MIDI),
  pinned(SATIN_ROBE),
  BODYSUIT,
  LACE_THONG_SET,
  BLACK_THONG_SET,
  OPEN_SHIRT,
  BATH_TOWEL,
];

/** Before she heads out she checks her jeans: the bra and jeans, plain or lace (P-BA S1). */
const JEANS = [BRA_AND_JEANS.text, LACE_AND_JEANS.text];
/** With her arms up or over her head she wears what stays over her chest: every general outfit but the open shirt. */
const ARMS_UP = armsUpOutfits(OUTFITS);
/** On her stomach on the hotel bed: the sets drawn prone, and the jeans she walked in. */
const PRONE = [TEE_AND_PANTIES.text, CAMI_AND_PANTIES.text, BRA_AND_JEANS.text, BLACK_LACE.text, LACE_BRALETTE.text, LACE_THONG_SET.text, BLACK_THONG_SET.text];
/** A legs frame: three satin (the cami and shorts is the plain one) and plain cotton (P-BA L1); never lace, never jeans. */
const LEGS = [SATIN_CAMI.text, SATIN_MIDI.text, SATIN_ROBE.text, TEE_AND_PANTIES.text, CAMI_AND_PANTIES.text];

export const PHOTOSHOOT_BOLD: CategoryBank = {
  bold: true,
  places: [
    {
      name: "her hallway",
      at: "in her hallway",
      room: true,
      lamp: true,
      mirror: true,
      details: ["a coat rack in the corner", "a row of shoes"],
      times: ["morning", "evening"],
      moments: [
        // P-BA S1: drawn without its coverage.
        { text: "checks her jeans before heading out", motion: "she turns a little toward the mirror", captures: ["mirror-hidden", "mirror"], twoHanded: false, outfits: JEANS },
        // Review M3: on her way out she is in her jeans, never in the general draw's thong or bodysuit.
        { text: "stands by the door, ready to go", motion: "she shifts her weight a little", captures: ["mirror-hidden", "mirror"], twoHanded: false, outfits: JEANS },
        { text: "brushes her fringe aside", motion: "she sweeps her fringe aside slowly", captures: ["mirror-hidden", "mirror"], twoHanded: false, hair: "own" },
        // Home from the walk: on a timer, both hands at her laces.
        { text: "sits on the bench, untying her boot", motion: "she tugs the lace loose slowly", captures: ["timer"], twoHanded: true, gaze: "focus", outfits: JEANS },
        { text: "leans on the front door", motion: "she leans her head back a little", captures: ["mirror-hidden", "mirror"], twoHanded: false, level: "flirty" },
        { text: "leans back against the wall", motion: "she presses her shoulders back slowly", captures: ["mirror-hidden", "mirror", "timer"], twoHanded: false, level: "flirty" },
        // Side to the mirror, only her reflection.
        { text: "stands side-on, hand on her hip", motion: "she shifts her hip a little", captures: ["mirror-hidden"], twoHanded: false, angle: "three-quarter", mirrorBack: true, level: "bold", route: "seedream" },
        { text: "sits on the bench, legs crossed", motion: "she bobs her crossed foot a little", captures: ["pov-legs"], twoHanded: false, outfits: LEGS, legs: { framing: "legs" } },
      ],
    },
    {
      name: "her bedroom",
      at: "in her bedroom",
      room: true,
      lamp: true,
      mirror: true,
      details: ["an open drawer", "a plant on the windowsill"],
      times: ["morning", "evening"],
      moments: [
        { text: "stands at the mirror, half-dressed", motion: "she turns a little to one side", captures: ["mirror-hidden", "mirror"], twoHanded: false },
        { text: "picks out what to wear", motion: "she sorts through the hangers slowly", captures: ["mirror-hidden", "mirror"], twoHanded: false, gaze: "focus" },
        { text: "leans on the dresser, half-dressed", motion: "she drums her fingers a little", captures: ["mirror-hidden", "mirror"], twoHanded: false, level: "flirty" },
        { text: "sits on the bed, leaning back", motion: "she leans back a little further", captures: ["mirror-hidden", "mirror"], twoHanded: false, level: "bold", route: "seedream" },
        // Her back to the mirror as she looks at it over her shoulder: only her reflection.
        { text: "turns to look at her back", motion: "she turns her head a little further", captures: ["mirror-hidden"], twoHanded: false, angle: "three-quarter", gaze: "own", mirrorBack: true, level: "bold", route: "seedream" },
        { text: "lifts one foot onto the chair", motion: "she lowers her foot slowly", captures: ["mirror-hidden"], twoHanded: false, outfits: LEGS, legs: { framing: "legs" } },
      ],
    },
    {
      name: "her hotel bed",
      at: "on the bed in her hotel room, beside her shopping bags",
      room: true,
      lamp: true,
      details: ["her sneakers by the door", "a bottle of water on the nightstand"],
      times: ["golden hour", "evening"],
      moments: [
        { text: "lies back, tired from walking", motion: "she lets her head sink back slowly", captures: ["above"], twoHanded: false, messyOk: true },
        { text: "lies on her side, legs tucked up", motion: "she pulls her knees in a little", captures: ["above"], twoHanded: false },
        { text: "lies on her stomach, shoes off", motion: "she swings her feet slowly", captures: ["prone"], twoHanded: false, outfits: PRONE, noLegwear: true },
        { text: "sits on the edge, rubbing one foot", motion: "she rubs her heel slowly", captures: ["timer"], twoHanded: true, gaze: "focus" },
        // P-BA S2: drawn in the white lace bra and thong without its coverage; a flirty slot wears the lace bralette.
        { text: "lies prone after a long walk", motion: "she sways her feet slowly behind her", captures: ["prone"], twoHanded: false, level: "flirty", outfits: [LACE_THONG_SET.text, LACE_BRALETTE.text], noLegwear: true },
        { text: "sits back on her hands", motion: "she tips her head back a little", captures: ["timer"], twoHanded: true, level: "flirty" },
        { text: "lies back, arms above her head", motion: "she flexes her fingers a little", captures: ["above"], twoHanded: false, level: "bold", route: "seedream", outfits: ARMS_UP },
        { text: "lies prone, one heel kicked up", motion: "she bends her raised knee slowly", captures: ["prone"], twoHanded: false, level: "bold", route: "seedream", outfits: PRONE, noLegwear: true },
        { text: "lies with her legs out straight", motion: "she flexes her toes slowly", captures: ["pov-legs"], twoHanded: false, outfits: LEGS, legs: { framing: "legs" } },
      ],
    },
    {
      name: "the hotel window at night",
      at: "by the window of her hotel room",
      room: true,
      lamp: true,
      details: ["the city lights below", "a small armchair in the corner"],
      times: ["evening", "night"],
      moments: [
        { text: "leans on the sill, looking out", motion: "she rests her chin a little lower", captures: ["timer"], twoHanded: false, gaze: "own" },
        { text: "stands with her arms crossed", motion: "she hugs her arms a little tighter", captures: ["timer"], twoHanded: true },
        // From behind, her hands on the pane (C3′).
        { text: "rests both hands on the pane", motion: "she leans in a little closer", captures: ["timer"], twoHanded: true, angle: "back" },
        { text: "sits on the sill, one knee up", motion: "she sways her knee a little", captures: ["timer"], twoHanded: false, level: "flirty" },
        { text: "leans back against the cool pane", motion: "she tilts her head back slowly", captures: ["timer"], twoHanded: false, level: "bold", route: "seedream" },
        { text: "stands after a shower, looking out", motion: "she rolls her neck a little", captures: ["timer"], twoHanded: false, gaze: "own", ...TOWEL_PIN },
        { text: "stands, feet together on the carpet", motion: "she rocks onto her heels slowly", captures: ["pov-legs"], twoHanded: false, outfits: LEGS, legs: { framing: "legs" } },
      ],
    },
  ],
  outfits: OUTFITS,
  legwear: {
    items: ["thigh-high socks", "sheer black tights"],
    share: 0.3,
    bold: {
      items: ["black thigh-high stockings", "sheer black stockings"],
      share: 0.5,
      route: "seedream",
      outfits: [SATIN_CAMI.text, SATIN_MIDI.text, SATIN_ROBE.text, BLACK_LACE.text, LACE_BRALETTE.text, BODYSUIT.text, LACE_THONG_SET.text],
    },
  },
  // She shoots herself: 3 phone-over-face mirror frames of 10, 2 mirrors, 2 from above, 1 prone, 2 timers. Never a friend.
  captureDeck: ["mirror-hidden", "mirror", "timer", "above", "mirror-hidden", "prone", "timer", "mirror", "above", "mirror-hidden"],
};
