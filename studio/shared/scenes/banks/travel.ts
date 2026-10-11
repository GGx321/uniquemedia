import { DEFAULT_SHOT_DECK } from "./decks";
import type { CategoryBank } from "./types";

// «Путешествия» (the owner's «Виды» from 2026-10-11 reuses this id). PROVISIONAL content, seeded from today's pool (plan s5a2 r1.2 replaces it).
export const TRAVEL: CategoryBank = {
  places: [
    {
      name: "a sandy beach at the waterline",
      at: "on a sandy beach at the waterline",
      details: ["a beach towel behind her", "a few shells near the water", "a beach bag in the sand"],
      times: ["midday", "golden hour"],
      moments: [
        { text: "walks along the waterline", twoHanded: false, outdoor: true, posture: "walking" },
        { text: "holds her sandals in one hand", twoHanded: false, outdoor: true },
        { text: "sits on a towel, knees drawn up", twoHanded: false, outdoor: true, posture: "sitting" },
        { text: "shades her eyes with one hand", twoHanded: false, gaze: "own", outdoor: true },
        { text: "brushes sand off her knees", twoHanded: false, gaze: "focus", outdoor: true },
      ],
    },
    {
      name: "a narrow old-town street",
      at: "on a narrow old-town street",
      details: ["a bicycle against a wall", "some flower pots on a windowsill", "a cafe awning above a door"],
      times: ["morning", "midday", "golden hour"],
      moments: [
        { text: "holds a takeaway coffee", twoHanded: false, outdoor: true },
        { text: "checks directions on her phone", twoHanded: true, phone: true, gaze: "own", outdoor: true },
        { text: "eats a gelato from a cone", twoHanded: false, outdoor: true },
        { text: "walks past old stone houses", twoHanded: false, outdoor: true, posture: "walking" },
        { text: "stops to look up at a balcony", twoHanded: false, gaze: "own", outdoor: true },
      ],
    },
    {
      name: "a small hotel balcony",
      at: "on a small hotel balcony",
      details: ["a small table with two cups", "a towel over the railing"],
      times: ["morning", "golden hour"],
      moments: [
        { text: "leans on the railing", twoHanded: false, posture: "leaning" },
        { text: "holds a cup of coffee", twoHanded: false },
        { text: "looks out at the sea", twoHanded: false, gaze: "own" },
        { text: "eats a croissant for breakfast", twoHanded: false },
        { text: "sits with her knees pulled up", twoHanded: false, posture: "sitting" },
      ],
    },
    {
      name: "an airplane window seat",
      at: "in an airplane window seat",
      details: ["a folded blanket on her lap", "a cup on the tray table", "a neck pillow on the seat"],
      times: ["morning", "midday"],
      moments: [
        { text: "looks out of the window", twoHanded: false, gaze: "own" },
        { text: "holds a cup of coffee", twoHanded: false },
        { text: "scrolls through her phone", twoHanded: false, phone: true, gaze: "own" },
        { text: "rests her head against the window", twoHanded: false },
        { text: "tucks a blanket around her legs", twoHanded: true },
      ],
    },
    {
      name: "a mountain viewpoint",
      at: "at a mountain viewpoint",
      details: ["a wooden railing", "a backpack at her feet"],
      times: ["morning", "midday", "golden hour"],
      moments: [
        { text: "takes in the view", twoHanded: false, gaze: "own", outdoor: true },
        { text: "adjusts her backpack straps", twoHanded: true, gaze: "focus", outdoor: true },
        { text: "drinks from a water bottle", twoHanded: false, outdoor: true },
        { text: "leans on the wooden railing", twoHanded: false, outdoor: true, posture: "leaning" },
        { text: "catches her breath after the climb", twoHanded: false, outdoor: true },
      ],
    },
    {
      name: "a ferry deck",
      at: "on a ferry deck",
      details: ["a white railing", "a few seagulls over the water"],
      times: ["midday", "golden hour"],
      moments: [
        { text: "holds the rail with one hand", twoHanded: false, outdoor: true },
        { text: "sits on a bench on the deck", twoHanded: false, outdoor: true, posture: "sitting" },
        { text: "lets the wind blow her hair", twoHanded: false, hair: "own", outdoor: true },
        { text: "holds a cup of coffee", twoHanded: false, outdoor: true },
        { text: "looks out at the passing coast", twoHanded: false, gaze: "own", outdoor: true },
      ],
    },
    {
      name: "an ordinary hotel room",
      at: "in an ordinary hotel room",
      room: true,
      details: ["a suitcase open on the floor", "a key card on the nightstand"],
      times: ["morning", "evening"],
      mirror: true,
      moments: [
        { text: "adjusts her outfit", twoHanded: false },
        { text: "puts on her earrings", twoHanded: false, gaze: "focus" },
        { text: "checks her look", twoHanded: false },
        { text: "unpacks her suitcase", twoHanded: true, gaze: "focus" },
        { text: "sits on the edge of the bed", twoHanded: false, posture: "sitting" },
      ],
    },
  ],
  outfits: ["a cotton top and linen trousers", "a linen shirt and denim shorts", "a sundress and sneakers", "a white button-up shirt"],
  shotDeck: DEFAULT_SHOT_DECK,
};
