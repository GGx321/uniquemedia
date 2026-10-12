// 5a.3 (S5.9b1, plan s5a3 §5.2 and §6.1): what the «Смелая» level is allowed that the global lists refuse. The lists in shared/scenes/words.ts and
// shared/engine/ageText.ts stay exactly as they are, for every other level and every other path (montage captions included); the exemptions live only
// here, and only the content-line module (contentLine.ts) and, from S5.9b2, the two «Смелая» bank schemas (banks/schema.ts, engine/scenes/pools.ts) import them.

/**
 * Garment names the youth rule would refuse (its `bab(?:y|ies)\w*` matches «babydoll») but that are lingerie, not a youth word: answer (b) of the owner.
 * The name only: «baby» alone, «baby doll» in two words and «baby blue» stay refused, and the plural «babydolls» is the same garment.
 */
export const BOLD_EXEMPT_YOUTH: readonly string[] = ["babydoll"];

/**
 * S5.9b2 (plan s5a3 §6.4): the satin nightwear of «Ночнушки и бельё», which the soft look list refuses («satin», K-22). Exempt only in a «Смелая» bank's
 * soft-list check: the list itself, the writer's prompt and every ordinary bank keep refusing «satin» (and «satin pajamas», «a satin dress»).
 */
export const BOLD_EXEMPT_LOOK: readonly string[] = ["satin slip nightdress", "satin midi nightdress", "satin cami", "satin shorts", "satin robe"];

/** The text with the exempt «Смелая» look phrases taken out (whole words, any case), for a «Смелая» bank's check against the soft look list. */
export function withoutBoldExemptLook(text: string): string {
  return BOLD_EXEMPT_LOOK.reduce((out, phrase) => out.replace(new RegExp(`\\b${phrase.replace(/ /g, "\\s+")}\\b`, "gi"), ""), text);
}

/** An outfit whose shirt is worn open: with her arms up it does not stay closed over her chest (bold-arms-up; the nightwear bank derives its arms-up pins from it). */
export const OPEN_SHIRT = /\bopen\b[^,]*\bshirt\b/i;

/** An outfit with no shoulder straps: strapless or bandeau, or a bikini whose top is a shirt, a sweatshirt or a tee (or missing). A strap action never meets one (rule strap). */
export const NO_STRAPS = /\bstrap-?less\b|\bbandeau\b|\bbottoms\b|\bsweatshirts?\b|\bshirts?\b|\btee\b|\btube\b|\boff-shoulder\b|\bhoodies?\b/i;

// S5.9b2 (plan s5a3 §6.4, I5.37): the «Смелая» vocabulary, word by word. It may appear only in a «Смелая» bank (rule bold-only-here), any item that names it is
// drawn on Seedream (bold-route), a water moment pins swimwear (water), stockings ride only on the bold legwear (legwear), and no legs moment pins lingerie
// (bold-legs; P-5a3 #6). These lists decide where a word may stand in OUR banks; they are never a gate on a text the owner writes.
const LINGERIE: readonly string[] = ["lingerie", "bra", "bras", "bralette", "bralettes", "panties", "panty", "briefs", "thong", "thongs", "underwear", "babydoll", "babydolls", "bodysuit", "bodysuits"];
const SWIMWEAR: readonly string[] = ["bikini", "bikinis", "swimsuit", "swimsuits", "swimwear"];
const STOCKINGS: readonly string[] = ["stocking", "stockings"];
const SATIN: readonly string[] = ["satin"];
const BOLD_VOCABULARY: readonly string[] = [...LINGERIE, ...SWIMWEAR, ...STOCKINGS, ...SATIN];

/** The words of a text that are in the list, in order, as the text has them. */
function wordsOf(text: string, list: readonly string[]): string[] {
  return (text.match(/[A-Za-z]+/g) ?? []).filter((word) => list.includes(word.toLowerCase()));
}

/** The «Смелая» words of a text: lingerie, swimwear, stockings and satin. */
export function boldWordsIn(text: string): string[] {
  return wordsOf(text, BOLD_VOCABULARY);
}

/** The lingerie words of a text (the babydoll and the bodysuit included). */
export function lingerieWordsIn(text: string): string[] {
  return wordsOf(text, LINGERIE);
}

/** The swimwear words of a text. */
export function swimwearWordsIn(text: string): string[] {
  return wordsOf(text, SWIMWEAR);
}

/** The stocking words of a text. */
export function stockingWordsIn(text: string): string[] {
  return wordsOf(text, STOCKINGS);
}
