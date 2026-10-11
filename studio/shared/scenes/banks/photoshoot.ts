import type { CategoryBank } from "./types";

// «Улица» (the stored id `photoshoot`/`shoot` stays, I5.33; plan s5a2 r1.2 §5.1): on the street she mostly asks someone, a friend or a passer-by,
// at natural angles; some selfies, the phone on a timer on a ledge, a candid. Posing by an object (a lamppost, a shop window) is a moment
// (`object`), and «from behind, looking back» is a three-quarter moment that carries its own gaze.
export const PHOTOSHOOT: CategoryBank = {
  places: [
    {
      name: "a colourful painted wall",
      at: "against a colourful painted wall",
      details: ["a bicycle against the wall", "some weeds by the pavement"],
      times: ["midday", "golden hour"],
      moments: [
        { text: "leans back against the wall", motion: "she shifts her weight a little", captures: ["friend", "timer", "selfie"], twoHanded: false, outdoor: true },
        { text: "looks back over her shoulder", motion: "she turns her head a little more", captures: ["friend"], twoHanded: false, angle: "three-quarter", gaze: "own", outdoor: true },
        { text: "walks past the wall mid-step", motion: "she keeps walking slowly", captures: ["friend", "candid"], twoHanded: false, outdoor: true },
        { text: "adjusts the strap of her bag", motion: "she tugs the strap a little", captures: ["candid", "friend", "selfie"], twoHanded: false, gaze: "focus", outdoor: true },
        { text: "rests one foot against the wall", motion: "she taps her raised foot slowly", captures: ["friend", "timer"], twoHanded: false, outdoor: true },
      ],
    },
    {
      name: "a cafe table on the pavement",
      at: "at a cafe table on the pavement",
      details: ["a cup and saucer", "a small vase on the table", "a croissant on a plate"],
      times: ["morning", "midday"],
      moments: [
        { text: "sits at the table, legs crossed", motion: "she swings her crossed foot slowly", captures: ["timer", "friend"], twoHanded: false },
        { text: "rests her chin on her hand", motion: "she tilts her head a little", captures: ["friend", "selfie", "timer"], twoHanded: false },
        { text: "stirs her coffee", motion: "she stirs slowly", captures: ["candid", "friend"], twoHanded: false, gaze: "focus" },
        { text: "laughs, looking down the street", motion: "she laughs a little and looks away", captures: ["candid", "friend"], twoHanded: false, gaze: "own" },
        { text: "sips her coffee", motion: "she lowers the cup a little", captures: ["selfie", "friend", "candid"], twoHanded: false },
      ],
    },
    {
      name: "a lamppost on a quiet street",
      at: "by a lamppost on a quiet street",
      details: ["a row of parked bikes", "a low hedge behind her"],
      times: ["golden hour", "evening"],
      moments: [
        { text: "leans on the lamppost", motion: "she sways a little on the post", captures: ["friend", "timer", "candid", "selfie"], twoHanded: false, object: true },
        { text: "holds the lamppost with one hand", motion: "she leans out a little and back", captures: ["friend", "selfie"], twoHanded: false, object: true },
        { text: "walks toward the viewer mid-step", motion: "she keeps walking slowly", captures: ["friend"], twoHanded: false, gaze: "viewer" },
        { text: "waits to cross the street", motion: "she shifts her weight a little", captures: ["candid", "friend", "selfie"], twoHanded: false },
        { text: "looks back over her shoulder", motion: "she turns her head a little more", captures: ["friend"], twoHanded: false, angle: "three-quarter", gaze: "own" },
      ],
    },
    {
      name: "a railing by the road",
      at: "at a railing by the road",
      details: ["a few parked scooters", "a low stone wall"],
      times: ["midday", "golden hour"],
      moments: [
        { text: "sits on the railing", motion: "she swings one foot a little", captures: ["friend", "timer", "selfie", "candid"], twoHanded: false, outdoor: true },
        { text: "leans her arms on the railing", motion: "she rests her chin down slowly", captures: ["friend", "timer", "candid"], twoHanded: true, outdoor: true },
        { text: "looks out at the passing cars", motion: "she turns her head slowly", captures: ["candid", "friend"], twoHanded: false, gaze: "own", outdoor: true },
        { text: "holds a takeaway coffee", motion: "she lifts the cup a little", captures: ["selfie", "friend"], twoHanded: false, outdoor: true },
      ],
    },
    {
      name: "a city street at night",
      at: "on a city street at night",
      details: ["a lit shop window behind her", "a parked scooter by the curb", "the wet pavement under a lamp"],
      times: ["night"],
      moments: [
        { text: "walks down the street", motion: "she keeps walking slowly", captures: ["friend", "candid"], twoHanded: false },
        { text: "stops under a street lamp", motion: "she tilts her head a little", captures: ["friend", "timer", "selfie"], twoHanded: false },
        { text: "looks back over her shoulder", motion: "she turns her head a little more", captures: ["friend"], twoHanded: false, angle: "three-quarter", gaze: "own" },
        { text: "waits to cross the street", motion: "she shifts her weight a little", captures: ["candid", "friend", "selfie"], twoHanded: false },
        { text: "leans against a shop window", motion: "she shifts against the glass a bit", captures: ["friend", "timer"], twoHanded: false, object: true },
      ],
    },
  ],
  outfits: [
    { text: "a fitted mini dress", showsLegs: true },
    { text: "a mini dress with thin straps", showsLegs: true },
    { text: "a hoodie, a mini skirt and sneakers", showsLegs: true },
    { text: "a denim jacket and jeans" },
    { text: "a red mini dress", showsLegs: true },
  ],
  captureDeck: ["friend", "selfie", "friend", "timer", "friend", "candid"],
};
