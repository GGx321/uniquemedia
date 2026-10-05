import { z } from "zod";
import { NO_HIDDEN_CHARS } from "./avatar";
import { Count, Id, Micros, ModelId } from "./primitives";

// Scene categories on the contract: the five built-ins the Photos mockup
// draws, and the owner's own categories (per library, shared by every
// avatar), which are referenced by a prefixed id next to the five. Pure: the
// planner, the writer's label resolver and the renderer's chips all read the
// same ordering and split rules from here, so they cannot drift apart.

/** Scene categories from the Photos mockup; revealing outfits are out of Stage 2. */
export const SceneCategory = z.enum(["home", "travel", "shoot", "glam", "fit"]);
export type SceneCategory = z.infer<typeof SceneCategory>;

const CUSTOM_CATEGORY_ID = /^cat-[a-z0-9-]{8,59}$/;

/**
 * A custom category's id: `cat-` and 8 to 59 of a-z, 0-9, `-` (never one of the
 * five built-in names). Typed as a `cat-…` template, not `string`, so a ref
 * stays distinguishable from any other text in the type system: after the
 * check for a custom id, what is left of a `CategoryRef` is a `SceneCategory`.
 */
export const CustomCategoryId = z.custom<`cat-${string}`>((value) => typeof value === "string" && CUSTOM_CATEGORY_ID.test(value), "must be cat-<8..59 of a-z 0-9 ->");
export type CustomCategoryId = z.infer<typeof CustomCategoryId>;

/** What a run, a plan slot or a request names as its category: one of the five, or a custom one. */
export const CategoryRef = z.union([SceneCategory, CustomCategoryId]);
export type CategoryRef = z.infer<typeof CategoryRef>;

/** A photo of the owner's own scene (scene review): no pool category behind it. */
export const OWN_CATEGORY = "own";

/** What a photo carries as its category: a ref, or `"own"`. */
export const PhotoCategory = z.union([CategoryRef, z.literal(OWN_CATEGORY)]);
export type PhotoCategory = z.infer<typeof PhotoCategory>;

/** How a custom category's photos are lit and finished: the editorial look of the photoshoot, or an ordinary phone photo. */
export const CategoryStyle = z.enum(["editorial", "phone"]);
export type CategoryStyle = z.infer<typeof CategoryStyle>;

/** A run asks for at most this many categories (five built-ins plus custom ones). */
export const MAX_RUN_CATEGORIES = 20;

/** The English label the writer is told a custom category is: at most this many printable ASCII chars. */
export const CATEGORY_LABEL_MAX = 24;
/** The owner's name for a category (shown in the UI and on its photos; any script): at most this many chars. */
export const CATEGORY_NAME_MAX = 40;
/**
 * A custom pool's place names, activities and outfits are at most this long.
 * Measured, not chosen: the writer's 14K input ceiling must cover a full
 * 25-slot chunk of the worst pool a custom category can have, with a margin
 * (writer.custom.test.ts builds that chunk by hand and pins the bound).
 */
export const POOL_TEXT_MAX = 35;
/** A custom slot's time of day is at most this long (the longest built-in time, "studio lighting", is 15). */
export const TIME_OF_DAY_MAX = 15;

/**
 * Printable ASCII with no quote and no backslash, and no space at either end.
 * The writer's slots go out as indented JSON, where a quote or a backslash costs
 * two bytes, and the reserve is priced on bytes: with them, a chunk of a bounded
 * pool could outgrow the ceiling its price was set at. Every other char costs one.
 */
const PLAIN_TEXT = /^[\x21\x23-\x5b\x5d-\x7e](?:[\x20\x21\x23-\x5b\x5d-\x7e]*[\x21\x23-\x5b\x5d-\x7e])?$/;
const PLAIN_TEXT_MESSAGE = "must be printable ASCII without a quote, a backslash or an edge space";

/** A custom pool's place name, activity or outfit: what a prompt is built from. */
export const PoolText = z.string().min(1).max(POOL_TEXT_MAX).regex(PLAIN_TEXT, PLAIN_TEXT_MESSAGE);

/** A custom slot's time of day. */
export const TimeOfDay = z.string().min(1).max(TIME_OF_DAY_MAX).regex(PLAIN_TEXT, PLAIN_TEXT_MESSAGE);

/** The owner's name for a custom category, as the UI and a photo's label show it. */
export const CategoryName = z
  .string()
  .max(CATEGORY_NAME_MAX)
  .regex(NO_HIDDEN_CHARS, "must not contain control or invisible characters")
  .refine((s) => s.trim().length > 0, "must not be blank");

