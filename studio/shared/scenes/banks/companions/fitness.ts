import type { CategoryBank, Outfit } from "../types";
import {
  BATH_TOWEL,
  BLACK_LACE,
  BLACK_THONG_SET,
  BODYSUIT,
  HIP_TOWEL,
  HIP_TOWEL_PIN,
  LACE_BRALETTE,
  LACE_THONG_SET,
  pinned,
  SATIN_CAMI,
  SATIN_MIDI,
  SATIN_ROBE,
  SPORTS_AND_PANTIES,
  SPORTS_SET,
  SPORTS_THONG,
  TANK_AND_BRIEFS,
  TOWEL_PIN,
  WHITE_LACE,
} from "./outfits";

// «Фитнес» at «Смелая» (5a.4, S5.BA2, plan s5a4 §5.2): home after the workout, never the gym (I5.72). On the yoga mat in her living room, in her bedroom mirror after the
// workout, in her bathroom after the shower, stretching on her bedroom floor, and on her bed. She shoots herself: on a timer, in the mirror, from above, on her stomach and over
// her own shoulder on the bed. P-BA drew the sports bra and thong in the bedroom mirror without its coverage (F1), the sports set on a legs frame (L1), and the bare back on her
// bed, a towel over her hips, with its kept sentence (F2: she looked at the camera there, so the moment keeps its own gaze on her feet). The tier table: a thong is most revealing.

// Review M2 (§5.2, §5.9 «Фитнес»: белье; атлас only with «Ножки»): the satin is the legs frames' alone (pinned), so the general draw is the sports sets, plain cotton and lace.
const OUTFITS: readonly Outfit[] = [
  SPORTS_SET,
  SPORTS_AND_PANTIES,
  TANK_AND_BRIEFS,
  pinned(SATIN_CAMI),
  BLACK_LACE,
  WHITE_LACE,
  LACE_BRALETTE,
  pinned(SATIN_MIDI),
  pinned(SATIN_ROBE),
  SPORTS_THONG,
  BLACK_THONG_SET,
  LACE_THONG_SET,
  BODYSUIT,
  BATH_TOWEL,
  HIP_TOWEL,
];

/** On her stomach on the bed: the sets, the sports sets included. */
const PRONE = [SPORTS_SET.text, SPORTS_AND_PANTIES.text, TANK_AND_BRIEFS.text, BLACK_LACE.text, WHITE_LACE.text, LACE_BRALETTE.text, SPORTS_THONG.text, BLACK_THONG_SET.text];
/** A legs frame: three satin (the cami and shorts is the plain one) and the sports set P-BA L1 drew; never lace, never a mini. */
const LEGS = [SPORTS_SET.text, SATIN_CAMI.text, SATIN_MIDI.text, SATIN_ROBE.text];

