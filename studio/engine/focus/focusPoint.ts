import type { Focus } from "../../shared/engine/montage";
import type { FaceBox, ImageSize } from "../face/largestFace";

/**
 * S8: the crop's focus for a detected face — the CENTRE OF THE YUNET BOX, as
 * fractions of the source image, clamped into 0..1.
 *
 * Why the box centre and not the eyes line. `coverCrop` centres the crop on the
 * focus, so the focus lands in the middle of the cell. YuNet's box runs from the
 * brow to the chin; measured on the five committed face fixtures the eyes sit
 * 7 to 14 percent of the box height ABOVE its centre. Centring on the box centre
 * therefore leaves the eyes a little above the middle of the cell (the usual
 * placement, and it keeps the chin and neck), where centring on the eyes would
 * clip them. The box is also the steadier signal: landmarks wander on a turned
 * or tilted head. And it keeps the wire protocol to one small box.
 *
 * (The fallback for a photo with no face is (0.5, 0.38), roughly where the
 * fixtures' box centres sit: 0.31 to 0.49 of the height, median 0.41.)
 */
export function focusFromFace(face: FaceBox, source: ImageSize): Focus {
  // Four decimals is a tenth of a pixel on a 1000 px axis: more digits only bloat the stored file.
  const unit = (v: number): number => Math.round(Math.min(1, Math.max(0, v)) * 10_000) / 10_000;
  return { x: unit((face.x + face.width / 2) / source.width), y: unit((face.y + face.height / 2) / source.height) };
}
