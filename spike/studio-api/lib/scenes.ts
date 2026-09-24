import { z } from "zod";
import { makeRng, rngInt, rngPick, type Rng } from "../../../src/core/rng";

export const PLANNER_SEED = 20260924;

export type Category = "home" | "travel" | "photoshoot" | "glamour" | "fitness";
export type Shot = "friend" | "selfie" | "mirror" | "candid" | "photographer";
export const CATEGORIES: Category[] = ["home", "travel", "photoshoot", "glamour", "fitness"];
const SHOT_DECK: Shot[] = ["friend", "selfie", "mirror", "candid", "friend"];
const PHOTOSHOOT_SHOT_DECK: Shot[] = ["photographer", "photographer", "photographer", "candid", "candid"];
const GLAMOUR_SPICE = [1, 1, 2, 2, 3];

interface Activity {
  text: string;
  /** Needs both hands, so never paired with a selfie or mirror shot (one hand holds the phone). */
  twoHanded: boolean;
}
const one = (text: string): Activity => ({ text, twoHanded: false });
const two = (text: string): Activity => ({ text, twoHanded: true });

/**
 * A location with the times of day it is plausible at and the activities that
 * fit it; `mirror` marks where a mirror selfie can happen.
 */
interface Place {
  name: string;
  times: string[];
  activities: Activity[];
  mirror?: true;
}

/** Outfits are grouped by spice level; non-glamour categories have a single level. */
interface Pool {
  locations: Place[];
  outfitsByLevel: string[][];
}

