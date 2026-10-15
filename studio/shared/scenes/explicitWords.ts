// 5a.3 (S5.9b2, plan s5a3 §5.2, I5.37, K-36): what the «Смелая» banks are designed never to say, swept over OUR bank text and the sentences the template makes from it
// (banks/boldDesign.testkit.ts re-exports these for the sweeps). Since 5b.2 (S5.WC2 round 2, the controller's decision on explicit content) the one motion check
// (scenes/motionText.ts) also reads them on a motion text: an explicit act is refused on every frame, exposure everywhere but in the owner's own idea on a frame of «Смелая».
// They stay off the owner's own scene text (answer (c): «Если будет голая прям голая — окей, не страшно»). Moved here from the test kit, the two lists verbatim; pure.

/**
 * Exposure (concept-r3 tier 1b): nipples, areolae, genitals; naked, topless, bottomless; «nude» when it describes her, never the colour before a colourable noun
 * (heels, lipstick, lip, tights, nails, colour, tone, polish, makeup, bra, stockings); «sheer», «see-through» or «transparent» before concept-r3's garments (top,
 * blouse, shirt, dress, bra, panties, lingerie, bodysuit), one word between them at most. The sheer garment the «Смелая» exemption names (banks/boldRules.ts) is not on the list (answer (b)).
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
    // S5.WC2b round 3 (the re-review's M4): toward the mirror too, which on a mirror frame is the camera; the final touch: at it, facing it or in front of it as well.
    String.raw`|\b(?:bend|bends|bending|bent)\s+over\b[^.;]*?\b(?:towards?|at|facing|in\s+front\s+of)\s+(?:the\s+)?(?:camera|lens|phone|viewer|mirror)\b`,
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
