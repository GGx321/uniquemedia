import { Caption, type CaptionIssue, type MontageDraft, type TextFont, type TextLayer, type TextStyle } from "../../../shared/engine";
import { TEXT_BASE_PX } from "../../../shared/montage";
import { captionIssue } from "../../../shared/text/captionRules";
import { CaptionLayoutError, layoutCaption } from "../../../shared/text/layout";

// 3d.5: a text layer's properties (EditorText.dc.html; the reconciliation's R23–R31, T2) as pure edits over a draft, the
// sibling of layerOps.ts. The editor sends each result through `DraftSession.edit`, so every one is an undo step and is saved
// like any other edit.
//
// The caption is the ENGINE's to judge: the text panel asks `montages.textPreview` for every caption it commits, and shows the
// engine's TEXT_INVALID + `captionIssue` inline (captionCheck.ts). The window keeps out of the draft only what can never reach
// the engine: text the contract's `Caption` refuses (empty, over 60 characters, a control or bidi character), and a caption the
// shared layout has nothing to draw from (only spaces and line breaks: a render holding one fails as a whole, 3b.4b). Even those
// are worded by the SHARED caption rules (`captionIssue`), never by rules of the window's own.

/**
 * Why typed text cannot become the caption:
 * - `empty`: nothing typed (the contract's `Caption` needs a character);
 * - `blank`: only spaces and line breaks, which the shared layout refuses to lay out (nothing to draw);
 * - a `CaptionIssue`: the contract refuses it, worded by the shared rules' first issue (`too-long`, `charset` for a control
 *   or bidi character).
 */
export type CaptionRefusal = "empty" | "blank" | CaptionIssue;

export type CaptionEdit = { readonly ok: true; readonly spec: MontageDraft } | { readonly ok: false; readonly reason: CaptionRefusal };

/** A «Стили» preset (T2): adds a text in its font and style, with its sample as the caption and the style's default colour. */
export interface TextPreset {
  readonly label: string;
  readonly font: TextFont;
  readonly style: TextStyle;
  readonly sample: string;
}

/** The artboard's six presets, in its order; the first is «Добавить текст»'s own (AM7). */
export const TEXT_PRESETS: readonly TextPreset[] = [
  { label: "Плашка · Manrope", font: "manrope", style: "plaque", sample: "sunday reset" },
  { label: "Обводка · Oswald", font: "oswald", style: "outline", sample: "coffee first" },
  { label: "Без фона · Playfair", font: "playfair", style: "none", sample: "golden hour" },
  { label: "Без фона · Caveat", font: "caveat", style: "none", sample: "slow morning" },
  { label: "Плашка · PT Mono", font: "ptmono", style: "plaque", sample: "day 01" },
  { label: "Обводка · Manrope", font: "manrope", style: "outline", sample: "wait for it" },
];

/**
 * The swatches (R31): «Плашка» paints the plaque with the colour (the engine draws the text #111111 or #ffffff, whichever
 * contrasts more), «Обводка» and «Без фона» take it as the text colour (the owner, 2026-09-30: Q2). White first: the default.
 */
export const TEXT_COLORS: readonly { readonly color: string; readonly label: string }[] = [
  { color: "#ffffff", label: "Белый" },
  { color: "#111111", label: "Почти чёрный" },
  { color: "#ffd166", label: "Жёлтый" },
  { color: "#ff9ec4", label: "Розовый" },
  { color: "#9ad9ff", label: "Голубой" },
  { color: "#ff7a59", label: "Коралловый" },
];

/** The contract's bounds of `TextLayer.scale` (a test binds them to the schema). */
export const MIN_TEXT_SCALE = 0.5;
export const MAX_TEXT_SCALE = 2;

const HEX_COLOR = /^#[0-9a-f]{6}$/;
/** Any width will do: the layout is asked only whether there is anything to lay out. */
const ANY_WIDTH = (run: string): number => run.length * 50;

function textAt(spec: MontageDraft, index: number): TextLayer {
  if (!Number.isSafeInteger(index) || index < 0 || index >= spec.layers.length) throw new RangeError(`layer index must be 0..${spec.layers.length - 1}, got ${index}`);
  const layer = spec.layers[index];
  if (layer?.kind !== "text") throw new RangeError(`layer ${index} is not a text`);
  return layer;
}

