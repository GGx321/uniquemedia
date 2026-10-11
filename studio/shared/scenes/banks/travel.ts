import type { CategoryBank } from "./types";

// «Виды» (the stored id `travel` stays, I5.33; plan s5a2 r1.2 §5.1): a balcony over a city, a garden pond, a path above green hills, a river railing.
// As on the street, she mostly asks someone; some selfies, a timer, a candid. The beach leaves for «Пляж и бассейн» (5a.3, «Смелая»).
export const TRAVEL: CategoryBank = {
  places: [
    {
      name: "a balcony over city rooftops",
      at: "on a balcony over city rooftops",
      details: ["an iron railing", "a small table with two cups"],
      times: ["morning", "golden hour", "evening"],
      moments: [
        { text: "leans on the balcony railing", motion: "her hair lifts a little in the wind", captures: ["friend", "timer", "selfie"], twoHanded: false },
        { text: "looks out over the rooftops", motion: "she turns her head slowly", captures: ["friend", "candid"], twoHanded: false, gaze: "own" },
        { text: "sips a coffee by the railing", motion: "she lowers the cup a little", captures: ["selfie", "friend", "candid", "timer"], twoHanded: false },
        { text: "sits with her feet on the railing", motion: "she stretches her toes a little", captures: ["timer", "friend"], twoHanded: false, noLegwear: true },
      ],
    },
    {
      name: "a garden pond",
      at: "by a garden pond",
      details: ["a few lily pads on the water", "a wooden bench nearby", "some reeds at the edge"],
      times: ["morning", "midday", "golden hour"],
      moments: [
        { text: "looks out over the pond", motion: "she slowly turns toward the water", captures: ["friend"], twoHanded: false, gaze: "own", angle: "profile", outdoor: true },
        { text: "crouches at the edge of the pond", motion: "she leans a little toward the water", captures: ["friend", "candid", "timer"], twoHanded: false, outdoor: true },
        { text: "sits on the wooden bench", motion: "she leans back a little", captures: ["friend", "timer", "selfie"], twoHanded: false, outdoor: true },
        { text: "walks along the pond path", motion: "she keeps walking slowly", captures: ["friend", "candid"], twoHanded: false, outdoor: true },
        { text: "sits on the grass by the pond", motion: "she leans back a little", captures: ["friend", "timer", "selfie", "candid"], twoHanded: false, outdoor: true },
      ],
    },
    {
      name: "a dirt path above green hills",
      at: "on a dirt path above green hills",
      details: ["a wooden fence by the path", "a backpack at her feet"],
      times: ["morning", "midday", "golden hour"],
      moments: [
        { text: "shades her eyes with one hand", motion: "she lowers her hand slowly", captures: ["friend", "selfie", "timer"], twoHanded: false, gaze: "own", outdoor: true },
        { text: "walks up the path", motion: "she keeps walking slowly", captures: ["friend", "candid"], twoHanded: false, outdoor: true },
        { text: "sits on the fence by the path", motion: "she swings one foot a little", captures: ["friend", "timer"], twoHanded: false, outdoor: true },
        { text: "takes in the view", motion: "she breathes in slowly and smiles", captures: ["friend", "candid", "selfie", "timer"], twoHanded: false, gaze: "own", outdoor: true },
      ],
    },
    {
      name: "a railing by the river",
      at: "at a railing by the river",
      details: ["a bridge in the distance", "a low stone wall"],
      times: ["morning", "golden hour", "evening"],
      moments: [
        { text: "rests her hands on the railing", motion: "she rises on her toes a little", captures: ["timer", "friend"], twoHanded: true, outdoor: true },
        { text: "leans over the railing", motion: "she leans out a little and back", captures: ["friend", "candid", "timer"], twoHanded: false, outdoor: true },
        { text: "looks out over the water", motion: "she turns her head slowly", captures: ["friend", "candid", "selfie"], twoHanded: false, gaze: "own", outdoor: true },
        { text: "holds a takeaway coffee", motion: "she lifts the cup a little", captures: ["selfie", "friend", "timer"], twoHanded: false, outdoor: true },
      ],
    },
  ],
  outfits: [
    { text: "a sundress", showsLegs: true },
    { text: "a strapless mini dress", showsLegs: true },
    { text: "a tank top, pleated skirt, boots", showsLegs: true },
    { text: "a linen shirt and denim shorts", showsLegs: true },
    { text: "a cotton top and linen trousers" },
  ],
  captureDeck: ["friend", "selfie", "friend", "timer", "friend", "candid"],
};
