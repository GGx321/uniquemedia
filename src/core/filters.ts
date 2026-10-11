import type { MediaInfo } from "./types";
import { clamp, round } from "./util";

type Params = Record<string, number | boolean | string>;
type Fragment = (p: Params, info: MediaInfo) => string | null;

const n = (v: unknown) => Number(v);

interface PanWindow {
  w: number;
  h: number;
  x: number;
  y: number;
}

/**
 * The rectangle `pancrop` cuts out and `fitpad` fills: a `pct` fraction of the
 * frame, placed inside the free margin by `panX`/`panY` (-1..1, 0 centred).
 *
 * Shared by both fragments on purpose. They are one decision taken in opposite
 * directions, so a sampler can feed either from a single draw and know the two
 * agree pixel for pixel; duplicating the arithmetic would let them drift.
 * Returns null when there is nothing to place.
 */
function panWindow(pct: number, panX: number, panY: number, info: MediaInfo): PanWindow | null {
  if (!(pct > 0) || pct >= 1) return null;
  const w = Math.round(info.width * pct);
  const h = Math.round(info.height * pct);
  const marginX = info.width - w;
  const marginY = info.height - h;
  if (marginX <= 0 && marginY <= 0) return null;
  const place = (margin: number, pan: number) =>
    clamp(Math.round((margin / 2) * (1 + clamp(pan, -1, 1))), 0, margin);
  return { w, h, x: place(marginX, panX), y: place(marginY, panY) };
}

/**
 * How far luma-only uniform noise of strength `s` lifts pure black, measured as
 * the peak of the gray plane of a black 1080x1920 yuv420p frame (the plane the
 * JPEG's luma is made from): 0 up to strength 2, then 1, 1, 2, 2, 3, 3, 5, 5, 6,
 * 6 for 3..12. Above 12 (past the sampler's ceiling) it is half the strength,
 * rounded up. Noise on the chroma planes lifted an RGB channel about three
 * times as far and speckled colour onto the picture, hence luma only.
 */
const NOISE_BLACK_LIFT = [0, 0, 0, 1, 1, 2, 2, 3, 3, 5, 5, 6, 6] as const;
function noiseBlackLift(s: number): number {
  return s < NOISE_BLACK_LIFT.length ? NOISE_BLACK_LIFT[s] : Math.ceil(s / 2);
}