/** The category's English label, as the writer is told it: 1 to 24 plain printable ASCII chars (no quote, no backslash, no edge space). */
export const CategoryLabel = z.string().min(1).max(CATEGORY_LABEL_MAX).regex(PLAIN_TEXT, PLAIN_TEXT_MESSAGE);

/**
 * What a plan keeps of each custom category it uses, so a resume or a writer
 * chunk never reads the category library: renaming, regenerating or deleting
 * a category never changes a run in flight.
 */
export const CategorySnapshot = z.strictObject({
  ref: CustomCategoryId,
  name: CategoryName,
  label: CategoryLabel,
  style: CategoryStyle,
});
export type CategorySnapshot = z.infer<typeof CategorySnapshot>;

const BUILT_IN: readonly string[] = SceneCategory.options;

/** Whether `ref` is a custom category's id (and not one of the five). */
export function isCustomCategory(ref: string): ref is CustomCategoryId {
  return CUSTOM_CATEGORY_ID.test(ref);
}

/**
 * The order a run draws its categories in: the five built-ins in their
 * canonical order, then the custom ones in the order given (creation order),
 * each once.
 */
export function orderCategories(refs: readonly CategoryRef[]): CategoryRef[] {
  const wanted = new Set<string>(refs);
  const builtIns = SceneCategory.options.filter((c) => wanted.has(c));
  const custom = [...new Set(refs.filter((ref) => !BUILT_IN.includes(ref)))];
  return [...builtIns, ...custom];
}

/**
 * How many photos each category gets: `count` spread as evenly as possible
 * over the ordered categories, the remainder going to the earliest ones, one
 * each. The engine's planner and the renderer's chips both read this, so the
 * per-chip counts can never drift from the engine's own split.
 */
export function splitCount(count: number, refs: readonly CategoryRef[]): { ref: CategoryRef; count: number }[] {
  const ordered = orderCategories(refs);
  if (ordered.length === 0) return [];
  const base = Math.floor(count / ordered.length);
  const remainder = count % ordered.length;
  return ordered.map((ref, i) => ({ ref, count: base + (i < remainder ? 1 : 0) }));
}

// ---------- CS.2: the category library ----------

/** A library holds at most this many custom categories. */
export const MAX_CUSTOM_CATEGORIES = 50;
/** The owner's description of a category, which the pool call is written from: at most this many chars, any script. */
export const CATEGORY_DESCRIPTION_MAX = 500;

/** A text area's text: no control or invisible char but the line break. */
const NO_HIDDEN_CHARS_BUT_NEWLINE = /^(?:[^\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]|\n)*$/u;

/**
 * The owner's own words for what a category is (any script, up to 500 chars, line breaks allowed). It goes to the pool call
 * only; the provider decides what it accepts, and the engine adds no content rule to it.
 */
export const CategoryDescription = z
  .string()
  .max(CATEGORY_DESCRIPTION_MAX)
  .regex(NO_HIDDEN_CHARS_BUT_NEWLINE, "must not contain control or invisible characters")
  .refine((s) => s.trim().length > 0, "must not be blank");
export type CategoryDescription = z.infer<typeof CategoryDescription>;

/** The shots a pool's deck is drawn from: who or what took the photo (the engine's own `SHOTS`). */
export const POOL_SHOTS = ["friend", "selfie", "mirror", "candid", "photographer"] as const;
export const PoolShot = z.enum(POOL_SHOTS);
export type PoolShot = z.infer<typeof PoolShot>;

/** The counts a custom pool is held to: what the model is asked for, and what a removal may not go below. */
export const POOL_PLACES_MIN = 5;
export const POOL_PLACES_MAX = 7;
export const POOL_OUTFITS_MIN = 3;
export const POOL_OUTFITS_MAX = 6;
export const POOL_DECK_SIZE = 5;
export const PLACE_TIMES_MAX = 3;
export const PLACE_ACTIVITIES_MIN = 2;
export const PLACE_ACTIVITIES_MAX = 4;

const PoolActivity = z.strictObject({ text: PoolText, twoHanded: z.boolean() });

