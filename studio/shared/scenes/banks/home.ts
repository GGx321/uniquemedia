import { DEFAULT_SHOT_DECK } from "./decks";
import type { CategoryBank } from "./types";

// «Дом». PROVISIONAL content (the owner's style references of 2026-10-11 will replace it; plan s5a2 r1.2): seeded from today's pool (engine/scenes/
// pools.ts) with moments as finite verb phrases, every place with 2-3 details. The `captures`, `lights` and `legwear` entries are placeholders for
// hooks that nothing draws yet.
export const HOME: CategoryBank = {
  places: [
    {
      name: "her small kitchen",
      at: "in her small kitchen",
      room: true,
      details: ["a kettle on the counter", "a fruit bowl"],
      times: ["morning", "midday"],
      moments: [
        { text: "waits for the kettle", twoHanded: false },
        { text: "sips from a ceramic coffee mug", twoHanded: false },
        { text: "slices fruit on a cutting board", twoHanded: true, gaze: "focus" },
        { text: "leans on the counter with a mug", twoHanded: false, posture: "leaning" },
        { text: "laughs at something on her phone", twoHanded: false, phone: true, gaze: "own" },
        { text: "pours milk into her coffee", twoHanded: true, gaze: "focus" },
      ],
    },
    {
      name: "her bed in the morning",
      at: "on her bed",
      room: true,
      details: ["a pillow", "a bedside lamp"],
      times: ["morning"],
      moments: [
        { text: "stretches after waking up", twoHanded: false, messyOk: true },
        { text: "scrolls through her phone", twoHanded: false, phone: true, gaze: "own" },
        { text: "holds a ceramic coffee mug", twoHanded: false },
        { text: "sits up against the pillows", twoHanded: false, messyOk: true, posture: "sitting" },
        { text: "pulls the blanket up to her chin", twoHanded: true },
        { text: "sits on the bed, her back turned", twoHanded: false, angle: "back", posture: "sitting" },
        { text: "lies on the bed with her legs up", twoHanded: false, captures: ["selfie-above"], posture: "lying" },
      ],
    },
    {
      name: "the couch under a blanket",
      at: "on the couch under a blanket",
      room: true,
      details: ["a cushion in the corner", "a mug on the side table"],
      times: ["midday", "evening"],
      lights: ["evening-lamp", "fairy-lights", "low-light"],
      moments: [
        { text: "laughs at something on her phone", twoHanded: false, phone: true, gaze: "own" },
        { text: "holds a ceramic coffee mug", twoHanded: false },
        { text: "pulls the blanket over her knees", twoHanded: true },
        { text: "curls up with a cup of tea", twoHanded: false },
        { text: "stretches her arms over her head", twoHanded: true },
      ],
    },
    {
      name: "her bathroom",
      at: "in her bathroom",
      room: true,
      details: ["a hair dryer by the sink", "a towel on the hook"],
      times: ["morning", "evening"],
      mirror: true,
      moments: [
        { text: "brushes her hair", twoHanded: false, hair: "own" },
        { text: "applies lip balm", twoHanded: false, gaze: "focus" },
        { text: "ties her hair up", twoHanded: true, hair: "own" },
        { text: "pats moisturiser into her cheeks", twoHanded: false, gaze: "focus" },
        { text: "dries her face with a towel", twoHanded: true },
        { text: "sits on the floor by the mirror", twoHanded: false, captures: ["mirror-face-hidden"], posture: "sitting" },
      ],
    },
    {
      name: "a small balcony with potted plants",
      at: "on a small balcony with potted plants",
      details: ["a watering can by the plants", "a small folding chair", "a mug on the railing"],
      times: ["morning", "golden hour"],
      moments: [
        { text: "waters the plants", twoHanded: false, gaze: "focus" },
        { text: "sips her morning coffee", twoHanded: false },
        { text: "leans on the railing", twoHanded: false, posture: "leaning" },
        { text: "looks out over the street", twoHanded: false, gaze: "own" },
        { text: "picks a dry leaf off a plant", twoHanded: false, gaze: "focus" },
      ],
    },
    {
      name: "a chair by her bedroom window",
      at: "on a chair by her bedroom window",
      room: true,
      details: ["a plant on the windowsill", "a cardigan over the chair"],
      times: ["midday", "golden hour"],
      moments: [
        { text: "looks out of the window", twoHanded: false, gaze: "own" },
        { text: "holds a cup of tea", twoHanded: false },
        { text: "pulls her knees up to her chest", twoHanded: true },
        { text: "sips tea with her legs tucked up", twoHanded: false },
        { text: "rests her head against the window", twoHanded: false },
      ],
    },
  ],
  outfits: ["an oversized cream knit sweater", "a tank top and pajama shorts", "a grey lounge set", "a white t-shirt and cotton shorts", "a cozy hoodie"],
  shotDeck: DEFAULT_SHOT_DECK,
  // The references' legwear slot: drawn only once a probe passes. «Knee-high socks» are not here: I5.29's youth-prop sweep refuses knee socks (an
  // owner question).
  legwear: [
    { text: "sheer black tights", status: "probe" },
    { text: "thigh-high socks", status: "probe" },
  ],
};
