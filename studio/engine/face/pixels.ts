/**
 * 8-bit interleaved pixels in OpenCV's channel order (B, G, R), row-major, no
 * padding — the same convention `spike/face-js/lib/decode.ts`'s `BgrImage`
 * uses, so `yunet.ts`/`sface.ts` below are an unmodified port of the spike's
 * detection and alignment math.
 */
export interface BgrImage {
  width: number;
  height: number;
  data: Uint8Array;
}

/**
 * Decoded pixels crossing into this module, tagged with their real byte
 * order. Review fix (2c): an untagged buffer let a caller silently feed
 * BGRA where RGBA was assumed (or the reverse) with no type error — the two
 * real decoders Chromium can give T6 disagree: `nativeImage.toBitmap()`
 * (main process) is BGRA, a renderer's `createImageBitmap` +
 * `CanvasRenderingContext2D.getImageData` is RGBA. The tag makes the caller
 * say which, and `toBgrImage` refuses anything else rather than guessing.
 */
export type PixelFormat = "rgba" | "bgra";
export interface TaggedPixels {
  format: PixelFormat;
  width: number;
  height: number;
  data: Uint8Array;
}

/**
 * Converts tagged pixels to the interleaved BGR the ported detector and
 * recognizer expect. Alpha is dropped either way: OpenCV never sees it
 * (`cv2.imread` decodes straight to BGR). `bgra` only drops the alpha byte
 * (its channel order already matches); `rgba` also swaps R and B.
 */
export function toBgrImage(pixels: TaggedPixels): BgrImage {
  const { format, width, height, data } = pixels;
  const expected = width * height * 4;
  if (data.length !== expected) {
    throw new Error(`face/pixels: expected ${expected} bytes for a ${width}x${height} ${format} buffer, got ${data.length}`);
  }
  const out = new Uint8Array(width * height * 3);
  if (format === "rgba") {
    for (let i = 0, o = 0; o < out.length; i += 4, o += 3) {
      out[o] = data[i + 2] ?? 0;
      out[o + 1] = data[i + 1] ?? 0;
      out[o + 2] = data[i] ?? 0;
    }
  } else if (format === "bgra") {
    for (let i = 0, o = 0; o < out.length; i += 4, o += 3) {
      out[o] = data[i] ?? 0;
      out[o + 1] = data[i + 1] ?? 0;
      out[o + 2] = data[i + 2] ?? 0;
    }
  } else {
    throw new Error(`face/pixels: unrecognized pixel format "${String(format)}"`);
  }
  return { width, height, data: out };
}
