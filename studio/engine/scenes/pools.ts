import { z } from "zod";
import { CategoryPoses, isBoldCategory, POOL_TEXT_MAX, youthWords } from "../../shared/engine";
import { BANKS } from "../../shared/scenes/banks";
import { withoutBoldExemptLook } from "../../shared/scenes/banks/boldRules";
import { MOMENT_HAIRS, type CategoryBank, type LegwearSlot, type Moment, type Outfit } from "../../shared/scenes/banks/types";
import { CAPTURES, shotOf, type Capture } from "../../shared/scenes/captures";
import { boldContentLevel, contentProblems } from "../../shared/scenes/contentLine";
import { PHONE_WORDS, SELFIE_WORDS, isOwnerBannedOutfit, withoutExemptLookPhrases } from "../../shared/scenes/words";
import { isPhoneInHandShot, type Pose } from "./schema";
import { CATEGORIES, SHOTS, type Category, type Shot } from "./types";
import { REVEALING_WORDS } from "./words";

// The scene pools: everyday locations, outfits and shot decks per category.
// Data, not code (T5a, item 1) — ported and cleaned up from the spike
// (spike/studio-api/lib/scenes.ts, proven on the 2026-09-24 run) and validated
// with zod at load, so a malformed pool is a test failure, not a production
// surprise. Kept in English throughout: this text feeds image prompts (T5b).
//
// 5a.2 (S5.6b, I5.21): the built-in pools are DERIVED from the shared scene banks (shared/scenes/banks/*, S5.6a), the one source of every phrase: a bank place
// is a `Place`, a bank moment an `Activity` carrying the moment's tags, and a category's deck of captures rides on the pool (`captureDeck`) next to the stored
// `shotDeck` of five shots (I5.27). The bank text is held to the engine's word lists here too (the revealing words, the paper, screens, staging and luxury
// words, with «silk pajamas» exempt, K-22).
//
// Deviations from the spike, both required by the fixed decisions
// (docs/studio/2026-09-24-stage-2-plan.md, "Revealing outfits"):
// - No spice levels / outfitsByLevel: Stage 2 has no revealing-scene provider
//   yet, so every category has one flat outfit list.
// - Swimwear and sports bras are explicitly on the disabled list even though
//   they are not Glamour-category items.

/**
 * One activity a location allows: a bank moment (5a.2), or a stored custom activity, which has only a text and the hands. Two-handed activities never pair
 * with a selfie or mirror shot: one hand holds the phone. The tags are the moment's (shared/scenes/banks/types.ts); a custom activity has none.
 */
export type Activity = Omit<Moment, "captures" | "motion"> & { captures?: readonly Capture[]; motion?: string };

/** A location with the times of day it is plausible at and the activities
 *  that fit it; `mirror` marks a location a mirror shot may land on. */
export interface Place {
  name: string;
  times: readonly string[];
  activities: readonly Activity[];
  mirror?: true;
  /** A room of her home or hotel: the room draw adds a tidy, lived-in or messy phrase. Absent on a custom place. */
  room?: true;
  /** 2-3 ordinary things in the place (every built-in place has them since 5a.2, K-3; a custom place has none). */
  details?: readonly string[];
  /** The place as a locative phrase, for 5a.2's sentence template. */
  at?: string;
  /** «Дом»'s lamp mood at evening and night (I5.34). */
  lamp?: true;
}

// 5a.2 (S5.6b): the two word lists are the shared scene banks' own (shared/scenes/words.ts), so the banks, the template and the engine can never disagree.
// A stored custom pool carries no phone flag, so its phone activities are found by their words; the image model draws a phone for «selfie» or «front camera»
// (owner canary C1), so a hand-held slot's text may not say either.
export { PHONE_WORDS, SELFIE_WORDS };

/** The phone is in her hand or in use: the flag for a built-in activity, the word-bounded text for a stored custom one (the built-ins' flags are pinned to agree with the words). */
export function isPhoneActivity(activity: { text: string; phone?: true | undefined }): boolean {
  return activity.phone === true || PHONE_WORDS.test(activity.text);
}

