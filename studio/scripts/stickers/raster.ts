// A small software rasteriser for the generated stickers.
//
// Why not an SVG renderer: nothing in the repo rasterises SVG yet (the text
// rasteriser is still being written elsewhere) and ffmpeg's bundled build has
// no SVG decoder. The stickers are simple vector art, so shapes are described
// as polygons in a 0..100 design space and drawn here with exact horizontal
// coverage and 8 vertical sub-scanlines per pixel.
//
// Determinism: only + - * / sqrt, floor and round on IEEE doubles, which every
// JS engine computes identically. No Math.sin/cos/pow/exp (a libm can differ in
// the last place between platforms), so `sinTurns` is a polynomial.

export type Rgb = readonly [number, number, number];

export interface Pt {
  readonly x: number;
  readonly y: number;
}

export type Contour = readonly Pt[];

export type Paint =
  | { readonly kind: "solid"; readonly rgb: Rgb; readonly alpha?: number }
  | { readonly kind: "vertical"; readonly y0: number; readonly y1: number; readonly from: Rgb; readonly to: Rgb; readonly alpha?: number };

const TWO_PI = 6.283185307179586;
const SUBSCANLINES = 8;
/** How many pixels of colour are spread into fully transparent pixels around a shape. */
const BLEED_PASSES = 3;

/** sin(2*pi*t) for any finite `t`, from arithmetic alone. */
export function sinTurns(t: number): number {
  let u = t - Math.floor(t + 0.5);
  if (u > 0.25) u = 0.5 - u;
  else if (u < -0.25) u = -0.5 - u;
  const x = u * TWO_PI;
  const x2 = x * x;
  // Taylor series to x^13 on [-pi/2, pi/2]: the error stays below 1e-9.
  return x * (1 - (x2 / 6) * (1 - (x2 / 20) * (1 - (x2 / 42) * (1 - (x2 / 72) * (1 - (x2 / 110) * (1 - x2 / 156))))));
}

