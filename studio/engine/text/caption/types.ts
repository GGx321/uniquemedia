import type { TextStyle } from "../../../shared/engine/montage";
import type { TextFontKey } from "../fonts";

// What a caption call takes and gives, with no rasteriser in it: the engine side (the worker gate, the preview service)
// imports these, and only the worker thread imports the renderer that produces them.

/** A text layer's drawing fields. */
export interface CaptionRequest {
  value: string;
  font: TextFontKey;
  style: TextStyle;
  /** Lowercase `#rrggbb`; what it paints depends on the style. */
  color: string;
  /** 0.5 to 2. */
  scale: number;
}

/** What is stored as the layer's resolved layout: the size the text was drawn at, what each line says, and the picture's box. */
export interface ResolvedCaptionLayout {
  fontSize: number;
  lines: string[];
  width: number;
  height: number;
}

export interface CaptionImage {
  png: Uint8Array;
  width: number;
  height: number;
  layout: ResolvedCaptionLayout;
}
