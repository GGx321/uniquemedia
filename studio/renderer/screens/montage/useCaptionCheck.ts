import type { TextLayer } from "../../../shared/engine";
import { type CaptionCheck, captionCheckOf } from "./captionCheck";
import { useLayerPreview } from "./textPreviews";

/**
 * The engine's verdict on a text layer's caption (3d.5): `montages.textPreview` is asked again whenever what decides the picture
 * changes (the caption, the font, the style, the colour, the size), on every keystroke. 3d.4: the ask is the window's one per-layer
 * queue (textPreviews.tsx), shared with the preview, so the panel and the preview never supersede each other's asks and the panel
 * is never left waiting for an answer nobody draws.
 */
export function useCaptionCheck(layer: TextLayer): CaptionCheck {
  return captionCheckOf(useLayerPreview(layer));
}
