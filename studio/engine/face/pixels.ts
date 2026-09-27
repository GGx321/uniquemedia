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
 * Converts the engine's own input contract — decoded pixels as RGBA,
 * whatever produced them (`nativeImage.toBitmap()` is BGRA and needs a
 * caller-side swap first; a renderer's `createImageBitmap` +
 * `CanvasRenderingContext2D.getImageData` is RGBA already) — to the
 * interleaved BGR the ported detector/recognizer expect. Alpha is dropped:
 * OpenCV never sees it either (`cv2.imread` decodes to BGR).
 */
export function rgbaToBgr(width: number, height: number, rgba: Uint8Array): BgrImage {
  const expected = width * height * 4;
  if (rgba.length !== expected) {
    throw new Error(`face/pixels: expected ${expected} bytes for a ${width}x${height} RGBA buffer, got ${rgba.length}`);
  }
  const data = new Uint8Array(width * height * 3);
  for (let i = 0, o = 0; o < data.length; i += 4, o += 3) {
    data[o] = rgba[i + 2] ?? 0;
    data[o + 1] = rgba[i + 1] ?? 0;
    data[o + 2] = rgba[i] ?? 0;
  }
  return { width, height, data };
}