/** A free-hand activity that does not use her phone: what a selfie or a mirror shot may draw (the phone in her hand is the camera or the mirror prop). */
export function isCleanActivity(activity: Activity): boolean {
  return !activity.twoHanded && !isPhoneActivity(activity) && !SELFIE_WORDS.test(activity.text);
}

/**
 * Whether a selfie or mirror shot can be placed at `place`: it has an activity for one free hand that is not on the phone, and neither its name nor its locative
 * phrase says selfie (C1). Every built-in place has one (pinned).
 */
export function hasCleanActivity(place: { name?: string; at?: string; activities: readonly Activity[] }): boolean {
  if (SELFIE_WORDS.test(place.name ?? "") || SELFIE_WORDS.test(place.at ?? "")) return false;
  return place.activities.some(isCleanActivity);
}

/**
 * The activities a shot may draw at a place (M3, N1), shared by the planner and «Другая сцена» (redraw.ts). A selfie or mirror has one hand on the phone, so it
 * drops the two-handed activities, and it drops the phone ones too: her phone is already the camera or the mirror prop, and a second one in her hand is the
 * «second phone» defect (I5.2). It never falls back to the phone ones (S5.R1): the writer is told her phone appears only when the activity uses it, and the reader refuses a
 * phone in a selfie sentence, so such a slot would be asked again and, refused twice, fail the run. A place with no clean activity is EMPTY here, and the planner and the
 * redraw do not put a selfie or mirror there (`hasCleanActivity`); every other shot draws from all of the place's activities.
 */
export function allowedActivities(place: { activities: readonly Activity[] }, shot: Shot): readonly Activity[] {
  if (!isPhoneInHandShot(shot)) return place.activities;
  return place.activities.filter(isCleanActivity);
}

/** One category's pools: its locations, its flat outfit list (no revealing items in Stage 2) and the shot deck the planner draws from. */
export interface Pool {
  locations: readonly Place[];
  outfits: readonly string[];
  shotDeck: readonly Shot[];
  /**
   * CS.8a: the angles a custom category's description asked for. A slot of the category draws its pose from them, whatever the run's «Ракурсы» toggles say
   * (planner.ts). Absent on every built-in and on a custom category without a preference.
   */
  poses?: readonly Pose[];
  /**
   * 5a.2: who takes the photos, as the planner deals them (exact Bag cycles, I5.32). Present on a built-in pool only; its presence is what makes the planner
   * draw capture, then pose, then a place with a fitting moment, then the moment (planner.ts). A custom pool keeps its stored `shotDeck`.
   */
  captureDeck?: readonly Capture[];
  /** 5a.2: each outfit's marks (shows her legs; worn only by a moment that pins it), beside `outfits`. Built-in pools only. */
  outfitInfo?: readonly Outfit[];
  /** 5a.2: the legwear slot (I5.29, K-17), drawn on about `share` of the slots whose outfit shows her legs. Built-in pools only. */
  legwear?: LegwearSlot;
}

/**
 * The shared everyday outfits (5a.2, S5.6b): what a custom pool draws when the owner's denim rule leaves it none (a pool whose every outfit is denim shorts or a
 * denim skirt). Each passes the same word lists as the banks' outfits.
 */
export const EVERYDAY_OUTFITS: readonly string[] = ["a white t-shirt and jeans", "a grey hoodie and leggings", "a cotton top and linen trousers", "an oversized knit sweater and jeans"];

/**
 * The outfits a pool may draw (the owner, 2026-10-11): no denim shorts and no denim skirts, anywhere. A custom pool stored before the rule may hold them, so the
 * planner and «Другая сцена» draw through this; a pool left with none draws the shared everyday list. The order is kept, so a pool the rule leaves alone plans as it did.
 */
export function usableOutfits(outfits: readonly string[]): readonly string[] {
  const kept = outfits.filter((outfit) => !isOwnerBannedOutfit(outfit));
  return kept.length > 0 ? kept : EVERYDAY_OUTFITS;
}

function activityOf(moment: Moment): Activity {
  return { ...moment };
}

