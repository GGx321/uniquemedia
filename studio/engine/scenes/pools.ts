import { z } from "zod";
import { CategoryPoses, youthWords } from "../../shared/engine";
import { isPhoneInHandShot, type Pose } from "./schema";
import { CATEGORIES, SHOTS, type Category, type Shot } from "./types";
import { REVEALING_WORDS } from "./words";

// The scene pools: everyday locations, outfits and shot decks per category.
// Data, not code (T5a, item 1) — ported and cleaned up from the spike
// (spike/studio-api/lib/scenes.ts, proven on the 2026-09-24 run) and validated
// with zod at load, so a malformed pool is a test failure, not a production
// surprise. Kept in English throughout: this text feeds image prompts (T5b).
//
// Deviations from the spike, both required by the fixed decisions
// (docs/studio/2026-09-24-stage-2-plan.md, "Revealing outfits"):
// - No spice levels / outfitsByLevel: Stage 2 has no revealing-scene provider
//   yet, so every category now has one flat outfit list. Glamour's list keeps
//   only the three outfits the decision names as non-revealing (bodycon
//   dress, mini skirt + cropped top, corset top + trousers); its other two
//   tiers (bikini, lingerie, ...) are dropped entirely, not merely disabled.
// - Travel's "one-piece swimsuit with a sarong" and fitness's "leggings and a
//   sports bra" are dropped: swimwear and sports bras are explicitly on the
//   disabled list even though they are not Glamour-category items.

/** One activity a location allows. Two-handed activities never pair with a
 *  selfie or mirror shot: one hand holds the phone. */
export interface Activity {
  text: string;
  twoHanded: boolean;
  /** The phone is in her hand or in use. Optional: a stored custom pool has no such flag (see `isPhoneActivity`). */
  phone?: true;
  /** The activity may happen in a messy room (the room draw's rare messy state, phoneLook.ts). */
  messyOk?: true;
}
type ActivityFlag = "phone" | "messyOk";
function activity(text: string, twoHanded: boolean, flags: readonly ActivityFlag[]): Activity {
  return { text, twoHanded, ...(flags.includes("phone") ? { phone: true as const } : {}), ...(flags.includes("messyOk") ? { messyOk: true as const } : {}) };
}
function one(text: string, ...flags: ActivityFlag[]): Activity {
  return activity(text, false, flags);
}
function two(text: string, ...flags: ActivityFlag[]): Activity {
  return activity(text, true, flags);
}

/** A location with the times of day it is plausible at and the activities
 *  that fit it; `mirror` marks a location a mirror shot may land on. */
export interface Place {
  name: string;
  times: readonly string[];
  activities: readonly Activity[];
  mirror?: true;
  /** A room of her home or hotel: the room draw adds a tidy, lived-in or messy phrase. Absent on a custom place. */
  room?: true;
  /** 2-3 ordinary things in the room, only where `room` is set. */
  details?: readonly string[];
  /** The place as a locative phrase, for 5a.2's sentence template. */
  at?: string;
}

// A stored custom pool is built from the shared `PoolActivity {text, twoHanded}`, which carries no phone flag, so its phone activities are found by their words.
export const PHONE_WORDS = /\b(phones?|smartphones?|iphones?|cellphones?|texting|facetime)\b/i;

/** The phone is in her hand or in use: the flag for a built-in activity, the word-bounded text for a stored custom one (the built-ins' flags are pinned to agree with the words). */
export function isPhoneActivity(activity: { text: string; phone?: true | undefined }): boolean {
  return activity.phone === true || PHONE_WORDS.test(activity.text);
}

/**
 * The activities a shot may draw at a place (M3, N1), shared by the planner and «Другая сцена» (redraw.ts). A selfie or mirror has one hand on the phone, so it
 * drops the two-handed activities, and it drops the phone ones too: her phone is already the camera or the mirror prop, and a second one in her hand is the
 * «second phone» defect (I5.2). A place with no one-handed non-phone activity keeps its one-handed list (a custom place can be built that way), so the list is
 * never emptied by the phone rule; every other shot draws from all of them.
 */
export function allowedActivities(place: { activities: readonly Activity[] }, shot: Shot): readonly Activity[] {
  if (!isPhoneInHandShot(shot)) return place.activities;
  const freeHanded = place.activities.filter((a) => !a.twoHanded);
  const clean = freeHanded.filter((a) => !isPhoneActivity(a));
  return clean.length > 0 ? clean : freeHanded;
}

/** One category's pools: its locations, its flat outfit list (no revealing
 *  items in Stage 2) and the shot deck the planner draws from. */
