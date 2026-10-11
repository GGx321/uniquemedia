import { PHOTOSHOOT_SHOT_DECK } from "./decks";
import type { CategoryBank } from "./types";

// «Фотосессия на телефон» (the owner's «Улица» from 2026-10-11 reuses this id). PROVISIONAL content, seeded from today's pool plus one street place;
// plan s5a2 r1.2 replaces it. The `by-object` capture is a placeholder for a hook nothing draws yet.
export const PHOTOSHOOT: CategoryBank = {
  places: [
    {
      name: "a plain wall in her hallway",
      at: "against a plain wall in her hallway",
      room: true,
      details: ["a coat rack by the door", "her shoes by the door"],
      times: ["morning", "evening"],
      moments: [
        { text: "tucks her hair behind her ear", twoHanded: false, hair: "own" },
        { text: "leans a shoulder on the wall", twoHanded: false, posture: "leaning" },
        { text: "looks back over her shoulder", twoHanded: false, angle: "three-quarter", gaze: "own" },
        { text: "rests her head against the wall", twoHanded: false, posture: "leaning" },
        { text: "crosses her arms loosely", twoHanded: true },
      ],
    },
    {
      name: "a city street at night",
      at: "on a city street at night",
      details: ["a lit shop window behind her", "a parked scooter by the curb", "the wet pavement under a lamp"],
      times: ["night"],
      moments: [
        { text: "walks down the street", twoHanded: false, posture: "walking" },
        { text: "leans against a wall", twoHanded: false, posture: "leaning" },
        { text: "looks back over her shoulder", twoHanded: false, angle: "three-quarter", gaze: "own" },
        { text: "waits to cross the street", twoHanded: false },
        { text: "stops under a street lamp", twoHanded: false },
        { text: "leans on a parked scooter", twoHanded: false, captures: ["by-object"], posture: "leaning" },
      ],
    },
    {
      name: "a park path",
      at: "on a park path",
      details: ["a wooden bench nearby", "some fallen leaves on the path"],
      times: ["golden hour", "midday"],
      moments: [
        { text: "walks along the path", twoHanded: false, outdoor: true, posture: "walking" },
        { text: "sits on a bench", twoHanded: false, outdoor: true, posture: "sitting" },
        { text: "looks back over her shoulder", twoHanded: false, angle: "three-quarter", gaze: "own", outdoor: true },
        { text: "stops to pick up a leaf", twoHanded: false, gaze: "focus", outdoor: true },
        { text: "leans against a tree", twoHanded: false, outdoor: true, posture: "leaning" },
      ],
    },
    {
      name: "the stairs outside her building",
      at: "on the stairs outside her building",
      details: ["a metal railing", "a potted plant by the door"],
      times: ["golden hour", "evening"],
      moments: [
        { text: "sits on a step", twoHanded: false, outdoor: true, posture: "sitting" },
        { text: "leans against the railing", twoHanded: false, outdoor: true, posture: "leaning" },
        { text: "walks down the stairs", twoHanded: false, outdoor: true, posture: "walking" },
        { text: "sits with her chin in her hand", twoHanded: false, outdoor: true, posture: "sitting" },
        { text: "looks up the street", twoHanded: false, gaze: "own", outdoor: true },
      ],
    },
    {
      name: "a corner cafe table",
      at: "at a corner cafe table",
      details: ["a cup and saucer", "a small vase on the table", "a croissant on a plate"],
      times: ["midday", "evening"],
      moments: [
        { text: "sits at the table with a cup", twoHanded: false, posture: "sitting" },
        { text: "rests her chin on her hand", twoHanded: false },
        { text: "looks out of the window", twoHanded: false, gaze: "own" },
        { text: "stirs her coffee", twoHanded: false, gaze: "focus" },
        { text: "breaks off a piece of croissant", twoHanded: true, gaze: "focus" },
      ],
    },
    {
      name: "a riverside walkway",
      at: "on a riverside walkway",
      details: ["a low stone wall", "a bridge in the distance"],
      times: ["morning", "golden hour"],
      moments: [
        { text: "walks along the river", twoHanded: false, outdoor: true, posture: "walking" },
        { text: "sits on the low wall", twoHanded: false, outdoor: true, posture: "sitting" },
        { text: "leans on the stone wall", twoHanded: false, outdoor: true, posture: "leaning" },
        { text: "looks out over the water", twoHanded: false, gaze: "own", outdoor: true },
        { text: "looks back over her shoulder", twoHanded: false, angle: "three-quarter", gaze: "own", outdoor: true },
      ],
    },
  ],
  outfits: ["a loose blazer over a tee and jeans", "a black going-out dress", "a denim jacket and jeans", "a monochrome knit set", "a cropped cardigan and jeans"],
  shotDeck: PHOTOSHOOT_SHOT_DECK,
};