export const FITNESS_BOLD: CategoryBank = {
  bold: true,
  places: [
    {
      name: "her living room",
      at: "on a yoga mat in her living room",
      room: true,
      details: ["a water bottle on the floor", "a plant by the window"],
      times: ["morning", "evening"],
      moments: [
        { text: "sits cross-legged after a workout", motion: "she rolls her shoulders back slowly", captures: ["timer"], twoHanded: false, hair: "sport" },
        { text: "stretches one arm across her chest", motion: "she presses her arm in a little closer", captures: ["timer"], twoHanded: true, hair: "sport" },
        { text: "lies back, knees bent, resting", motion: "she lets her knees sway a little", captures: ["timer"], twoHanded: false, hair: "sport" },
        // C3′: from behind she does something the frame can read, a long stretch.
        { text: "reaches up in a long stretch", motion: "she reaches a little higher", captures: ["timer"], twoHanded: true, angle: "back", hair: "sport" },
        { text: "sits back on her heels", motion: "she sinks back a little lower", captures: ["timer"], twoHanded: false, hair: "sport", level: "flirty" },
        { text: "lies back, arms over her head", motion: "she lengthens her arms a little", captures: ["timer"], twoHanded: true, hair: "sport", level: "flirty" },
        { text: "lies on her side, on one elbow", motion: "she rolls her hips forward slowly", captures: ["timer"], twoHanded: false, level: "bold", route: "seedream" },
        { text: "stands, feet together, after a set", motion: "she rises onto her toes a little", captures: ["pov-legs"], twoHanded: false, outfits: LEGS, legs: { framing: "legs" } },
      ],
    },
    {
      name: "her bedroom",
      at: "in her bedroom",
      room: true,
      mirror: true,
      details: ["a rolled yoga mat by the wall", "a pair of dumbbells on the rug"],
      times: ["morning", "evening"],
      moments: [
        { text: "wipes her forehead after a workout", motion: "she lowers her hand slowly", captures: ["mirror-hidden", "mirror"], twoHanded: false, hair: "sport" },
        { text: "turns side-on, hand on her stomach", motion: "she turns a little further", captures: ["mirror-hidden", "mirror"], twoHanded: false, hair: "sport" },
        { text: "puts one hand on her hip, flushed", motion: "she catches her breath slowly", captures: ["mirror-hidden", "mirror"], twoHanded: false, hair: "sport" },
        // P-BA F1: drawn in the sports bra and thong without its coverage.
        { text: "checks her progress after a workout", motion: "she turns a little to one side", captures: ["mirror", "mirror-hidden"], twoHanded: false, hair: "sport", level: "flirty" },
        { text: "stands with her weight on one leg", motion: "she shifts her weight slowly", captures: ["mirror-hidden", "mirror"], twoHanded: false, level: "bold", route: "seedream" },
        // Her back to the mirror, only her reflection.
        { text: "turns her back to check her shape", motion: "she turns her head a little further", captures: ["mirror-hidden"], twoHanded: false, angle: "three-quarter", mirrorBack: true, level: "bold", route: "seedream" },
        { text: "lifts one foot behind her", motion: "she lowers her foot slowly", captures: ["mirror-hidden"], twoHanded: false, outfits: LEGS, legs: { framing: "legs" } },
      ],
    },
    {
      name: "her bathroom",
      at: "in her bathroom",
      room: true,
      mirror: true,
      details: ["a bath mat on the floor", "a bottle of shampoo on the shelf"],
      times: ["morning", "evening"],
      moments: [
        { text: "stands by the mirror after a shower", motion: "she tucks the towel in a little", captures: ["mirror-hidden", "mirror"], twoHanded: false, ...TOWEL_PIN },
        { text: "leans on the sink, flushed", motion: "she leans in a little", captures: ["mirror-hidden", "mirror"], twoHanded: false },
        { text: "lets her hair down after a shower", motion: "she shakes her hair out a little", captures: ["mirror-hidden", "mirror"], twoHanded: false, hair: "own" },
        { text: "rests her hip on the counter", motion: "she tilts her head a little", captures: ["mirror-hidden", "mirror"], twoHanded: false, level: "flirty" },
        { text: "stands side-on by the door", motion: "she rolls one shoulder slowly", captures: ["mirror-hidden"], twoHanded: false, angle: "three-quarter", mirrorBack: true, level: "bold", route: "seedream" },
      ],
    },
    {
      name: "her bedroom floor",
      at: "on the floor of her bedroom",
      room: true,
      details: ["a foam roller by the bed", "a plant in the corner"],
      times: ["morning", "evening"],
      moments: [
        { text: "stretches into a side bend", motion: "she leans a little further", captures: ["timer"], twoHanded: false, angle: "profile", hair: "sport" },
        { text: "sits with her soles together", motion: "she presses her knees down gently", captures: ["timer"], twoHanded: true, hair: "sport" },
        { text: "pulls one knee to her chest", motion: "she draws her knee in a little", captures: ["timer"], twoHanded: true, hair: "sport" },
        { text: "lies back, one leg raised", motion: "she lowers her leg slowly", captures: ["timer"], twoHanded: false, hair: "sport", level: "flirty", noLegwear: true },
        { text: "kneels, arching her back a little", motion: "she arches a little further", captures: ["timer"], twoHanded: false, level: "bold", route: "seedream" },
        { text: "sits with both legs out straight", motion: "she flexes her feet slowly", captures: ["pov-legs"], twoHanded: false, outfits: LEGS, legs: { framing: "legs" } },
      ],
    },
    {
      name: "her bed",
      at: "on her bed",
      room: true,
      details: ["a glass of water on the nightstand", "a pair of sneakers by the bed"],
      times: ["morning", "evening"],
      moments: [
        { text: "lies back after a long workout", motion: "she lets one arm flop out slowly", captures: ["above"], twoHanded: false, hair: "sport" },
        { text: "lies on her side, worn out", motion: "she slowly closes her eyes", captures: ["above"], twoHanded: false },
        { text: "lies prone, cheek on one arm", motion: "she swings her feet a little", captures: ["prone"], twoHanded: false, handAtFace: true, outfits: PRONE, noLegwear: true },
        { text: "lies prone, crossing her ankles", motion: "she crosses her ankles the other way slowly", captures: ["over-shoulder"], twoHanded: false, angle: "three-quarter", outfits: PRONE, noLegwear: true },
        { text: "lies back, hand on her stomach", motion: "she breathes in slowly", captures: ["above"], twoHanded: false, level: "flirty" },
        { text: "lies prone, hips to one side", motion: "she shifts her hips a little", captures: ["prone"], twoHanded: false, level: "bold", route: "seedream", outfits: PRONE, noLegwear: true },
        // P-BA F2: on her stomach, a towel over her hips, her bare back; drawn with its kept sentence. Her gaze stays on her feet (the probe drew her looking at the camera).
        { text: "lies prone, glancing at her feet", motion: "she lets her feet sway slowly behind her", captures: ["over-shoulder"], twoHanded: false, angle: "three-quarter", gaze: "own", noLegwear: true, ...HIP_TOWEL_PIN },
        // P-BA L1: the sports set drew on a legs frame.
        { text: "rests after a workout, legs crossed", motion: "she bounces her crossed foot a little", captures: ["pov-legs"], twoHanded: false, outfits: LEGS, legs: { framing: "legs" } },
      ],
    },
  ],
  outfits: OUTFITS,
  legwear: {
    items: ["thigh-high socks"],
    share: 0.2,
    bold: { items: ["sheer black stockings", "black thigh-high stockings"], share: 0.5, route: "seedream", outfits: [SATIN_CAMI.text, SATIN_MIDI.text, SATIN_ROBE.text, BLACK_LACE.text, WHITE_LACE.text, LACE_BRALETTE.text, BODYSUIT.text] },
  },
  // She shoots herself: 3 timers of 11, 2 mirrors, 2 phone-over-face mirror frames, 2 from above, 1 prone, 1 over her shoulder. Never a friend.
  captureDeck: ["timer", "mirror", "mirror-hidden", "above", "timer", "prone", "mirror", "mirror-hidden", "over-shoulder", "timer", "above"],
};
