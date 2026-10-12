// Test-only (5a.3, S5.9b2, plan s5a3 §5.2, I5.37, K-36): what the «Смелая» banks are designed never to say. These are sweeps of OUR bank text and of the
// sentences the template makes from it, never a gate on a text the owner writes (answer (c): «Если будет голая прям голая — окей, не страшно»), so they live in
// a test kit and no production module reads them.

/**
 * Exposure (concept-r3 tier 1b): nipples, areolae, genitals; naked, topless, bottomless; «nude» when it describes her, never the colour before a colourable noun
 * (heels, lipstick, lip, tights, nails, colour, tone, polish, makeup, bra, stockings); «sheer», «see-through» or «transparent» before concept-r3's garments (top,
 * blouse, shirt, dress, bra, panties, lingerie, bodysuit), one word between them at most. «a sheer babydoll» is not on the list (answer (b)).
 */
const EXPOSURE = new RegExp(
  String.raw`\b(?:nipples?|areolae?|areolas|genitals?|naked|topless|bottomless)\b` +
    String.raw`|\bnude\b(?!\s+(?:heels?|lipstick|lips?|tights|nails?|colou?r|tone|polish|makeup|bra|stockings)\b)` +
    String.raw`|\b(?:sheer|see-through|transparent)\s+(?:[a-z]+\s+)?(?:tops?|blouses?|shirts?|dress(?:es)?|bras?|panties|lingerie|bodysuits?)\b`,
  "gi",
);

/**
 * Explicit acts (concept-r3 tier 1a): touching between her legs, grabbing or squeezing her breasts, licking or sucking (a finger or an object), spread legs, on all
 * fours, a sex position, and «bent over» toward the camera, the lens, the phone or the viewer (only with that target: «bent over, pulling her jeans up» is the
 * owner's own example of what is allowed).
 */
const EXPLICIT = new RegExp(
  String.raw`\b(?:touch\w*|rubb?\w*|hands?)\s+between\s+her\s+legs\b` +
    String.raw`|\b(?:grabb?\w*|squeez\w*|cupp?\w*|fondl\w*)\s+(?:her\s+)?breasts?\b` +
    String.raw`|\b(?:lick\w*|suck\w*)\b` +
    String.raw`|\bspread\s+(?:her\s+)?legs\b|\blegs\s+(?:spread|apart|wide open)\b` +
    String.raw`|\bon\s+all\s+fours\b` +
    String.raw`|\b(?:doggy|missionary|cowgirl|straddl\w*|sex|sexual\w*|intercourse|orgasm\w*)\b` +
    String.raw`|\b(?:bend|bends|bending|bent)\s+over\b[^.;]*?\btowards?\s+(?:the\s+)?(?:camera|lens|phone|viewer)\b`,
  "gi",
);

/**
 * C3′ (the owner's verdict, 2026-10-12; the load rule `bottom-fabric` and `unfabricBottomsIn` arrive with fix/c3-prompts): Grok draws a skirt or shorts named
 * without its fabric as denim, so every one names it. Until the rebase brings the shared detector, the «Смелая» banks are held to it here, in its simple form: the
 * garment's own words, read back from its noun to the word that joins it to another garment, name a fabric.
 */
const FABRICS = /\b(?:cotton|linen|jersey|knit|knitted|wool|woollen|woolen|leather|suede|corduroy|tweed|lycra|spandex|nylon|fleece|terry|waffle|sequin\w*|chiffon|tulle|lace|mesh|satin|silk|velvet|crepe|polyester|modal|seersucker|poplin|ribbed)\b/i;
const BOTTOM = /\b(?:mini(?:-?skirts?)?|skirts?|skorts?|shorts|bermudas?)\b/gi;
const JOINS = /\b(?:and|or|with|over|under|a|an|the|her)\b|,/gi;

/** The skirts and shorts a text names without their fabric, as it names them. */
export function unfabricBottomsOf(text: string): string[] {
  return Array.from(text.matchAll(new RegExp(BOTTOM)), (m) => {
    const before = text.slice(0, m.index);
    const joins = Array.from(before.matchAll(new RegExp(JOINS)), (j) => (j.index ?? 0) + j[0].length);
    const own = before.slice(joins.length === 0 ? 0 : (joins[joins.length - 1] ?? 0));
    return FABRICS.test(own) ? null : m[0];
  }).filter((bottom): bottom is string => bottom !== null);
}

/**
 * C3′ (the owner: «просто стоит спиной без какой-либо позы»; the load rule `away-action` arrives with fix/c3-prompts): a moment seen from behind or in profile
 * names what she is doing, so the frame reads. The rule's own words, held here until the rebase.
 */
export const AWAY_ACTION = /\b(?:hands?|arms?|hair|earrings?|straps?|railing|stretch\w*|hugging|bent|turns to look)\b/i;

/** The exposure words of a text, as it writes them, in order. */
export function exposureWordsIn(text: string): string[] {
  return Array.from(text.matchAll(new RegExp(EXPOSURE)), (m) => m[0]);
}

/** The explicit acts a text names, as it writes them, in order. */
export function explicitActsIn(text: string): string[] {
  return Array.from(text.matchAll(new RegExp(EXPLICIT)), (m) => m[0]);
}
