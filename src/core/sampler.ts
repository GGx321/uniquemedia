import { makeRng, type Rng } from "./rng";
import { PARAMS } from "./presets";
import { round, clamp } from "./util";
import { samplePhotoRecipe } from "./photo/sampler";
import {
  EXPORT_DIMS,
  type ExportFormat,
  type FirstFrame,
  type FrameSpec,
  type Operation,
  type Recipe,
  type ResolvedCopyOptions,
} from "./types";

function dev(rng: Rng, key: keyof typeof PARAMS, scalar: number, oneSided = false): number {
  const spec = PARAMS[key];
  const mag = (oneSided ? rng() : rng() * 2 - 1) * spec.dev * scalar;
  return spec.neutral + mag;
}

const FPS_CHOICES = [24, 25, 30] as const;
const GOP_SECONDS = [2, 3, 4] as const;
// Slower presets compress better at equal quality; the random pick stays
// because the preset is part of the encoder fingerprint.
const PRESET_CHOICES = ["medium", "slow"] as const;
const AUDIO_KBPS_CHOICES = [160, 192, 224] as const;
const SEGMENT_COUNTS = [3, 4, 5] as const;

function pick<T>(rng: Rng, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

/**
 * What frame 0 will be. The mode is copied; the cover, when there is one, is
 * DRAWN — by the photo sampler, from the same seed and intensity as the copy,
 * on an rng instance of its own. That is what lets every copy open on a
 * different rendition of the same picture while the video draws stay exactly
 * what they are with the mode off: the cover consumes nothing from the video's
 * generator. (Seeded the same, the two instances replay one sequence, so the
 * cover's first draws are correlated with the video's first draws. That is a
 * known property, not independence — the invariant pinned in the tests is
 * only that the video recipe does not move.)
 *
 * The cover's options are not the video's. It is never mirrored (a flipped
 * cover flips its text) and it keeps its own framing (`original`): the graph
 * fits it to the video afterwards, and sampling it to EXPORT_DIMS first would
 * crop it twice. Strength and edge are the video's and the route's.
 */
function firstFrameOf(opts: ResolvedCopyOptions, seed: number, intensity: number): FirstFrame {
  const ff = opts.firstFrame;
  if (ff.mode !== "photo") return { mode: ff.mode };
  const { path, edge, info } = ff.cover;
  const recipe = samplePhotoRecipe(
    {
      strength: opts.strength,
      exportFormat: "original",
      allowMirror: false,
      targetDistance: opts.targetDistance,
      identity: opts.identity,
      edge,
    },
    seed,
    intensity
  );
  return { mode: "photo", path, info, recipe };
}

/** Frame mode's own stream, so enabling it moves no other draw. */
const FRAME_RNG_SALT = 0x46524d45;
const FRAME_MIN_SCALE = 0.9;
const FRAME_MAX_SCALE = 0.95;

const evenRound = (v: number): number => 2 * Math.round(v / 2);

/**
 * An even offset on one axis, drawn from the middle half of the free space so
 * the gap on both sides is at least a quarter of it: the video never touches
 * an edge or a corner.
 */
function middleHalfOffset(rng: Rng, free: number): number {
  const lo = 2 * Math.ceil(Math.ceil(free / 4) / 2);
  const hi = 2 * Math.floor(Math.floor((3 * free) / 4) / 2);
  return lo + 2 * Math.floor(rng() * ((hi - lo) / 2 + 1));
}

/**
 * Where the video sits in a frame: 90-95% of the canvas, at a random offset
 * from the middle half of the free space, over a background picked from the pack. The
 * canvas is the export format's size, and `original` has none, so it becomes
 * reels (9:16).
 */
function drawFrame(
  opts: ResolvedCopyOptions,
  canvasFormat: Exclude<ExportFormat, "original">,
  seed: number
): FrameSpec | undefined {
  if (!opts.frame) return undefined;
  const { backgrounds } = opts.frame;
  if (backgrounds.length === 0) {
    throw new Error("Для режима «В рамке» нет ни одного фона: набор пуст.");
  }
  const rng = makeRng((seed ^ FRAME_RNG_SALT) >>> 0);
  const { w: W, h: H } = EXPORT_DIMS[canvasFormat];
  const scale = FRAME_MIN_SCALE + rng() * (FRAME_MAX_SCALE - FRAME_MIN_SCALE);
  const w = evenRound(W * scale);
  const h = evenRound(H * scale);
  const x = middleHalfOffset(rng, W - w);
  const y = middleHalfOffset(rng, H - h);
  return { background: pick(rng, backgrounds), w, h, x, y, fit: opts.exportFormat === "original" };
}

export function sampleRecipe(opts: ResolvedCopyOptions, seed: number, intensity = 1): Recipe {
  const rng = makeRng(seed);
  const s = opts.strength * intensity;

  // No hue shift, no brightness or gamma, no vignette: those read as a colour
  // cast or a darker picture. Contrast and saturation are drawn one-sided (up
  // only), so no copy comes out flatter or duller than its source.
  const video: Operation[] = [
    {
      id: "eq",
      params: {
        contrast: round(dev(rng, "contrast", s, true)),
        saturation: round(dev(rng, "saturation", s, true)),
      },
    },
  ];

  // Always apply a small zoom-crop (~3%) — visually a thin edge crop but shifts
  // the PDQ hash meaningfully via spatial resampling.
  const zoomPct = round(dev(rng, "zoomPct", s, true));
  video.push({ id: "zoomcrop", params: { zoomPct } });

  video.push(
    { id: "rotate", params: { deg: round(dev(rng, "rotateDeg", s)) } },
    { id: "perspective", params: { off: round(dev(rng, "perspective", s, true)) } },
    { id: "lenscorrection", params: { k1: round(dev(rng, "lens", s)) } },
    { id: "noise", params: { strength: Math.round(dev(rng, "noise", s, true)) } },
  );

  // Determinism invariant: same seed + same opts => same recipe. The mirror draw
  // below is conditional, so changing `allowMirror` shifts the rng stream for the
  // speed/crf/eqGain draws — that's intentional and acceptable.
  if (opts.allowMirror && rng() < 0.5) {
    video.push({ id: "hflip", params: { on: true } });
  }

  // Per-segment speed changes break the temporal fingerprint. Non-uniform
  // fractions so segment boundaries aren't a fixed pattern and no segment is
  // vanishingly small; each keeps the subtle PARAMS.speed spread (~±5%).
  const segCount = pick(rng, SEGMENT_COUNTS);
  const weights = Array.from({ length: segCount }, () => 0.5 + rng());
  const weightSum = weights.reduce((a, b) => a + b, 0);
  const segments = weights.map((w) => ({
    fraction: w / weightSum,
    speed: round(clamp(dev(rng, "speed", s), 0.9, 1.1)),
  }));
  const crf = Math.round(clamp(dev(rng, "crf", s), 17, 20));

  // Container/bitstream signature spread. Drawn here (before the conditional
  // audio draw) so they stay independent of `keepTrendAudio`, and they ignore
  // `s` so the encoder fingerprint is decoupled from the visual-change budget.
  const fps = pick(rng, FPS_CHOICES);
  const gop = fps * pick(rng, GOP_SECONDS);
  const keyintMin = fps;
  const preset = pick(rng, PRESET_CHOICES);
  const audioKbps = pick(rng, AUDIO_KBPS_CHOICES);

  const audio: Operation[] = opts.keepTrendAudio
    ? []
    : [{ id: "aeq", params: { gain: round(dev(rng, "eqGain", s)) } }];

  const exportFormat: ExportFormat =
    opts.frame && opts.exportFormat === "original" ? "reels" : opts.exportFormat;
  const frame = drawFrame(opts, exportFormat === "original" ? "reels" : exportFormat, seed);

  return {
    seed,
    intensity,
    exportFormat,
    keepTrendAudio: opts.keepTrendAudio,
    identity: opts.identity,
    firstFrame: firstFrameOf(opts, seed, intensity),
    ...(frame ? { frame } : {}),
    segments,
    video: [...video, { id: "encode", params: { crf, fps, gop, keyintMin, preset, audioKbps } }],
    audio,
  };
}
