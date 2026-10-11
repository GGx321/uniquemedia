import type { PoolShot, ScenePose } from "../engine";
import { captureOfShot, isHandCapture, posesFor, type Capture } from "./captures";
import { captureOfSlot, momentAllowed, renderSentence, type MomentTags, type SentenceParts, type TemplateContext, type TemplateSlot } from "./render";
import { EXPRESSION_WORDS, HAIR_WORDS, OWN_GAZE_WORDS, PHONE_WORDS, SELFIE_WORDS, VIEWER_GAZE } from "./words";

// 5a.2 (S5.6a, plan s5a2 §5.2 step 2, K-7): the custom-category adapter. Today's custom pools store short activity phrases, mostly gerunds («holding a
// mug», «on her stomach, scrolling»), so a custom slot renders «{At}, she is {activity}, wearing {outfit}, {gaze}, {cue}.»: no detail and no room
// phrase (a custom place has neither). A plan's or a set's category snapshot carries no pool (shared/engine/categories.ts `CategorySnapshot`), so the
// slot's own stored texts are what renders; the snapshot only says the category is the plan's. An activity that does not read after «she is» is
// null: the LLM writes that slot, as today.

/** A stored custom activity (shared/engine/categories.ts `PoolActivity`, engine/scenes/pools.ts `Activity`). */
export interface CustomActivity {
  text: string;
  twoHanded: boolean;
}

/** The part of a custom pool the planner draws from (the contract's `CategoryPool`, or the engine's `Pool`). */
export interface CustomPool {
  locations: readonly { name: string; activities: readonly CustomActivity[]; mirror?: boolean | undefined }[];
  outfits: readonly string[];
  shotDeck: readonly PoolShot[];
  poses?: readonly ScenePose[] | undefined;
}

/** Words ending in «-ing» that are not a verb's «-ing» form: «morning stretches» does not read after «she is». Pinned (custom.test.ts). */
const NOT_A_GERUND = new Set([
  "morning", "evening", "ceiling", "building", "wedding", "clothing", "something", "nothing", "anything", "everything", "pudding", "earring", "railing",
  "awning", "icing", "darling", "sibling", "dumpling", "lightning", "stocking", "ending", "during", "evening's", "morning's",
]);

