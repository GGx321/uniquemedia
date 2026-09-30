import { captionIssue } from "../captionRules";
import type { EmojiFont } from "../emoji/emojiFont";
import type { TextFontKey } from "../fonts";
import type { TextRasteriser } from "../rasteriser";
import { RasterError } from "../rasterTypes";
import { CaptionLayoutError, layoutCaption } from "./layout";
import { buildCaptionSvg, CaptionTemplateError, INK_ORIGIN_PX, inkSvg, measureSvg } from "./template";
import type { CaptionImage, CaptionRequest } from "./types";

/**
 * A caption from its layer to a PNG (plan 3b.4b): the caption rules, the layout, the fixed SVG template and resvg, in
 * that order, in whichever thread owns the rasteriser (the text worker; tests run it in-process). Nothing here draws a
 * fallback: a rule broken is `CAPTION_INVALID`, and every other failure is a `RasterError` of the rasteriser's own or
 * `RENDER_FAILED`.
 *
 * Three caches keep a keystroke's re-render cheap and all are bounded: the advance of each text run at 100 px (per font), how
 * far its ink sticks out past that advance (the box is sized by ink), and each emoji bitmap's base64 and aspect (per glyph id).
 */

export type { CaptionImage, CaptionRequest, ResolvedCaptionLayout } from "./types";

export interface CaptionRenderer {
  /** Rejects with a `RasterError`; a caption rule broken is `CAPTION_INVALID` with the rule. */
  render(request: CaptionRequest): Promise<CaptionImage>;
}

export interface CaptionRendererDeps {
  rasteriser: TextRasteriser;
  emoji: EmojiFont;
}

/** Entries a cache may hold before it starts over: far above what one owner's captions use, and a hard cap on memory. */
const MAX_WIDTHS = 20_000;
const MAX_EMOJI = 512;

interface EmojiEntry {
  base64: string;
  aspect: number;
}

export function createCaptionRenderer(deps: CaptionRendererDeps): CaptionRenderer {
  const { rasteriser, emoji } = deps;
  const widths = new Map<string, number>();
  const overhangs = new Map<string, { left: number; right: number }>();
  const bitmaps = new Map<number, EmojiEntry>();

  function inkWidth(font: TextFontKey, svg: string): number {
    const box = rasteriser.measure({ svg, font });
    if (box === null) throw new RasterError("RENDER_FAILED", "resvg measured a text run as empty");
    return box.width;
  }

  /** The advance of a run at 100 px: the ink of `|run|` less the ink of `||`, so a space at either end counts. */
  function advance(font: TextFontKey, run: string): number {
    const key = `advance\u0000${font}\u0000${run}`;
    const known = widths.get(key);
    if (known !== undefined) return known;
    const bars = cachedBars(font);
    const width = inkWidth(font, measureSvg(font, run)) - bars;
    remember(key, width);
    return width;
  }

  function cachedBars(font: TextFontKey): number {
    const key = `bars\u0000${font}`;
    const known = widths.get(key);
    if (known !== undefined) return known;
    const bars = inkWidth(font, measureSvg(font, ""));
    remember(key, bars);
    return bars;
  }

  /** How far the ink of a run sticks out before its start and past its end at 100 px: its ink box against its advance. */
  function overhang(font: TextFontKey, run: string): { left: number; right: number } {
    const key = `ink\u0000${font}\u0000${run}`;
    const known = overhangs.get(key);
    if (known !== undefined) return known;
    const box = rasteriser.measure({ svg: inkSvg(font, run), font });
    const answer = box === null ? { left: 0, right: 0 } : { left: INK_ORIGIN_PX - box.x, right: box.x + box.width - INK_ORIGIN_PX - advance(font, run) };
    if (overhangs.size >= MAX_WIDTHS) overhangs.clear();
    overhangs.set(key, answer);
    return answer;
  }

  function remember(key: string, width: number): void {
    if (widths.size >= MAX_WIDTHS) widths.clear();
    widths.set(key, width);
  }

  function emojiEntry(codePoints: readonly number[]): { key: number; entry: EmojiEntry } {
    const key = emoji.glyphId(codePoints);
    if (key === null) throw new RasterError("RENDER_FAILED", "the emoji font has no bitmap for a cluster the caption rules accepted");
    const known = bitmaps.get(key);
    if (known !== undefined) return { key, entry: known };
    const bitmap = emoji.bitmap(codePoints);
    if (bitmap === null) throw new RasterError("RENDER_FAILED", "the emoji font has no bitmap for a cluster the caption rules accepted");
    const entry = { base64: Buffer.from(bitmap.png).toString("base64"), aspect: bitmap.width / bitmap.height };
    if (bitmaps.size >= MAX_EMOJI) bitmaps.clear();
    bitmaps.set(key, entry);
    return { key, entry };
  }

  return {
    async render(request) {
      await rasteriser.init();
      const issue = captionIssue(request.value, { hasEmoji: (codePoints) => emoji.has(codePoints) });
      if (issue !== null) throw new RasterError("CAPTION_INVALID", `the caption breaks the rule "${issue}"`, { captionIssue: issue });
      try {
        const layout = layoutCaption({
          text: request.value,
          scale: request.scale,
          measure: (run) => advance(request.font, run),
          emojiAspect: (codePoints) => emojiEntry(codePoints).entry.aspect,
          inkOverhang: (run) => overhang(request.font, run),
        });
        const box = buildCaptionSvg({
          layout,
          font: request.font,
          style: request.style,
          color: request.color,
          metrics: rasteriser.verticalMetrics(request.font),
          emoji: (codePoints) => {
            const { key, entry } = emojiEntry(codePoints);
            return { key, base64: entry.base64 };
          },
        });
        const image = await rasteriser.render({ svg: box.svg, font: request.font });
        if (image.width !== box.width || image.height !== box.height) {
          throw new RasterError("RENDER_FAILED", `resvg drew ${image.width}x${image.height}, not the ${box.width}x${box.height} the layout asked for`);
        }
        return { png: image.png, width: box.width, height: box.height, layout: { fontSize: layout.fontSize, lines: layout.lines.map((line) => line.text), width: box.width, height: box.height } };
      } catch (error) {
        if (error instanceof CaptionLayoutError || error instanceof CaptionTemplateError) throw new RasterError("RENDER_FAILED", error.message, { cause: error });
        throw error;
      }
    },
  };
}