export interface Pool {
  locations: readonly Place[];
  outfits: readonly string[];
  shotDeck: readonly Shot[];
  /**
   * CS.8a: the angles a custom category's description asked for. A slot of the category draws its pose from them, whatever the run's «Ракурсы» toggles say
   * (planner.ts). Absent on every built-in and on a custom category without a preference.
   */
  poses?: readonly Pose[];
}

/** Every category but Photoshoot: 2 friend, 1 selfie, 1 mirror, 1 candid. */
const DEFAULT_SHOT_DECK: readonly Shot[] = ["friend", "selfie", "mirror", "candid", "friend"];
/** Photoshoot's own deck (spike "Planner rules"): 3 photographer, 2 candid. */
const PHOTOSHOOT_SHOT_DECK: readonly Shot[] = ["photographer", "photographer", "photographer", "candid", "candid"];

// planner.ts gives each category its own rng sub-stream (categorySeed), so
// editing one category's pool here (adding/removing a location, outfit or
// shot-deck entry) only ever changes THAT category's plans for a given seed
// — never another category's, even though `plan()` draws every category
// from what looks like "the same" seed. Order within a category's own arrays
// still matters for existing seeds (the initial shuffle depends on it).
// S5.1c (T11): ordinary places of her own life. No paper, no screens but her phone, no studio, no luxury (spike A: «все комнаты в хламе» was the tidiness draw
// run too high, and the paper and the laptops were the staging). A `phone` activity has the phone in use; a `room` carries 2-3 ordinary details for the room
// draw; `messyOk` marks an activity that fits a rarely messy room; `at` is the place as a locative phrase for 5a.2's sentence template.
export const POOLS: Record<Category, Pool> = {
  home: {
    locations: [
      {
        name: "her small kitchen",
        at: "in her small kitchen",
        room: true,
        details: ["a kettle on the counter", "a fruit bowl"],
        times: ["morning", "midday"],
        activities: [one("waiting for the kettle"), one("holding a ceramic coffee mug"), two("slicing fruit on a cutting board")],
      },
      {
        name: "her unmade bed",
        at: "on her unmade bed",
        room: true,
        details: ["a charger cable on the bed", "a hoodie on the chair"],
        times: ["morning"],
        activities: [one("stretching after waking up", "messyOk"), one("scrolling her phone", "phone"), one("holding a ceramic coffee mug")],
      },
      {
        name: "the couch under a blanket",
        at: "on the couch under a blanket",
        room: true,
        details: ["a cushion on the floor", "a mug on the side table"],
        times: ["midday", "evening"],
        activities: [one("laughing at her phone", "phone"), one("holding a ceramic coffee mug"), two("pulling the blanket over her knees")],
      },
      {
        name: "her bathroom mirror",
        at: "at her bathroom mirror",
        room: true,
        details: ["a hair dryer by the sink", "a towel on the hook"],
        times: ["morning", "evening"],
        mirror: true,
        activities: [one("brushing her hair"), one("applying lip balm"), two("tying her hair up")],
      },
      {
        name: "a small balcony with potted plants",
        at: "on a small balcony with potted plants",
        times: ["morning", "golden hour"],
        activities: [one("watering plants"), one("holding a ceramic coffee mug"), one("leaning on the railing")],
      },
      {
        name: "a chair by her bedroom window",
        at: "on a chair by her bedroom window",
        room: true,
        details: ["a plant on the windowsill", "a cardigan over the chair"],
        times: ["midday", "golden hour"],
        activities: [one("looking out of the window"), one("holding a cup of tea"), one("pulling her knees up")],
      },
    ],
    outfits: ["an oversized cream knit sweater", "a tank top and pajama shorts", "a grey lounge set", "a plain white t-shirt and cotton shorts", "a cozy hoodie"],
    shotDeck: DEFAULT_SHOT_DECK,
  },
  travel: {
    locations: [
      {
        name: "a sandy beach at the waterline",
        at: "on a sandy beach at the waterline",
        times: ["midday", "golden hour"],
        activities: [one("walking along the waterline"), one("holding her sandals"), one("sitting on a towel")],
      },
      {
        name: "a narrow old-town street",
        at: "on a narrow old-town street",
        times: ["morning", "midday", "golden hour"],
        activities: [one("holding a takeaway coffee"), two("checking directions on her phone", "phone"), one("eating gelato")],
      },
      {
        name: "a small hotel balcony",
        at: "on a small hotel balcony",
        times: ["morning", "golden hour"],
        activities: [one("leaning on the railing"), one("holding a cup of coffee"), one("looking out at the sea")],
      },
      {
        name: "an airplane window seat",
        at: "in an airplane window seat",
        times: ["morning", "midday"],
        activities: [one("looking out of the window"), one("holding a cup of coffee"), one("scrolling her phone", "phone")],
      },
      {
        name: "a mountain viewpoint",
        at: "at a mountain viewpoint",
        times: ["morning", "midday", "golden hour"],
        activities: [one("taking in the view"), two("adjusting her backpack straps"), one("holding a water bottle")],
      },
      {
        name: "a ferry deck",
        at: "on a ferry deck",
        times: ["midday", "golden hour"],
        activities: [one("holding the rail"), one("sitting on the edge of the deck"), one("letting the wind blow her hair")],
      },
      {
        name: "an ordinary hotel room mirror",
        at: "at the mirror of an ordinary hotel room",
        room: true,
        details: ["a suitcase open on the floor", "a key card on the nightstand"],
        times: ["morning", "evening"],
        mirror: true,
        activities: [one("adjusting her outfit"), one("putting on earrings"), one("checking her look")],
      },
    ],
    outfits: ["a light linen sundress", "a linen shirt and denim shorts", "a sundress and sneakers", "a white button-up shirt"],
    shotDeck: DEFAULT_SHOT_DECK,
  },
  photoshoot: {
    locations: [
      {
        name: "a plain wall in her hallway",
        at: "against a plain wall in her hallway",
        room: true,
        details: ["a coat rack by the door", "shoes by the door"],
        times: ["morning", "evening"],
        activities: [one("tucking her hair behind her ear"), one("sitting on a wooden stool"), one("looking over her shoulder")],
      },
      {
        name: "a city street at night",
        at: "on a city street at night",
        times: ["night"],
        activities: [one("walking down the street"), one("leaning against a wall"), one("looking over her shoulder")],
      },
      {
        name: "a field by the road",
        at: "in a field by the road",
        times: ["golden hour"],
        activities: [one("walking through the wheat"), one("running her hand over the wheat"), one("looking over her shoulder")],
      },
      {
        name: "the stairs outside her building",
        at: "on the stairs outside her building",
        times: ["golden hour", "evening"],
        activities: [one("sitting on a step"), one("leaning against the railing"), one("walking down the stairs")],
      },
      {
        name: "a corner cafe table",
        at: "at a corner cafe table",
        times: ["midday", "evening"],
        activities: [one("sitting at a small table with a cup"), one("leaning on the counter"), one("looking out of the window")],
      },
    ],
    outfits: ["an oversized blazer over a tee and jeans", "a black going-out dress", "a denim jacket and jeans", "a monochrome knit set", "a trench coat"],
    shotDeck: PHOTOSHOOT_SHOT_DECK,
  },
  glamour: {
    locations: [
      {
        name: "her bedroom mirror, clothes on the chair",
        at: "at her bedroom mirror",
        room: true,
        details: ["a lamp on the nightstand", "shoes by the bed"],
        times: ["evening", "night"],
        mirror: true,
        activities: [one("adjusting her hair"), one("checking her outfit", "messyOk"), one("putting on earrings")],
      },
      {
        name: "an ordinary hotel room",
        at: "in an ordinary hotel room",
        room: true,
        details: ["a suitcase open on the floor", "a key card on the nightstand"],
        times: ["evening", "night"],
        mirror: true,
        activities: [one("sitting on the edge of the bed"), one("putting on earrings"), one("standing by the window")],
      },
      {
        name: "her bathroom mirror, the ceiling light on",
        at: "at her bathroom mirror",
        room: true,
        details: ["a hair dryer by the sink", "a towel on the hook"],
        times: ["evening"],
        mirror: true,
        activities: [one("adjusting her hair"), one("applying lipstick"), one("leaning on the sink counter")],
      },
      {
        name: "her open wardrobe with a mirror door",
        at: "at her open wardrobe",
        room: true,
        details: ["shoes by the door", "a pile of folded tops"],
        times: ["evening"],
        mirror: true,
        activities: [two("choosing a dress from her wardrobe", "messyOk"), one("adjusting her hair"), one("standing with one hand on her hip")],
      },
      {
        name: "her bed with cotton sheets",
        at: "on her bed with cotton sheets",
        room: true,
        details: ["a charger cable on the bed", "a hoodie on the chair"],
        times: ["morning", "evening"],
        activities: [one("sitting on the edge of the bed"), one("lying on her side propped on an elbow"), one("stretching")],
      },
    ],
    // Non-revealing only (fixed decision, "Revealing outfits"): the mini
    // skirt + cropped top and the corset top + trousers passed refusal
    // checks on every model in the spike. The bodycon dress is untested
    // there; per the same decision it relies on the one-attempt Seedream
    // fallback if Grok refuses it. Bikinis, lingerie and slip dresses are
    // dropped entirely, not merely gated.
    outfits: ["a fitted black bodycon dress", "a mini skirt with a cropped top", "a corset top with high-waisted trousers"],
    shotDeck: DEFAULT_SHOT_DECK,
  },
  fitness: {
    locations: [
      {
        name: "a gym in front of a mirror",
        at: "in a gym in front of a mirror",
        times: ["morning", "evening"],
        mirror: true,
        activities: [one("resting between sets"), one("holding a water bottle"), one("adjusting her ponytail")],
      },
      {
        name: "a yoga mat on her living-room floor",
        at: "on a yoga mat on her living-room floor",
        room: true,
        details: ["a rolled-up towel", "a water bottle on the floor"],
        times: ["morning"],
        activities: [two("doing a yoga pose"), one("stretching"), one("sitting cross-legged")],
      },
      {
        name: "a park running path",
        at: "on a park running path",
        times: ["morning"],
        activities: [two("jogging"), one("stretching her legs"), one("holding a water bottle")],
      },
      {
        name: "the gym locker-room mirror",
        at: "at the gym locker-room mirror",
        times: ["morning", "evening"],
        mirror: true,
        activities: [one("resting on the bench"), one("holding a water bottle"), one("adjusting her ponytail")],
      },
      {
        name: "a home workout corner",
        at: "in her home workout corner",
        room: true,
        details: ["a yoga mat against the wall", "a pair of dumbbells by the door"],
        times: ["morning", "evening"],
        activities: [one("stretching after a workout"), one("holding a water bottle"), two("tying her sneakers")],
      },
    ],
    outfits: ["biker shorts and a crop top", "leggings and a fitted tank top", "a loose hoodie over leggings", "running shorts and a tank top"],
    shotDeck: DEFAULT_SHOT_DECK,
  },
};

