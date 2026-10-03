/**
 * Splits a caption into text runs and emoji clusters. Pure, and independent of the font: whether the font can DRAW
 * a cluster is the reader's `has()`, asked by the caller (3b.3 refuses the caption, 3b.4b draws it).
 *
 * The clusters are `Intl.Segmenter` graphemes, so VS16, ZWJ sequences, skin tones, flags, keycaps and tag
 * sequences arrive as one unit. A cluster is an emoji when the caption should show it as one: it starts with an
 * emoji-presentation character (which covers flags and skin tone modifiers), or with ANY pictograph, or it is a
 * keycap. That includes text-style pictographs without VS16 (❤ ✔ ✈ ☀): no text font has them, so they must not
 * reach a text run as tofu; the emoji font either draws them or `has()` says no and the caption is refused.
 * The exceptions are a bare ©, ® and ™, which the text fonts have (with VS16 they are emoji). A digit, a hash,
 * a letter or a lone VS16 or ZWJ stay text.
 */

export type CaptionRun = { kind: "text"; text: string } | { kind: "emoji"; text: string; codePoints: readonly number[] };

let segmenterInstance: Intl.Segmenter | undefined;
/** Made on first use, not at load: a module that builds something when it loads cannot be dropped from a bundle that never calls it. */
const segmenter = (): Intl.Segmenter => (segmenterInstance ??= new Intl.Segmenter("en", { granularity: "grapheme" }));

const STARTS_EMOJI_PRESENTATION = /^\p{Emoji_Presentation}/u;
const STARTS_PICTOGRAPH = /^\p{Extended_Pictographic}/u;
const CARRIES_EMOJI_FORM = /[\u{FE0F}\u{200D}]|\p{Emoji_Modifier}/u;
const KEYCAP = /^[0-9#*]\u{FE0F}?\u{20E3}$/u;
/** Pictographs the text fonts have as letters-like signs; bare, they are text. The owner has not approved them as emoji for captions. */
const TEXT_FONT_SIGNS: ReadonlySet<string> = new Set(["\u{A9}", "\u{AE}", "\u{2122}"]);

function isEmoji(cluster: string): boolean {
  if (STARTS_EMOJI_PRESENTATION.test(cluster)) return true;
  if (STARTS_PICTOGRAPH.test(cluster)) return !TEXT_FONT_SIGNS.has(cluster) || CARRIES_EMOJI_FORM.test(cluster);
  return KEYCAP.test(cluster);
}

function codePointsOf(cluster: string): number[] {
  return Array.from(cluster, (character) => character.codePointAt(0) ?? 0);
}

/** The runs in order, always adding up to the input; adjacent text is one run, every emoji cluster its own. */
export function segmentCaption(text: string): CaptionRun[] {
  const runs: CaptionRun[] = [];
  for (const { segment } of segmenter().segment(text)) {
    if (isEmoji(segment)) {
      runs.push({ kind: "emoji", text: segment, codePoints: codePointsOf(segment) });
      continue;
    }
    const last = runs[runs.length - 1];
    if (last?.kind === "text") last.text += segment;
    else runs.push({ kind: "text", text: segment });
  }
  return runs;
}