const POOLS: Record<Category, Pool> = {
  home: {
    locations: [
      { name: "a bright kitchen", times: ["morning", "midday"], activities: [two("cooking pancakes"), one("holding a ceramic coffee mug"), two("slicing fruit on a cutting board")] },
      { name: "an unmade bed with white linen", times: ["morning"], activities: [one("holding a ceramic coffee mug"), one("stretching after waking up"), one("scrolling her phone")] },
      { name: "a living room couch with a laptop", times: ["midday", "evening"], activities: [two("typing on the laptop"), one("holding a ceramic coffee mug"), one("laughing at something on the screen")] },
      { name: "a bathroom with a large vanity mirror", times: ["morning", "evening"], mirror: true, activities: [one("brushing her hair"), one("applying lip balm"), two("tying her hair up")] },
      { name: "a small balcony with potted plants", times: ["morning", "golden hour"], activities: [one("watering plants"), one("holding a ceramic coffee mug"), one("leaning on the railing")] },
      { name: "a reading nook by the window", times: ["midday", "golden hour"], activities: [one("reading a paperback"), one("holding a cup of tea"), one("looking out of the window")] },
    ],
    outfitsByLevel: [["an oversized cream knit sweater", "matching satin pajamas", "a grey lounge set", "a plain white t-shirt and cotton shorts", "a cozy hoodie"]],
  },
  travel: {
    locations: [
      { name: "a sandy beach at the waterline", times: ["midday", "golden hour"], activities: [one("walking along the waterline"), one("holding her sandals"), one("sitting on a towel")] },
      { name: "a narrow old-town street", times: ["morning", "midday", "golden hour"], activities: [one("holding a paper cup of coffee"), two("looking at a paper map"), one("eating gelato")] },
      { name: "a hotel balcony overlooking the sea", times: ["morning", "golden hour"], activities: [one("leaning on the railing"), one("holding a cup of coffee"), one("looking out at the sea")] },
      { name: "an airplane window seat", times: ["morning", "midday"], activities: [one("looking out of the window"), one("holding a cup of coffee"), one("reading a magazine")] },
      { name: "a mountain viewpoint", times: ["morning", "midday", "golden hour"], activities: [one("taking in the view"), two("adjusting her backpack straps"), one("holding a water bottle")] },
      { name: "the deck of a small boat", times: ["midday", "golden hour"], activities: [one("holding the rail"), one("sitting on the edge of the deck"), one("letting the wind blow her hair")] },
      { name: "a hotel room with a full-length mirror", times: ["morning", "evening"], mirror: true, activities: [one("adjusting her outfit"), one("putting on earrings"), one("checking her look")] },
    ],
    outfitsByLevel: [["a light linen sundress", "a linen shirt and denim shorts", "a straw hat and a summer dress", "a one-piece swimsuit with a sarong", "a white button-up shirt"]],
  },
  photoshoot: {
    locations: [
      { name: "a studio with a seamless beige backdrop", times: ["studio lighting"], activities: [one("posing with one hand in her hair"), one("sitting on a wooden stool"), one("looking over her shoulder")] },
      { name: "a city street, lit by direct on-camera flash", times: ["night"], activities: [one("walking toward the camera"), one("leaning against a wall"), one("looking over her shoulder")] },
      { name: "a wheat field", times: ["golden hour"], activities: [one("walking through the wheat"), one("running her hand over the wheat"), one("looking over her shoulder")] },
      { name: "a concrete rooftop", times: ["golden hour", "evening"], activities: [one("leaning against a wall"), one("sitting on a concrete step"), one("walking toward the camera")] },
      { name: "a vintage cafe interior", times: ["midday", "evening"], activities: [one("sitting at a small table with a cup"), one("leaning on the counter"), one("looking out of the window")] },
    ],
    outfitsByLevel: [["a tailored black blazer over a white tee", "a satin evening dress", "a denim jacket and jeans", "a monochrome knit set", "a trench coat"]],
  },
  glamour: {
    locations: [
      { name: "a bedroom with a full-length mirror", times: ["evening", "night"], mirror: true, activities: [one("adjusting her hair"), one("standing with one hand on her hip"), one("putting on earrings")] },
      { name: "a hotel room", times: ["evening", "night"], mirror: true, activities: [one("sitting on the edge of the bed"), one("putting on earrings"), one("standing by the window")] },
      { name: "a bathroom with soft warm light", times: ["evening"], mirror: true, activities: [one("adjusting her hair"), one("applying lipstick"), one("leaning on the sink counter")] },
      { name: "a walk-in closet", times: ["evening"], mirror: true, activities: [two("choosing a dress from a rack"), one("adjusting her hair"), one("standing with one hand on her hip")] },
      { name: "a bed with silk sheets", times: ["morning", "evening"], activities: [one("sitting on the edge of the bed"), one("lying on her side propped on an elbow"), one("stretching")] },
    ],
    outfitsByLevel: [
      ["a fitted black bodycon dress", "a mini skirt with a cropped top", "a satin slip dress"],
      ["a bikini", "a corset top with high-waisted trousers", "a sports bra and shorts"],
      ["a lace lingerie set", "lingerie with thigh-high stockings", "a short silk robe over lingerie"],
    ],
  },
  fitness: {
    locations: [
      { name: "a gym in front of a mirror", times: ["morning", "evening"], mirror: true, activities: [one("resting between sets"), one("holding a water bottle"), one("adjusting her ponytail")] },
      { name: "a yoga mat in a sunlit living room", times: ["morning"], activities: [two("doing a yoga pose"), one("stretching"), one("sitting cross-legged")] },
      { name: "a park running path", times: ["morning"], activities: [two("jogging"), one("stretching her legs"), one("holding a water bottle")] },
      { name: "a pilates studio", times: ["morning", "midday"], mirror: true, activities: [two("stretching on a reformer"), one("resting between exercises"), one("holding a water bottle")] },
      { name: "a home workout corner", times: ["morning", "evening"], activities: [one("stretching after a workout"), one("holding a water bottle"), two("tying her sneakers")] },
    ],
    outfitsByLevel: [["black leggings and a sports bra", "biker shorts and a crop top", "a matching athletic set", "a loose hoodie over leggings", "running shorts and a tank top"]],
  },
};

export const Slot = z.object({
  slotId: z.string(),
  category: z.enum(["home", "travel", "photoshoot", "glamour", "fitness"]),
  index: z.number().int(),
  shot: z.enum(["friend", "selfie", "mirror", "candid", "photographer"]),
  location: z.string(),
  outfit: z.string(),
  activity: z.string(),
  timeOfDay: z.string(),
  spice: z.number().int().nullable(),
});
export type Slot = z.infer<typeof Slot>;

