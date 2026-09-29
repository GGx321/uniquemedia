/** A face box in pixels of one image: the top-left corner and the size. */
export interface FaceBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ImageSize {
  width: number;
  height: number;
}

/**
 * S8 (focus): the largest face among YuNet's rows (its layout: x, y, w, h, ...),
 * mapped from the image detection ran on to the SOURCE image.
 *
 * Detection runs on a copy normalised to at most 1280 px on the long side
 * (normalize.ts), so a box is scaled back by the ratio of the two sizes, per
 * axis (the normalised size is rounded, so the two ratios differ slightly).
 * The largest by area wins, and a tie keeps the earlier row (YuNet's NMS order
 * is score descending). A row that is not finite or has no area is not a face.
 * The box is NOT clamped: YuNet boxes may reach past the edge, and the caller
 * clamps the point it derives.
 */
export function largestFaceInSource(rows: readonly Float32Array[], detectedOn: ImageSize, source: ImageSize): FaceBox | null {
  let best: FaceBox | null = null;
  for (const row of rows) {
    const box = { x: row[0] ?? Number.NaN, y: row[1] ?? Number.NaN, width: row[2] ?? Number.NaN, height: row[3] ?? Number.NaN };
    if (![box.x, box.y, box.width, box.height].every(Number.isFinite) || box.width <= 0 || box.height <= 0) continue;
    if (best === null || box.width * box.height > best.width * best.height) best = box;
  }
  if (best === null) return null;
  const sx = source.width / detectedOn.width;
  const sy = source.height / detectedOn.height;
  return { x: best.x * sx, y: best.y * sy, width: best.width * sx, height: best.height * sy };
}
