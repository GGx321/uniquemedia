import { FRAGMENTS } from "../filters";
import { EXPORT_DIMS, type MediaInfo } from "../types";
import type { PhotoRecipe, Subsampling } from "./types";

const PIX_FMT: Record<Subsampling, string> = {
  "420": "yuvj420p",
  "444": "yuvj444p",
};

/** Extra margin on top of the geometric bound. The bound is exact in theory but
 *  integer rounding and interpolation can still leave a soft pixel at the edge;
 *  measured worst gap was 0.0023, so 0.005 is ~2x headroom. */
const COVER_MARGIN = 0.995;

/** Ops that can leave the frame a different size, or leave uncovered edges. */
const SIZE_CHANGING = new Set(["pancrop", "rotate", "lenscorrection"]);

function numericParam(recipe: PhotoRecipe, id: string, key: string): number {
  const value = recipe.ops.find((o) => o.id === id)?.params[key];
  return typeof value === "number" ? value : 0;
}

/**
 * Largest centred same-aspect fraction that stays inside content distorted by
 * `lenscorrection` with k1 > 0.
 *
 * The equation solved here, `t + k1*t^3 = 1`, is deliberately stricter than the
 * geometry. ffmpeg normalises the radius against the frame's half-diagonal, so
 * the corner of the picture sits at r = 0.5, not r = 1, and a source point
 * lands at r*(1 + k1*r^2) — making the exact corner equation
 * `t + 0.25*k1*t^3 = 1`. Solving without that quarter yields a slightly smaller
 * t, i.e. a crop about 1% tighter than strictly needed (2.7% at the k1 ceiling).
 *
 * That slack is kept, not fixed: the bound is exact only in continuous
 * geometry, while the real chain rounds to integer pixels and interpolates, and
 * erring inward costs a sliver of picture whereas erring outward puts a black
 * wedge in the corner. `filterGraph.test.ts` pins the direction of the error.
 */
function lensCover(k1: number): number {
  if (k1 <= 0) return 1;
  let lo = 0.5;
  let hi = 1;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (mid + k1 * mid ** 3 > 1) hi = mid;
    else lo = mid;
  }
  return lo;
}

/** Rotation expands the canvas (`ow=rotw`) and positive lens distortion samples
 *  past the source edge — both leave black wedges the eye reads instantly. The
 *  video path hides them behind its export over-zoom; a photo keeping its native
 *  size has no such cover, so the chain crops the largest rectangle guaranteed to
 *  be real content and scales it back. Returns 1 when nothing needs covering. */
function geometryCover(recipe: PhotoRecipe, info: MediaInfo): number {
  const deg = Math.abs(numericParam(recipe, "rotate", "deg"));
  const k1 = numericParam(recipe, "lenscorrection", "k1");
  if (deg === 0 && k1 <= 0) return 1;
  const a = (deg * Math.PI) / 180;
  const { width: w, height: h } = info;
  const rotated = Math.min(
    w / (w * Math.cos(a) + h * Math.sin(a)),
    h / (w * Math.sin(a) + h * Math.cos(a))
  );
  return rotated * lensCover(k1) * COVER_MARGIN;
}

/** Spatial chain for a still: recipe ops in order, the geometry cover, then the
 *  export framing. Mirrors the video spatial chain, minus everything temporal. */
function chain(recipe: PhotoRecipe, info: MediaInfo): string {
  const parts: string[] = [];
  let afterGeometry = 0;
  for (const op of recipe.ops) {
    const frag = FRAGMENTS[op.id]?.(op.params, info);
    if (!frag) continue;
    parts.push(frag);
    if (SIZE_CHANGING.has(op.id)) afterGeometry = parts.length;
  }
  const cover = geometryCover(recipe, info);
  if (cover < 1) {
    // Closes the geometry section rather than trailing the chain: everything
    // downstream (the vignette's pad/crop, the export framing) assumes the frame
    // is back at its nominal size.
    parts.splice(
      afterGeometry,
      0,
      `crop=${Math.round(info.width * cover)}:${Math.round(info.height * cover)},` +
        `scale=${info.width}:${info.height}`
    );
  }
  if (recipe.exportFormat !== "original") {
    const { w, h } = EXPORT_DIMS[recipe.exportFormat];
    parts.push(`scale=${w}:${h}:force_original_aspect_ratio=increase`);
    parts.push(`crop=${w}:${h}`);
  } else {
    // Keep native size but force even dimensions — a source can be odd
    // (e.g. 1081x1351) and chroma-subsampled JPEG wants both even.
    parts.push("crop=trunc(iw/2)*2:trunc(ih/2)*2");
  }
  parts.push("setsar=1");
  return parts.join(",");
}

export function buildPhotoArgs(recipe: PhotoRecipe, info: MediaInfo): string[] {
  return [
    "-vf",
    chain(recipe, info),
    "-q:v",
    String(recipe.encode.quality),
    "-pix_fmt",
    PIX_FMT[recipe.encode.subsampling],
    "-map_metadata",
    "-1",
  ];
}
