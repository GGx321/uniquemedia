import type { CategoryBank } from "./types";

// «Фитнес» (plan s5a2 r1.2 §5.1): today's places and outfits, today's activities as moments with motions, and a gym mirror selfie with the phone over
// her face. A workout moment is `sport` (S5.6R round C; it was `tied`, which left 3 in 4 of a «Фитнес» run blow-dried or loose): a sporty style on 3 in 4 of
// a run's, outside the tied cap (hair.ts). S5.6R (the owner: at home she shoots
// herself): the home workout (the yoga mat, the workout corner) is on a timer or at arm's length, never a friend's or a candid; those stay at the gym and in
// the park. A timer moment holds nothing (the timer line says both hands are empty), so the yoga pose is «stands in a tree pose».
/** S5.8a review: legs frames wear shorts or leggings (a low angle under a skirt would read wrong), and «Фитнес» has four outfits that show her legs, not two. */
const LEGS_TRAINING = ["lycra biker shorts and a crop top", "nylon running shorts and a tank top", "lycra yoga shorts and a fitted tank", "lycra cycling shorts and a tee", "leggings and a fitted tank top", "leggings and a cropped tank top"];

export const FITNESS: CategoryBank = {
  places: [
    {
      name: "a gym floor",
      at: "on a gym floor",
      details: ["a rack of dumbbells", "a row of machines"],
      times: ["morning", "evening"],
      mirror: true,
      moments: [
        { text: "rests between sets", motion: "she breathes out slowly", captures: ["friend", "candid", "selfie", "mirror-hidden"], twoHanded: false, hair: "sport" },
        { text: "holds a water bottle", motion: "she takes a small sip", captures: ["friend", "selfie", "mirror", "mirror-hidden"], twoHanded: false, hair: "sport" },
        { text: "adjusts her ponytail", motion: "she tightens her ponytail a bit", captures: ["mirror", "mirror-hidden", "friend", "candid"], twoHanded: false, hair: "own" },
        { text: "wipes her face with a towel", motion: "she pats her face slowly", captures: ["friend", "candid"], twoHanded: false, hair: "sport" },
        { text: "stands at the mirror", motion: "she shifts slowly to one hip", captures: ["mirror-hidden", "mirror"], twoHanded: false, hair: "sport" },
        { text: "laces up her sneakers", motion: "she pulls the laces tight slowly", captures: ["friend", "candid"], twoHanded: true, gaze: "focus", hair: "sport" },
        // S5.7b: the angle comes from the moment; someone catches her from behind between sets (C3′: stretching, so the frame reads).
        { text: "stretches her arms above her head", motion: "she reaches up a little higher", captures: ["friend", "candid"], twoHanded: true, angle: "back", hair: "sport" },
      ],
    },
    {
      name: "a yoga mat on her living-room floor",
      at: "on a yoga mat on her living-room floor",
      room: true,
      details: ["a rolled-up towel", "a small plant"],
      times: ["morning"],
      moments: [
        { text: "stands in a tree pose", motion: "she sways a little in the pose", captures: ["timer"], twoHanded: true, hair: "sport" },
        { text: "stretches her arms overhead", motion: "she reaches a little higher", captures: ["timer"], twoHanded: true, hair: "sport" },
        { text: "sits cross-legged", motion: "she rolls her shoulders slowly", captures: ["timer", "selfie"], twoHanded: false, hair: "sport" },
        { text: "rolls her shoulders back", motion: "she rolls her shoulders slowly", captures: ["selfie"], twoHanded: false, hair: "sport" },
        { text: "drinks from a water bottle", motion: "she takes a small sip", captures: ["selfie"], twoHanded: false, hair: "sport" },
        { text: "kneels with her back straight", motion: "she sinks back a little", captures: ["timer", "selfie"], twoHanded: false, hair: "sport" },
        { text: "sits with her legs stretched out", motion: "she reaches toward her toes slowly", captures: ["pov-legs"], twoHanded: false, hair: "sport", outfits: LEGS_TRAINING, legs: { framing: "legs" } },
      ],
    },
    {
      name: "a park running path",
      at: "on a park running path",
      details: ["a wooden bench", "a row of tall trees"],
      times: ["morning"],
      moments: [
        { text: "jogs at an easy pace", motion: "she keeps jogging slowly", captures: ["friend", "candid"], twoHanded: true, hair: "sport", outdoor: true },
        { text: "stretches her legs", motion: "she leans into the stretch a bit", captures: ["friend", "candid", "selfie"], twoHanded: false, hair: "sport", outdoor: true },
        { text: "holds a water bottle", motion: "she takes a small sip", captures: ["selfie", "friend"], twoHanded: false, hair: "sport", outdoor: true },
        { text: "catches her breath after a run", motion: "she breathes out slowly", captures: ["friend", "selfie", "candid"], twoHanded: false, hair: "sport", outdoor: true },
        { text: "checks her run on her phone", motion: "she scrolls her phone slowly", captures: ["candid", "friend"], twoHanded: false, phone: true, gaze: "own", hair: "sport", outdoor: true },
        { text: "walks to cool down", motion: "she keeps walking slowly", captures: ["friend", "candid"], twoHanded: false, hair: "sport", outdoor: true },
        { text: "stretches an arm across her chest", motion: "she pulls her arm in a little", captures: ["friend", "candid"], twoHanded: true, angle: "back", hair: "sport", outdoor: true },
        { text: "stretches her calves", motion: "she presses her heel down a little", captures: ["low-feet"], twoHanded: false, hair: "sport", outdoor: true, outfits: LEGS_TRAINING, legs: { framing: "legs" } },
      ],
    },
    {
      name: "the gym locker room",
      at: "in the gym locker room",
      details: ["a row of grey lockers", "a towel on a hook"],
      times: ["morning", "evening"],
      mirror: true,
      moments: [
        { text: "rests on the bench", motion: "she leans back a little", captures: ["friend", "candid", "selfie"], twoHanded: false, hair: "sport" },
        { text: "holds a water bottle", motion: "she takes a small sip", captures: ["mirror", "mirror-hidden", "selfie", "friend"], twoHanded: false, hair: "sport" },
        { text: "adjusts her ponytail", motion: "she tightens her ponytail a bit", captures: ["mirror", "mirror-hidden", "candid"], twoHanded: false, hair: "own" },
        { text: "packs her bag", motion: "she zips the bag slowly", captures: ["candid", "friend"], twoHanded: true, gaze: "focus", hair: "sport" },
        { text: "checks her outfit after training", motion: "she turns a little to each side", captures: ["mirror-hidden", "mirror"], twoHanded: false, hair: "sport" },
        { text: "pulls on a light jacket", motion: "she slides one arm in slowly", captures: ["friend", "candid"], twoHanded: true, hair: "sport" },
      ],
    },
    {
      name: "a home workout corner",
      at: "in her home workout corner",
      room: true,
      details: ["a small fan", "a rolled-up towel"],
      times: ["morning", "evening"],
      moments: [
        { text: "stretches after training", motion: "she reaches a little further", captures: ["timer", "selfie"], twoHanded: false, hair: "sport" },
        { text: "holds a water bottle", motion: "she takes a small sip", captures: ["selfie"], twoHanded: false, hair: "sport" },
        { text: "rests her hands on her hips", motion: "she catches her breath slowly", captures: ["timer"], twoHanded: true, hair: "sport" },
        { text: "lifts a light dumbbell", motion: "she lifts the weight slowly", captures: ["selfie"], twoHanded: false, hair: "sport" },
        { text: "sits on the mat for a breather", motion: "she breathes out slowly", captures: ["timer", "selfie"], twoHanded: false, hair: "sport" },
        { text: "stretches to one side, in profile", motion: "she reaches a little further", captures: ["timer"], twoHanded: true, angle: "profile", hair: "sport" },
        // S5.8a («Ножки»): a POV along her own legs on the mat.
        { text: "stretches her legs on the mat", motion: "she flexes her feet slowly", captures: ["pov-legs"], twoHanded: false, hair: "sport", outfits: LEGS_TRAINING, legs: { framing: "legs" } },
      ],
    },
  ],
  outfits: [
    { text: "lycra biker shorts and a crop top", showsLegs: true },
    { text: "leggings and a fitted tank top" },
    { text: "a loose hoodie over leggings" },
    { text: "nylon running shorts and a tank top", showsLegs: true },
    { text: "lycra yoga shorts and a fitted tank", showsLegs: true, pinOnly: true },
    { text: "lycra cycling shorts and a tee", showsLegs: true, pinOnly: true },
    { text: "leggings and a cropped tank top", pinOnly: true },
  ],
  // S5.6R: the timer is the home workout's (only the home places take it); the gym and the park keep a friend twice and a candid.
  captureDeck: ["friend", "selfie", "mirror", "friend", "mirror-hidden", "candid", "timer"],
};
