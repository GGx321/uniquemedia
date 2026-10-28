// 5a.4 (S5.BA9, plan s5a4 §8 BA9, Q-F → 1): «Своя сцена» at «Смелая». An own scene of a «Смелая» set is a «Смелая» frame: drawn bold by the idea writer's bold variant and,
// for an imported avatar or one of unknown origin, ended with the kept coverage below (I5.74, §5.6: lingerie at most, no implied cover). Shared by the engine and the renderer's mock.

/**
 * The kept, restrictive coverage an imported avatar's own «Смелая» scene ends with, appended after the idea writer's sentence as the bank outfits' kept sentences are after the compose
 * writer's. An own idea names no bank outfit, so it is the one sentence that holds for every garment the bold variant may draw (lingerie, a nightdress, swimwear by the water), in the
 * probe's proven words («opaque», «fully covers her breasts and her hips»).
 */
export const OWN_BOLD_COVERAGE = "What she wears is opaque and fully covers her breasts and her hips.";

/**
 * The coverage an own «Смелая» scene's accepted sentence ends with, by the avatar's origin (I5.74): the kept one for an imported avatar or one of unknown origin (`impliedNudity` false, the
 * fail-closed side), none for an avatar made in Studio (its idea is drawn as the owner wrote it).
 */
export function ownCoverageOf(impliedNudity: boolean): string | undefined {
  return impliedNudity ? undefined : OWN_BOLD_COVERAGE;
}
