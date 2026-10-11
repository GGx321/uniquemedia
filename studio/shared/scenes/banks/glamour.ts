import { DEFAULT_SHOT_DECK } from "./decks";
import type { CategoryBank } from "./types";

// «Гламур» = «вечер выхода» (S5.5, owner canary C1′, 2026-10-11): a bar, a restaurant, a taxi, a street at night, an elevator; at home ONLY getting
// ready (the bathroom sink, the front door). Never on a bed (validated). Every place now carries details: the five non-room places use them in the
// template's `with {detail}`. PROVISIONAL wording (plan s5a2 r1.2).
export const GLAMOUR: CategoryBank = {
  places: [
    {
      name: "a cocktail bar",
      at: "at a cocktail bar",
      details: ["a coaster on the counter", "a row of bottles behind the bar", "a small candle on the counter"],
      times: ["evening", "night"],
      moments: [
        { text: "leans on the bar counter", twoHanded: false, posture: "leaning" },
        { text: "holds a cocktail glass", twoHanded: false },
        { text: "laughs at something nearby", twoHanded: false, gaze: "own" },
        { text: "sips her drink through a straw", twoHanded: false },
        { text: "sits on a high bar stool", twoHanded: false, posture: "sitting" },
      ],
    },
    {
      name: "a restaurant table",
      at: "at a restaurant table",
      details: ["a glass of water by her plate", "a small candle on the table", "a basket of bread"],
      times: ["evening"],
      moments: [
        { text: "reaches for her glass", twoHanded: false },
        { text: "rests her chin on her hand", twoHanded: false },
        { text: "smiles across the table", twoHanded: false, gaze: "own" },
        { text: "lifts her glass for a toast", twoHanded: false },
        { text: "twirls pasta onto her fork", twoHanded: false, gaze: "focus" },
      ],
    },
    {
      name: "the back seat of a taxi",
      at: "in the back seat of a taxi",
      details: ["the city lights through the window", "a small clutch on the seat"],
      times: ["night"],
      moments: [
        { text: "adjusts an earring", twoHanded: false, gaze: "focus" },
        { text: "looks out of the window", twoHanded: false, gaze: "own" },
        { text: "leans back in the seat", twoHanded: false },
        { text: "scrolls through her phone", twoHanded: false, phone: true, gaze: "own" },
        { text: "fastens her seat belt", twoHanded: true, gaze: "focus" },
      ],
    },
    {
      name: "a street outside a bar",
      at: "on a street outside a bar",
      details: ["the warm light from the doorway", "a row of parked scooters"],
      times: ["night"],
      moments: [
        { text: "walks with a small clutch", twoHanded: false, posture: "walking" },
        { text: "waits by the door", twoHanded: false },
        { text: "looks back over her shoulder", twoHanded: false, angle: "three-quarter", gaze: "own" },
        { text: "laughs on her way inside", twoHanded: false },
        { text: "stops under a street lamp", twoHanded: false },
      ],
    },
    {
      name: "her bathroom while getting ready",
      at: "at her bathroom sink",
      room: true,
      details: ["some makeup on the counter", "a hair dryer by the sink"],
      times: ["evening"],
      mirror: true,
      moments: [
        { text: "applies lipstick", twoHanded: false, gaze: "focus" },
        { text: "puts on mascara", twoHanded: false, gaze: "focus" },
        { text: "curls her hair", twoHanded: true, hair: "own" },
        { text: "puts on her earrings", twoHanded: false, gaze: "focus" },
        { text: "sprays on some perfume", twoHanded: false },
      ],
    },
    {
      name: "an elevator",
      at: "in an elevator",
      details: ["a row of floor buttons", "a brushed metal wall"],
      times: ["evening", "night"],
      mirror: true,
      moments: [
        { text: "checks her outfit", twoHanded: false },
        { text: "fixes her hair", twoHanded: false, hair: "own" },
        { text: "rests a hand on the handrail", twoHanded: false },
        { text: "waits for her floor", twoHanded: false },
        { text: "leans against the elevator wall", twoHanded: false, posture: "leaning" },
      ],
    },
    {
      name: "her front door",
      at: "by her front door",
      room: true,
      details: ["a coat rack", "her shoes by the door"],
      times: ["evening"],
      mirror: true,
      moments: [
        { text: "slips on her heels", twoHanded: true },
        { text: "grabs her keys", twoHanded: false },
        { text: "checks her outfit", twoHanded: false },
        { text: "picks up a small clutch", twoHanded: false },
        { text: "takes her coat from the rack", twoHanded: false },
      ],
    },
  ],
  // Non-revealing only (engine/scenes/pools.ts keeps the reasons): today's list, untouched (K-10).
  outfits: [
    "a fitted black bodycon dress",
    "a mini skirt with a cropped top",
    "a corset top and high-rise trousers",
    "a long-sleeved red mini dress",
    "a white top and leather mini skirt",
    "a silver sequin top and trousers",
    "an emerald blouse and leather skirt",
    "a fitted beige knit midi dress",
    "a halter top and a midi skirt",
    "a navy wrap dress",
    "an off-shoulder top and jeans",
  ],
  shotDeck: DEFAULT_SHOT_DECK,
};
