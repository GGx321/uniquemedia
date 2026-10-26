import type { CategoryBank, Outfit } from "../types";
import {
  BATH_TOWEL,
  BEDSHEET,
  BEDSHEET_PIN,
  BLACK_LACE,
  BLACK_THONG_SET,
  BODYSUIT,
  CAMI_AND_PANTIES,
  COTTON_SET,
  LACE_BRALETTE,
  LACE_THONG_SET,
  SHEER_SET,
  TANK_AND_BRIEFS,
  TEE_AND_PANTIES,
  TOWEL_PIN,
  WHITE_LACE,
} from "./outfits";

// «rooms» (5a.4, S5.BA2, plan s5a4 §5.3.1): a custom category at «Смелая» away from the water. Generic private places the bold writer sets inside the category's world (her hotel
// room in that city, the cabin of that boat, the bedroom of that chalet), in underwear and lingerie; the towel and the sheet as implied pins (Studio-created avatars only). The
// place names are the five kinds the writer's `place-missing` keys read (S5.BA4). The writer writes every frame (no template sentence), `she {moment}` kept verbatim; a plain
// fallback reads the place's `at`. P-BA drew «her room» in the world «a cafe terrace in Paris» without the lace set's coverage (C1), and «her bathroom» with the towel (C2).

// Review M2 (§5.3.1, §5.9: a custom category is «белье»): underwear and lingerie, no satin.
const OUTFITS: readonly Outfit[] = [
  TEE_AND_PANTIES,
  COTTON_SET,
  CAMI_AND_PANTIES,
  TANK_AND_BRIEFS,
  BLACK_LACE,
  WHITE_LACE,
  LACE_BRALETTE,
  SHEER_SET,
  BODYSUIT,
  LACE_THONG_SET,
  BLACK_THONG_SET,
  BATH_TOWEL,
  BEDSHEET,
];

/** On her stomach: the sets. */
const PRONE = [TEE_AND_PANTIES.text, COTTON_SET.text, CAMI_AND_PANTIES.text, BLACK_LACE.text, WHITE_LACE.text, LACE_THONG_SET.text, BLACK_THONG_SET.text];