// ---------- validation ----------

// REVEALING_WORDS lives in ./words.ts now (review round 1, MEDIUM: it was
// duplicated here and in writer.ts). Anything matching it can never enter a
// pool.

/**
 * The same check the descriptor gate uses on its own text
 * (studio/shared/engine/ageText.ts, `adultTextProblems`'s "youth-word"
 * branch), in the same "descriptor" scope: this pool text is engine-authored
 * and goes straight into every image prompt, exactly like the descriptor, so
 * it is held to the same strict word list ("petite", "school...", "young",
 * ...), not only the vibe's hard markers. Independent of REVEALING_WORDS
 * above: an outfit can be perfectly non-revealing and still suggest a minor
 * ("a schoolgirl skirt"), or vice versa.
 */
function suggestsAMinor(text: string): boolean {
  return youthWords(text, "descriptor").length > 0;
}

const NonEmpty = z.string().min(1);

/** Location names and activity text: free English prose that feeds prompts,
 *  so both go through the youth-word guard. */
const PromptText = z.string().min(1).refine((text) => !suggestsAMinor(text), {
  message: "pool text must not suggest a minor (studio/shared/engine/ageText.ts youthWords)",
});

const ActivitySchema = z.strictObject({ text: PromptText, twoHanded: z.boolean() });