/** A bank's legwear slot as the pool keeps it, with the «Смелая» stockings when the bank has them (M4, plan s5a3 r3 #7: without them no bold slot would wear any). */
function legwearOf(legwear: LegwearSlot): LegwearSlot {
  const { bold } = legwear;
  return { items: [...legwear.items], share: legwear.share, ...(bold === undefined ? {} : { bold: { items: [...bold.items], share: bold.share, route: bold.route, outfits: [...bold.outfits] } }) };
}

/** A category's pool, from its bank (the planner's `shotDeck` is the five shots the captures ride on; I5.27). */
export function poolOfBank(bank: CategoryBank): Pool {
  return {
    locations: bank.places.map((place) => ({
      name: place.name,
      at: place.at,
      times: [...place.times],
      activities: place.moments.map(activityOf),
      details: [...place.details],
      ...(place.mirror === true ? { mirror: true as const } : {}),
      ...(place.room === true ? { room: true as const } : {}),
      ...(place.lamp === true ? { lamp: true as const } : {}),
    })),
    outfits: bank.outfits.map((outfit) => outfit.text),
    shotDeck: bank.captureDeck.map(shotOf),
    captureDeck: [...bank.captureDeck],
    outfitInfo: bank.outfits.map((outfit) => ({ ...outfit })),
    ...(bank.legwear === undefined ? {} : { legwear: legwearOf(bank.legwear) }),
  };
}

