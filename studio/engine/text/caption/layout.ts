import { TEXT_BASE_PX } from "../../../shared/montage";
import { segmentCaption } from "../emoji/segment";

/**
 * The caption layout (plan 3b.4b, A3): where every word and emoji of a caption goes, and at what size. Pure and
 * deterministic: the one thing it asks the outside world is the width of a run of text, a function the caller binds to a
 * font (resvg's own `getBBox()` in production, an arithmetic stand-in in tests), and the aspect of an emoji bitmap.
 *
 * - **Tokens.** LF and CRLF end an explicit line (SVG collapses a raw newline inside a text node to a space, so the
 *   layout, not the template, breaks lines). A line's words are what a single space separates; runs of spaces collapse and
 *   the ends are trimmed. A word is `Intl.Segmenter` graphemes: text runs and emoji clusters (`segmentCaption`), and an
 *   emoji written against a word stays in it, so a word is never split. Blank lines are skipped.
 * - **Lines.** One line when the caption fits the fit width at its own size. Otherwise a BALANCED split into two: the
 *   split whose widest line is narrowest (not the fullest first line), and on a tie the one with the shorter top line.
 *   Explicit lines are kept as they are: with a line break there are exactly two lines and neither is re-wrapped. A
 *   third line is never drawn.
 * - **Size.** The base size times the layer's `scale`, kept to a hundredth. A caption whose widest line is over the fit
 *   width (929 px, 86% of the frame) shrinks to fit, to a whole number of pixels, 0.5% under it. A single over-long word
 *   shrinks, and is never broken. Every width is measured once at 100 px and scaled, so the fitted size is one exact step
 *   (SP2 looped up to three passes; nothing here can need a second one).
 * - **Emoji.** Each is an inline picture `EMOJI_HEIGHT_EM` tall at its bitmap's aspect. PROVISIONAL, like the baseline
 *   the template puts it on (SP2's first guess, 0.82): both wait for the owner's design review.
 */

/** 86% of the 1080 frame, rounded to a whole pixel: the widest a caption's text may be (plan, Text row). */
export const TEXT_FIT_WIDTH = 929;
/** An emoji's height in ems; its width follows the bitmap. PROVISIONAL (owner's design review). */
export const EMOJI_HEIGHT_EM = 1.15;
/** The distance between two baselines, in ems (the mockup's `line-height: 1.15`). */
export const LINE_HEIGHT_EM = 1.15;
/** The fitted size stays this far under the fit width, so a hair of measuring error never pushes a line over it. */
const FIT_MARGIN = 0.995;
/** How wide the widths are measured, in pixels: a font size at which every width is taken, then scaled. */
const REFERENCE_PX = 100;
const MAX_LINES = 2;
const MIN_SCALE = 0.5;
const MAX_SCALE = 2;

export type CaptionLayoutErrorCode = "EMPTY" | "TOO_MANY_LINES" | "BAD_MEASURE" | "BAD_SCALE";

export class CaptionLayoutError extends Error {
  readonly code: CaptionLayoutErrorCode;
  constructor(code: CaptionLayoutErrorCode, why: string) {
    super(why);
    this.name = "CaptionLayoutError";
    this.code = code;
  }
}

export type LaidItem =
  | { kind: "text"; text: string; x: number; width: number }
  | { kind: "emoji"; text: string; codePoints: readonly number[]; x: number; width: number };

export interface LaidLine {
  /** The pieces left to right; `x` is from the line's own left edge, and the gap between two words is one space. */
  items: LaidItem[];
  width: number;
  /** What the line says: its words with one space between them. */
  text: string;
}

export interface CaptionLayout {
  /** Pixels on the 1080 frame. */
  fontSize: number;
  /** Pixels between two baselines. */
  lineHeight: number;
  lines: LaidLine[];
  /** The widest line. */
  textWidth: number;
}

export interface LayoutInput {
  text: string;
  /** The layer's `scale`, 0.5 to 2. */
  scale: number;
  /** The advance of a run of text at 100 px, in pixels. Called once per distinct run (and once for the space). */
  measure: (run: string) => number;
  /** Width over height of the bitmap an emoji cluster is drawn from. */
  emojiAspect: (codePoints: readonly number[]) => number;
}

interface Piece {
  kind: "text" | "emoji";
  text: string;
  codePoints: readonly number[];
  /** Width at the 100 px reference. */
  width: number;
}

interface Word {
  text: string;
  pieces: Piece[];
  width: number;
}