function shuffle<T>(rng: Rng, arr: readonly T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = rngInt(rng, 0, i);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * A mirror shot may only sit on a mirror location. Each misplaced mirror shot
 * swaps with the first mirror-location slot holding a non-mirror shot; with no
 * such slot left it becomes a selfie. Deterministic, no RNG draws.
 */
function placeMirrorShots(shots: Shot[], places: Place[]): Shot[] {
  const out = [...shots];
  for (let i = 0; i < out.length; i++) {
    if (out[i] !== "mirror" || places[i].mirror) continue;
    const j = out.findIndex((shot, k) => places[k].mirror && shot !== "mirror");
    if (j >= 0) [out[i], out[j]] = [out[j], out[i]];
    else out[i] = "selfie";
  }
  return out;
}

/**
 * Deterministic slot plan. Draw order per category: location shuffle (first 5
 * kept), shot shuffle, one outfit shuffle per spice level, then per slot an
 * activity from that location's list (two-handed ones excluded for selfie and
 * mirror shots) and a time of day from that location's allowed times.
 * Shuffles guarantee no repeated location or outfit within a category;
 * activities may repeat. Changing this order changes every slot.
 */
export function planSlots(): Slot[] {
  const rng = makeRng(PLANNER_SEED);
  const slots: Slot[] = [];
  for (const category of CATEGORIES) {
    const pool = POOLS[category];
    const places = shuffle(rng, pool.locations).slice(0, 5);
    const deck = category === "photoshoot" ? PHOTOSHOOT_SHOT_DECK : SHOT_DECK;
    const shots = placeMirrorShots(shuffle(rng, deck), places);
    const decks = pool.outfitsByLevel.map((level) => shuffle(rng, level));
    const used = decks.map(() => 0);
    const spices = category === "glamour" ? GLAMOUR_SPICE : null;
    for (let i = 0; i < 5; i++) {
      const spice = spices ? spices[i] : null;
      const level = (spice ?? 1) - 1;
      const outfit = decks[level][used[level]++];
      if (!outfit) throw new Error(`Outfit pool exhausted for ${category} level ${level + 1}`);
      const phoneInHand = shots[i] === "selfie" || shots[i] === "mirror";
      const activities = places[i].activities.filter((a) => !(phoneInHand && a.twoHanded));
      if (!activities.length) throw new Error(`No one-handed activity for ${places[i].name}`);
      slots.push({
        slotId: `${category}-${i + 1}`,
        category,
        index: i + 1,
        shot: shots[i],
        location: places[i].name,
        outfit,
        activity: rngPick(rng, activities).text,
        timeOfDay: rngPick(rng, places[i].times),
        spice,
      });
    }
  }
  return slots;
}

// ---------- writer ----------

export const WRITER_SYSTEM_PROMPT = `You write scene descriptions for photorealistic smartphone photos of one
recurring character. Reference images supply her identity, so you never
describe her face, never give her a name, and never change her hair color,
eye color or body type.

For each slot, write one scene that uses exactly the slot's category,
location, time of day, shot type, outfit and activity. Fill every field:
- setting: the place plus 1-2 concrete details (not "a cafe" but "a narrow
  corner cafe with a marble counter and a chalkboard menu")
- wardrobe: garment, color, fabric, fit
- action: what her hands and body do, natural and unposed
- expression: one precise expression
- background: what is behind her, with ordinary real-life clutter
- lighting: the light that would really be there at that time

Rules:
- She is the only person in focus; other people only blurred, far behind.
- Her face is fully visible: no sunglasses over the eyes, no hand or phone
  covering it.
- Everyday realism: ordinary places, imperfect framing. Studio polish only
  in the Photoshoot category.
- No text, logos, brand names or readable signs.
- Never use words that suggest youth (girl, teen, kid, child, schoolgirl) —
  say "woman" or "she". No children anywhere in the scene.
- Glamour: suggestive but non-nude and non-explicit; clothing stays on and
  opaque.
- 40-70 words per scene. Plain present tense. Never use "stunning",
  "beautiful", "perfect", "flawless".
Return JSON matching the schema, one object per slot, in slot order.`;

const CATEGORY_LABEL: Record<Category, string> = {
  home: "Home",
  travel: "Travel",
  photoshoot: "Photoshoot",
  glamour: "Glamour",
  fitness: "Fitness",
};
const SHOT_LABEL: Record<Shot, string> = {
  friend: "photo taken by a friend",
  selfie: "front-camera selfie",
  mirror: "mirror selfie",
  candid: "candid shot, not looking at the camera",
  photographer: "photo taken by a photographer with a full-frame camera",
};

/** The writer's user message: the slots as JSON, with readable labels. */
export function writerUserMessage(slots: Slot[]): string {
  return JSON.stringify(
    slots.map((s) => ({
      slotId: s.slotId,
      category: CATEGORY_LABEL[s.category],
      location: s.location,
      timeOfDay: s.timeOfDay,
      shot: SHOT_LABEL[s.shot],
      outfit: s.outfit,
      activity: s.activity,
    })),
    null,
    2
  );
}

const SCENE_FIELDS = ["setting", "wardrobe", "action", "expression", "background", "lighting"] as const;

export const Scene = z.object({
  slotId: z.string(),
  setting: z.string().min(1),
  wardrobe: z.string().min(1),
  action: z.string().min(1),
  expression: z.string().min(1),
  background: z.string().min(1),
  lighting: z.string().min(1),
});
export type Scene = z.infer<typeof Scene>;
export const WriterOutput = z.object({ scenes: z.array(Scene) });
export type WriterOutput = z.infer<typeof WriterOutput>;

export const WRITER_RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "scenes",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["scenes"],
      properties: {
        scenes: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["slotId", ...SCENE_FIELDS],
            properties: Object.fromEntries(["slotId", ...SCENE_FIELDS].map((f) => [f, { type: "string" }])),
          },
        },
      },
    },
  },
};

