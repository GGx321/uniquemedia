import type { SceneLevel, SceneRoute } from "../engine/categories";
import { lingerieWordsIn, swimwearWordsIn } from "./banks/boldRules";
import { COVER } from "./banks/companions/outfits";

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

/**
 * S5.BA9 r2 (review M1, M2): the implied covers an own «Смелая» sentence may name, by their words (a towel, a sheet or the bedsheet, bath foam), each with the bank's sentence that says
 * what covers her (banks/schema.ts open-coverage: «an implied cover says what covers her to every avatar»): the towel's open one, which P-BA B1 drew on a Studio-created avatar, and the
 * sheet's and the foam's kept ones, which every avatar says (r2.2 P5).
 */
const IMPLIED_COVERS = [
  { words: /\btowels?\b/i, coverage: COVER.towelOpen },
  { words: /\b(?:bed)?sheets?\b/i, coverage: COVER.sheet },
  { words: /\bfoam\b/i, coverage: COVER.foam },
] as const;
/** A nightdress: the bold variant's third garment (ideaWriter.ts `boldRules`), beside its lingerie and its swimwear. */
const NIGHTDRESS = /\bnightdress(?:es)?\b/i;

/**
 * The implied cover that covers her in an own «Смелая» sentence: the one it names first, when it names no garment the bold variant draws (lingerie or underwear, a nightdress, swimwear).
 * A sentence that names a garment beside one («a towel over her shoulder», «on a towel by the pool in a black bikini») is a lingerie frame: undefined.
 */
function impliedCoverOf(sentence: string): (typeof IMPLIED_COVERS)[number] | undefined {
  if (lingerieWordsIn(sentence).length > 0 || swimwearWordsIn(sentence).length > 0 || NIGHTDRESS.test(sentence)) return undefined;
  const named = IMPLIED_COVERS.map((cover) => ({ cover, at: sentence.search(cover.words) })).filter(({ at }) => at >= 0);
  return named.sort((a, b) => a.at - b.at)[0]?.cover;
}

/** S5.BA9 r2 (review M1, I5.74, §5.6): whether a towel, a sheet or bath foam is what covers her in an own «Смелая» sentence (`impliedCoverOf`). */
export function namesImpliedCover(sentence: string): boolean {
  return impliedCoverOf(sentence) !== undefined;
}

/**
 * The coverage an own «Смелая» scene's accepted sentence ends with, by the avatar's origin (I5.74): the kept one for an imported avatar or one of unknown origin (`impliedNudity` false, the
 * fail-closed side). An avatar made in Studio's idea is drawn as the owner wrote it: S5.BA9 r2 (review M2), a frame that a towel, a sheet or bath foam covers ends with that cover's bank
 * sentence (`impliedCoverOf`), any other with none.
 */
export function ownCoverageOf(impliedNudity: boolean, sentence: string): string | undefined {
  return impliedNudity ? impliedCoverOf(sentence)?.coverage : OWN_BOLD_COVERAGE;
}
