import { z } from "zod";
import { NO_HIDDEN_CHARS } from "./avatar";

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
 * 25-slot chunk of the worst pool a custom category can have (every text at
 * the bound, an all-photographer deck, the widest pose and time, the 24-char
 * label, the worst refusal). That prompt's floor is 14494 tokens at 48 chars,
 * 14194 at 44 and 13894 at 40; only 40 fits (writer.custom.test.ts pins it).
 */
export const POOL_TEXT_MAX = 40;

/** The owner's name for a custom category, as the UI and a photo's label show it. */
export const CategoryName = z
  .string()
  .max(CATEGORY_NAME_MAX)
  .regex(NO_HIDDEN_CHARS, "must not contain control or invisible characters")
  .refine((s) => s.trim().length > 0, "must not be blank");

/** The category's English label, as the writer is told it: printable ASCII, no leading or trailing space. */
export const CategoryLabel = z
  .string()
  .min(1)
  .max(CATEGORY_LABEL_MAX)
  .regex(/^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/, "must be printable ASCII without leading or trailing space");

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