export const CUSTOM_ROOMS: CategoryBank = {
  bold: true,
  places: [
    {
      name: "her room",
      at: "in her room",
      room: true,
      lamp: true,
      details: ["a bedside lamp", "a glass of water on the nightstand"],
      times: ["morning", "evening", "night"],
      moments: [
        { text: "lies on her side, half asleep", motion: "she slowly closes her eyes", captures: ["above"], twoHanded: false, messyOk: true },
        { text: "lies prone, resting her chin", motion: "she swings her feet a little", captures: ["prone"], twoHanded: false, outfits: PRONE, noLegwear: true },
        { text: "lies prone, peeking back", motion: "she turns her head a little further", captures: ["over-shoulder"], twoHanded: false, angle: "three-quarter", gaze: "own", outfits: PRONE, noLegwear: true },
        { text: "sits up in bed, knees drawn up", motion: "she rests her chin a little lower", captures: ["timer"], twoHanded: true },
        // P-BA C1: drawn in the white lace set without its coverage, the world «a cafe terrace in Paris».
        { text: "lies back across the bed", motion: "she slowly turns her head and smiles", captures: ["above"], twoHanded: false, level: "flirty" },
        { text: "lies prone, swinging her feet", motion: "her feet swing slowly behind her", captures: ["prone"], twoHanded: false, level: "flirty", outfits: PRONE, noLegwear: true },
        { text: "lies back, one arm up on the pillow", motion: "she stretches slowly and smiles", captures: ["above"], twoHanded: false, level: "bold", route: "seedream" },
        { text: "lies prone, back curved a little", motion: "she lifts her heels a little", captures: ["prone"], twoHanded: false, level: "bold", route: "seedream", outfits: PRONE, noLegwear: true },
        { text: "lies back, the sheet to her chest", motion: "she pulls the sheet up a little", captures: ["above"], twoHanded: false, ...BEDSHEET_PIN },
      ],
    },
    {
      name: "her bathroom",
      at: "in her bathroom",
      room: true,
      mirror: true,
      details: ["a bath mat on the floor", "a bottle of lotion on the shelf"],
      times: ["morning", "evening"],
      moments: [
        { text: "fixes her hair at the mirror", motion: "she tucks a strand back slowly", captures: ["mirror-hidden", "mirror"], twoHanded: false, hair: "own" },
        { text: "stands by the shower, getting ready", motion: "she shifts her weight a little", captures: ["mirror-hidden", "mirror"], twoHanded: false },
        { text: "leans close to the mirror", motion: "she leans in a little closer", captures: ["mirror"], twoHanded: false, level: "flirty" },
        // Her back to the mirror, only her reflection.
        { text: "stands with her back to the mirror", motion: "she turns her head a little more", captures: ["mirror-hidden"], twoHanded: false, angle: "three-quarter", mirrorBack: true, level: "bold", route: "seedream" },
        // P-BA C2: drawn with the towel and its kept sentence.
        { text: "leans on the sink after a shower", motion: "she smooths the towel down slowly", captures: ["mirror-hidden", "mirror"], twoHanded: false, ...TOWEL_PIN },
      ],
    },
    {
      name: "her window",
      at: "by her window",
      room: true,
      details: ["a long curtain", "a plant on the sill"],
      times: ["morning", "evening"],
      moments: [
        { text: "leans against the frame", motion: "she leans her shoulder in a little", captures: ["timer"], twoHanded: false },
        { text: "rests her forehead on the pane", motion: "she lets her shoulders drop slowly", captures: ["timer"], twoHanded: false },
        // C3′: from behind she does something the frame can read.
        { text: "rests her arms on the ledge", motion: "she leans out a little and back", captures: ["timer"], twoHanded: true, angle: "back" },
        { text: "sits on the ledge, legs crossed", motion: "she swings her crossed foot slowly", captures: ["timer"], twoHanded: false, level: "flirty" },
        { text: "stands with one hip on the ledge", motion: "she leans her hip in a little", captures: ["timer"], twoHanded: false, level: "bold", route: "seedream" },
      ],
    },
    {
      name: "her balcony",
      at: "on her balcony",
      details: ["two potted plants", "a folding chair"],
      times: ["morning", "golden hour", "evening"],
      moments: [
        { text: "leans on the railing in the sun", motion: "her hair lifts a little in the wind", captures: ["timer", "selfie"], twoHanded: false },
        { text: "sits with her feet on the rail", motion: "she wiggles her toes a little", captures: ["timer"], twoHanded: false, noLegwear: true },
        { text: "rests her forearms on the railing", motion: "she leans forward a little", captures: ["timer"], twoHanded: true, angle: "back" },
        { text: "sits sideways, knees pulled up", motion: "she hugs her knees a little", captures: ["timer", "selfie"], twoHanded: false, level: "flirty" },
        { text: "leans back on the railing, arms out", motion: "she tips her head back a little", captures: ["timer"], twoHanded: true, level: "bold", route: "seedream" },
      ],
    },
    {
      name: "her sofa",
      at: "on her sofa",
      room: true,
      lamp: true,
      details: ["a floor lamp", "a pile of cushions"],
      times: ["evening", "night"],
      moments: [
        { text: "curls up with her knees in", motion: "she settles a little deeper", captures: ["timer"], twoHanded: false },
        { text: "lies back, head on a pillow", motion: "she turns her head a little", captures: ["above", "timer"], twoHanded: false },
        { text: "lies back, one foot on the backrest", motion: "she taps her raised foot slowly", captures: ["above"], twoHanded: false, level: "flirty", noLegwear: true },
        { text: "lies on her side, top knee forward", motion: "she slides her knee forward a little", captures: ["above", "timer"], twoHanded: false, level: "bold", route: "seedream" },
      ],
    },
  ],
  outfits: OUTFITS,
  // She shoots herself: from above, the mirror, the timer, a selfie on the balcony; never a friend.
  captureDeck: ["above", "mirror-hidden", "timer", "selfie", "mirror", "prone", "timer", "above", "over-shoulder", "mirror-hidden", "timer"],
};
