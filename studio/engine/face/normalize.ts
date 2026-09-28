import type { TaggedPixels } from "./pixels";

/**
 * Re-review, MUST FIX 1: the face pipeline fed YuNet the image at whatever
 * resolution the source happened to be, with no normalization to the
 * geometry the owner's calibration (0.55/0.66/0.70, spike/face-js/README.md)
 * was measured at. Measured directly (the reviewer's own sweep, confirmed
 * here): a 422 px face scores 0.885, 504 px 0.758, ~630 px is not detected
 * at all — detection fails on LARGE faces, not just small ones, because
 * YuNet's own anchor sizes assume a face that fits the geometry it was
 * calibrated against. A real phone photo (3024x4032, 12 MP) or a 2K close-up
 * render both produce faces well past that size.
 *
 * Fix: every image entering the face pipeline (the master, in `prepare()`,
 * and every candidate, in `check()`) is downscaled so its long side is at
 * most `FACE_PIPELINE_MAX_SIDE` before detection/alignment/embedding —
 * never upscaled. A strict no-op at or below the cap (the exact same object
 * returned, not a copy) — every calibrated size (1K renders 720x1280,
 * generated masters 864x1152) never enters the resize path at all, so
 * parity.test.ts's byte-exact assertions are untouched.
 *
 * Box/area-average downscale, never nearest-neighbour or bilinear: this is
 * OpenCV's own documented recommendation for shrinking (`INTER_AREA`) —
 * averaging every source pixel into its one destination pixel avoids the
 * aliasing nearest-neighbour would introduce (dropping most of a large
 * photo's real detail on the floor, at exactly the fine-grained facial
 * features YuNet/SFace read) and needs no separate kernel tuning bilinear's
 * own quality depends on. It is also the simplest correct choice: every
 * source pixel is visited exactly once (no dependency other than
 * `TaggedPixels` itself), so it stays pure TypeScript, deterministic across
 * platforms, and does not reopen the "which decoder" question this task's
 * own security review just closed.
 */
export const FACE_PIPELINE_MAX_SIDE = 1280;

function boxDownscale(src: Uint8Array, sw: number, sh: number, dw: number, dh: number): Uint8Array {
  const dst = new Uint8Array(dw * dh * 4);
  for (let oy = 0; oy < dh; oy++) {
    const sy0 = Math.floor((oy * sh) / dh);
    const sy1 = Math.max(sy0 + 1, Math.floor(((oy + 1) * sh) / dh));
    for (let ox = 0; ox < dw; ox++) {
      const sx0 = Math.floor((ox * sw) / dw);
      const sx1 = Math.max(sx0 + 1, Math.floor(((ox + 1) * sw) / dw));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        let idx = (sy * sw + sx0) * 4;
        for (let sx = sx0; sx < sx1; sx++) {
          r += src[idx] ?? 0;
          g += src[idx + 1] ?? 0;
          b += src[idx + 2] ?? 0;
          a += src[idx + 3] ?? 0;
          idx += 4;
          n++;
        }
      }
      const o = (oy * dw + ox) * 4;
      dst[o] = Math.round(r / n);
      dst[o + 1] = Math.round(g / n);
      dst[o + 2] = Math.round(b / n);
      dst[o + 3] = Math.round(a / n);
    }
  }
  return dst;
}

/**
 * Normalizes `pixels` for the face pipeline: downscaled (area/box filter,
 * see this module's own header) so its long side is at most `maxSide`,
 * preserving aspect ratio (rounded, at least 1 px either side); the exact
 * same object, untouched, when already within bounds — never enlarged.
 */
export function normalizeForFacePipeline(pixels: TaggedPixels, maxSide: number = FACE_PIPELINE_MAX_SIDE): TaggedPixels {
  const longSide = Math.max(pixels.width, pixels.height);
  if (longSide <= maxSide) return pixels;
  const scale = maxSide / longSide;
  const width = Math.max(1, Math.round(pixels.width * scale));
  const height = Math.max(1, Math.round(pixels.height * scale));
  return { format: pixels.format, width, height, data: boxDownscale(pixels.data, pixels.width, pixels.height, width, height) };
}
