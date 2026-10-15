// Test-only (5a.3, S5.9b2, plan s5a3 §5.2, I5.37, K-36): what the «Смелая» banks are designed never to say, swept over OUR bank text and the sentences the template
// makes from it. The exposure and explicit lists moved to scenes/explicitWords.ts (S5.WC2 round 2), where the one motion check reads them too; they stay off the
// owner's own scene text (answer (c): «Если будет голая прям голая — окей, не страшно»). The sweeps import them from here, unchanged.

export { explicitActsIn, exposureWordsIn } from "../explicitWords";

/**
 * S5.R4 round 2: a legs moment's pose family, read from its words. Round 3: every family its words name is read (the first one hid «sits on the pool steps, legs out» in «stepping»),
 * and a legs moment of a «Смелая» bank names exactly one; the banks hold their legs moments to one moment a family (banks/legs.test.ts), and the prompt sweep counts a run's legs
 * frames by family.
 */
export const POSE_FAMILIES: readonly (readonly [string, RegExp])[] = [
  // S5.R4 round 3: her feet in the water is one picture, whether she dangles them, steps down into it or lets the waves wash over them.
  ["feet in the water", /\b(?:in|into)\s+the\s+(?:water|sea|pool)\b|\bwaves?\b/i],
  ["on tiptoe", /\btiptoe\b/i],
  ["kneeling", /\bkneel\w*\b/i],
  // A foot dangling in the water is her feet in the water.
  ["a foot dangling", /\bdangl\w*\b(?![^,]*\b(?:in|into)\s+the\s+(?:water|sea|pool)\b)/i],
  // A step she takes, not the pool's steps she sits on.
  ["stepping", /\bsteps?\s+(?:down|up|into|out|onto|off|over|toward|towards|forward|across|back|closer)\b/i],
  ["one knee bent", /\b(?:one|a) knee\b|\bknees?\s+(?:bent|up|drawn up)\b/i],
  ["a foot lifted", /\b(?:lifts?|raises?)\s+(?:one|a|her)\s+(?:bare\s+)?(?:foot|leg)\b/i],
  ["her weight on one leg", /\bweight on one leg\b/i],
  // Polish after C4: standing still, her feet together («Ночнушки») or in the sand («beach»).
  ["her feet together", /\bfeet together\b/i],
  ["her feet in the sand", /\bfeet in the sand\b/i],
  ["legs over the armrest", /\blegs? over the\b/i],
  ["legs crossed", /\bcross\w*\b/i],
  ["legs stretched out", /\bstretch\w*\b|\blegs?\s+(?:out|forward)\b|\bout straight\b/i],
];
/** S5.R4 round 3: the one family a «Смелая» bank may hold twice, on two places (a pool and the sea are two settings); never three times. */
export const FEET_IN_THE_WATER = "feet in the water";
export const FEET_IN_THE_WATER_MAX = 2;

/** Every pose family a text's words name, in the list's order. */
export const poseFamiliesOf = (text: string): string[] => POSE_FAMILIES.filter(([, words]) => words.test(text)).map(([family]) => family);

/** How many of the texts name the family, whatever other families they also name (a step down into the water is a stepping and her feet in the water). */
export const countInFamily = (texts: readonly string[], family: string): number => texts.filter((text) => poseFamiliesOf(text).includes(family)).length;

/** A legs moment's pose family: the one family its words name; undefined when they name none, or more than one (the moment is then worded apart). */
export const poseFamilyOf = (text: string): string | undefined => {
  const families = poseFamiliesOf(text);
  return families.length === 1 ? families[0] : undefined;
};

/** S5.R4 round 3: the words that do not change a pose: articles, her, numbers, the adjectives of her feet, and the motion's pace words. */
const SAME_POSE_WORDS = new Set(["a", "an", "the", "her", "his", "she", "one", "two", "bare", "socked", "little", "bit", "slowly", "slightly", "gently", "small"]);
/** A word's stem, roughly: «crosses», «crossed» and «crossing» are one word, and «feet» is «foot». */
const stemOf = (word: string): string => (word === "feet" ? "foot" : word.replace(/(?:es|ed|ing|s)$/, ""));

/**
 * S5.R4 round 3: a text as a pose, for comparing moments across banks: its words, lower-cased, stemmed and sorted, without the words that do not change the pose. «lifts one foot to
 * the mirror» and «lifts one bare foot to the mirror» read the same; «sits on the sand, legs out» and «sits on the grass, legs out» do not (another place is another photo).
 */
export function poseWordsOf(text: string): string {
  // Polish after C4: shifting her weight onto a leg or onto a hip is one pose («weight on one leg» and «weight on one hip», «to the other leg»).
  const unshifted = text.toLowerCase().replace(/\b(?:on|to)\s+(?:one|the other)\s+(?:leg|hip)\b/g, "");
  const words = (unshifted.match(/[a-z]+/g) ?? []).filter((w) => !SAME_POSE_WORDS.has(w)).map(stemOf);
  return [...new Set(words)].sort().join(" ");
}
