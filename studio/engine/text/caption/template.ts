import type { TextStyle } from "../../../shared/engine/montage";
import { FRAME_W } from "../../../shared/montage";
import { TEXT_FONTS, type TextFontKey } from "../fonts";
import type { VerticalMetrics } from "../sfnt";
import { EMOJI_HEIGHT_EM, type CaptionLayout } from "../../../shared/text/layout";

/**
 * The fixed SVG template (plan invariant 17): the ONLY place caption text meets markup.
 *
 * - The caption enters only as XML-escaped character data, one `<text>` per run of text, `xml:space="preserve"`. It
 *   never becomes an attribute, an element or a URL. A control character or a lone surrogate is refused here rather than
 *   left for resvg to throw on.
 * - The only `href`s are `data:image/png;base64,` URIs built from the bundled emoji font (each emitted once in
 *   `<defs><image id="eN"/>`, every use a `<use href="#eN"/>` the engine wrote itself) and those `#eN` references.
 *   resvg 2.6.2 resolves nothing else, and there is no resources directory.
 * - Colours are validated as lowercase `#rrggbb` before they are written; the font family and weight come from the
 *   manifest; every number is written to two decimals, so the same layout is the same text on every platform.
 * - Any change here moves the caption fingerprint (`fingerprint.ts`): that is the point of pinning it.
 *
 * The three styles follow the owner's mockups (EditorText.dc.html, `styleCss`, converted from the 306 px preview at a
 * font size of 84 px on the 1080 frame to ems):
 * - «Плашка»: a rounded plaque painted with `color`, the text #111111 or #ffffff, whichever contrasts more (the owner's
 *   Q2, Instagram-like). Padding 0.5 em across, 0.13 em above and 0.21 em below; radius 0.3 em (the mockup's 7 px, 25 px on 1080).
 * - «Обводка»: the text in `color` with a 0.125 em stroke (the mockup's eight 1.5 px text shadows), black, or white under a
 *   dark colour.
 * - «Без фона»: the text in `color` over a soft shadow. The dark one (0.55 black) is the mockup's 12 px of blur (sigma 0.25 em)
 *   at 2 px down, with sigma cut to 0.2 em and 0.084 em down so three sigma of blur plus the widest legal text (929 px at 112 px)
 *   still fits the 1080 frame. Under a dark colour it is the mockup's own light one: 0.5 white, 8 px of blur, 1 px down
 *   (sigma 0.168 em, 0.042 em down).
 *
 * The box is sized by INK on each side, not by advance: a glyph that sticks out past its advance (Caveat's bracket by 0.3 em, its
 * f and j) plus what the style draws beyond the ink (half the stroke and a pixel, three sigma of blur) must fit inside it, or the
 * edge would cut it in a hard vertical line. The frame caps the box; past the cap it is a shadow's far tail that is cut.
 */

/**
 * Where the emoji's baseline cuts it: the picture's top is this fraction of its height above the baseline. SP2's first guess;
 * PROVISIONAL until the owner's design review, like `EMOJI_HEIGHT_EM`.
 */
export const EMOJI_BASELINE = 0.82;

/** The stroke of «Обводка», in ems (the sum of the mockup's two 1.5 px sides). */
const OUTLINE_EM = 0.125;
const SHADOW_SIGMA_EM = 0.2;
const SHADOW_DY_EM = 0.084;
const SHADOW_OPACITY = 0.55;
const SHADOW_OPACITY_ON_DARK = 0.5;
/** The light shadow under a dark text colour is the mockup's own: `0 1px 8px` on the 84 px preview, sigma 4 px = 0.168 em, 0.042 em down. It is the smaller of the two, so the box's room for the dark one covers it. */
const SHADOW_SIGMA_ON_DARK_EM = 0.168;
const SHADOW_DY_ON_DARK_EM = 0.042;
const PLAQUE_RADIUS_EM = 0.3;

/** Each style's padding around the text, in ems: across, above and below. */
const PADDING_EM: Record<TextStyle, { x: number; top: number; bottom: number }> = {
  plaque: { x: 0.5, top: 0.13, bottom: 0.21 },
  outline: { x: 0.25, top: 0.15, bottom: 0.15 },
  // Three sigma of blur on every side; the offset moves the shadow down, so the room above shrinks by it and below grows by it.
  none: { x: 3 * SHADOW_SIGMA_EM, top: 3 * SHADOW_SIGMA_EM - SHADOW_DY_EM, bottom: 3 * SHADOW_SIGMA_EM + SHADOW_DY_EM },
};

/** How far past the ink each style draws on the sides: the stroke's outer half plus a pixel of antialiasing, three sigma of blur, nothing. */
const REACH: Record<TextStyle, { em: number; px: number }> = {
  plaque: { em: 0, px: 0 },
  outline: { em: OUTLINE_EM / 2, px: 1 },
  none: { em: 3 * SHADOW_SIGMA_EM, px: 0 },
};

