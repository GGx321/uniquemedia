import type { CategoryBank } from "./types";

// «Улица» (the stored id `photoshoot`/`shoot` stays, I5.33; plan s5a2 r1.2 §5.1): on the street she mostly asks someone, a friend or a passer-by,
// at natural angles; some selfies, the phone on a timer on a ledge, a candid. Posing by an object (a lamppost, a shop window) is a moment
// (`object`), and «from behind, looking back» is a three-quarter moment that carries its own gaze.
/** S5.8a review: a friend's photo from below wears trousers, jeans or a midi dress, never a mini (a low angle under a mini reads as an upskirt shot). */
const LEGS_STREET = ["a denim jacket and jeans", "cropped trousers and a fitted top", "a linen midi dress", "wide jeans and a knit top", "a striped top and cropped jeans"];

export const PHOTOSHOOT: CategoryBank = {
  places: [
    {
      name: "a colourful side street",
      at: "on a colourful side street",
      details: ["a bicycle by the curb", "some weeds by the pavement"],
      times: ["midday", "golden hour"],
      moments: [
        { text: "leans back against a painted wall", motion: "she shifts her weight a little", captures: ["friend", "timer", "selfie"], twoHanded: false, outdoor: true },
        { text: "looks back over her shoulder", motion: "she turns her head a little more", captures: ["friend"], twoHanded: false, angle: "three-quarter", gaze: "own", outdoor: true },
        { text: "walks past mid-step", motion: "she keeps walking slowly", captures: ["friend", "candid"], twoHanded: false, outdoor: true },
        { text: "adjusts the strap of her bag", motion: "she tugs the strap a little", captures: ["candid", "friend", "selfie"], twoHanded: false, gaze: "focus", outdoor: true },
        { text: "rests one foot against the wall", motion: "she taps her raised foot slowly", captures: ["friend", "timer"], twoHanded: false, outdoor: true },
        // S5.7b: the angle comes from the moment; a friend or a passer-by can shoot her from behind or from the side.
        { text: "walks away down the road", motion: "she keeps walking slowly", captures: ["friend", "candid"], twoHanded: false, angle: "back", outdoor: true },
      ],
    },
    {
      name: "a cafe table on the pavement",
      at: "at a cafe table on the pavement",
      details: ["a cup and saucer", "a small vase of flowers", "a croissant on a plate"],
      times: ["morning", "midday"],
      moments: [
        { text: "sits with her legs crossed", motion: "she swings her crossed foot slowly", captures: ["timer", "friend"], twoHanded: false },
        { text: "rests her chin on her hand", motion: "she tilts her head a little", captures: ["friend", "selfie", "timer"], twoHanded: false },
        { text: "stirs her coffee", motion: "she stirs slowly", captures: ["candid", "friend"], twoHanded: false, gaze: "focus" },
        { text: "laughs, looking down the street", motion: "she laughs a little and looks away", captures: ["candid", "friend"], twoHanded: false, gaze: "own", expression: true },
        { text: "sips her coffee", motion: "she lowers the cup a little", captures: ["selfie", "friend", "candid"], twoHanded: false },
        { text: "turns to look across the road", motion: "she turns her head slowly", captures: ["friend", "candid", "timer"], twoHanded: false, gaze: "own", angle: "profile" },
        // S5.8a («Ножки»): outside, a friend crouches a couple of metres away, low down near her feet.
        { text: "sits with her ankles crossed", motion: "she shifts her crossed ankles slowly", captures: ["low-feet"], twoHanded: false, outfits: LEGS_STREET, legs: { framing: "legs" } },
        { text: "sits with one knee over the other", motion: "she tilts her raised foot slowly", captures: ["low-feet"], twoHanded: false, outfits: LEGS_STREET, legs: { framing: "legs" } },
      ],
    },
    {
      name: "a quiet street corner",
      at: "on a quiet street corner",
      details: ["a row of parked bikes", "a low hedge behind her"],
      times: ["golden hour", "evening"],
      moments: [
        { text: "leans on a lamppost", motion: "she sways a little on the post", captures: ["friend", "timer", "candid", "selfie"], twoHanded: false, object: true },
        { text: "holds a lamppost with one hand", motion: "she leans out a little and back", captures: ["friend", "selfie"], twoHanded: false, object: true },
        { text: "walks toward the viewer mid-step", motion: "she keeps walking slowly", captures: ["friend"], twoHanded: false, gaze: "viewer" },
        { text: "waits at the crossing", motion: "she shifts her weight a little", captures: ["candid", "friend", "selfie"], twoHanded: false },
        { text: "looks back over her shoulder", motion: "she turns her head a little more", captures: ["friend"], twoHanded: false, angle: "three-quarter", gaze: "own" },
        { text: "waits with her back turned", motion: "she shifts her weight a little", captures: ["friend", "candid"], twoHanded: false, angle: "back" },
        // S5.8a review: a second place for «Ножки», so the legs frames of «Улица» are not one sentence.
        { text: "sits on the steps, legs out", motion: "she flexes her feet a little", captures: ["low-feet"], twoHanded: false, outfits: LEGS_STREET, legs: { framing: "legs" } },
      ],
    },
    {
      name: "a busy road",
      at: "by a busy road",
      details: ["a few parked scooters", "a low stone wall"],
      times: ["midday", "golden hour"],
      moments: [
        { text: "sits on the railing", motion: "she swings one foot a little", captures: ["friend", "timer", "selfie", "candid"], twoHanded: false, outdoor: true },
        { text: "leans her arms on the railing", motion: "she rests her chin down slowly", captures: ["friend", "timer", "candid"], twoHanded: true, outdoor: true },
        { text: "looks out at the passing cars", motion: "she turns her head slowly", captures: ["candid", "friend"], twoHanded: false, gaze: "own", angle: "three-quarter", outdoor: true },
        { text: "holds a takeaway coffee", motion: "she lifts the cup a little", captures: ["selfie", "friend"], twoHanded: false, outdoor: true },
        { text: "stands in profile by the cars", motion: "she turns her head slowly", captures: ["friend", "candid"], twoHanded: false, gaze: "own", angle: "profile", outdoor: true },
      ],
    },
    {
      name: "a city street at night",
      at: "on a city street at night",
      details: ["a parked scooter", "the wet pavement"],
      times: ["night"],
      moments: [
        { text: "walks along, mid-step", motion: "she keeps walking slowly", captures: ["friend", "candid"], twoHanded: false },
        { text: "stops under a lamp", motion: "she tilts her head a little", captures: ["friend", "timer", "selfie"], twoHanded: false },
        { text: "looks back over her shoulder", motion: "she turns her head a little more", captures: ["friend"], twoHanded: false, angle: "three-quarter", gaze: "own" },
        { text: "waits at the crossing", motion: "she shifts her weight a little", captures: ["candid", "friend", "selfie"], twoHanded: false },
        { text: "leans against a shop window", motion: "she shifts against the glass a bit", captures: ["friend", "timer"], twoHanded: false, object: true },
        { text: "walks away under the lights", motion: "she keeps walking slowly", captures: ["friend", "candid"], twoHanded: false, angle: "back" },
      ],
    },
  ],
  outfits: [
    { text: "a fitted mini dress", showsLegs: true },
    { text: "a mini dress with thin straps", showsLegs: true },
    { text: "a hoodie, a mini skirt and sneakers", showsLegs: true },
    { text: "a denim jacket and jeans" },
    { text: "a red mini dress", showsLegs: true },
    { text: "cropped trousers and a fitted top", showsLegs: true, pinOnly: true },
    { text: "a linen midi dress", showsLegs: true, pinOnly: true },
    { text: "wide jeans and a knit top", showsLegs: true, pinOnly: true },
    { text: "a striped top and cropped jeans", showsLegs: true, pinOnly: true },
  ],
  captureDeck: ["friend", "selfie", "friend", "timer", "friend", "candid"],
};
