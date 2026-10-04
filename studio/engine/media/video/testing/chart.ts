// Test-only: the colour chart the video fixtures are made of, and the arithmetic to read a patch back. Used by the fixture generator
// (`fixtures/generate.ts`) and by the tests that check a normalised clip against invariant 36's tolerance. Production code never imports it.

/** Patches across and down: 24 of them, each 32 x 24 pixels in a 192 x 96 picture (every edge on an even pixel, so 4:2:0 chroma is clean). */
export const CHART = { columns: 6, rows: 4, patchWidth: 32, patchHeight: 24, width: 192, height: 96 } as const;

export type Rgb = readonly [number, number, number];

/**
 * The patches as non-linear R'G'B' signals in 0..1, row by row: twelve greys, then twelve colours kept clear of the gamut's edge. As an
 * HLG chart they are BT.2020 HLG signals (0.75 is HLG's reference white); as an SDR chart they are BT.709 gamma signals.
 */
export const CHART_PATCHES: readonly Rgb[] = [
  [0.04, 0.04, 0.04],
  [0.1, 0.1, 0.1],
  [0.18, 0.18, 0.18],
  [0.26, 0.26, 0.26],
  [0.34, 0.34, 0.34],
  [0.42, 0.42, 0.42],
  [0.5, 0.5, 0.5],
  [0.58, 0.58, 0.58],
  [0.65, 0.65, 0.65],
  [0.75, 0.75, 0.75],
  [0.85, 0.85, 0.85],
  [0.95, 0.95, 0.95],
  [0.6, 0.15, 0.15],
  [0.15, 0.55, 0.15],
  [0.15, 0.15, 0.65],
  [0.15, 0.55, 0.6],
  [0.6, 0.15, 0.6],
  [0.65, 0.6, 0.15],
  [0.65, 0.4, 0.12],
  [0.55, 0.42, 0.35],
  [0.35, 0.45, 0.65],
  [0.25, 0.4, 0.2],
  [0.4, 0.2, 0.5],
  [0.7, 0.45, 0.5],
];

export type Matrix = "bt709" | "bt2020";
const KR_KB: Readonly<Record<Matrix, readonly [number, number]>> = { bt709: [0.2126, 0.0722], bt2020: [0.2627, 0.0593] };

/** Limited-range Y'CbCr codes for an R'G'B' signal, at 8 or 10 bits, as a coder writes them (rounded to a code). */
export function rgbToYcbcr(rgb: Rgb, matrix: Matrix, bits: 8 | 10): [number, number, number] {
  const [kr, kb] = KR_KB[matrix];
  const [r, g, b] = rgb;
  const y = kr * r + (1 - kr - kb) * g + kb * b;
  const cb = (b - y) / (2 * (1 - kb));
  const cr = (r - y) / (2 * (1 - kr));
  const scale = bits === 10 ? 4 : 1;
  return [Math.round((16 + 219 * y) * scale), Math.round((128 + 224 * cb) * scale), Math.round((128 + 224 * cr) * scale)];
}

/** The inverse of `rgbToYcbcr`, from codes (they need not be whole): R'G'B' in 0..1, unclamped. */
export function ycbcrToRgb(ycbcr: readonly [number, number, number], matrix: Matrix, bits: 8 | 10): Rgb {
  const [kr, kb] = KR_KB[matrix];
  const scale = bits === 10 ? 4 : 1;
  const y = (ycbcr[0] / scale - 16) / 219;
  const cb = (ycbcr[1] / scale - 128) / 224;
  const cr = (ycbcr[2] / scale - 128) / 224;
  const r = y + 2 * (1 - kr) * cr;
  const b = y + 2 * (1 - kb) * cb;
  const g = (y - kr * r - kb * b) / (1 - kr - kb);
  return [r, g, b];
}

export interface ChartFrameOptions {
  matrix: Matrix;
  bits: 8 | 10;
  /** 4:2:0 or 4:2:2: where the chroma planes are halved. */
  chroma: "420" | "422";
  /** The Y'CbCr codes of each patch, in the patches' order, instead of the codes of `CHART_PATCHES` (for a chart whose point is codes outside the RGB cube). */
  codes?: readonly (readonly [number, number, number])[];
}

/** One raw planar frame of the chart (`yuv420p`, `yuv420p10le`, `yuv422p10le`), ready for `-f rawvideo`. */
export function chartFrame(options: ChartFrameOptions): Uint8Array {
  const { width, height, columns, patchWidth, patchHeight } = CHART;
  const bytes = options.bits === 10 ? 2 : 1;
  const chromaWidth = width / 2;
  const chromaHeight = options.chroma === "420" ? height / 2 : height;
  const out = new Uint8Array((width * height + 2 * chromaWidth * chromaHeight) * bytes);
  const view = new DataView(out.buffer);
  const put = (plane: number, index: number, value: number): void => {
    const at = (plane === 0 ? 0 : width * height + (plane - 1) * chromaWidth * chromaHeight) + index;
    if (bytes === 2) view.setUint16(at * 2, value, true);
    else out[at] = value;
  };
  const codes = options.codes ?? CHART_PATCHES.map((rgb) => rgbToYcbcr(rgb, options.matrix, options.bits));
  const patchAt = (x: number, y: number): readonly [number, number, number] => codes[Math.floor(y / patchHeight) * columns + Math.floor(x / patchWidth)] ?? [0, 0, 0];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) put(0, y * width + x, patchAt(x, y)[0]);
  const stepY = options.chroma === "420" ? 2 : 1;
  for (let y = 0; y < height; y += stepY) {
    for (let x = 0; x < width; x += 2) {
      const code = patchAt(x, y);
      put(1, (y / stepY) * chromaWidth + x / 2, code[1]);
      put(2, (y / stepY) * chromaWidth + x / 2, code[2]);
    }
  }
  return out;
}

