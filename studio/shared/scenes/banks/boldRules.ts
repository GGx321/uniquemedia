import type { Level } from "./types";

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

/** An outfit whose shirt is worn open: with her arms up it does not stay closed over her chest. */
export const OPEN_SHIRT = /\bopen\b[^,]*\bshirt\b/i;

/**
 * An outfit whose top does not stay over her chest with her arms up: an open shirt falls open, and (S5.R4) a crop top or a cropped tee rides up (bold-arms-up; the nightwear bank
 * derives its arms-up pins from it).
 */
export const OPENS_WITH_ARMS_UP = new RegExp(`${OPEN_SHIRT.source}|\\bcrop(?:ped)?\\b`, "i");

/** An outfit with no shoulder straps: strapless or bandeau, or a bikini whose top is a shirt, a sweatshirt or a tee (or missing). A strap action never meets one (rule strap). */
export const NO_STRAPS = /\bstrap-?less\b|\bbandeau\b|\bbottoms\b|\bsweatshirts?\b|\bshirts?\b|\btee\b|\btube\b|\boff-shoulder\b|\bhoodies?\b/i;

/**
 * What covers her when she is under it, in it or pulls it up (the sheet she holds to her chest is the bedsheet moment's outfit, so «sheet» counts only as «the sheets» she lies
 * under). Polish after C4: a cover word counts wherever it stands in the phrase («under the covers reading», «under the duvet until noon», «under the duvet cover»); what keeps a
 * false noun out is the noun itself, named: another thing made of the same cloth (a pillow, a jacket, a shirt, a bag), a fort built of it, a pattern, what is worn (pyjamas, a robe, a hoodie), a rug, and «a blanket of stars».
 */
const NOT_A_COVER = String.raw`(?!\s+(?:pillows?|cushions?|jackets?|coats?|shirts?|dress(?:es)?|skirts?|shorts|pants|scarf|scarves|cardigans?|sweaters?|hoodies?|pyjamas|pajamas|robes?|rugs?|bags?|forts?|patterns?|prints?|of)\b)`;
const COVER = String.raw`(?:duvet|blankets?|covers|quilts?|comforters?|throws?|plaids?)\b${NOT_A_COVER}`;
/** Up to two words between the article and the cover word («the soft blanket»), none of them a picnic or a beach. */
const COVER_GAP = String.raw`(?:(?!picnic\b|beach\b)[a-z]+\s+){0,2}`;

/**
 * S5.R4: a moment under a cover (rule bold-covered; a bold slot never takes one, engine/scenes/fit.ts), in its text or its motion: under, beneath or into a cover («lies curled up
 * under the duvet», «snuggles into the duvet», «dozes under the sheets»), with a blanket or wrapped in one («curls up with a blanket»), pulling one up or closer («she pulls the
 * covers up»), or (round 3) one laid over her («the blanket over her legs»): what she wears does not show. On a blanket or a duvet is no cover (round 2: «sits on a picnic blanket»),
 * and the sheet she holds to her chest is the outfit itself.
 */
export const COVERS_HER = new RegExp(
  String.raw`\b(?:under|beneath|into|in)\s+(?:the|a|her)\s+${COVER_GAP}(?:${COVER}|sheets\b)` +
    String.raw`|\b(?:with|wrapped in)\s+(?:a|the|her)\s+${COVER_GAP}${COVER}` +
    String.raw`|\bpull(?:s|ing)?\s+(?:the|a|her)\s+${COVER}(?:\s+[a-z]+){0,2}?\s+(?:up|over|closer|around|higher)\b` +
    String.raw`|\b(?:the|a|her)\s+${COVER_GAP}${COVER}\s+(?:over|across|around)\s+her\b`,
  "i",
);

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

// 5a.4 (S5.BA2, plan s5a4 §5.1.1, r2.2 P6): the garment words of the tier table.
const BOLD_GARMENT = /\bthongs?\b|\bsheer\b|\bbodysuits?\b|\bstring\s+bikinis?\b|\btriangle\s+bikinis?\b|\bbandeau\b|\bhigh-leg\b/i;
const FLIRTY_GARMENT = /\blace\b|\bslip\s+nightdress\b|\bmidi\s+nightdress\b|\bsatin\s+robe\b/i;
const PLAIN_SWIMWEAR = /\bone-piece\b|\bsporty\b|\bsarongs?\b|\blinen\s+shirts?\b/i;
const PLAIN_SATIN = /\bsatin\s+cami\b/i;

/**
 * 5a.4 (S5.BA2, plan s5a4 §5.1.1, r2.2 P6): the tier table. The garment decides how revealing an outfit is, in every «Смелая» bank (the tier-table rule holds each outfit to it).
 * Null: a garment the table does not know.
 */
export function tierOfGarment(outfit: { text: string; tier?: "implied" | undefined }): Level | null {
  const text = outfit.text;
  // Every implied cover (the sheet, the towel, the foam, the bare back) is the most revealing tier.
  if (outfit.tier === "implied") return "bold";
  // A thong (any set with one), sheer, the lace bodysuit, the open shirt; at the water the string, triangle and bandeau bikinis and the high-leg swimsuit.
  if (BOLD_GARMENT.test(text) || OPEN_SHIRT.test(text)) return "bold";
  // Lace sets, the satin slip and midi nightdresses, the short tied satin robe.
  if (FLIRTY_GARMENT.test(text)) return "flirty";
  // At the water: the one-piece, a sporty bikini, a bikini under a sarong or a linen shirt are plain; the plain bikinis, a bikini and a straw hat, bikini bottoms and a sweatshirt flirty.
  if (swimwearWordsIn(text).length > 0) return PLAIN_SWIMWEAR.test(text) ? "ordinary" : "flirty";
  // Plain underwear: cotton, a plain bra or bra and briefs, the sports set with briefs or panties; and the satin cami and satin shorts.
  if (PLAIN_SATIN.test(text) || lingerieWordsIn(text).length > 0) return "ordinary";
  return null;
}

