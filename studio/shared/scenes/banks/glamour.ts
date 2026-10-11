import type { CategoryBank } from "./types";

// «Гламур» = «вечер выхода» (S5.5, owner canary C1′, 2026-10-11): a bar, a restaurant, a taxi, a street at night, an elevator; at home ONLY getting
// ready (the bathroom sink, the front door). Never on a bed (validated). Every place now carries details: the five non-room places use them in the
// template's `with {detail}`. Captures (plan r1.2): mixed, out at night and getting ready in the mirror.
export const GLAMOUR: CategoryBank = {
  places: [
    {
      name: "a cocktail bar",
      at: "at a cocktail bar",
      details: ["a row of bottles", "a small candle", "a bowl of olives"],
      times: ["evening", "night"],
      moments: [
        { text: "leans on the counter", motion: "she leans in a little", captures: ["friend", "selfie", "candid"], twoHanded: false },
        { text: "holds a tall glass", motion: "she turns her glass slowly", captures: ["friend", "selfie", "candid"], twoHanded: false },
        { text: "laughs at something nearby", motion: "she laughs a little and looks away", captures: ["friend", "candid"], twoHanded: false, gaze: "own", expression: true },
        { text: "sips her drink through a straw", motion: "she sips slowly", captures: ["friend", "selfie"], twoHanded: false },
        { text: "sits on a high stool", motion: "she swings one foot a little", captures: ["friend", "candid"], twoHanded: false },
      ],
    },
    {
      name: "a restaurant table",
      at: "at a restaurant table",
      details: ["a small candle", "a basket of bread"],
      times: ["evening"],
      moments: [
        { text: "reaches for her glass", motion: "she lifts her glass a little", captures: ["friend", "candid"], twoHanded: false },
        { text: "rests her chin on her hand", motion: "she tilts her head a little", captures: ["friend", "selfie"], twoHanded: false },
        { text: "smiles at someone opposite", motion: "she laughs a little", captures: ["friend", "candid"], twoHanded: false, gaze: "own", expression: true },
        { text: "lifts her glass for a toast", motion: "she raises her glass a bit higher", captures: ["friend", "selfie"], twoHanded: false },
        { text: "twirls pasta onto her fork", motion: "she twirls the fork slowly", captures: ["candid", "friend"], twoHanded: false, gaze: "focus" },
      ],
    },
    {
      name: "the back seat of a taxi",
      at: "in the back seat of a taxi",
      details: ["the city lights outside", "a small clutch beside her"],
      times: ["night"],
      // S5.6R: nobody stands a few steps away in the back seat of a taxi, so a friend's whole-body photo never lands here: she takes it at arm's length.
      moments: [
        { text: "adjusts an earring", motion: "she turns the earring slowly", captures: ["selfie"], twoHanded: false, gaze: "focus" },
        { text: "looks out of the window", motion: "she turns toward the window slowly", captures: ["selfie"], twoHanded: false, gaze: "own", angle: "three-quarter" },
        { text: "leans back, relaxed", motion: "she sinks back a little", captures: ["selfie"], twoHanded: false },
        { text: "rests her head on the window", motion: "she closes her eyes slowly", captures: ["selfie"], twoHanded: false },
        { text: "pulls her coat a little closer", motion: "she tugs the coat closer slowly", captures: ["selfie"], twoHanded: false },
      ],
    },
    {
      name: "a street outside a bar",
      at: "on a street outside a bar",
      details: ["the warm light from the doorway", "a row of parked scooters"],
      times: ["night"],
      moments: [
        { text: "walks with a small clutch", motion: "she keeps walking slowly", captures: ["friend", "candid"], twoHanded: false },
        { text: "waits by the door", motion: "she shifts her weight a little", captures: ["friend", "selfie", "candid"], twoHanded: false },
        { text: "looks back over her shoulder", motion: "she turns her head a little more", captures: ["friend"], twoHanded: false, angle: "three-quarter", gaze: "own" },
        { text: "laughs on her way inside", motion: "she laughs a little and turns away", captures: ["friend", "candid"], twoHanded: false, expression: true },
        { text: "stops under a lamp", motion: "she tilts her head a little", captures: ["friend", "selfie"], twoHanded: false },
        // S5.6R: the taxi's phone moment left with its friend's photo; on the street she checks her phone for the ride home, caught by a friend.
        { text: "checks her phone for her ride", motion: "she scrolls her phone slowly", captures: ["candid", "friend"], twoHanded: false, phone: true, gaze: "own" },
      ],
    },
    {
      name: "her bathroom while getting ready",
      at: "at her bathroom sink",
      room: true,
      details: ["some makeup on the counter", "a curling iron"],
      times: ["evening"],
      mirror: true,
      moments: [
        { text: "applies lipstick", motion: "she presses her lips together a bit", captures: ["mirror", "candid", "friend"], twoHanded: false, gaze: "focus" },
        { text: "puts on mascara", motion: "she blinks slowly", captures: ["mirror", "candid"], twoHanded: false, gaze: "focus" },
        { text: "curls her hair", motion: "she turns the curler slowly", captures: ["candid", "friend"], twoHanded: true, hair: "own" },
        { text: "puts on her earrings", motion: "she turns her head a little", captures: ["mirror", "mirror-hidden", "friend"], twoHanded: false, gaze: "focus" },
        { text: "sprays on some perfume", motion: "she tilts her neck a little", captures: ["mirror", "mirror-hidden", "selfie"], twoHanded: false },
        { text: "turns to check her outfit", motion: "she turns a little to each side", captures: ["mirror-hidden", "mirror"], twoHanded: false },
      ],
    },
    {
      name: "an elevator",
      at: "in an elevator",
      details: ["a row of buttons", "a brushed metal door"],
      times: ["evening", "night"],
      mirror: true,
      // S5.6R: in an elevator she takes it in the mirror or at arm's length; nobody stands a few steps away.
      moments: [
        { text: "checks her outfit", motion: "she turns a little to each side", captures: ["mirror-hidden", "mirror", "selfie"], twoHanded: false },
        { text: "fixes her hair", motion: "she smooths her hair down slowly", captures: ["mirror", "selfie"], twoHanded: false, hair: "own" },
        { text: "rests a hand on the handrail", motion: "she shifts her weight a little", captures: ["mirror-hidden", "mirror", "selfie"], twoHanded: false },
        { text: "waits for her floor", motion: "she taps her foot a little", captures: ["mirror-hidden", "mirror", "selfie"], twoHanded: false },
        { text: "leans against the wall", motion: "she tilts her head back a little", captures: ["mirror", "mirror-hidden", "selfie"], twoHanded: false },
      ],
    },
    {
      name: "her front door",
      at: "by her front door",
      room: true,
      details: ["a small shelf", "her shoes on the mat"],
      times: ["evening"],
      mirror: true,
      moments: [
        { text: "slips on her heels", motion: "she wiggles her heel in slowly", captures: ["friend", "candid"], twoHanded: true },
        { text: "grabs her keys", motion: "she jingles her keys a little", captures: ["mirror-hidden", "mirror", "friend"], twoHanded: false },
        { text: "checks her outfit", motion: "she turns a little to each side", captures: ["mirror-hidden", "mirror"], twoHanded: false },
        { text: "picks up a small clutch", motion: "she tucks the clutch away slowly", captures: ["mirror", "mirror-hidden", "friend", "selfie"], twoHanded: false },
        { text: "takes her coat from the rack", motion: "she slides one arm in slowly", captures: ["friend", "candid", "selfie"], twoHanded: false },
      ],
    },
  ],
  // Non-revealing only (engine/scenes/pools.ts keeps the reasons): S5.4's eleven, untouched.
  outfits: [
    { text: "a fitted black bodycon dress", showsLegs: true },
    { text: "a mini skirt with a cropped top", showsLegs: true },
    { text: "a corset top and high-rise trousers" },
    { text: "a long-sleeved red mini dress", showsLegs: true },
    { text: "a white top and leather mini skirt", showsLegs: true },
    { text: "a silver sequin top and trousers" },
    { text: "an emerald blouse and leather skirt", showsLegs: true },
    { text: "a fitted beige knit midi dress" },
    { text: "a halter top and a midi skirt" },
    { text: "a navy wrap dress", showsLegs: true },
    { text: "an off-shoulder top and jeans" },
  ],
  captureDeck: ["friend", "selfie", "mirror", "friend", "mirror-hidden", "candid"],
};