const OutfitSchema = z
  .string()
  .min(1)
  .regex(/^[\x20-\x7e]+$/, "outfit text must be plain ASCII")
  .refine((outfit) => !REVEALING_WORDS.test(outfit), { message: "revealing outfits are out of scope for Stage 2" })
  .refine((outfit) => !suggestsAMinor(outfit), { message: "pool text must not suggest a minor (studio/shared/engine/ageText.ts youthWords)" });

const MIRROR_NEEDS_A_PLACE = {
  message: "a shot deck that can draw a mirror shot needs at least one mirror location to place it on",
  path: ["locations"],
};

/** The shape of a pool a custom category can store: a place has a name, times, activities and a mirror mark, nothing more. */
const PlaceSchema = z
  .strictObject({
    name: PromptText,
    times: z.array(NonEmpty).min(1),
    activities: z.array(ActivitySchema).min(1),
    mirror: z.literal(true).optional(),
  })
  .refine((place) => place.activities.some((a) => !a.twoHanded), {
    message: "every location needs at least one one-handed activity: a selfie or mirror shot needs a free hand",
    path: ["activities"],
  });

export const PoolSchema = z
  .strictObject({
    locations: z.array(PlaceSchema).min(1),
    outfits: z.array(OutfitSchema).min(1),
    shotDeck: z.array(z.enum(SHOTS)).min(1),
    poses: CategoryPoses.optional(),
  })
  .refine((pool) => !pool.shotDeck.includes("mirror") || pool.locations.some((l) => l.mirror === true), MIRROR_NEEDS_A_PLACE);

