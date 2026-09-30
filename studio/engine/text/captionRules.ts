import { CAPTION_ISSUES, type CaptionIssue, graphemeCount, MAX_CAPTION_GRAPHEMES, MAX_CAPTION_UNITS } from "../../shared/engine";
import { type CaptionRun, segmentCaption } from "./emoji/segment";

/**
 * The technical caption rules (plan 3b.3, contract K19): what a text must be for the rasteriser to draw it, and never
 * as tofu. Pure and deterministic; the one thing it asks the outside world is whether the emoji font can draw a
 * cluster. It says nothing about what a caption means: youth words and ages were dropped from the scope on
 * 2026-09-30 (the owner configures age checks himself later).
 *
 * The rules, each reported once under its `CaptionIssue`, in `CAPTION_ISSUES` order:
 * - charset: a text run may hold only printable ASCII, ’ ‘ “ ” – — …, LF and CRLF. Everything else is refused: control
 *   characters (a lone CR too), Cyrillic and any other script, and ZWJ, VS15/VS16, tag characters, U+20E3 and skin
 *   tone modifiers when they sit in text (they are legal only inside an emoji cluster the font draws). © ® ™ are
 *   refused in every form, by code point, anywhere in a cluster, the VS16 and VS15 forms too (owner, 2026-09-30).
 *   ★ ☆ are text, and no text font has them.
 * - emoji-missing: an emoji run the font cannot draw (`hasEmoji`), a lone regional indicator, a tag sequence that is not a
 *   black flag with letter tags and a cancel tag. Text-style pictographs without VS16 (❤ ✔ ✈) are emoji runs.
 * - emoji-text-style: an emoji run with VS15, which the font has no bitmap for.
 * - too-long: over 60 graphemes (`graphemeCount`, the contract's own count; a line break is one, CRLF is one). Over
 *   `MAX_CAPTION_UNITS` UTF-16 units nothing else is read and only this is reported.
 * - too-many-lines: over 2 lines, a line being what an explicit LF or CRLF ends: a trailing newline opens an empty
 *   line and a blank line counts. How the layout wraps a long line is 3b.4b's, not a rule here.
 *
 * Decision: the empty caption and a blank one (spaces, newlines) break no rule here. "At least one character" is the
 * contract's `Caption`; whether an all-blank caption is worth drawing is the editor's.
 */
export interface CaptionContext {
  /** Whether the emoji font draws exactly this cluster as one bitmap (`EmojiFont.has`). Asked of emoji runs only. */
  hasEmoji: (codePoints: readonly number[]) => boolean;
}

const COPYRIGHT_SIGNS: ReadonlySet<number> = new Set([0xa9, 0xae, 0x2122]);
const VS15 = 0xfe0e;
/** Printable ASCII, ’ ‘ “ ” – — …, LF and CRLF: the text the five fonts all cover (a test pins it). */
export const TEXT_ALLOWED = /^(?:[\u{20}-\u{7E}\u{2019}\u{2018}\u{201C}\u{201D}\u{2013}\u{2014}\u{2026}]|\r\n|\n)*$/u;
const REGIONAL_INDICATOR = /^[\u{1F1E6}-\u{1F1FF}]$/u;
const TAG_CHARACTER = /[\u{E0020}-\u{E007F}]/u;
/** The only tag sequence there is: a black flag, letter tags, a cancel tag. Whether the font has it is `hasEmoji`'s. */
const SUBDIVISION_FLAG = /^\u{1F3F4}[\u{E0061}-\u{E007A}]+\u{E007F}$/u;
const LINE_BREAK = /\r\n|\n/;
const MAX_LINES = 2;

/** True for a shape the font's `has` must not be asked about: a lone flag half, or tags on anything but a black flag. */
function isMalformedEmoji(run: Extract<CaptionRun, { kind: "emoji" }>): boolean {
  if (run.codePoints.length === 1 && REGIONAL_INDICATOR.test(run.text)) return true;
  return TAG_CHARACTER.test(run.text) && !SUBDIVISION_FLAG.test(run.text);
}

/** Every caption rule the text breaks, each once, in `CAPTION_ISSUES` order. Empty when the caption is fine. */
export function captionIssues(text: string, ctx: CaptionContext): CaptionIssue[] {
  // Bounded first, like the contract's Caption: an enormous string never reaches the segmenter.
  if (text.length > MAX_CAPTION_UNITS) return ["too-long"];

  const found = new Set<CaptionIssue>();
  for (const run of segmentCaption(text)) {
    if (run.kind === "text") {
      if (!TEXT_ALLOWED.test(run.text)) found.add("charset");
      continue;
    }
    if (run.codePoints.some((cp) => COPYRIGHT_SIGNS.has(cp))) found.add("charset");
    else if (run.codePoints.includes(VS15)) found.add("emoji-text-style");
    else if (isMalformedEmoji(run) || !ctx.hasEmoji(run.codePoints)) found.add("emoji-missing");
  }

  if (graphemeCount(text) > MAX_CAPTION_GRAPHEMES) found.add("too-long");
  if (text.split(LINE_BREAK).length > MAX_LINES) found.add("too-many-lines");
  return CAPTION_ISSUES.filter((issue) => found.has(issue));
}

/** The first rule the text breaks (what `TEXT_INVALID.captionIssue` carries), or null when the caption is fine. */
export function captionIssue(text: string, ctx: CaptionContext): CaptionIssue | null {
  return captionIssues(text, ctx)[0] ?? null;
}
