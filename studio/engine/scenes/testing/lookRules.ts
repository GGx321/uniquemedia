import type { Pool } from "../pools";
import { CUSTOM_POOL } from "./customPool";

// S5.1d: the detectors the look sweeps share (I5.2, I5.3, I5.10). Test-only: the rules live in the plan (docs/studio/2026-10-10-stage-5-plan.md §4), and the
// engine's own checks (youthWords, REVEALING_WORDS) are called directly by the sweeps, never copied here.

/** I5.2: the held-phone patterns no non-mirror capture line, constraint or prompt may match. */
export const HELD_PHONE: readonly RegExp[] = [/holds? (the|her) phone/i, /phone in (her|one) hand/i, /phone (is )?visible/i];

/** The writer's soft list (writer.ts «Never use these words», Spike A v3): the luxury, studio and mood words no new prompt carries. Word-bounded. */
export const SOFT_WORDS: readonly string[] = [
  "professional", "photographer", "photoshoot", "studio", "editorial", "fashion", "model", "posing", "captures", "candid", "cinematic", "bokeh", "golden hour",
  "softly lit", "soft light", "glow", "glowing", "dramatic", "moody", "dreamy", "elegant", "luxurious", "lavish", "glamorous", "chic", "sophisticated", "polished",
  "pristine", "marble", "silk", "satin", "velvet", "stunning", "beautiful", "perfect", "flawless", "gorgeous",
];
export const SOFT_LIST: RegExp = new RegExp(`\\b(?:${SOFT_WORDS.join("|")})\\b`, "i");

/** I5.3: the camera and staging phrases (the plan's list; the soft list covers «photographer», «bokeh», «golden hour» and «softly lit» again). */
export const STAGING: readonly RegExp[] = [/only she is in focus/i, /full-frame/i, /editorial/i, /shot on a camera/i, /photographer/i, /bokeh/i, /studio lighting/i, /golden hour/i, /softly lit/i];

/** Paper and screens: nothing in a place, an activity or an outfit of the pools reads as one (her phone is the only screen). */
export const PAPER_AND_SCREENS =
  /\b(paper\w*|books?|magazines?|documents?|notebooks?|menus?|maps?|desks?|stud(?:y|ying)|laptops?|tablets?|screens?|newspapers?|television|tv)\b/i;

/** I5.10: a negated look term puts the term into the prompt. The plan's regex, «not retouched», «without retouching», and the same negations of the other look words. */
export const NEGATED_LOOK: readonly RegExp[] = [
  /\bno (retouching|airbrushing|beauty filter|bokeh|blur|makeup filter)\b/i,
  /not retouched/i,
  /without retouching/i,
  /\b(no|without|not|never|non)[- ](any )?(retouch\w*|airbrush\w*|beauty|bokeh|blur\w*|filters?|makeup|smooth\w*|soft[- ]focus|depth of field|shallow|grain|noise|compression)\b/i,
];

/** The first pattern of the list the text matches, as the matched text, or null. */
export function firstHit(text: string, patterns: readonly RegExp[]): string | null {
  for (const pattern of patterns) {
    const hit = pattern.exec(text);
    if (hit !== null) return hit[0];
  }
  return null;
}

/**
 * The shared custom-pool fixture with the one place the engine's own youth-word gate refuses ("a tiny bookshop": «tiny» is a youth word, and the assembler would
 * throw on a sentence that carries it) renamed. The sweeps run over a custom category that is clean; the fixture itself is left as other tests pin it.
 */
export const SWEEP_CUSTOM_POOL: Pool = {
  ...CUSTOM_POOL,
  locations: CUSTOM_POOL.locations.map((place) => (place.name === "a tiny bookshop" ? { ...place, name: "a quiet bookshop" } : place)),
};
