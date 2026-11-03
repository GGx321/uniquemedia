import type { SceneLevel, SceneRoute } from "../engine/categories";
import { lingerieWordsIn, swimwearWordsIn } from "./banks/boldRules";
import { COVER } from "./banks/companions/outfits";
import { GARMENT } from "./motionText";

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

/** Up to two words between the article and the cover («a soft white towel», «thick bath foam»). */
const BEFORE_COVER = String.raw`(?:[a-z-]+\s+){0,2}`;
/** Not her hair or her head in it («her hair wrapped in a towel», «her hair up in a towel»): up to two words after either. */
const NOT_HER_HAIR = String.raw`(?<!\b(?:hair|head)\s+(?:[a-z]+\s+){0,2})`;
/** What makes a cover word name another thing she may be «under» in her bath: a sheet mask on her face. */
const NOT_THE_COVER = String.raw`(?![\s-]+masks?\b)`;

/**
 * S5.BA9 round 3 (review MEDIUM, L-a): a cover she is IN, never one only named beside her (a towel over her shoulders, on the rack or under her by the pool, the sheets she lies on).
 * Wrapped, draped, covered or swaddled in it; in, into or under it, or wearing only it; it up to her («foam up to her shoulders», «the sheet pulled up to her chest»); or it pulled,
 * drawn, tucked, held or wrapped to, over, around or across her (not her hair, her head, her neck, her shoulders, her arms or her hands).
 */
function coverFormsOf(word: string): RegExp {
  const cover = String.raw`(?:(?:a|an|the|her|some)\s+)?${BEFORE_COVER}${word}${NOT_THE_COVER}`;
  return new RegExp(
    String.raw`${NOT_HER_HAIR}\b(?:wrapped|draped|covered|swaddled|cocooned)\s+(?:only\s+)?(?:in|with|by|under)\s+(?:only\s+)?${cover}` +
      String.raw`|${NOT_HER_HAIR}\b(?:in|into|under|beneath|underneath|only)\s+(?:only\s+)?${cover}` +
      String.raw`|\b${word},?\s+(?:(?:pulled|drawn|tucked|held|wrapped|rising|rises|reaching|reaches)\s+)?up\s+to\s+her\b` +
      String.raw`|\b${word},?\s+(?:pulled|drawn|tucked|held|wrapped)\s+(?:to|over|around|across)\s+her\b(?!\s+(?:hair|head|neck|shoulders?|arms?|hands?)\b)`,
    "i",
  );
}

/**
 * S5.BA9 r2 (review M1, M2): the implied covers an own «Смелая» sentence may put her in (a towel, a sheet or the bedsheet, bath foam), each with the bank's sentence that says what covers
 * her (banks/schema.ts open-coverage: «an implied cover says what covers her to every avatar»): the towel's open one, which P-BA B1 drew on a Studio-created avatar, and the sheet's and
 * the foam's kept ones, which every avatar says (r2.2 P5).
 */
const IMPLIED_COVERS = [
  { forms: coverFormsOf(String.raw`towels?\b`), coverage: COVER.towelOpen },
  { forms: coverFormsOf(String.raw`(?:bed)?sheets?\b`), coverage: COVER.sheet },
  { forms: coverFormsOf(String.raw`foam\b`), coverage: COVER.foam },
] as const;

/**
 * S5.BA9 round 3 (review MEDIUM): what she wears that neither the banks' lingerie and swimwear lists nor the motion check's `GARMENT` names: a lace, lingerie, cotton, satin or silk set,
 * a teddy (never a teddy bear), a slip (the garment: after «a», «her» or its fabric), a chemise, a negligee, a one-piece, knickers, a corset.
 */
const MORE_WORN = /\b(?:lace|lingerie|cotton|satin|silk)\s+sets?\b|\bteddy\b(?!\s+bears?\b)|\bteddies\b|\b(?:a|her|satin|silk|lace)\s+slip\b|\bchemises?\b|\bnegligees?\b|\bone-pieces?\b|\bknickers\b|\bcorsets?\b/i;

/** Whether she wears a garment in the sentence: lingerie, swimwear (the banks' lists), any garment the motion check names (`GARMENT`; the towel is a cover here), or `MORE_WORN`. */
function wearsAGarment(sentence: string): boolean {
  if (lingerieWordsIn(sentence).length > 0 || swimwearWordsIn(sentence).length > 0 || MORE_WORN.test(sentence)) return true;
  return Array.from(sentence.matchAll(new RegExp(GARMENT.source, "gi")), (m) => m[0]).some((word) => !/^towels?$/i.test(word));
}

/**
 * The implied cover that covers her in an own «Смелая» sentence: the first one she is in (`coverFormsOf`), when she wears no garment (`wearsAGarment`). A sentence that names a garment
 * («in a black lace set, a towel over her shoulders», «on a towel by the pool in a red one-piece») is a lingerie frame, and a cover only named beside her is none: undefined.
 */
function impliedCoverOf(sentence: string): (typeof IMPLIED_COVERS)[number] | undefined {
  if (wearsAGarment(sentence)) return undefined;
  const named = IMPLIED_COVERS.map((cover) => ({ cover, at: sentence.search(cover.forms) })).filter(({ at }) => at >= 0);
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
