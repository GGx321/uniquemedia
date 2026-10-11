import type { CategoryBank } from "./types";

// «Дом» (plan s5a2 r1.2 §5.1, the owner's references of 2026-10-11): she shoots herself. About a third of the frames are mirror selfies with the
// phone over her face; close selfies from above as she lies on the bed; the prone selfie (lying on her stomach, arms out toward the phone, the curve
// of her back and hips behind her head) in the one outfit its probe drew; on the bed from behind; sitting or kneeling at the mirror; the side profile
// in the mirror. Lamp light at evening and night. Legwear is its own slot. Never a friend (I5.32): no moment here fits one. Satin nightdresses, legs-up
// in tights and boots, and bikinis were refused by Grok and wait for «Смелая» (5a.3).

/** The prone selfie's outfits: Grok drew it in grey lounge shorts and in grey leggings and refused it in cotton shorts (the probes), so every
 *  moment that lies on her stomach pins these. */
const PRONE_OUTFIT = "grey lounge shorts and a fitted tee";
const LEGGINGS = "grey leggings and a cropped tee";
const PRONE = [PRONE_OUTFIT, LEGGINGS];
/** The over-her-shoulder POV's outfits: her feet raised in platform sneakers, in leggings or lounge shorts (the owner, 2026-10-11). */
const SNEAKERS = ["grey leggings and platform sneakers", "lounge shorts and platform sneakers"];
/** The bathroom counter mirror selfie's outfit, as the owner approved it. */
const OPEN_BACK = "an open-back top and grey jeans";

