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

/** The exposure words of a text, as it writes them, in order. */
export function exposureWordsIn(text: string): string[] {
  return Array.from(text.matchAll(new RegExp(EXPOSURE)), (m) => m[0]);
}

/** The explicit acts a text names, as it writes them, in order. */
export function explicitActsIn(text: string): string[] {
  return Array.from(text.matchAll(new RegExp(EXPLICIT)), (m) => m[0]);
}