/** Spec list plus plural forms; any hit rejects the whole writer output. */
const YOUTH_WORDS = /\b(?:teens?|teenage|schoolgirls?|girls?|child|children|kids?|minors?|underage|young-looking|barely legal)\b/i;

/**
 * Validates the writer's output against the plan: exactly one scene per slot
 * id, no unknown ids, and no youth words in any field. Throws with a clear
 * message; the caller writes nothing on failure.
 */
export function validateScenes(slots: Slot[], out: WriterOutput): Map<string, Scene> {
  const bySlot = new Map<string, Scene>();
  const known = new Set(slots.map((s) => s.slotId));
  for (const scene of out.scenes) {
    if (!known.has(scene.slotId)) throw new Error(`Writer returned unknown slotId "${scene.slotId}"`);
    if (bySlot.has(scene.slotId)) throw new Error(`Writer returned slotId "${scene.slotId}" more than once`);
    for (const f of SCENE_FIELDS) {
      const hit = YOUTH_WORDS.exec(scene[f]);
      if (hit) throw new Error(`Writer output rejected: youth word "${hit[0]}" in ${scene.slotId}.${f}: "${scene[f]}"`);
    }
    bySlot.set(scene.slotId, scene);
  }
  const missing = slots.filter((s) => !bySlot.has(s.slotId)).map((s) => s.slotId);
  if (missing.length) throw new Error(`Writer output is missing slots: ${missing.join(", ")}`);
  return bySlot;
}

/** Offline stand-in for the writer (--fake-writer): scene fields straight from slot fields. */
export function fakeWriterOutput(slots: Slot[]): WriterOutput {
  return {
    scenes: slots.map((s) => ({
      slotId: s.slotId,
      setting: `${s.location}, ${s.timeOfDay}`,
      wardrobe: s.outfit,
      action: `She is ${s.activity}`,
      expression: "a relaxed half-smile",
      background: "ordinary everyday clutter, softly out of focus",
      lighting: `light that fits ${s.timeOfDay}`,
    })),
  };
}