/** The mockups' `letter-spacing` per font, in ems. */
const LETTER_SPACING_EM: Record<TextFontKey, number> = { manrope: -0.02, playfair: 0, oswald: 0.01, ptmono: 0, caveat: 0 };

/** The size of the throwaway canvas a run is measured on: resvg measures the tree, not the canvas. */
const MEASURE_CANVAS_PX = 8;
const REFERENCE_PX = 100;

const HEX_COLOR = /^#[0-9a-f]{6}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const FORBIDDEN = /[\u0000-\u001F\u007F-\u009F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export class CaptionTemplateError extends Error {
  constructor(why: string) {
    super(why);
    this.name = "CaptionTemplateError";
  }
}

/** One emoji bitmap: `key` tells two uses of the same glyph apart from two glyphs, `base64` is its PNG. */
export interface EmojiImage {
  key: number;
  base64: string;
}

export interface TemplateInput {
  layout: CaptionLayout;
  font: TextFontKey;
  style: TextStyle;
  /** Lowercase `#rrggbb`: the plaque for «Плашка», the text otherwise. */
  color: string;
  metrics: VerticalMetrics;
  /** The bitmap an emoji cluster is drawn from. */
  emoji: (codePoints: readonly number[]) => EmojiImage;
}

export interface CaptionSvg {
  svg: string;
  /** The box in whole pixels. */
  width: number;
  height: number;
}

/** Text as XML character data. Refuses what XML 1.0 cannot carry instead of letting resvg throw on it. */
export function escapeXml(text: string): string {
  if (FORBIDDEN.test(text)) throw new CaptionTemplateError("the text holds a control character or a lone surrogate");
  return text.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&apos;";
    }
  });
}

function linear(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((at) => linear(Number.parseInt(hex.slice(at, at + 2), 16)));
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

function contrast(a: number, b: number): number {
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const INK_DARK = "#111111";
const INK_LIGHT = "#ffffff";
const INK_DARK_LUMINANCE = luminance(INK_DARK);

/** The text colour on a plaque of `color`: #111111 or #ffffff, whichever the WCAG contrast ratio prefers (a tie goes to #111111). */
export function inkFor(color: string): typeof INK_DARK | typeof INK_LIGHT {
  const l = luminance(color);
  return contrast(l, INK_DARK_LUMINANCE) >= contrast(l, 1) ? INK_DARK : INK_LIGHT;
}

function checkColor(color: string): string {
  if (!HEX_COLOR.test(color)) throw new CaptionTemplateError("a colour must be lowercase #rrggbb");
  return color;
}

const px = (value: number): string => value.toFixed(2);

function textAttributes(font: TextFontKey, fontSize: string, letterSpacing: string): string {
  const spec = TEXT_FONTS[font];
  return `font-family="${escapeXml(spec.family)}" font-weight="${spec.weight}" font-size="${fontSize}"${letterSpacing === "" ? "" : ` letter-spacing="${letterSpacing}"`}`;
}

/**
 * The tiny SVG resvg's `getBBox()` measures a run on: the run at 100 px between two bars (so leading and trailing spaces
 * count and a side bearing does not), on an 8 px canvas (resvg measures the tree, not the canvas, and a big canvas
 * would fall foul of the pixel cap). A run's advance is the width of this minus the width of `measureSvg(font, "")`.
 */
export function measureSvg(font: TextFontKey, run: string): string {
  const spacing = LETTER_SPACING_EM[font] === 0 ? "" : String(Number((LETTER_SPACING_EM[font] * REFERENCE_PX).toFixed(2)));
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${MEASURE_CANVAS_PX}" height="${MEASURE_CANVAS_PX}">` +
    `<text x="0" y="0" ${textAttributes(font, String(REFERENCE_PX), spacing)} xml:space="preserve">|${escapeXml(run)}|</text></svg>`
  );
}

/** Where `inkSvg` puts a run: far enough right of 0 that ink before the origin is still measured. */
export const INK_ORIGIN_PX = 200;

/**
 * The SVG resvg's `getBBox()` measures the INK of a run on: the run alone at 100 px, at x = 200, with no bars. Its box, against the
 * run's advance, says how far the ink sticks out before its start and after its end.
 */
export function inkSvg(font: TextFontKey, run: string): string {
  const spacing = LETTER_SPACING_EM[font] === 0 ? "" : String(Number((LETTER_SPACING_EM[font] * REFERENCE_PX).toFixed(2)));
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${MEASURE_CANVAS_PX}" height="${MEASURE_CANVAS_PX}">` +
    `<text x="${INK_ORIGIN_PX}" y="0" ${textAttributes(font, String(REFERENCE_PX), spacing)} xml:space="preserve">${escapeXml(run)}</text></svg>`
  );
}

interface DefinedEmoji {
  id: string;
  width: number;
}