/** cos(2*pi*t), see `sinTurns`. */
export function cosTurns(t: number): number {
  return sinTurns(t + 0.25);
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const clampByte = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

interface Edge {
  readonly yMin: number;
  readonly yMax: number;
  readonly x0: number;
  readonly slope: number;
  readonly y0: number;
}

export class Raster {
  /** Premultiplied colour (0..255 scale) and alpha (0..1), 4 doubles per pixel. */
  private readonly px: Float64Array;
  private readonly layer: Float64Array;
  private readonly scratch: Float64Array;

  constructor(readonly size: number) {
    this.px = new Float64Array(size * size * 4);
    this.layer = new Float64Array(size * size);
    this.scratch = new Float64Array(size * size);
  }

  /** Fills the contours (even-odd) with `paint`. `softness`, in design units, blurs the edge. */
  fill(contours: readonly Contour[], paint: Paint, softness = 0): void {
    const k = this.size / 100;
    const edges: Edge[] = [];
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const contour of contours) {
      if (contour.length < 3) continue;
      for (let i = 0; i < contour.length; i++) {
        const a = contour[i];
        const b = contour[(i + 1) % contour.length];
        if (a === undefined || b === undefined) continue;
        const ax = a.x * k;
        const ay = a.y * k;
        const bx = b.x * k;
        const by = b.y * k;
        minX = Math.min(minX, ax);
        maxX = Math.max(maxX, ax);
        minY = Math.min(minY, ay);
        maxY = Math.max(maxY, ay);
        if (ay === by) continue;
        edges.push({ yMin: Math.min(ay, by), yMax: Math.max(ay, by), x0: ax, y0: ay, slope: (bx - ax) / (by - ay) });
      }
    }
    if (edges.length === 0) return;

    const radius = softness > 0 ? Math.max(1, Math.round((softness * k) / 2)) : 0;
    const pad = radius * 2 + 1;
    const x0 = Math.max(0, Math.floor(minX) - pad);
    const x1 = Math.min(this.size - 1, Math.floor(maxX) + pad);
    const y0 = Math.max(0, Math.floor(minY) - pad);
    const y1 = Math.min(this.size - 1, Math.floor(maxY) + pad);
    if (x0 > x1 || y0 > y1) return;

    const w = this.size;
    const layer = this.layer;
    for (let y = y0; y <= y1; y++) layer.fill(0, y * w + x0, y * w + x1 + 1);

    const weight = 1 / SUBSCANLINES;
    const xs: number[] = [];
    for (let y = Math.max(0, Math.floor(minY)); y <= Math.min(this.size - 1, Math.floor(maxY)); y++) {
      for (let s = 0; s < SUBSCANLINES; s++) {
        const sy = y + (s + 0.5) / SUBSCANLINES;
        xs.length = 0;
        for (const e of edges) if (sy >= e.yMin && sy < e.yMax) xs.push(e.x0 + (sy - e.y0) * e.slope);
        xs.sort((a, b) => a - b);
        for (let i = 0; i + 1 < xs.length; i += 2) {
          const xa = Math.max(0, Math.min(w, xs[i] ?? 0));
          const xb = Math.max(0, Math.min(w, xs[i + 1] ?? 0));
          if (xb <= xa) continue;
          const ia = Math.floor(xa);
          const ib = Math.floor(xb);
          const row = y * w;
          if (ia === ib) layer[row + ia] = (layer[row + ia] ?? 0) + (xb - xa) * weight;
          else {
            layer[row + ia] = (layer[row + ia] ?? 0) + (ia + 1 - xa) * weight;
            for (let x = ia + 1; x < ib; x++) layer[row + x] = (layer[row + x] ?? 0) + weight;
            if (ib < w) layer[row + ib] = (layer[row + ib] ?? 0) + (xb - ib) * weight;
          }
        }
      }
    }

    if (radius > 0) {
      this.boxBlur(x0, y0, x1, y1, radius);
      this.boxBlur(x0, y0, x1, y1, radius);
    }

    const baseAlpha = paint.alpha ?? 1;
    for (let y = y0; y <= y1; y++) {
      const t = paint.kind === "vertical" ? clamp01((((y + 0.5) / k) - paint.y0) / (paint.y1 - paint.y0)) : 0;
      const rgb: Rgb =
        paint.kind === "solid"
          ? paint.rgb
          : [
              paint.from[0] + (paint.to[0] - paint.from[0]) * t,
              paint.from[1] + (paint.to[1] - paint.from[1]) * t,
              paint.from[2] + (paint.to[2] - paint.from[2]) * t,
            ];
      for (let x = x0; x <= x1; x++) {
        const cov = layer[y * w + x] ?? 0;
        if (cov <= 0) continue;
        this.over(y * w + x, rgb, clamp01(cov) * baseAlpha);
      }
    }
  }

  /** A soft round blob: alpha `alpha` at the centre, easing to 0 at radius `r` (design units). */
  glow(cx: number, cy: number, r: number, rgb: Rgb, alpha: number): void {
    const k = this.size / 100;
    const pcx = cx * k;
    const pcy = cy * k;
    const pr = r * k;
    if (pr <= 0) return;
    const x0 = Math.max(0, Math.floor(pcx - pr));
    const x1 = Math.min(this.size - 1, Math.ceil(pcx + pr));
    const y0 = Math.max(0, Math.floor(pcy - pr));
    const y1 = Math.min(this.size - 1, Math.ceil(pcy + pr));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - pcx;
        const dy = y + 0.5 - pcy;
        const d = Math.sqrt(dx * dx + dy * dy) / pr;
        if (d >= 1) continue;
        const f = 1 - d;
        this.over(y * this.size + x, rgb, alpha * f * f * (3 - 2 * f));
      }
    }
  }

  private over(index: number, rgb: Rgb, a: number): void {
    if (a <= 0) return;
    const i = index * 4;
    const keep = 1 - a;
    this.px[i] = rgb[0] * a + (this.px[i] ?? 0) * keep;
    this.px[i + 1] = rgb[1] * a + (this.px[i + 1] ?? 0) * keep;
    this.px[i + 2] = rgb[2] * a + (this.px[i + 2] ?? 0) * keep;
    this.px[i + 3] = a + (this.px[i + 3] ?? 0) * keep;
  }

  /** One box-blur pass (horizontal then vertical) of `layer` inside the box; outside counts as 0. */
  private boxBlur(x0: number, y0: number, x1: number, y1: number, r: number): void {
    const w = this.size;
    const { layer, scratch } = this;
    const norm = 1 / (2 * r + 1);
    for (let y = y0; y <= y1; y++) {
      let sum = 0;
      for (let x = x0; x <= Math.min(x1, x0 + r - 1); x++) sum += layer[y * w + x] ?? 0;
      for (let x = x0; x <= x1; x++) {
        if (x + r <= x1) sum += layer[y * w + x + r] ?? 0;
        if (x - r - 1 >= x0) sum -= layer[y * w + x - r - 1] ?? 0;
        scratch[y * w + x] = sum * norm;
      }
    }
    for (let x = x0; x <= x1; x++) {
      let sum = 0;
      for (let y = y0; y <= Math.min(y1, y0 + r - 1); y++) sum += scratch[y * w + x] ?? 0;
      for (let y = y0; y <= y1; y++) {
        if (y + r <= y1) sum += scratch[(y + r) * w + x] ?? 0;
        if (y - r - 1 >= y0) sum -= scratch[(y - r - 1) * w + x] ?? 0;
        layer[y * w + x] = sum * norm;
      }
    }
  }

  /**
   * The frame as straight (non-premultiplied) RGBA. A pixel with no alpha at
   * all takes the colour of its nearest painted neighbours (up to a few pixels
   * out), so a scaler that blends the colour channels independently of alpha
   * shows no dark halo around the shape. Pixels farther out stay 0,0,0,0.
   */
  toRgba(): Uint8Array {
    const n = this.size * this.size;
    const out = new Uint8Array(n * 4);
    const straight = new Float64Array(n * 3);
    let known = new Uint8Array(n);
    for (let p = 0; p < n; p++) {
      const a = this.px[p * 4 + 3] ?? 0;
      if (a <= 0) continue;
      known[p] = 1;
      for (let c = 0; c < 3; c++) straight[p * 3 + c] = (this.px[p * 4 + c] ?? 0) / a;
      out[p * 4 + 3] = Math.round(a * 255);
    }
    const w = this.size;
    for (let pass = 0; pass < BLEED_PASSES; pass++) {
      const next = known.slice();
      for (let y = 0; y < w; y++) {
        for (let x = 0; x < w; x++) {
          const p = y * w + x;
          if (known[p] === 1) continue;
          let count = 0;
          let r = 0;
          let g = 0;
          let b = 0;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const nx = x + dx;
              const ny = y + dy;
              if ((dx === 0 && dy === 0) || nx < 0 || ny < 0 || nx >= w || ny >= w) continue;
              const q = ny * w + nx;
              if (known[q] !== 1) continue;
              count += 1;
              r += straight[q * 3] ?? 0;
              g += straight[q * 3 + 1] ?? 0;
              b += straight[q * 3 + 2] ?? 0;
            }
          }
          if (count === 0) continue;
          straight[p * 3] = r / count;
          straight[p * 3 + 1] = g / count;
          straight[p * 3 + 2] = b / count;
          next[p] = 1;
        }
      }
      known = next;
    }
    for (let p = 0; p < n; p++) {
      if (known[p] !== 1) continue;
      out[p * 4] = clampByte(straight[p * 3] ?? 0);
      out[p * 4 + 1] = clampByte(straight[p * 3 + 1] ?? 0);
      out[p * 4 + 2] = clampByte(straight[p * 3 + 2] ?? 0);
    }
    return out;
  }
}