export const HOME: CategoryBank = {
  places: [
    {
      name: "her bedroom",
      at: "in her bedroom",
      room: true,
      lamp: true,
      mirror: true,
      details: ["a string of fairy lights", "a bedside lamp", "a plain wall behind her"],
      times: ["morning", "evening", "night"],
      moments: [
        { text: "stands sideways to the mirror", motion: "she turns her hips a little", captures: ["mirror"], twoHanded: false, angle: "three-quarter" },
        { text: "stands with her weight on one hip", motion: "she shifts her weight slowly", captures: ["mirror-hidden", "mirror"], twoHanded: false },
        { text: "adjusts the hem of her top", motion: "she smooths the hem down slowly", captures: ["mirror-hidden", "mirror", "timer"], twoHanded: false, gaze: "focus" },
        { text: "tucks her hair behind one ear", motion: "she tucks her hair back slowly", captures: ["mirror", "timer"], twoHanded: false, hair: "own" },
        { text: "sits on the edge of the bed", motion: "she swings one foot a little", captures: ["mirror-hidden", "timer"], twoHanded: false },
      ],
    },
    {
      name: "her bed",
      at: "on her bed",
      room: true,
      lamp: true,
      mirror: true,
      details: ["a bedside lamp", "a glass of water on the nightstand"],
      times: ["morning", "evening", "night"],
      moments: [
        { text: "lies back on the pillow", motion: "she slowly blinks and smiles", captures: ["above"], twoHanded: false, messyOk: true },
        { text: "lies on her side, head on her hand", motion: "she smiles a little and looks away", captures: ["above", "timer"], twoHanded: false },
        {
          text: "lies on her stomach, arms out",
          motion: "she lifts her hips a little",
          startPose: "flat on her stomach, hips down",
          captures: ["prone"],
          twoHanded: false,
          outfits: PRONE,
        },
        { text: "lies on her stomach, feet raised", motion: "her raised feet swing slowly", captures: ["prone"], twoHanded: false, outfits: PRONE, noLegwear: true },
        { text: "lies on her stomach, legs bent up", motion: "she kicks her feet slowly", captures: ["timer"], twoHanded: false, angle: "back", outfits: PRONE, noLegwear: true },
        { text: "lies on her stomach, hips behind", motion: "she lifts her hips a little", captures: ["mirror-hidden"], twoHanded: false, outfits: PRONE },
        { text: "lies on her stomach, on her elbows", motion: "she shifts her hips a little", captures: ["mirror-hidden"], twoHanded: false, outfits: PRONE },
        { text: "lies prone, her cheek on her hand", motion: "she slowly blinks and smiles", captures: ["prone"], twoHanded: false, outfits: PRONE },
        { text: "lies prone, sneakers raised behind", motion: "her raised sneakers swing slowly behind her", captures: ["over-shoulder"], twoHanded: false, outfits: SNEAKERS, noLegwear: true },
        { text: "lies prone, feet up in sneakers", motion: "she crosses her raised ankles slowly", captures: ["over-shoulder"], twoHanded: false, outfits: SNEAKERS, noLegwear: true },
        { text: "lies prone, glancing back", motion: "she turns her head a little further", captures: ["over-shoulder"], twoHanded: false, gaze: "own", outfits: SNEAKERS, noLegwear: true },
        { text: "sits cross-legged", motion: "she rocks a little side to side", captures: ["timer"], twoHanded: false },
        { text: "rests her cheek on the pillow", motion: "she slowly closes her eyes", captures: ["above"], twoHanded: false },
        { text: "lies curled under the blanket", motion: "she pulls the blanket up a little", captures: ["above", "timer"], twoHanded: false, messyOk: true },
        { text: "lies prone, hips behind to one side", motion: "she shifts her hips a little", captures: ["prone"], twoHanded: false, outfits: PRONE },
        { text: "lies on her stomach, head tilted", motion: "she tilts her head a little", captures: ["prone"], twoHanded: false, outfits: PRONE },
      ],
    },
    {
      name: "the floor of her bedroom",
      at: "on the floor of her bedroom",
      room: true,
      lamp: true,
      mirror: true,
      details: ["a tall lamp in the corner", "a plant by the wall"],
      times: ["evening", "night"],
      moments: [
        { text: "sits on the rug facing the mirror", motion: "she leans back a little", captures: ["mirror-hidden", "mirror"], twoHanded: false },
        { text: "sits with her legs to one side", motion: "she leans back a little", captures: ["mirror-hidden", "mirror", "timer"], twoHanded: false },
        { text: "sits hugging her knees", motion: "she rocks a little on the floor", captures: ["timer"], twoHanded: true },
        { text: "leans back on her hands on the rug", motion: "she tilts her head a little", captures: ["timer"], twoHanded: true },
        { text: "lies on her stomach on the rug", motion: "she lifts her hips a little", captures: ["prone"], twoHanded: false, outfits: PRONE },
        { text: "lies back on the rug", motion: "she slowly turns her head", captures: ["above", "timer"], twoHanded: false },
      ],
    },
    {
      name: "her bathroom",
      at: "in her bathroom",
      room: true,
      mirror: true,
      details: ["a towel on the hook", "a plant on the windowsill"],
      times: ["morning", "evening"],
      moments: [
        { text: "sits on the counter by the mirror", motion: "she swings one foot a little", captures: ["mirror-hidden"], twoHanded: false, angle: "three-quarter", outfits: [OPEN_BACK] },
        { text: "leans on the edge of the sink", motion: "she leans in a little", captures: ["mirror-hidden", "mirror"], twoHanded: false },
        { text: "brushes her hair", motion: "she brushes slowly", captures: ["mirror"], twoHanded: false, hair: "own" },
        { text: "applies lip balm", motion: "she presses her lips a bit", captures: ["mirror"], twoHanded: false, gaze: "focus" },
        { text: "sits on the edge of the bathtub", motion: "she swings one foot a little", captures: ["mirror-hidden", "timer"], twoHanded: false },
      ],
    },
    {
      name: "her hallway",
      at: "in her hallway",
      mirror: true,
      details: ["a coat rack", "a row of shoes"],
      times: ["morning", "evening"],
      moments: [
        { text: "checks her outfit before going out", motion: "she turns a little to each side", captures: ["mirror-hidden", "mirror"], twoHanded: false },
        { text: "grabs her keys from the hook", motion: "she jingles her keys a little", captures: ["mirror-hidden", "mirror"], twoHanded: false },
        { text: "leans on the wall by the door", motion: "she shifts her shoulder slowly", captures: ["mirror", "timer"], twoHanded: false },
        { text: "waits by the door, ready to go", motion: "she shifts her weight a little", captures: ["mirror-hidden", "mirror", "timer"], twoHanded: false },
      ],
    },
    {
      name: "a chair in her bedroom",
      at: "on a chair in her bedroom",
      room: true,
      lamp: true,
      mirror: true,
      details: ["a cardigan over the chair", "a plant on the windowsill"],
      times: ["evening", "night"],
      moments: [
        { text: "sits with one leg crossed", motion: "she wiggles her crossed foot a bit", captures: ["mirror-hidden", "mirror", "timer"], twoHanded: false },
        { text: "sits sideways, knees together", motion: "she rocks a little in place", captures: ["mirror-hidden", "mirror"], twoHanded: false },
        { text: "pulls one knee up to her chest", motion: "she rests her cheek a little lower", captures: ["mirror-hidden", "timer"], twoHanded: false },
        { text: "sits back with her arms crossed", motion: "she taps her fingers a little", captures: ["timer"], twoHanded: true },
      ],
    },
  ],
  outfits: [
    { text: "an oversized tee off one shoulder", showsLegs: true },
    { text: "an oversized sweater as a dress", showsLegs: true },
    { text: "a crop top and pajama shorts", showsLegs: true },
    { text: "a pleated mini and a fitted top", showsLegs: true },
    { text: "silk pajamas" },
    { text: PRONE_OUTFIT, showsLegs: true },
    { text: LEGGINGS },
    { text: OPEN_BACK },
    { text: "grey leggings and platform sneakers" },
    { text: "lounge shorts and platform sneakers", showsLegs: true },
  ],
  legwear: { items: ["white knee-high socks", "black knee-high socks", "thigh-high socks", "sheer black tights"], share: 0.4 },
  // ⅓ phone-over-face mirror frames (I5.32), never a friend; the prone selfie and the over-her-shoulder POV share the prone body's 1 in 6.
  captureDeck: ["mirror-hidden", "mirror", "above", "mirror-hidden", "prone", "timer", "mirror-hidden", "mirror", "above", "mirror-hidden", "over-shoulder", "timer"],
};
