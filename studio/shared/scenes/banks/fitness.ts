import { DEFAULT_SHOT_DECK } from "./decks";
import type { CategoryBank } from "./types";

// «Фитнес». PROVISIONAL content, seeded from today's pool (plan s5a2 r1.2 replaces it). A workout moment is `tied`: the only kind of moment a tied
// hairstyle may go to (probe P-5a2: a messy bun lost likeness, so tied styles stay rare, hair.ts).
export const FITNESS: CategoryBank = {
  places: [
    {
      name: "a gym floor",
      at: "on a gym floor",
      details: ["a rack of dumbbells", "a water bottle on the bench"],
      times: ["morning", "evening"],
      mirror: true,
      moments: [
        { text: "rests between sets", twoHanded: false, hair: "tied" },
        { text: "holds a water bottle", twoHanded: false, hair: "tied" },
        { text: "adjusts her ponytail", twoHanded: false, hair: "own" },
        { text: "wipes her face with a towel", twoHanded: false, hair: "tied" },
        { text: "sits on a bench catching her breath", twoHanded: false, hair: "tied", posture: "sitting" },
        { text: "laces up her sneakers", twoHanded: true, gaze: "focus", hair: "tied" },
      ],
    },
    {
      name: "a yoga mat on her living-room floor",
      at: "on a yoga mat on her living-room floor",
      room: true,
      details: ["a rolled-up towel", "a water bottle on the floor"],
      times: ["morning"],
      moments: [
        { text: "holds a yoga pose", twoHanded: true, hair: "tied" },
        { text: "stretches her arms overhead", twoHanded: true, hair: "tied" },
        { text: "sits cross-legged on the mat", twoHanded: false, hair: "tied", posture: "sitting" },
        { text: "rolls out her yoga mat", twoHanded: true, gaze: "focus", hair: "tied" },
        { text: "drinks from a water bottle", twoHanded: false, hair: "tied" },
      ],
    },
    {
      name: "a park running path",
      at: "on a park running path",
      details: ["a park bench by the path", "a row of trees along the path"],
      times: ["morning"],
      moments: [
        { text: "jogs along the path", twoHanded: true, hair: "tied", outdoor: true },
        { text: "stretches her legs", twoHanded: false, hair: "tied", outdoor: true },
        { text: "holds a water bottle", twoHanded: false, hair: "tied", outdoor: true },
        { text: "catches her breath after a run", twoHanded: false, hair: "tied", outdoor: true },
        { text: "checks her run on her phone", twoHanded: false, phone: true, gaze: "own", hair: "tied", outdoor: true },
      ],
    },
    {
      name: "the gym locker room",
      at: "in the gym locker room",
      details: ["a row of grey lockers", "a gym bag on the bench"],
      times: ["morning", "evening"],
      mirror: true,
      moments: [
        { text: "rests on the bench", twoHanded: false, hair: "tied", posture: "sitting" },
        { text: "holds a water bottle", twoHanded: false, hair: "tied" },
        { text: "adjusts her ponytail", twoHanded: false, hair: "own" },
        { text: "packs her gym bag", twoHanded: true, gaze: "focus", hair: "tied" },
        { text: "dries off with a towel", twoHanded: true, hair: "tied" },
      ],
    },
    {
      name: "a home workout corner",
      at: "in her home workout corner",
      room: true,
      details: ["a yoga mat against the wall", "a pair of dumbbells by the door"],
      times: ["morning", "evening"],
      moments: [
        { text: "stretches after a workout", twoHanded: false, hair: "tied" },
        { text: "holds a water bottle", twoHanded: false, hair: "tied" },
        { text: "ties her sneakers", twoHanded: true, gaze: "focus", hair: "tied" },
        { text: "lifts a light dumbbell", twoHanded: false, hair: "tied" },
        { text: "sits on the mat for a breather", twoHanded: false, hair: "tied", posture: "sitting" },
      ],
    },
  ],
  outfits: ["biker shorts and a crop top", "leggings and a fitted tank top", "a loose hoodie over leggings", "running shorts and a tank top"],
  shotDeck: DEFAULT_SHOT_DECK,
};
