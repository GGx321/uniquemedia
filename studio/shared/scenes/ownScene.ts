import type { SceneLevel, SceneRoute } from "../engine/categories";
import { lingerieWordsIn, swimwearWordsIn } from "./banks/boldRules";

// 5a.4 (S5.BA9, plan s5a4 §8 BA9, Q-F → 1): «Своя сцена» at «Смелая». An own scene of a «Смелая» set is a «Смелая» frame: drawn bold by the idea writer's bold variant and,
// for an imported avatar or one of unknown origin, ended with the kept coverage below (I5.74, §5.6: lingerie at most, no implied cover). Shared by the engine and the renderer's mock.

/**
 * The route an own scene of a set composed at `level` is drawn on: the Seedream route at «Смелая», as every other «Смелая» frame (I5.73); none below, so an own scene of an ordinary or a
 * flirty set is drawn on the owner's model as it always was. A set's level is fixed at its compose, so an own scene's route never changes.
 */
export function ownSceneRouteOf(level: SceneLevel | undefined): SceneRoute | undefined {
  return level === "bold" ? "seedream" : undefined;
}

/** An own scene's marker in a set composed at `level`, as the content line (`contentLevelOf`) and `isBoldFrame` read it: the category `own`, no mix level, and its route. */
export function ownSceneMarkerOf(level: SceneLevel | undefined): { category: "own"; level: undefined; route: SceneRoute | undefined } {
  return { category: "own", level: undefined, route: ownSceneRouteOf(level) };
}

/**
 * The kept, restrictive coverage an imported avatar's own «Смелая» scene ends with, appended after the idea writer's sentence as the bank outfits' kept sentences are after the compose
 * writer's. An own idea names no bank outfit, so it is the one sentence that holds for every garment the bold variant may draw (lingerie, a nightdress, swimwear by the water), in the
 * probe's proven words («opaque», «fully covers her breasts and her hips»).
 */
export const OWN_BOLD_COVERAGE = "What she wears is opaque and fully covers her breasts and her hips.";

/** S5.BA9 r2 (review M1): the implied covers an own «Смелая» sentence may name, by their words: a towel, a sheet (the bedsheet) and bath foam. */
const IMPLIED_COVERS = [/\btowels?\b/i, /\b(?:bed)?sheets?\b/i, /\bfoam\b/i] as const;
/** A nightdress: the bold variant's third garment (ideaWriter.ts `boldRules`), beside its lingerie and its swimwear. */
const NIGHTDRESS = /\bnightdress(?:es)?\b/i;

/**
 * S5.BA9 r2 (review M1, I5.74, §5.6): whether a towel, a sheet or bath foam is what covers her in an own «Смелая» sentence: it names one and no garment the bold variant draws (lingerie or
 * underwear, a nightdress, swimwear). A sentence that names a garment beside one («a towel over her shoulder», «on a towel by the pool in a black bikini») is a lingerie frame.
 */
export function namesImpliedCover(sentence: string): boolean {
  const garment = lingerieWordsIn(sentence).length > 0 || swimwearWordsIn(sentence).length > 0 || NIGHTDRESS.test(sentence);
  return !garment && IMPLIED_COVERS.some((cover) => cover.test(sentence));
}

/**
 * The coverage an own «Смелая» scene's accepted sentence ends with, by the avatar's origin (I5.74): the kept one for an imported avatar or one of unknown origin (`impliedNudity` false, the
 * fail-closed side), none for an avatar made in Studio (its idea is drawn as the owner wrote it).
 */
export function ownCoverageOf(impliedNudity: boolean): string | undefined {
  return impliedNudity ? undefined : OWN_BOLD_COVERAGE;
}
