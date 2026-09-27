// Review round 1 (MEDIUM): the revealing-outfit guard (Stage 2's fixed
// decision: no revealing outfits until the owner's provider is connected)
// was duplicated in pools.ts and writer.ts. This is the one place it lives
// now; pools.ts (the planner's outfit pool), writer.ts (the writer's own
// gate on its sentences) and assembler.ts (the last-resort re-check) all
// import from here.

/** Spec words plus plural/adjective forms for the outfits Stage 2 disables: swimwear, sports bras, lingerie, stockings, slip dresses and robes. */
export const REVEALING_WORDS = /\b(bikini|swimsuit|swimwear|lingerie|sports bra|thong|stockings?|slip dress|robe over lingerie)\b/i;

/** Whether the text uses any revealing word (a plain boolean guard, e.g. pools.ts's outfit schema). */
export function hasRevealingWord(text: string): boolean {
  return REVEALING_WORDS.test(text);
}

/**
 * The revealing words a text uses, exactly as it wrote them. Builds its own
 * global-flagged regex instance per call (never reuses one across calls):
 * `RegExp.prototype.test`/`exec` on a shared global regex carries a mutable
 * `lastIndex`, which would silently skip matches on alternating calls —
 * `REVEALING_WORDS` above stays flag-`i`-only for exactly that reason.
 */
export function revealingWordsIn(text: string): string[] {
  return Array.from(text.matchAll(new RegExp(REVEALING_WORDS, "gi")), (m) => m[0]);
}
