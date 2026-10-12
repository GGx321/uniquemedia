import type { CategoryBank } from "./types";

// «Дом» (plan s5a2 r1.2 §5.1, the owner's references of 2026-10-11): she shoots herself. About a third of the frames are mirror selfies with the
// phone over her face; close selfies from above as she lies on the bed; the prone selfie (lying on her stomach on the bed, one arm out toward the phone,
// the other hand free, the curve of her back and hips behind her) in the outfits its probe drew; the over-her-shoulder look back along her prone body;
// sitting at the mirror; and, side to the mirror, only her reflection (`mirrorBack`). Lamp light at evening and night. Legwear is its own slot. Never a friend (I5.32): no moment here fits one. Satin nightdresses, legs-up
// in tights and boots, and bikinis were refused by Grok and wait for «Смелая» (5a.3).

/** The prone selfie's outfits: Grok drew it in grey lounge shorts and in grey leggings and refused it in cotton shorts (the probes), so every
 *  moment that lies on her stomach pins these. S5.6R: and wears no legwear (`noLegwear`): the approved prone frames had bare legs. C3′: every skirt and
 *  shorts names its fabric (an unnamed one is drawn as denim), so the lounge shorts are jersey, never «cotton» (the refused wording); C4 checks the prone frames again. */
const PRONE_OUTFIT = "grey jersey lounge shorts and a tee";
const LEGGINGS = "grey leggings and a cropped tee";
const PRONE = [PRONE_OUTFIT, LEGGINGS];
/** The over-her-shoulder POV's outfits: her feet raised in platform sneakers, in leggings or lounge shorts (the owner, 2026-10-11). */
const SNEAKERS = ["grey leggings and platform sneakers", "jersey shorts and platform sneakers"];
/** The bathroom counter mirror selfie's outfit, as the owner approved it. */
const OPEN_BACK = "an open-back top and grey jeans";
/** S5.6R: what she wears on her way out (the hallway's going-out moments pin these): never pajamas, lounge shorts or leggings. */
const GOING_OUT_DRESS = "a knit midi dress and ankle boots";
const GOING_OUT = [OPEN_BACK, "a pleated wool mini skirt and a top", GOING_OUT_DRESS];
/**
 * S5.8a review: a low angle under a mini reads as an upskirt shot, so the legs moments wear shorts, trousers, leggings or joggers, never the mini or the tee or sweater worn as a dress.
 * The bedroom's (toward the mirror, along the bed) are pajamas and shorts; the bed's may also wear the lounge shorts and leggings that only the bed pins.
 */