/** The inside of patch `index` (a margin of 6 pixels from every edge, away from the edges' ringing), as pixel rectangles. */
export function patchRect(index: number, margin = 6): { x0: number; y0: number; x1: number; y1: number } {
  const col = index % CHART.columns;
  const row = Math.floor(index / CHART.columns);
  return { x0: col * CHART.patchWidth + margin, y0: row * CHART.patchHeight + margin, x1: (col + 1) * CHART.patchWidth - margin, y1: (row + 1) * CHART.patchHeight - margin };
}

// ---------- an independent model of the HLG to SDR chain ----------

const HLG_A = 0.17883277;
const HLG_B = 1 - 4 * HLG_A;
const HLG_C = 0.5 - HLG_A * Math.log(4 * HLG_A);

/** BT.2100's inverse HLG OETF: a signal in 0..1 to scene-linear light in 0..1. */
export function hlgToSceneLinear(signal: number): number {
  return signal <= 0.5 ? (signal * signal) / 3 : (Math.exp((signal - HLG_C) / HLG_A) + HLG_B) / 12;
}

/** BT.2020 linear light to BT.709 linear light (ITU-R BT.2087). */
const BT2020_TO_BT709: readonly (readonly [number, number, number])[] = [
  [1.660491, -0.587641, -0.07285],
  [-0.12455, 1.1329, -0.008349],
  [-0.018151, -0.100579, 1.11873],
];

/** John Hable's filmic curve with the constants ffmpeg's `tonemap=hable` uses. */
export function hable(x: number): number {
  return (x * (x * 0.15 + 0.05) + 0.004) / (x * (x * 0.15 + 0.5) + 0.06) - 0.02 / 0.3;
}

/**
 * What the importer's HDR chain (`zscale=t=linear:npl=100`, BT.709 primaries, `tonemap=hable:desat=0`, BT.709 matrix and range) must make of
 * an HLG R'G'B' signal (BT.2020), as limited-range 8-bit BT.709 Y'CbCr: written from the standards (BT.2100, BT.2087, Hable, BT.1886), with three constants that were FITTED to
 * ffmpeg's output. The constants that are facts of the chain rather than of the standards were found by measuring it stage by stage on
 * macOS ffmpeg 6.0 (see the fixtures' README):
 * - zimg lights HLG per channel: display = 10 x E^1.2 (a nominal 1000 nit peak over the 100 nit reference, the BT.2100 system gamma);
 * - `tonemap` takes the brightest channel, curves it with hable and divides by hable(10) (ffmpeg's default peak is 10 when a frame has none),
 *   and scales all three channels by the same factor, so the hue is kept;
 * - the BT.709 output is encoded with a plain 1/2.4 power (BT.1886), the way zimg does for display-referred light.
 * Light outside the BT.709 gamut is clipped at zero.
 */
export function hlgToSdrBt709(signal: Rgb): [number, number, number] {
  const display = signal.map((s) => 10 * Math.pow(hlgToSceneLinear(s), 1.2));
  const [r = 0, g = 0, b = 0] = BT2020_TO_BT709.map((row) => row[0] * (display[0] ?? 0) + row[1] * (display[1] ?? 0) + row[2] * (display[2] ?? 0));
  const brightest = Math.max(r, g, b);
  const gain = brightest <= 0 ? 0 : hable(brightest) / hable(10) / brightest;
  const encode = (light: number): number => Math.pow(Math.min(1, Math.max(0, light * gain)), 1 / 2.4);
  return rgbToYcbcr([encode(r), encode(g), encode(b)], "bt709", 8);
}

// ---------- charts whose point is colour outside the RGB cube or outside BT.709's gamut (3f.3a follow-up, review round 4) ----------

export type Codes = readonly [number, number, number];

/**
 * Y'CbCr codes (10-bit, limited range, BT.2020 matrix: legal codes all) of an HLG clip whose R'G'B' is OUTSIDE the 0..1 cube, as 4:2:0 coding of real
 * footage produces at saturated edges and near black: some channel negative (R', G' or B' down to about -0.9), some over 1 (up to about 1.6), some
 * both. Patch by patch: negative only, over 1 only, and both.
 */