export const FRAGMENTS: Record<string, Fragment> = {
  /** Each term is emitted only when the recipe drew one, in the order the video
   *  path has always written them — its chains are pinned byte-for-byte.
   *
   *  The term a still omits is `brightness`. ffmpeg's `eq` brightness is
   *  ADDITIVE: it shifts the whole scale including zero, so pure black stops
   *  being black (measured: `brightness=0.03` lifts it to 5/255, and a real
   *  copy read 7.07 mean over an area the original had at 0.00). On the phone a
   *  story is read on, a black pixel is an unlit pixel and 7/255 glows. The
   *  other three terms are multiplicative and leave zero at zero — measured 0,
   *  2 and 0 respectively — and they cost nothing to keep, because on real
   *  content the whole `eq` block moves PDQ by 0 either way. */
  eq: (p) => {
    const terms: string[] = [];
    for (const key of ["brightness", "contrast", "saturation", "gamma"] as const) {
      if (p[key] !== undefined) terms.push(`${key}=${n(p[key])}`);
    }
    return terms.length > 0 ? `eq=${terms.join(":")}` : null;
  },

  zoomcrop: (p, info) => {
    const f = round(1 + n(p.zoomPct) / 100, 4);
    if (f <= 1) return null;
    return `scale=iw*${f}:ih*${f},crop=${info.width}:${info.height}`;
  },

  rotate: (p) => {
    const rad = round((n(p.deg) * Math.PI) / 180, 6);
    if (rad === 0) return null;
    // ow/oh keep frame size; corners covered by the export over-zoom.
    return `rotate=${rad}:ow=rotw(${rad}):oh=roth(${rad}):c=black`;
  },

  perspective: (p, info) => {
    const off = n(p.off);
    if (off === 0) return null;
    const dx = round(info.width * off, 1);
    const dy = round(info.height * off, 1);
    const w = info.width;
    const h = info.height;
    // slight tilt: push top edge inward, bottom edge outward
    return (
      `perspective=` +
      `${dx}:${dy}:${w - dx}:${dy}:` +
      `0:${h}:${w}:${h}:interpolation=linear`
    );
  },

  lenscorrection: (p) => {
    const k1 = n(p.k1);
    if (k1 === 0) return null;
    return `lenscorrection=k1=${k1}:k2=0`;
  },

  /** Off-centre crop window scaled back to the source size. `windowPct` is the
   *  fraction of the frame kept; `panX`/`panY` (-1..1) place that window inside
   *  the free margin, 0 being centred. The window is always clamped to the frame.
   *
   *  Everything outside the window is gone. On a photograph a 3-5% edge loss is
   *  invisible; on a graphic whose content runs to the frame edge it is a
   *  defect — a measured copy of a 1080x1920 story read "NEVER GONNA MAKE I"
   *  where the original said "NEVER GONNA MAKE IT.", at a PDQ distance of 54
   *  with every check passing, because a hash cannot see a missing letter.
   *  `fitpad` is the answer for that case. */
  pancrop: (p, info) => {
    const win = panWindow(n(p.windowPct), n(p.panX), n(p.panY), info);
    if (!win) return null;
    return `crop=${win.w}:${win.h}:${win.x}:${win.y},scale=${info.width}:${info.height}`;
  },

  /** `pancrop` run backwards: the same window, drawn in the same free margin,
   *  but the picture is shrunk INTO it and the margin is filled with
   *  `padColor` instead of the picture being cut down to it. `scalePct` is the
   *  fraction of the source size kept.
   *
   *  Measured on the story above (1080x1920, flat background, maximum pan):
   *  fit 0.97 -> PDQ 46, fit 0.96 -> 62, both losing nothing, against crop 0.98
   *  -> 38 losing 38 px off one edge and crop 0.95 -> 82 losing 96 px. The hash
   *  moves just as far either way; only one of them keeps the picture. */
  fitpad: (p, info) => {
    const win = panWindow(n(p.scalePct), n(p.panX), n(p.panY), info);
    if (!win) return null;
    // A missing colour must not reach ffmpeg as the string "undefined".
    const colour = typeof p.padColor === "string" && p.padColor !== "" ? p.padColor : "black";
    return `scale=${win.w}:${win.h},pad=${info.width}:${info.height}:${win.x}:${win.y}:${colour}`;
  },

  noise: (p) => {
    const s = Math.round(n(p.strength));
    if (s <= 0) return null;
    // `t` is temporal — meaningless for a still, so photos pass temporal=false.
    if (p.temporal !== false) return `noise=alls=${s}:allf=t+u`;
    // A still: uniform noise lifts pure black, which glows on an AMOLED
    // screen, so the lift comes back out. Only the lifted floor is touched: the
    // knee maps [black + b, black + 2b) back down to [black, black + 2b) and
    // leaves everything from black + 2b up alone, so no shadow, gradient or
    // midtone gets darker. It works on the luma plane in place (`lutyuv`),
    // relative to that plane's own `minval` (16 limited, 0 full range), so there
    // is no round trip through RGB and no assumption about the range.
    const b = noiseBlackLift(s);
    if (b === 0) return `noise=c0s=${s}:c0f=u`;
    const y = `if(lt(val,minval+${2 * b}),max(minval,minval+2*(val-minval-${b})),val)`;
    return `noise=c0s=${s}:c0f=u,lutyuv=y='${y}'`;
  },

  hflip: (p) => (p.on ? "hflip" : null),
};