/** The caption as an SVG in its box. Throws `CaptionTemplateError` for anything it will not write. */
export function buildCaptionSvg(input: TemplateInput): CaptionSvg {
  const { layout, font, style, metrics } = input;
  const color = checkColor(input.color);
  const size = layout.fontSize;
  const pad = PADDING_EM[style];
  // The box is sized by INK on each side: a glyph that sticks out past its advance (Caveat's bracket, its f and j) plus what the
  // style itself draws beyond the ink must fit, whatever the style's padding is. The frame caps it: past it the tail of a
  // shadow is what is cut, never the ink.
  const reach = REACH[style];
  const room = Math.max(pad.x * size, (FRAME_W - layout.textWidth) / 2);
  const sideOf = (ink: number): number => Math.max(pad.x * size, Math.min(ink + reach.em * size + reach.px, room));
  const padLeft = sideOf(Math.max(0, ...layout.lines.map((line) => line.inkLeft)));
  const padRight = sideOf(Math.max(0, ...layout.lines.map((line) => line.inkRight)));
  const width = Math.ceil(padLeft + layout.textWidth + padRight);
  const height = Math.ceil(layout.lineHeight * layout.lines.length + (pad.top + pad.bottom) * size);
  if (width > FRAME_W) throw new CaptionTemplateError(`the box would be ${width} px wide, over the ${FRAME_W} px frame`);

  const dark = inkFor(color) === INK_LIGHT;
  const spacing = LETTER_SPACING_EM[font] === 0 ? "" : px(LETTER_SPACING_EM[font] * size);
  const ascent = (metrics.ascender / metrics.unitsPerEm) * size;
  const descent = (-metrics.descender / metrics.unitsPerEm) * size;
  const fill = style === "plaque" ? inkFor(color) : color;
  const outline = style === "outline" ? ` stroke="${dark ? INK_LIGHT : "#000000"}" stroke-width="${px(OUTLINE_EM * size)}" stroke-linejoin="round" paint-order="stroke fill"` : "";
  const textHead = `${textAttributes(font, px(size), spacing)} fill="${fill}"${outline}`;

  const emojiHeight = EMOJI_HEIGHT_EM * size;
  const defined = new Map<number, DefinedEmoji>();
  const images: string[] = [];
  let body = "";
  layout.lines.forEach((line, row) => {
    const baseline = pad.top * size + row * layout.lineHeight + (layout.lineHeight - (ascent + descent)) / 2 + ascent;
    const left = padLeft + (layout.textWidth - line.width) / 2;
    for (const item of line.items) {
      const x = px(left + item.x);
      if (item.kind === "text") {
        body += `<text x="${x}" y="${px(baseline)}" ${textHead} xml:space="preserve">${escapeXml(item.text)}</text>`;
        continue;
      }
      const image = input.emoji(item.codePoints);
      if (!BASE64.test(image.base64)) throw new CaptionTemplateError("an emoji bitmap is not base64");
      let entry = defined.get(image.key);
      if (entry === undefined) {
        entry = { id: `e${defined.size}`, width: item.width };
        defined.set(image.key, entry);
        images.push(`<image id="${entry.id}" width="${px(item.width)}" height="${px(emojiHeight)}" href="data:image/png;base64,${image.base64}"/>`);
      }
      body += `<use href="#${entry.id}" x="${x}" y="${px(baseline - EMOJI_BASELINE * emojiHeight)}"/>`;
    }
  });

  let defs = images.join("");
  let inner = body;
  if (style === "plaque") {
    const radius = Math.min(PLAQUE_RADIUS_EM * size, height / 2);
    inner = `<rect width="${width}" height="${height}" rx="${px(radius)}" fill="${color}"/>${body}`;
  } else if (style === "none") {
    const shadow = dark
      ? { color: INK_LIGHT, opacity: SHADOW_OPACITY_ON_DARK, sigma: SHADOW_SIGMA_ON_DARK_EM, dy: SHADOW_DY_ON_DARK_EM }
      : { color: "#000000", opacity: SHADOW_OPACITY, sigma: SHADOW_SIGMA_EM, dy: SHADOW_DY_EM };
    defs +=
      `<filter id="s" filterUnits="userSpaceOnUse" x="0" y="0" width="${width}" height="${height}">` +
      `<feGaussianBlur in="SourceAlpha" stdDeviation="${px(shadow.sigma * size)}"/>` +
      `<feOffset dx="0" dy="${px(shadow.dy * size)}" result="b"/>` +
      `<feFlood flood-color="${shadow.color}" flood-opacity="${shadow.opacity}"/>` +
      `<feComposite in2="b" operator="in"/>` +
      `<feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter>`;
    inner = `<g filter="url(#s)">${body}</g>`;
  }
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` + (defs === "" ? "" : `<defs>${defs}</defs>`) + `${inner}</svg>`;
  return { svg, width, height };
}