const LINE_BREAK = /\r\n|\n/;

function wordsOf(line: string): string[] {
  return line.split(" ").filter((word) => word !== "");
}

export function layoutCaption(input: LayoutInput): CaptionLayout {
  const { text, scale } = input;
  if (!Number.isFinite(scale) || scale < MIN_SCALE || scale > MAX_SCALE) throw new CaptionLayoutError("BAD_SCALE", `scale ${scale} is outside ${MIN_SCALE} to ${MAX_SCALE}`);

  const measured = new Map<string, number>();
  const advance = (run: string): number => {
    const known = measured.get(run);
    if (known !== undefined) return known;
    const width = input.measure(run);
    if (!Number.isFinite(width) || width < 0) throw new CaptionLayoutError("BAD_MEASURE", `the measure answered ${width} for a run of ${run.length} characters`);
    measured.set(run, width);
    return width;
  };

  const lineWords = text
    .split(LINE_BREAK)
    .map(wordsOf)
    .filter((words) => words.length > 0);
  if (lineWords.length === 0) throw new CaptionLayoutError("EMPTY", "the caption has nothing to draw");
  if (lineWords.length > MAX_LINES) throw new CaptionLayoutError("TOO_MANY_LINES", `the caption has ${lineWords.length} lines, at most ${MAX_LINES} are drawn`);

  const toWord = (raw: string): Word => {
    const pieces: Piece[] = segmentCaption(raw).map((run) => {
      if (run.kind === "text") return { kind: "text", text: run.text, codePoints: [], width: advance(run.text) };
      const aspect = input.emojiAspect(run.codePoints);
      if (!Number.isFinite(aspect) || aspect <= 0) throw new CaptionLayoutError("BAD_MEASURE", `an emoji bitmap with aspect ${aspect}`);
      return { kind: "emoji", text: run.text, codePoints: run.codePoints, width: REFERENCE_PX * EMOJI_HEIGHT_EM * aspect };
    });
    return { text: raw, pieces, width: pieces.reduce((sum, piece) => sum + piece.width, 0) };
  };
  const logical = lineWords.map((words) => words.map(toWord));
  const space = advance(" ");

  /** Width at the reference size of words `from` to `to` (exclusive) on one line. */
  const span = (words: readonly Word[], from: number, to: number): number => {
    let sum = space * Math.max(0, to - from - 1);
    for (let i = from; i < to; i++) sum += words[i]?.width ?? 0;
    return sum;
  };

  const baseSize = Math.round(TEXT_BASE_PX * scale * 100) / 100;
  const fits = (width100: number, size: number): boolean => (width100 * size) / REFERENCE_PX <= TEXT_FIT_WIDTH;

  // Which words go on which line, before any size is known: the split does not depend on the size, because every width scales with it.
  let lines: Word[][];
  const first = logical[0] ?? [];
  if (logical.length === MAX_LINES) {
    lines = logical;
  } else if (first.length < 2 || fits(span(first, 0, first.length), baseSize)) {
    lines = [first];
  } else {
    let bestAt = 1;
    let best = Number.POSITIVE_INFINITY;
    for (let k = 1; k < first.length; k++) {
      const widest = Math.max(span(first, 0, k), span(first, k, first.length));
      if (widest < best - 1e-9) {
        best = widest;
        bestAt = k;
      }
    }
    lines = [first.slice(0, bestAt), first.slice(bestAt)];
  }

  const widest100 = Math.max(...lines.map((words) => span(words, 0, words.length)));
  const fontSize = fits(widest100, baseSize) ? baseSize : Math.max(1, Math.floor(((TEXT_FIT_WIDTH * REFERENCE_PX) / widest100) * FIT_MARGIN));

  const k = fontSize / REFERENCE_PX;
  const laid: LaidLine[] = lines.map((words) => {
    const items: LaidItem[] = [];
    let x = 0;
    words.forEach((word, index) => {
      if (index > 0) x += space * k;
      for (const piece of word.pieces) {
        const width = piece.width * k;
        items.push(piece.kind === "text" ? { kind: "text", text: piece.text, x, width } : { kind: "emoji", text: piece.text, codePoints: piece.codePoints, x, width });
        x += width;
      }
    });
    return { items, width: x, text: words.map((word) => word.text).join(" ") };
  });

  return { fontSize, lineHeight: fontSize * LINE_HEIGHT_EM, lines: laid, textWidth: Math.max(...laid.map((line) => line.width)) };
}