// ---------- the built-in pools (S5.1c) ----------

// Paper, screens and the staging and luxury words of the writer's «never use these words» list: ordinary places of her own life have none of them. Her phone
// is the only screen. Word-bounded, so «headphones» and «papaya» pass; the stored `times` (POOL_TIMES, which keeps «golden hour») are not prose and not checked.
const POOL_BANNED_WORDS =
  /\b(paper\w*|books?|magazines?|documents?|notebooks?|menus?|maps?|desks?|stud(?:y|ying|io)|laptops?|tablets?|screens?|newspapers?|television|tv|professional|photographer|photoshoot|editorial|fashion|models?|posing|captures?|candid|cinematic|bokeh|golden hour|softly lit|soft light|glow\w*|dramatic|moody|dreamy|elegant|luxurious|lavish|glamorous|chic|sophisticated|polished|pristine|marble|silk|satin|velvet|stunning|beautiful|perfect|flawless|gorgeous)\b/i;

const BuiltInText = PromptText.refine((text) => !POOL_BANNED_WORDS.test(text), { message: "pool text must be an ordinary place of her own life: no paper, screens, staging or luxury words" });

const BuiltInActivitySchema = z.strictObject({ text: BuiltInText, twoHanded: z.boolean(), phone: z.literal(true).optional(), messyOk: z.literal(true).optional() });

const BuiltInPlaceSchema = z
  .strictObject({
    name: BuiltInText,
    times: z.array(NonEmpty).min(1),
    activities: z.array(BuiltInActivitySchema).min(1),
    mirror: z.literal(true).optional(),
    room: z.literal(true).optional(),
    details: z.array(BuiltInText).optional(),
    at: BuiltInText,
  })
  .superRefine((place, ctx) => {
    const problem = (message: string, path: string): void => ctx.addIssue({ code: "custom", message, path: [path] });
    // The shared PoolSchema only needs a free hand; a built-in place needs a free hand that is not on a phone, so a selfie or mirror always has an activity (M3).
    if (!place.activities.some((a) => !a.twoHanded && !isPhoneActivity(a))) problem("every built-in location needs at least one one-handed activity that is not a phone one", "activities");
    if (place.activities.some((a) => (a.phone === true) !== PHONE_WORDS.test(a.text))) problem("an activity carries the phone flag exactly when its text names her phone", "activities");
    if (place.room === true) {
      if (place.details === undefined || place.details.length < 2 || place.details.length > 3) problem("a room carries 2 or 3 details", "details");
    } else {
      if (place.details !== undefined) problem("only a room carries details", "details");
      if (place.activities.some((a) => a.messyOk === true)) problem("only an activity in a room can be messyOk", "activities");
    }
  });

/** The built-in pools: the shared shape plus the phone, room and look rules above. */
export const BuiltInPoolSchema = z
  .strictObject({
    locations: z.array(BuiltInPlaceSchema).min(1),
    outfits: z.array(OutfitSchema.refine((outfit) => !POOL_BANNED_WORDS.test(outfit), { message: "outfit text must not use a paper, screen, staging or luxury word" })).min(1),
    shotDeck: z.array(z.enum(SHOTS)).min(1),
    poses: CategoryPoses.optional(),
  })
  .refine((pool) => !pool.shotDeck.includes("mirror") || pool.locations.some((l) => l.mirror === true), MIRROR_NEEDS_A_PLACE);

/** Validates every category's pool; throws with every problem found (not
 *  just the first) so a malformed pool fails loudly and completely. Called
 *  eagerly below, so importing this module at all already checks the data. */
export function validatePools(): void {
  const problems: string[] = [];
  for (const category of CATEGORIES) {
    const result = BuiltInPoolSchema.safeParse(POOLS[category]);
    if (!result.success) problems.push(`${category}: ${z.prettifyError(result.error)}`);
  }
  if (problems.length > 0) throw new Error(`Studio scene pools are invalid:\n${problems.join("\n")}`);
}

validatePools();
