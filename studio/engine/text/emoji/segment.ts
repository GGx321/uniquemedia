/**
 * Splits a caption into text runs and emoji clusters. Pure, and independent of the font: whether the font can DRAW
 * a cluster is the reader's `has()`, asked by the caller (3b.3 refuses the caption, 3b.4b draws it).
 *
 * The clusters are `Intl.Segmenter` graphemes, so VS16, ZWJ sequences, skin tones, flags, keycaps and tag
 * sequences arrive as one unit. A cluster is an emoji when it is meant to be drawn as one: it starts with an
 * emoji-presentation character (which covers flags and skin tone modifiers), or it starts with a pictograph that
 * carries VS16, a ZWJ or a skin tone, or it is a keycap. "©", "❤", a digit or a lone VS16 stay text.
 */

export type CaptionRun = { kind: "text"; text: string } | { kind: "emoji"; text: string; codePoints: readonly number[] };

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

const STARTS_EMOJI_PRESENTATION = /^\p{Emoji_Presentation}/u;
const STARTS_PICTOGRAPH = /^\p{Extended_Pictographic}/u;
const CARRIES_EMOJI_FORM = /[️‍]|\p{Emoji_Modifier}/u;
const KEYCAP = /^[0-9#*]️?⃣$/;

function isEmoji(cluster: string): boolean {
  if (STARTS_EMOJI_PRESENTATION.test(cluster)) return true;
  if (STARTS_PICTOGRAPH.test(cluster)) return CARRIES_EMOJI_FORM.test(cluster);
  return KEYCAP.test(cluster);
}

function codePointsOf(cluster: string): number[] {
  return Array.from(cluster, (character) => character.codePointAt(0) ?? 0);
}

/** The runs in order, always adding up to the input; adjacent text is one run, every emoji cluster its own. */
export function segmentCaption(text: string): CaptionRun[] {
  const runs: CaptionRun[] = [];
  for (const { segment } of segmenter.segment(text)) {
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