const withText = (spec: MontageDraft, index: number, layer: TextLayer): MontageDraft => ({ ...spec, layers: spec.layers.map((l, i) => (i === index ? layer : l)) });

/** Whether the shared layout refuses the caption as one with nothing to draw (the engine's «the caption has nothing to draw»). */
function nothingToDraw(text: string): boolean {
  try {
    layoutCaption({ text, scale: 1, measure: ANY_WIDTH, emojiAspect: () => 1 });
    return false;
  } catch (error) {
    // Only "empty" is the window's to keep out; a third line and the like are the engine's verdict (TEXT_INVALID).
    return error instanceof CaptionLayoutError && error.code === "EMPTY";
  }
}

/** Why `text` cannot be the caption, or null when it may be (the engine then judges it by the caption rules). */
export function captionRefusal(text: string): CaptionRefusal | null {
  if (text.length === 0) return "empty";
  // The contract's own check of what may reach the rasteriser. Its refusal is worded by the shared rules, which judge the text the
  // way the engine does; emoji coverage is assumed here (only the engine has the font), so it never decides a refusal on its own.
  if (!Caption.safeParse(text).success) return captionIssue(text, { hasEmoji: () => true }) ?? "charset";
  return nothingToDraw(text) ? "blank" : null;
}

/** The caption typed into the text field, when it can be one; the same draft when it is the caption already. */
export function setCaption(spec: MontageDraft, index: number, text: string): CaptionEdit {
  const layer = textAt(spec, index);
  if (text === layer.value) return { ok: true, spec };
  const why = captionRefusal(text);
  if (why !== null) return { ok: false, reason: why };
  return { ok: true, spec: withText(spec, index, { ...layer, value: text }) };
}

export function setTextFont(spec: MontageDraft, index: number, font: TextFont): MontageDraft {
  const layer = textAt(spec, index);
  return font === layer.font ? spec : withText(spec, index, { ...layer, font });
}

export function setTextStyle(spec: MontageDraft, index: number, style: TextStyle): MontageDraft {
  const layer = textAt(spec, index);
  return style === layer.style ? spec : withText(spec, index, { ...layer, style });
}

/** The plaque's colour («Плашка») or the text's (the other styles); a lowercase `#rrggbb`, as the contract stores it. */
export function setTextColor(spec: MontageDraft, index: number, color: string): MontageDraft {
  const layer = textAt(spec, index);
  if (!HEX_COLOR.test(color)) throw new RangeError(`a colour must be a lowercase #rrggbb, got ${color}`);
  return color === layer.color ? spec : withText(spec, index, { ...layer, color });
}

/** The scale kept to a hundredth (the layout's own step) and within the contract's 0.5–2; the same draft when it stays. */
export function setTextScale(spec: MontageDraft, index: number, scale: number): MontageDraft {
  const layer = textAt(spec, index);
  if (!Number.isFinite(scale)) throw new RangeError(`a scale must be a finite number, got ${scale}`);
  const next = Math.min(MAX_TEXT_SCALE, Math.max(MIN_TEXT_SCALE, Math.round(scale * 100) / 100));
  return next === layer.scale ? spec : withText(spec, index, { ...layer, scale: next });
}

/** «Размер» as the panel shows it: the caption's pixels on the 1080 frame before any shrink to fit (K21). */
export function textSize(scale: number): number {
  return Math.round(scale * TEXT_BASE_PX);
}

/**
 * A typing burst is one undo step (review round 1): it ends when the caption field loses the focus, or after this long without a
 * keystroke. 1.5 s is the editor's default, a choice the owner may change.
 */
export const TYPING_PAUSE_MS = 1_500;

/** Whether a keystroke at `nowMs` goes on with the burst whose last keystroke was at `lastMs` (null: no burst is open). */
export function typingGoesOn(lastMs: number | null, nowMs: number): boolean {
  if (lastMs === null) return false;
  const gap = nowMs - lastMs;
  return gap >= 0 && gap < TYPING_PAUSE_MS;
}

/** `text` put over the selection `[start, end)` of `value` (either order, held to the text), and where the caret lands after it. */
export function insertAt(value: string, start: number, end: number, text: string): { value: string; caret: number } {
  const hold = (n: number): number => Math.min(value.length, Math.max(0, n));
  const from = Math.min(hold(start), hold(end));
  const to = Math.max(hold(start), hold(end));
  return { value: value.slice(0, from) + text + value.slice(to), caret: from + text.length };
}
