import type { CategoryBank } from "./types";

// «Фитнес» (plan s5a2 r1.2 §5.1): today's places and outfits, today's activities as moments with motions, and a gym mirror selfie with the phone over
// her face. A workout moment is `tied`: the only kind of moment a tied hairstyle may go to (probe P-5a2; hair.ts). S5.6R (the owner: at home she shoots
// herself): the home workout (the yoga mat, the workout corner) is on a timer or at arm's length, never a friend's or a candid; those stay at the gym and in
// the park. A timer moment holds nothing (the timer line says both hands are empty), so the yoga pose is «stands in a tree pose».
export const FITNESS: CategoryBank = {
  places: [
    {
      name: "a gym floor",
      at: "on a gym floor",
      details: ["a rack of dumbbells", "a row of machines"],
      times: ["morning", "evening"],
      mirror: true,
      moments: [
        { text: "rests between sets", motion: "she breathes out slowly", captures: ["friend", "candid", "selfie", "mirror-hidden"], twoHanded: false, hair: "tied" },
        { text: "holds a water bottle", motion: "she takes a small sip", captures: ["friend", "selfie", "mirror", "mirror-hidden"], twoHanded: false, hair: "tied" },
        { text: "adjusts her ponytail", motion: "she tightens her ponytail a bit", captures: ["mirror", "mirror-hidden", "friend", "candid"], twoHanded: false, hair: "own" },
        { text: "wipes her face with a towel", motion: "she pats her face slowly", captures: ["friend", "candid"], twoHanded: false, hair: "tied" },
        { text: "stands at the mirror", motion: "she shifts slowly to one hip", captures: ["mirror-hidden", "mirror"], twoHanded: false, hair: "tied" },
        { text: "laces up her sneakers", motion: "she pulls the laces tight slowly", captures: ["friend", "candid"], twoHanded: true, gaze: "focus", hair: "tied" },
      ],
    },
    {
      name: "a yoga mat on her living-room floor",
      at: "on a yoga mat on her living-room floor",
      room: true,
      details: ["a rolled-up towel", "a small plant"],
      times: ["morning"],
      moments: [
        { text: "stands in a tree pose", motion: "she sways a little in the pose", captures: ["timer"], twoHanded: true, hair: "tied" },
        { text: "stretches her arms overhead", motion: "she reaches a little higher", captures: ["timer"], twoHanded: true, hair: "tied" },
        { text: "sits cross-legged", motion: "she rolls her shoulders slowly", captures: ["timer", "selfie"], twoHanded: false, hair: "tied" },
        { text: "rolls her shoulders back", motion: "she rolls her shoulders slowly", captures: ["selfie"], twoHanded: false, hair: "tied" },
        { text: "drinks from a water bottle", motion: "she takes a small sip", captures: ["selfie"], twoHanded: false, hair: "tied" },
        { text: "kneels with her back straight", motion: "she sinks back a little", captures: ["timer", "selfie"], twoHanded: false, hair: "tied" },
      ],
    },
    {
      name: "a park running path",
      at: "on a park running path",
      details: ["a park bench by the path", "a row of trees along the path"],
      times: ["morning"],
      moments: [
        { text: "jogs at an easy pace", motion: "she keeps jogging slowly", captures: ["friend", "candid"], twoHanded: true, hair: "tied", outdoor: true },
        { text: "stretches her legs", motion: "she leans into the stretch a bit", captures: ["friend", "candid", "selfie"], twoHanded: false, hair: "tied", outdoor: true },
        { text: "holds a water bottle", motion: "she takes a small sip", captures: ["selfie", "friend"], twoHanded: false, hair: "tied", outdoor: true },
        { text: "catches her breath after a run", motion: "she breathes out slowly", captures: ["friend", "selfie", "candid"], twoHanded: false, hair: "tied", outdoor: true },
        { text: "checks her run on her phone", motion: "she scrolls her phone slowly", captures: ["candid", "friend"], twoHanded: false, phone: true, gaze: "own", hair: "tied", outdoor: true },
        { text: "walks to cool down", motion: "she keeps walking slowly", captures: ["friend", "candid"], twoHanded: false, hair: "tied", outdoor: true },
      ],
    },
    {
      name: "the gym locker room",
      at: "in the gym locker room",
      details: ["a row of grey lockers", "a towel on a hook"],
      times: ["morning", "evening"],
      mirror: true,
      moments: [
        { text: "rests on the bench", motion: "she leans back a little", captures: ["friend", "candid", "selfie"], twoHanded: false, hair: "tied" },
        { text: "holds a water bottle", motion: "she takes a small sip", captures: ["mirror", "mirror-hidden", "selfie", "friend"], twoHanded: false, hair: "tied" },
        { text: "adjusts her ponytail", motion: "she tightens her ponytail a bit", captures: ["mirror", "mirror-hidden", "candid"], twoHanded: false, hair: "own" },
        { text: "packs her bag", motion: "she zips the bag slowly", captures: ["candid", "friend"], twoHanded: true, gaze: "focus", hair: "tied" },
        { text: "checks her outfit after training", motion: "she turns a little to each side", captures: ["mirror-hidden", "mirror"], twoHanded: false, hair: "tied" },
        { text: "pulls on a light jacket", motion: "she slides one arm in slowly", captures: ["friend", "candid"], twoHanded: true, hair: "tied" },
      ],
    },
    {
      name: "a home workout corner",
      at: "in her home workout corner",
      room: true,
      details: ["a small fan", "a rolled-up towel"],
      times: ["morning", "evening"],
      moments: [
        { text: "stretches after training", motion: "she reaches a little further", captures: ["timer", "selfie"], twoHanded: false, hair: "tied" },
        { text: "holds a water bottle", motion: "she takes a small sip", captures: ["selfie"], twoHanded: false, hair: "tied" },
        { text: "rests her hands on her hips", motion: "she catches her breath slowly", captures: ["timer"], twoHanded: true, hair: "tied" },
        { text: "lifts a light dumbbell", motion: "she lifts the weight slowly", captures: ["selfie"], twoHanded: false, hair: "tied" },
        { text: "sits on the mat for a breather", motion: "she breathes out slowly", captures: ["timer", "selfie"], twoHanded: false, hair: "tied" },
      ],
    },
  ],
  outfits: [
    { text: "biker shorts and a crop top", showsLegs: true },
    { text: "leggings and a fitted tank top" },
    { text: "a loose hoodie over leggings" },
    { text: "running shorts and a tank top", showsLegs: true },
  ],
  // S5.6R: the timer is the home workout's (only the home places take it); the gym and the park keep a friend twice and a candid.
  captureDeck: ["friend", "selfie", "mirror", "friend", "mirror-hidden", "candid", "timer"],
};