/** A place with the times of day it fits and what she can do there; `mirror` marks a place a mirror shot may land on. */
export const CategoryPlace = z
  .strictObject({
    name: PoolText,
    times: z.array(TimeOfDay).min(1).max(PLACE_TIMES_MAX),
    activities: z.array(PoolActivity).min(PLACE_ACTIVITIES_MIN).max(PLACE_ACTIVITIES_MAX),
    mirror: z.boolean(),
  })
  .refine((place) => place.activities.some((a) => !a.twoHanded), {
    message: "every place needs one activity with a free hand: a selfie or a mirror shot holds the phone in the other",
    path: ["activities"],
  });
export type CategoryPlace = z.infer<typeof CategoryPlace>;

/**
 * A custom category's pool as the contract carries it: the technical bounds only (the engine's own pool rules, the youth and the
 * revealing words, are checked where the pool is written and read).
 */
export const CategoryPool = z
  .strictObject({
    locations: z.array(CategoryPlace).min(POOL_PLACES_MIN).max(POOL_PLACES_MAX),
    outfits: z.array(PoolText).min(POOL_OUTFITS_MIN).max(POOL_OUTFITS_MAX),
    shotDeck: z.array(PoolShot).length(POOL_DECK_SIZE),
  })
  .refine((pool) => !pool.shotDeck.includes("mirror") || pool.locations.some((l) => l.mirror), {
    message: "a deck that can draw a mirror shot needs a place with a mirror",
    path: ["locations"],
  });
export type CategoryPool = z.infer<typeof CategoryPool>;

const IsoDateTime = z.iso.datetime();

/**
 * A custom category as the sheet draws it. `spentMicros` is everything the category has cost: its creation and every
 * regeneration, answered or not, at what the ledger booked (a settled attempt at its cost, an open reserve at its worst case).
 */
export const CategorySummary = z.strictObject({
  categoryId: CustomCategoryId,
  name: CategoryName,
  description: CategoryDescription,
  label: CategoryLabel,
  style: CategoryStyle,
  pool: CategoryPool,
  model: ModelId,
  spentMicros: Micros,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type CategorySummary = z.infer<typeof CategorySummary>;

/**
 * What two category names are compared by: a library holds one category per key, because two with one name cannot be told apart in the montage bin's
 * filter. Trimmed, Unicode-normalised (a composed and a decomposed letter are one), case-folded. The engine's store, the mock and the window's own
 * pre-check (the dialog's «такое имя уже есть») all read this one rule.
 */
export function categoryNameKey(name: string): string {
  return name.trim().normalize("NFC").toLowerCase();
}

/** What a paid category call is: a new category, or a new pool for an existing one. */
export const CategoryCallKind = z.enum(["create", "regenerate"]);
export type CategoryCallKind = z.infer<typeof CategoryCallKind>;

/**
 * A create or a regenerate that a closed Studio left unanswered: its request may have been billed, and the reserve stays at its
 * worst case until the owner reconciles. The call is not resumable (a new request has its own cap): the sheet offers «Создать
 * снова» and forgets the record with `categories.dismissInterrupted`. `spentMicros` is what the call is counted at now.
 */
export const CategoryInterrupted = z
  .strictObject({
    jobId: Id,
    kind: CategoryCallKind,
    name: CategoryName,
    description: CategoryDescription,
    /** The category a regenerate was for; null for a create. */
    categoryId: CustomCategoryId.nullable(),
    startedAt: IsoDateTime,
    spentMicros: Micros,
  })
  .refine((i) => (i.kind === "regenerate") === (i.categoryId !== null), {
    message: "a regenerate names its category and a create has none",
    path: ["categoryId"],
  });
export type CategoryInterrupted = z.infer<typeof CategoryInterrupted>;

/** The paid category call this engine is making right now (one at a time), so a second dialog can say what it waits for. */
export const CategoryBusy = z
  .strictObject({ kind: CategoryCallKind, name: CategoryName, categoryId: CustomCategoryId.nullable() })
  .refine((b) => (b.kind === "regenerate") === (b.categoryId !== null), {
    message: "a regenerate names its category and a create has none",
    path: ["categoryId"],
  });
export type CategoryBusy = z.infer<typeof CategoryBusy>;

/** `categories.list`'s answer: the readable categories in creation order, how many files could not be read (they are kept), the calls a closed Studio left, and the call in flight. */
export const CategoriesListResult = z.strictObject({
  categories: z.array(CategorySummary).max(MAX_CUSTOM_CATEGORIES),
  unreadable: Count,
  interrupted: z.array(CategoryInterrupted).max(MAX_CUSTOM_CATEGORIES),
  busy: CategoryBusy.nullable(),
});
export type CategoriesListResult = z.infer<typeof CategoriesListResult>;