const LEGS_BEDROOM = ["a crop top and cotton pajama shorts", "silk pajamas", "linen shorts and a fitted tee", "soft joggers and a cropped tee", "a tank top and cotton sleep shorts", "a crop hoodie and lycra bike shorts", "a ribbed tank, knit lounge shorts", "a loose tee and cotton gym shorts"];
const LEGS_BED = ["a crop top and cotton pajama shorts", PRONE_OUTFIT, LEGGINGS, "soft joggers and a cropped tee", "a tank top and cotton sleep shorts", "a crop hoodie and lycra bike shorts", "a ribbed tank, knit lounge shorts", "a loose tee and cotton gym shorts"];

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
        { text: "stands sideways to the mirror", motion: "she turns her hips a little", captures: ["mirror-hidden"], twoHanded: false, angle: "three-quarter", mirrorBack: true },
        { text: "stands with her weight on one hip", motion: "she shifts her weight slowly", captures: ["mirror-hidden", "mirror"], twoHanded: false },
        { text: "adjusts the hem of her top", motion: "she smooths the hem down slowly", captures: ["mirror-hidden", "mirror", "timer"], twoHanded: false, gaze: "focus" },
        { text: "tucks her hair behind one ear", motion: "she tucks her hair back slowly", captures: ["mirror", "timer"], twoHanded: false, hair: "own" },
        { text: "sits on the edge of the bed", motion: "she swings one foot a little", captures: ["mirror-hidden", "timer"], twoHanded: false },
        // S5.7b: the angle comes from the moment. On a timer the phone stands across the room, so she can face the window with her back to it. C3′ (the owner:
        // «просто стоит спиной без какой-либо позы»): from behind she does something the frame can read, here a stretch at the window.
        { text: "stretches her arms up at the window", motion: "she stretches a little further", captures: ["timer"], twoHanded: true, angle: "back" },
        // S5.8a («Ножки», plan s5a2 §7.2): legs moments, drawn only on a legs slot. The POV looks down along her own legs; in the mirror frame the phone hides her face and her feet face the glass.
        { text: "stretches her legs along the bed", motion: "she points and flexes her toes slowly", captures: ["pov-legs"], twoHanded: false, outfits: LEGS_BEDROOM, legs: { framing: "legs" } },
        { text: "sits, soles toward the mirror", motion: "she taps her feet together a little", captures: ["mirror-hidden"], twoHanded: false, outfits: LEGS_BEDROOM, legs: { framing: "legs" } },
        { text: "lifts one bare foot to the mirror", motion: "she lifts her foot a little and lowers it", captures: ["mirror-hidden"], twoHanded: false, outfits: LEGS_BEDROOM, legs: { framing: "legs" } },
        { text: "sits on the rug, legs stretched out", motion: "she flexes her feet a little", captures: ["pov-legs"], twoHanded: false, outfits: LEGS_BEDROOM, legs: { framing: "legs" } },
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
        { text: "lies on her side, head on her hand", motion: "she smiles a little and looks away", captures: ["above", "timer"], twoHanded: false, handAtFace: true },
        {
          text: "lies on her stomach, one arm out",
          motion: "she lifts her hips a little",
          startPose: "flat on her stomach, hips down",
          captures: ["prone"],
          twoHanded: false,
          outfits: PRONE,
          noLegwear: true,
        },
        { text: "lies on her stomach, feet raised", motion: "her raised feet swing slowly", captures: ["prone"], twoHanded: false, outfits: PRONE, noLegwear: true },
        // S5.7b («Кокетливая», the owner: «кокетливо пойдёт»): on her bed only, in the prone selfie's outfits, her feet up; and a knees-hugged timer frame.
        { text: "lies on her stomach, feet up", motion: "her raised feet swing slowly behind her", captures: ["prone"], twoHanded: false, level: "flirty", outfits: PRONE, noLegwear: true },
        { text: "sits hugging her knees", motion: "she rocks a little and smiles", captures: ["timer"], twoHanded: true, level: "flirty" },
        { text: "lies on her stomach, legs bent up", motion: "she kicks her feet slowly", captures: ["timer"], twoHanded: false, angle: "back", outfits: PRONE, noLegwear: true },
        { text: "lies on her stomach, hips behind", motion: "she lifts her hips a little", captures: ["mirror-hidden"], twoHanded: false, outfits: PRONE, noLegwear: true },
        { text: "lies on her stomach, on her elbows", motion: "she shifts her hips a little", captures: ["mirror-hidden"], twoHanded: false, outfits: PRONE, noLegwear: true },
        { text: "lies prone, her cheek on her hand", motion: "she slowly blinks and smiles", captures: ["prone"], twoHanded: false, outfits: PRONE, handAtFace: true, noLegwear: true },
        // S5.6R: the pinned outfit already names the platform sneakers, so the moment names her feet, never the sneakers a second time.
        { text: "lies prone, feet raised behind", motion: "her raised feet swing slowly behind her", captures: ["over-shoulder"], twoHanded: false, angle: "three-quarter", outfits: SNEAKERS, noLegwear: true },
        { text: "lies prone, ankles crossed behind", motion: "she crosses her raised ankles slowly", captures: ["over-shoulder"], twoHanded: false, angle: "three-quarter", outfits: SNEAKERS, noLegwear: true },
        { text: "lies prone, glancing back", motion: "she turns her head a little further", captures: ["over-shoulder"], twoHanded: false, angle: "three-quarter", gaze: "own", outfits: SNEAKERS, noLegwear: true },
        { text: "sits cross-legged", motion: "she rocks a little side to side", captures: ["timer"], twoHanded: false },
        { text: "rests her cheek on the pillow", motion: "she slowly closes her eyes", captures: ["above"], twoHanded: false },
        { text: "lies curled under the blanket", motion: "she pulls the blanket up a little", captures: ["above", "timer"], twoHanded: false, messyOk: true },
        { text: "lies prone, hips behind to one side", motion: "she shifts her hips a little", captures: ["prone"], twoHanded: false, outfits: PRONE, noLegwear: true },
        { text: "lies on her stomach, head tilted", motion: "she tilts her head a little", captures: ["prone"], twoHanded: false, outfits: PRONE, noLegwear: true },
        // S5.8a: the bare and socked feet toward the viewer are a POV from where she lies or sits (the owner: at home she shoots herself, so not the friend's `low-feet`); the compositions are the approved ones.
        { text: "lies with her bare feet forward", motion: "she wiggles her toes a little", captures: ["pov-legs"], twoHanded: false, outfits: LEGS_BED, legs: { framing: "legs" } },
        { text: "sits with her socked feet forward", motion: "she crosses and uncrosses her ankles slowly", captures: ["pov-legs"], twoHanded: false, outfits: LEGS_BED, legs: { framing: "legs" } },
        { text: "lies with her ankles crossed", motion: "she crosses her ankles the other way slowly", captures: ["pov-legs"], twoHanded: false, outfits: LEGS_BED, legs: { framing: "legs" } },
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
        // S5.6R (the owner: prone only on a bed): it was «lies on the rug facing the mirror» in the prone outfits, lifting her hips, a prone frame off the bed.
        { text: "sits with her legs stretched out", motion: "she flexes her feet a little", captures: ["mirror-hidden", "mirror"], twoHanded: false },
        { text: "lies back on the rug", motion: "she slowly turns her head", captures: ["above", "timer"], twoHanded: false },
        { text: "sits side-on, hugging her knees", motion: "she rests her chin a little lower", captures: ["timer"], twoHanded: true, angle: "profile" },
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
        { text: "sits on the counter by the mirror", motion: "she swings one foot a little", captures: ["mirror-hidden"], twoHanded: false, angle: "three-quarter", outfits: [OPEN_BACK], mirrorBack: true },
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
        { text: "checks her outfit before going out", motion: "she turns a little to each side", captures: ["mirror-hidden", "mirror"], twoHanded: false, outfits: GOING_OUT },
        { text: "grabs her keys from the hook", motion: "she jingles her keys a little", captures: ["mirror-hidden", "mirror"], twoHanded: false, outfits: GOING_OUT },
        { text: "leans on the wall by the door", motion: "she shifts her shoulder slowly", captures: ["mirror", "timer"], twoHanded: false },
        { text: "waits by the door, ready to go", motion: "she shifts her weight a little", captures: ["mirror-hidden", "mirror", "timer"], twoHanded: false, outfits: GOING_OUT },
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
        // S5.6R: faces the mirror (it was «sits sideways», which a plain mirror selfie drew with her face clear: side to the mirror is reflection-only).
        { text: "sits with her knees together", motion: "she rocks a little in place", captures: ["mirror-hidden", "mirror"], twoHanded: false },
        { text: "pulls one knee up to her chest", motion: "she rests her cheek a little lower", captures: ["mirror-hidden", "timer"], twoHanded: false },
        { text: "sits back with her arms crossed", motion: "she taps her fingers a little", captures: ["timer"], twoHanded: true },
      ],
    },
  ],
  outfits: [
    { text: "an oversized tee off one shoulder", showsLegs: true },
    { text: "an oversized sweater as a dress", showsLegs: true },
    { text: "a crop top and cotton pajama shorts", showsLegs: true },
    { text: "a pleated wool mini skirt and a top", showsLegs: true },
    { text: "silk pajamas" },
    { text: PRONE_OUTFIT, showsLegs: true },
    { text: LEGGINGS },
    { text: OPEN_BACK },
    { text: "grey leggings and platform sneakers", pinOnly: true },
    { text: "jersey shorts and platform sneakers", showsLegs: true, pinOnly: true },
    { text: "linen shorts and a fitted tee", showsLegs: true, pinOnly: true },
    { text: "soft joggers and a cropped tee", pinOnly: true },
    { text: "a tank top and cotton sleep shorts", showsLegs: true, pinOnly: true },
    { text: "a crop hoodie and lycra bike shorts", showsLegs: true, pinOnly: true },
    { text: "a ribbed tank, knit lounge shorts", showsLegs: true, pinOnly: true },
    { text: "a loose tee and cotton gym shorts", showsLegs: true, pinOnly: true },
    { text: GOING_OUT_DRESS, pinOnly: true },
  ],
  legwear: { items: ["white knee-high socks", "black knee-high socks", "thigh-high socks", "sheer black tights"], share: 0.4 },
  // ⅓ phone-over-face mirror frames (I5.32), never a friend; 2 prone selfies and 1 over-her-shoulder POV of 12 (plan r1.5 §5.1: prone selfies are a typical owner subject), 2 close selfies from above, 2 mirrors, 1 timer.
  captureDeck: ["mirror-hidden", "mirror", "above", "mirror-hidden", "prone", "timer", "mirror-hidden", "mirror", "above", "mirror-hidden", "over-shoulder", "prone"],
};