/** Whether «she is {activity}» reads: the activity opens with a verb's «-ing» form, or with «on her …» (a position, «on her stomach, scrolling»). */
export function rendersActivity(activity: string): boolean {
  const text = activity.trim().toLowerCase();
  if (/^on her\s/.test(text)) return true;
  const first = /^[a-z']+/.exec(text)?.[0] ?? "";
  if (!first.endsWith("ing") || NOT_A_GERUND.has(first)) return false;
  // «bring», «thing», «swing», «string»: no vowel before the «-ing», so not a verb's «-ing» form.
  return /[aeiouy]/.test(first.slice(0, -3));
}

/** Prepositions a place name may already open with: it is kept as it is. */
const PREPOSITIONS = /^(in|on|at|by|inside|outside|under|near|beside|behind|along|against|across|around|above|below|beneath|over|next to|within|among|between)\s/i;
/** Where the head noun of a place name ends: before its first preposition. */
const HEAD_END = /\s(?:in|on|at|by|with|near|of|under|beside|behind|along|against|across|over|around|from|inside|outside|next|for|during|after|before)\s/i;

/** Head nouns that take «on»: surfaces, open outdoor places and vehicles. Pinned (custom.test.ts). */
const ON_NOUNS = new Set([
  "beach", "shore", "sand", "balcony", "terrace", "rooftop", "roof", "patio", "porch", "deck", "pier", "dock", "boardwalk", "bridge", "street", "sidewalk",
  "pavement", "road", "path", "trail", "track", "lawn", "grass", "field", "hill", "slope", "bench", "couch", "sofa", "bed", "floor", "carpet", "rug", "mat",
  "stairs", "steps", "staircase", "platform", "train", "bus", "boat", "ferry", "plane", "yacht", "swing", "windowsill", "blanket", "towel", "promenade",
]);
/** Head nouns that take «at»: a point she is at rather than inside. Pinned (custom.test.ts). */
const AT_NOUNS = new Set([
  "table", "desk", "counter", "bar", "cafe", "restaurant", "bistro", "pub", "club", "window", "door", "doorway", "entrance", "gate", "station", "stop", "airport",
  "gym", "pool", "party", "concert", "festival", "market", "sink", "viewpoint", "lookout", "museum", "gallery", "cinema", "theatre", "theater", "fountain",
  "kiosk", "stall", "reception",
]);

/** A custom place as a locative phrase: kept when it opens with a preposition; otherwise «on» or «at» by its head noun, or «in». */
export function locativeOf(name: string): string {
  const text = name.trim();
  if (PREPOSITIONS.test(text)) return text;
  const headPart = text.split(HEAD_END)[0] ?? text;
  const head = (/([A-Za-z']+)\W*$/.exec(headPart)?.[1] ?? "").toLowerCase();
  if (ON_NOUNS.has(head)) return `on ${text}`;
  if (AT_NOUNS.has(head)) return `at ${text}`;
  return `in ${text}`;
}

/**
 * The tags an old custom activity is read with (plan s5a2 §5.2 step 2, I5.23): one that looks at the camera, the viewer, the lens or the phone (the
 * custom gaze regex) is a viewer moment (no gaze clause, never on a candid, a profile or a back); one that names her phone or whose eyes are already
 * busy (watching, looking, reading…) carries its own gaze; one that names her hair carries its own hair.
 */
export function customMomentOf(activity: CustomActivity): MomentTags & { text: string; hair?: "own"; expression?: true } {
  const viewer = VIEWER_GAZE.test(activity.text);
  const phone = PHONE_WORDS.test(activity.text);
  const ownGaze = phone || OWN_GAZE_WORDS.test(activity.text);
  return {
    text: activity.text,
    twoHanded: activity.twoHanded,
    ...(phone ? { phone: true as const } : {}),
    ...(viewer ? { gaze: "viewer" as const } : ownGaze ? { gaze: "own" as const } : {}),
    ...(HAIR_WORDS.test(activity.text) ? { hair: "own" as const } : {}),
    ...(EXPRESSION_WORDS.test(activity.text) ? { expression: true as const } : {}),
  };
}

/** Whether a custom slot of this capture and pose may take the activity: `momentAllowed` on its tags (any capture fits), and never a selfie word on a hand-held capture (C1). */
export function customActivityAllowed(activity: CustomActivity, capture: Capture, pose: ScenePose): boolean {
  if (isHandCapture(capture) && SELFIE_WORDS.test(activity.text)) return false;
  return momentAllowed(customMomentOf(activity), capture, pose);
}

/** A stored text without the trailing punctuation a pool reader may have kept, so the template's separators are the only ones. */
const field = (text: string): string => text.trim().replace(/[\s.,;:!]+$/, "");

/** The sentence of a custom slot whose category the plan holds a snapshot of (template.ts checks that), or null. A custom pool has no legwear slot. */
export function customSentence(slot: TemplateSlot, ctx: TemplateContext): string | null {
  const capture = captureOfSlot(slot);
  if (capture === null || slot.location === undefined || slot.activity === undefined || slot.outfit === undefined || slot.legwear !== undefined) return null;
  const activity = field(slot.activity);
  if (!rendersActivity(activity)) return null;
  // The slot carries no `twoHanded` (a snapshot has no pool): the planner keeps two-handed activities off hand-held captures; the words are checked here.
  if (!customActivityAllowed({ text: activity, twoHanded: false }, capture, slot.pose)) return null;
  const tags = customMomentOf({ text: activity, twoHanded: false });
  const parts: SentenceParts = { at: locativeOf(field(slot.location)), doing: `is ${activity}`, wearing: field(slot.outfit), gaze: tags.gaze, expression: tags.expression === true, details: [] };
  return renderSentence(parts, { capture, pose: slot.pose, framing: slot.framing }, ctx);
}

/**
 * Whether the template renders every slot the planner can draw from the pool (I5.22; defined through the template itself, plan s5a2 M5). A custom
 * category keeps its stored deck of shots, and its captures are derived from them (plan r1.2 §5.1). A slot is a place, a capture of the deck (a
 * mirror only on a mirror place, a hand-held capture only where an activity allows it and the name says no selfie), a pose (the pool's own angles,
 * or any the capture can take), an activity the slot allows, and an outfit. A slot with no activity takes the planner's fallback: a three-quarter
 * pose, and a friend's photo for a candid. A covered pool needs no LLM writer, so its slots cost nothing to write.
 */
export function covers(pool: CustomPool): boolean {
  const ref = "cat-coveragecheck";
  const ctx: TemplateContext = { key: "covers", snapshots: [{ ref }] };
  const poses = pool.poses ?? posesFor("friend");
  for (const place of pool.locations) {
    for (const shot of new Set(pool.shotDeck)) {
      const capture = captureOfShot(shot);
      if (shot === "mirror" && place.mirror !== true) continue;
      if (isHandCapture(capture) && (SELFIE_WORDS.test(place.name) || !place.activities.some((a) => customActivityAllowed(a, capture, "front")))) continue;
      for (const drawnPose of poses.filter((p) => posesFor(capture).includes(p))) {
        const direct = place.activities.filter((a) => customActivityAllowed(a, capture, drawnPose));
        const fallback: Capture = capture === "candid" ? "friend" : capture;
        const [slotCapture, slotPose, activities] =
          direct.length > 0 ? [capture, drawnPose, direct] : ([fallback, "three-quarter", place.activities.filter((a) => customActivityAllowed(a, fallback, "three-quarter"))] as const);
        const slotShot: PoolShot = slotCapture === capture ? shot : "friend";
        for (const activity of activities) {
          for (const outfit of pool.outfits) {
            if (customSentence({ category: ref, location: place.name, activity: activity.text, outfit, shot: slotShot, capture: slotCapture, pose: slotPose }, ctx) === null) return false;
          }
        }
      }
    }
  }
  return true;
}