// ---------- assembler ----------

const ANCHORS = "25 years old, hazel eyes, light freckles across the nose, shoulder-length wavy chestnut hair";
const SHOT_TEXT: Record<Shot, string> = {
  friend: "Photo taken by a friend with the rear phone camera, three-quarter or full-body framing, face clearly visible",
  selfie: "Front-camera selfie at arm's length, slight wide-angle distortion, face fully visible",
  mirror: "Mirror selfie, phone held at chest height, face fully visible in the mirror",
  candid: "Candid shot, she is not looking at the camera, face in three-quarter view and clearly visible",
  photographer: "Photographed by a photographer with a full-frame camera, three-quarter or full-body framing, face clearly visible",
};
const REALISM_EDITORIAL = "Editorial photo, natural skin texture, no heavy retouching.";
const REALISM_PHONE = "Smartphone photo, natural skin texture, slight noise, no retouching, no beauty filter.";
const CONSTRAINTS = "She is an adult woman, 25 years old. Only she is in focus; no text, logos or brand names.";
const GLAMOUR_CONSTRAINTS = " Tasteful and non-nude: clothing stays on and fully opaque, no explicit pose.";
const BANNED = /\b(?:8k|masterpiece|professional photo|perfect skin|stunning|flawless|beautiful)\b/gi;

/** Trailing punctuation is dropped so the template's own separators are the only ones. */
function field(s: string): string {
  return s.trim().replace(/[\s.,;:!]+$/, "");
}

function normalize(s: string): string {
  return s
    .replace(BANNED, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,;])/g, "$1")
    .replace(/,(?:\s*,)+/g, ",")
    .replace(/\.(?:\s*\.)+/g, ".")
    .replace(/,\s*\./g, ".")
    .trim();
}

const BINDING_ONE = "The same woman as in the reference photo,";
const BINDING_MANY = "The same woman as in the reference photos,";

/** The assembled prompt names one reference photo; a request that sends several says "photos". */
export function bindReferences(prompt: string, refCount: number): string {
  if (!prompt.startsWith(BINDING_ONE)) throw new Error(`Prompt does not start with the identity binding: ${prompt.slice(0, 60)}`);
  return refCount > 1 ? BINDING_MANY + prompt.slice(BINDING_ONE.length) : prompt;
}

/** Deterministic final prompt for one slot. */
export function assemblePrompt(slot: Slot, scene: Scene): string {
  const realism = slot.category === "photoshoot" ? REALISM_EDITORIAL : REALISM_PHONE;
  const constraints = CONSTRAINTS + (slot.category === "glamour" ? GLAMOUR_CONSTRAINTS : "");
  const raw =
    `${BINDING_ONE} with her exact face, facial proportions and hairline; ${ANCHORS}. ` +
    `${SHOT_TEXT[slot.shot]}. ${field(scene.setting)}. ${field(scene.wardrobe)}. ` +
    `${field(scene.action)}, ${field(scene.expression)}. ${field(scene.background)}. ${field(scene.lighting)}. ` +
    `${realism} ${constraints}`;
  const prompt = normalize(raw);
  const hit = YOUTH_WORDS.exec(prompt);
  if (hit) throw new Error(`Assembled prompt for ${slot.slotId} contains youth word "${hit[0]}"`);
  return prompt;
}

// ---------- scenes.json ----------

export const ScenesFile = z.object({
  version: z.literal(1),
  fake: z.boolean(),
  createdAt: z.string(),
  seed: z.number().int(),
  slots: z.array(Slot),
  writerOutput: WriterOutput,
  prompts: z.record(z.string(), z.string()),
  writer: z.object({
    model: z.string(),
    jobId: z.string(),
    costMicros: z.number().int().nonnegative(),
    estimated: z.boolean(),
    latencyMs: z.number().nullable(),
    finishReason: z.string().nullable(),
  }),
});
export type ScenesFile = z.infer<typeof ScenesFile>;
