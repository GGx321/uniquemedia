import { z } from "zod";
import { CategoryPoses, youthWords } from "../../shared/engine";
import type { Pose } from "./schema";
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
}
function one(text: string): Activity {
  return { text, twoHanded: false };
}
function two(text: string): Activity {
  return { text, twoHanded: true };
}

/** A location with the times of day it is plausible at and the activities
 *  that fit it; `mirror` marks a location a mirror shot may land on. */
export interface Place {
  name: string;
  times: readonly string[];
  activities: readonly Activity[];
  mirror?: true;
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
export const POOLS: Record<Category, Pool> = {
  home: {
    locations: [
      {
        name: "a bright kitchen",
        times: ["morning", "midday"],
        activities: [two("cooking pancakes"), one("holding a ceramic coffee mug"), two("slicing fruit on a cutting board")],
      },
      {
        name: "an unmade bed with white linen",
        times: ["morning"],
        activities: [one("holding a ceramic coffee mug"), one("stretching after waking up"), one("scrolling her phone")],
      },
      {
        name: "a living room couch with a laptop",
        times: ["midday", "evening"],
        activities: [two("typing on the laptop"), one("holding a ceramic coffee mug"), one("laughing at something on the screen")],
      },
      {
        name: "a bathroom with a large vanity mirror",
        times: ["morning", "evening"],
        mirror: true,
        activities: [one("brushing her hair"), one("applying lip balm"), two("tying her hair up")],
      },
      {
        name: "a small balcony with potted plants",
        times: ["morning", "golden hour"],
        activities: [one("watering plants"), one("holding a ceramic coffee mug"), one("leaning on the railing")],
      },
      {
        name: "a reading nook by the window",
        times: ["midday", "golden hour"],
        activities: [one("reading a paperback"), one("holding a cup of tea"), one("looking out of the window")],
      },
    ],
    outfits: ["an oversized cream knit sweater", "matching satin pajamas", "a grey lounge set", "a plain white t-shirt and cotton shorts", "a cozy hoodie"],
    shotDeck: DEFAULT_SHOT_DECK,
  },
  travel: {
    locations: [
      {
        name: "a sandy beach at the waterline",
        times: ["midday", "golden hour"],
        activities: [one("walking along the waterline"), one("holding her sandals"), one("sitting on a towel")],
      },
      {
        name: "a narrow old-town street",
        times: ["morning", "midday", "golden hour"],
        activities: [one("holding a paper cup of coffee"), two("looking at a paper map"), one("eating gelato")],
      },
      {
        name: "a hotel balcony overlooking the sea",
        times: ["morning", "golden hour"],
        activities: [one("leaning on the railing"), one("holding a cup of coffee"), one("looking out at the sea")],
      },
      {
        name: "an airplane window seat",
        times: ["morning", "midday"],
        activities: [one("looking out of the window"), one("holding a cup of coffee"), one("reading a magazine")],
      },
      {
        name: "a mountain viewpoint",
        times: ["morning", "midday", "golden hour"],
        activities: [one("taking in the view"), two("adjusting her backpack straps"), one("holding a water bottle")],
      },
      {
        name: "the deck of a small boat",
        times: ["midday", "golden hour"],
        activities: [one("holding the rail"), one("sitting on the edge of the deck"), one("letting the wind blow her hair")],
      },
      {
        name: "a hotel room with a full-length mirror",
        times: ["morning", "evening"],
        mirror: true,
        activities: [one("adjusting her outfit"), one("putting on earrings"), one("checking her look")],
      },
    ],
    outfits: ["a light linen sundress", "a linen shirt and denim shorts", "a straw hat and a summer dress", "a white button-up shirt"],
    shotDeck: DEFAULT_SHOT_DECK,
  },
  photoshoot: {
    locations: [
      {
        name: "a studio with a seamless beige backdrop",
        times: ["studio lighting"],
        activities: [one("posing with one hand in her hair"), one("sitting on a wooden stool"), one("looking over her shoulder")],
      },
      {
        name: "a city street, lit by direct on-camera flash",
        times: ["night"],
        activities: [one("walking toward the camera"), one("leaning against a wall"), one("looking over her shoulder")],
      },
      {
        name: "a wheat field",
        times: ["golden hour"],
        activities: [one("walking through the wheat"), one("running her hand over the wheat"), one("looking over her shoulder")],
      },
      {
        name: "a concrete rooftop",
        times: ["golden hour", "evening"],
        activities: [one("leaning against a wall"), one("sitting on a concrete step"), one("walking toward the camera")],
      },
      {
        name: "a vintage cafe interior",
        times: ["midday", "evening"],
        activities: [one("sitting at a small table with a cup"), one("leaning on the counter"), one("looking out of the window")],
      },
    ],
    outfits: ["a tailored black blazer over a white tee", "a satin evening dress", "a denim jacket and jeans", "a monochrome knit set", "a trench coat"],
    shotDeck: PHOTOSHOOT_SHOT_DECK,
  },
  glamour: {
    locations: [
      {
        name: "a bedroom with a full-length mirror",
        times: ["evening", "night"],
        mirror: true,
        activities: [one("adjusting her hair"), one("standing with one hand on her hip"), one("putting on earrings")],
      },
      {
        name: "a hotel room",
        times: ["evening", "night"],
        mirror: true,
        activities: [one("sitting on the edge of the bed"), one("putting on earrings"), one("standing by the window")],
      },
      {
        name: "a bathroom with soft warm light",
        times: ["evening"],
        mirror: true,
        activities: [one("adjusting her hair"), one("applying lipstick"), one("leaning on the sink counter")],
      },
      {
        name: "a walk-in closet",
        times: ["evening"],
        mirror: true,
        activities: [two("choosing a dress from a rack"), one("adjusting her hair"), one("standing with one hand on her hip")],
      },
      {
        name: "a bed with silk sheets",
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
        times: ["morning", "evening"],
        mirror: true,
        activities: [one("resting between sets"), one("holding a water bottle"), one("adjusting her ponytail")],
      },
      {
        name: "a yoga mat in a sunlit living room",
        times: ["morning"],
        activities: [two("doing a yoga pose"), one("stretching"), one("sitting cross-legged")],
      },
      {
        name: "a park running path",
        times: ["morning"],
        activities: [two("jogging"), one("stretching her legs"), one("holding a water bottle")],
      },
      {
        name: "a pilates studio",
        times: ["morning", "midday"],
        mirror: true,
        activities: [two("stretching on a reformer"), one("resting between exercises"), one("holding a water bottle")],
      },
      {
        name: "a home workout corner",
        times: ["morning", "evening"],
        activities: [one("stretching after a workout"), one("holding a water bottle"), two("tying her sneakers")],
      },
    ],
    outfits: ["biker shorts and a crop top", "a matching athletic set", "a loose hoodie over leggings", "running shorts and a tank top"],
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

const OutfitSchema = z
  .string()
  .min(1)
  .regex(/^[\x20-\x7e]+$/, "outfit text must be plain ASCII")
  .refine((outfit) => !REVEALING_WORDS.test(outfit), { message: "revealing outfits are out of scope for Stage 2" })
  .refine((outfit) => !suggestsAMinor(outfit), { message: "pool text must not suggest a minor (studio/shared/engine/ageText.ts youthWords)" });

export const PoolSchema = z
  .strictObject({
    locations: z.array(PlaceSchema).min(1),
    outfits: z.array(OutfitSchema).min(1),
    shotDeck: z.array(z.enum(SHOTS)).min(1),
    poses: CategoryPoses.optional(),
  })
  .refine((pool) => !pool.shotDeck.includes("mirror") || pool.locations.some((l) => l.mirror === true), {
    message: "a shot deck that can draw a mirror shot needs at least one mirror location to place it on",
    path: ["locations"],
  });

/** Validates every category's pool; throws with every problem found (not
 *  just the first) so a malformed pool fails loudly and completely. Called
 *  eagerly below, so importing this module at all already checks the data. */
export function validatePools(): void {
  const problems: string[] = [];
  for (const category of CATEGORIES) {
    const result = PoolSchema.safeParse(POOLS[category]);
    if (!result.success) problems.push(`${category}: ${z.prettifyError(result.error)}`);
  }
  if (problems.length > 0) throw new Error(`Studio scene pools are invalid:\n${problems.join("\n")}`);
}

validatePools();