export const HLG_OUT_OF_CUBE_CODES: readonly Codes[] = [
  [90, 64, 64], [90, 300, 64], [90, 512, 64], [90, 724, 300], [90, 960, 512], [160, 64, 512],
  [160, 300, 512], [160, 512, 960], [160, 960, 300], [300, 64, 300], [300, 300, 300], [300, 512, 300],
  [300, 960, 300], [500, 64, 300], [500, 300, 960], [500, 960, 64], [700, 64, 300], [700, 300, 724],
  [700, 724, 300], [700, 960, 300], [850, 64, 300], [850, 300, 300], [850, 512, 960], [850, 724, 960],
];

const clip01 = (value: number): number => Math.min(1, Math.max(0, value));

/** The R'G'B' of Y'CbCr codes (BT.2020, 10-bit), UNCLIPPED: a channel can be negative or over 1. */
export function hlgOutOfCubeRgb(codes: Codes): Rgb {
  return ycbcrToRgb(codes, "bt2020", 10);
}

/**
 * What the importer must make of out-of-cube HLG Y'CbCr: the signal is CLIPPED to the cube (16-bit integers, before any transfer function), then it
 * goes through the same chain as an HLG signal (`hlgToSdrBt709`), as 8-bit limited BT.709 Y'CbCr.
 */
export function hlgOutOfCubeToSdrBt709(codes: Codes): [number, number, number] {
  const [r, g, b] = hlgOutOfCubeRgb(codes);
  return hlgToSdrBt709([clip01(r), clip01(g), clip01(b)]);
}

/**
 * Display P3 patches as sRGB-encoded P3 signals in 0..1 (the transfer of Display P3), all INSIDE the RGB cube: twelve greys, then six colours at the
 * edge of P3's gamut, which are OUTSIDE BT.709's (a P3 green or red is a negative BT.709 red, or blue, channel of linear light).
 */
export const P3_SDR_PATCHES: readonly Rgb[] = [
  [0.04, 0.04, 0.04], [0.1, 0.1, 0.1], [0.18, 0.18, 0.18], [0.26, 0.26, 0.26], [0.34, 0.34, 0.34], [0.42, 0.42, 0.42],
  [0.5, 0.5, 0.5], [0.58, 0.58, 0.58], [0.65, 0.65, 0.65], [0.75, 0.75, 0.75], [0.85, 0.85, 0.85], [0.95, 0.95, 0.95],
  [0.0, 0.9, 0.0], [0.05, 0.8, 0.1], [0.9, 0.0, 0.0], [0.0, 0.0, 0.9], [0.0, 0.85, 0.85], [0.9, 0.0, 0.9],
];

/** Six 8-bit limited BT.709 Y'CbCr codes (all legal) whose R'G'B' is OUTSIDE the 0..1 cube: negative (down to -0.7), over 1 (up to 1.6), and both. */
export const P3_OUT_OF_CUBE_CODES: readonly Codes[] = [
  [30, 16, 16], [100, 70, 16], [30, 240, 240], [100, 240, 70], [150, 70, 240], [200, 70, 240],
];

/** The 24 patches of the Display P3 clip as Y'CbCr codes: `P3_SDR_PATCHES` (BT.709 matrix), then `P3_OUT_OF_CUBE_CODES`. */
export const P3_SDR_CODES: readonly Codes[] = [...P3_SDR_PATCHES.map((rgb): Codes => rgbToYcbcr(rgb, "bt709", 8)), ...P3_OUT_OF_CUBE_CODES];

const srgbToLinear = (value: number): number => (value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4));
/** Linear Display P3 (D65) to linear BT.709 (D65). */
const P3_TO_BT709: readonly (readonly [number, number, number])[] = [
  [1.2249401, -0.2249404, 0],
  [-0.0420569, 1.0420571, 0],
  [-0.0196376, -0.0786361, 1.0982735],
];

/** The BT.709 LINEAR light of Y'CbCr codes of a Display P3 clip (BT.709 matrix, sRGB transfer, 8-bit limited), unclipped: a channel can be negative. */
export function p3LinearBt709(codes: Codes): Rgb {
  const [r, g, b] = ycbcrToRgb(codes, "bt709", 8).map((value) => srgbToLinear(clip01(value)));
  const light = P3_TO_BT709.map((row) => row[0] * (r ?? 0) + row[1] * (g ?? 0) + row[2] * (b ?? 0));
  return [light[0] ?? 0, light[1] ?? 0, light[2] ?? 0];
}

/**
 * What the importer must make of Display P3 Y'CbCr (BT.709 matrix, sRGB transfer, 8-bit limited): clip the signal to the cube, to linear light,
 * to BT.709 primaries, CLIP the light to 0..1 (what is outside BT.709's gamut), then the BT.709 curve zimg applies to display-referred light: a
 * plain 1/2.4 power (as in `hlgToSdrBt709`), as 8-bit limited BT.709 Y'CbCr.
 */
export function p3SdrToSdrBt709(codes: Codes): [number, number, number] {
  const [r, g, b] = p3LinearBt709(codes);
  const encode = (light: number): number => Math.pow(clip01(light), 1 / 2.4);
  return rgbToYcbcr([encode(r), encode(g), encode(b)], "bt709", 8);
}