// planner.ts gives each category its own rng sub-stream (categorySeed), so editing one category's bank only ever changes THAT category's plans for a given seed
// — never another category's. Order within a category's own arrays still matters for existing seeds (the shuffles depend on it).
export const POOLS: Record<Category, Pool> = {
  home: poolOfBank(BANKS.home),
  travel: poolOfBank(BANKS.travel),
  photoshoot: poolOfBank(BANKS.photoshoot),
  glamour: poolOfBank(BANKS.glamour),
  fitness: poolOfBank(BANKS.fitness),
  nightwear: poolOfBank(BANKS.nightwear),
  beach: poolOfBank(BANKS.beach),
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

// K-22: the owner's references wear «silk pajamas», so that phrase is exempt from the luxury words («satin» stays refused).
const hasBannedWord = (text: string): boolean => POOL_BANNED_WORDS.test(withoutExemptLookPhrases(text));

const BuiltInUnboundedText = PromptText.refine((text) => !hasBannedWord(text), { message: "pool text must be an ordinary place of her own life: no paper, screens, staging or luxury words" });

// S5.R1: the built-in texts are held to the bound a custom pool is held to (POOL_TEXT_MAX), so the writer's floor pins for the worst custom chunk cover the
// built-in ones too. The locative `at` is not sent to the writer and is not bound.
const BuiltInText = BuiltInUnboundedText.refine((text) => text.length <= POOL_TEXT_MAX, { message: `pool text must be at most ${POOL_TEXT_MAX} characters` });

// S5.R1 H1: a shot other than the mirror can land on any place, so no place names a mirror (the mirror capture line names it); `mirror: true` marks the places a
// mirror shot may use.
const NO_MIRROR_WORD = { message: "a place must not name a mirror: only the mirror shot's own line does" };
const PlaceName = BuiltInText.refine((text) => !/mirror/i.test(text), NO_MIRROR_WORD);
const PlaceAt = BuiltInUnboundedText.refine((text) => !/mirror/i.test(text), NO_MIRROR_WORD);

const TRUE = z.literal(true).optional();
// A built-in activity is a bank moment: the tags are checked for their shape here and for their meaning where the bank loads (shared/scenes/banks/schema.ts).
const BuiltInActivitySchema = z.strictObject({
  text: BuiltInText,
  twoHanded: z.boolean(),
  phone: TRUE,
  messyOk: TRUE,
  motion: z.string().min(1).optional(),
  startPose: z.string().min(1).optional(),
  captures: z.array(z.enum(CAPTURES)).min(1).optional(),
  level: z.literal("flirty").optional(),
  angle: z.enum(["three-quarter", "profile", "back"]).optional(),
  gaze: z.enum(["own", "viewer", "focus"]).optional(),
  hair: z.enum(MOMENT_HAIRS).optional(),
  expression: TRUE,
  handAtFace: TRUE,
  outdoor: TRUE,
  object: TRUE,
  outfits: z.array(z.string().min(1)).min(1).optional(),
  legs: z.strictObject({ framing: z.literal("legs").optional() }).optional(),
  noLegwear: TRUE,
  mirrorBack: TRUE,
});

/** The rules of a built-in place, the five's and (5a.3) the «Смелая» banks'. */
function builtInPlaceRules(place: { activities: readonly { text: string; twoHanded: boolean; phone?: true | undefined; messyOk?: true | undefined }[]; details?: readonly string[] | undefined; room?: true | undefined }, ctx: z.RefinementCtx): void {
  const problem = (message: string, path: string): void => ctx.addIssue({ code: "custom", message, path: [path] });
  // The shared PoolSchema only needs a free hand; a built-in place needs a free hand that is not on a phone, so a selfie or mirror always has an activity (M3).
  if (!place.activities.some((a) => !a.twoHanded && !isPhoneActivity(a))) problem("every built-in location needs at least one one-handed activity that is not a phone one", "activities");
  if (place.activities.some((a) => (a.phone === true) !== PHONE_WORDS.test(a.text))) problem("an activity carries the phone flag exactly when its text names her phone", "activities");
  // K-3 (5a.2): every built-in place carries 2 or 3 ordinary details; a room's go into its room phrase, the others into the sentence's `with {detail}`.
  if (place.details === undefined || place.details.length < 2 || place.details.length > 3) problem("a place carries 2 or 3 details", "details");
  if (place.room !== true && place.activities.some((a) => a.messyOk === true)) problem("only an activity in a room can be messyOk", "activities");
}

/** A built-in place's shape around the schema of its activities (the five's, or the «Смелая» banks'). */
function builtInPlaceShape<A extends z.ZodType>(activity: A) {
  return {
    name: PlaceName,
    times: z.array(NonEmpty).min(1),
    activities: z.array(activity).min(1),
    mirror: TRUE,
    room: TRUE,
    lamp: TRUE,
    details: z.array(BuiltInText).optional(),
    at: PlaceAt,
  };
}

const BuiltInPlaceSchema = z.strictObject(builtInPlaceShape(BuiltInActivitySchema)).superRefine(builtInPlaceRules);

const BuiltInOutfitText = OutfitSchema.refine((outfit) => !hasBannedWord(outfit), { message: "outfit text must not use a paper, screen, staging or luxury word" })
  .refine((outfit) => outfit.length <= POOL_TEXT_MAX, { message: `outfit text must be at most ${POOL_TEXT_MAX} characters` })
  .refine((outfit) => !isOwnerBannedOutfit(outfit), { message: "no denim shorts and no denim skirts, anywhere (the owner)" });

/** The built-in pools: the shared shape plus the phone, room and look rules above. */
export const BuiltInPoolSchema = z
  .strictObject({
    locations: z.array(BuiltInPlaceSchema).min(1),
    outfits: z.array(BuiltInOutfitText).min(1),
    shotDeck: z.array(z.enum(SHOTS)).min(1),
    poses: CategoryPoses.optional(),
    captureDeck: z.array(z.enum(CAPTURES)).min(1).optional(),
    outfitInfo: z.array(z.strictObject({ text: BuiltInOutfitText, showsLegs: TRUE, pinOnly: TRUE })).min(1).optional(),
    legwear: z.strictObject({ items: z.array(BuiltInOutfitText).min(1), share: z.number().min(0).max(1) }).optional(),
  })
  .refine((pool) => !pool.shotDeck.includes("mirror") || pool.locations.some((l) => l.mirror === true), MIRROR_NEEDS_A_PLACE);

// ---------- the «Смелая» pools (5a.3, S5.9b2, plan s5a3 §6.4, H2) ----------

/** A text a «Смелая» bank may hold: the bold content line refuses only youth words, and spares the exempt garment name (answer (b)). */
const holdsNoYouthWord = (text: string): boolean => contentProblems(text, boldContentLevel()).length === 0;
const NO_YOUTH_WORD = { message: "pool text must not suggest a minor (the bold content line: youth words, the exempt garment name spared)" };

/** The soft look list with the «Смелая» satin nightwear taken out first (banks/boldRules.ts); «satin» anywhere else stays refused, as K-22 keeps it. */
const hasBoldBannedWord = (text: string): boolean => hasBannedWord(withoutBoldExemptLook(text));

const BoldText = z
  .string()
  .min(1)
  .refine(holdsNoYouthWord, NO_YOUTH_WORD)
  .refine((text) => !hasBoldBannedWord(text), { message: "pool text must be an ordinary place of her own life: no paper, screens, staging or luxury words" })
  .refine((text) => text.length <= POOL_TEXT_MAX, { message: `pool text must be at most ${POOL_TEXT_MAX} characters` });

/** A «Смелая» outfit: plain ASCII, at most the pool bound, no denim shorts or skirts, the soft list minus the satin nightwear, the bold content line in place of the revealing words. */
const BoldOutfitText = BoldText.regex(/^[\x20-\x7e]+$/, "outfit text must be plain ASCII").refine((outfit) => !isOwnerBannedOutfit(outfit), { message: "no denim shorts and no denim skirts, anywhere (the owner)" });

/** The sentence the template appends for what an item covers: plain ASCII, the bold content line (its full rules are the bank schema's, banks/schema.ts). */
const Coverage = z.string().min(1).regex(/^[\x20-\x7e]+$/, "a coverage sentence is plain ASCII").refine(holdsNoYouthWord, NO_YOUTH_WORD);

const BOLD_LEVEL = z.enum(["flirty", "bold"]).optional();
const ROUTE = z.literal("seedream").optional();

const BoldActivitySchema = BuiltInActivitySchema.extend({ text: BoldText, level: BOLD_LEVEL, route: ROUTE, coverage: Coverage.optional(), water: TRUE });

const BoldPlaceSchema = z.strictObject(builtInPlaceShape(BoldActivitySchema)).superRefine(builtInPlaceRules);

/**
 * A «Смелая» category's pool (`nightwear`, `beach`): the built-in pool with the «Смелая» shapes and the bold word rules above. The five keep BuiltInPoolSchema
 * byte for byte; `validatePools` picks by category.
 */
export const BoldPoolSchema = z
  .strictObject({
    locations: z.array(BoldPlaceSchema).min(1),
    outfits: z.array(BoldOutfitText).min(1),
    shotDeck: z.array(z.enum(SHOTS)).min(1),
    poses: CategoryPoses.optional(),
    captureDeck: z.array(z.enum(CAPTURES)).min(1).optional(),
    outfitInfo: z.array(z.strictObject({ text: BoldOutfitText, showsLegs: TRUE, pinOnly: TRUE, level: BOLD_LEVEL, route: ROUTE, coverage: Coverage.optional() })).min(1).optional(),
    legwear: z
      .strictObject({
        items: z.array(BoldOutfitText).min(1),
        share: z.number().min(0).max(1),
        bold: z.strictObject({ items: z.array(BoldOutfitText).min(1), share: z.number().min(0).max(1), route: z.literal("seedream"), outfits: z.array(BoldOutfitText).min(1) }).optional(),
      })
      .optional(),
  })
  .refine((pool) => !pool.shotDeck.includes("mirror") || pool.locations.some((l) => l.mirror === true), MIRROR_NEEDS_A_PLACE);

/** Validates every category's pool; throws with every problem found (not
 *  just the first) so a malformed pool fails loudly and completely. Called
 *  eagerly below, so importing this module at all already checks the data. */
export function validatePools(pools: Readonly<Record<Category, unknown>> = POOLS): void {
  const problems: string[] = [];
  for (const category of CATEGORIES) {
    // 5a.3 (S5.9b2, H2): a «Смелая» category's pool is held to its own schema; the five keep the built-in one.
    const result = (isBoldCategory(category) ? BoldPoolSchema : BuiltInPoolSchema).safeParse(pools[category]);
    if (!result.success) problems.push(`${category}: ${z.prettifyError(result.error)}`);
  }
  if (problems.length > 0) throw new Error(`Studio scene pools are invalid:\n${problems.join("\n")}`);
}

validatePools();
