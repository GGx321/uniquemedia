import type { Orientation } from "./exif";

// Turning decoded pixels upright (Stage 3, 3f.2): the EXIF orientation applied AFTER decode (jsquash and ffmpeg ignore it for a still),
// and the alpha flattened onto black, in one pass that yields the 8-bit RGB the encoder takes. A source pixel (x, y) lands at
//   (a*x + b*y + c, d*x + e*y + f)
// in the result, whose width is the source's (orientations 1 to 4) or its height (5 to 8, the quarter turns).

interface Affine {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly e: number;
  readonly f: number;
  readonly swap: boolean;
}

function affineOf(orientation: Orientation, width: number, height: number): Affine {
  switch (orientation) {
    case 1:
      return { a: 1, b: 0, c: 0, d: 0, e: 1, f: 0, swap: false };
    case 2:
      return { a: -1, b: 0, c: width - 1, d: 0, e: 1, f: 0, swap: false };
    case 3:
      return { a: -1, b: 0, c: width - 1, d: 0, e: -1, f: height - 1, swap: false };
    case 4:
      return { a: 1, b: 0, c: 0, d: 0, e: -1, f: height - 1, swap: false };
    case 5:
      return { a: 0, b: 1, c: 0, d: 1, e: 0, f: 0, swap: true };
    case 6:
      return { a: 0, b: -1, c: height - 1, d: 1, e: 0, f: 0, swap: true };
    case 7:
      return { a: 0, b: -1, c: height - 1, d: -1, e: 0, f: width - 1, swap: true };
    case 8:
      return { a: 0, b: 1, c: 0, d: -1, e: 0, f: width - 1, swap: true };
  }
}

/** `rgba` (8-bit, `width` x `height`) turned by `orientation`, as 8-bit RGB with the alpha mixed with black. Throws a RangeError for a size that does not fit the bytes. */
export function orientedRgb(rgba: Uint8Array, width: number, height: number, orientation: Orientation): { rgb: Uint8Array; width: number; height: number } {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) throw new RangeError(`the size must be whole and positive, got ${width}x${height}`);
  if (rgba.length !== width * height * 4) throw new RangeError(`${rgba.length} bytes is not ${width}x${height} RGBA pixels`);
  const t = affineOf(orientation, width, height);
  const outWidth = t.swap ? height : width;
  const outHeight = t.swap ? width : height;
  const rgb = new Uint8Array(outWidth * outHeight * 3);
  // dest index = (d*x + e*y + f) * outWidth + a*x + b*y + c, which is linear in x and y.
  const stepX = t.d * outWidth + t.a;
  const stepY = t.e * outWidth + t.b;
  const base = t.f * outWidth + t.c;
  for (let y = 0; y < height; y++) {
    let src = y * width * 4;
    let dst = (base + y * stepY) * 3;
    const stride = stepX * 3;
    for (let x = 0; x < width; x++, src += 4, dst += stride) {
      const alpha = rgba[src + 3] ?? 0;
      if (alpha === 255) {
        rgb[dst] = rgba[src] ?? 0;
        rgb[dst + 1] = rgba[src + 1] ?? 0;
        rgb[dst + 2] = rgba[src + 2] ?? 0;
      } else {
        rgb[dst] = Math.round(((rgba[src] ?? 0) * alpha) / 255);
        rgb[dst + 1] = Math.round(((rgba[src + 1] ?? 0) * alpha) / 255);
        rgb[dst + 2] = Math.round(((rgba[src + 2] ?? 0) * alpha) / 255);
      }
    }
  }
  return { rgb, width: outWidth, height: outHeight };
}
