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

/** The middle of a plane's range, as `lutyuv` states it: 125.5 for limited
 *  luma, 127.5 for a full-range (yuvj) still. */
const MID = "(minval+maxval)/2";

export const FRAGMENTS: Record<string, Fragment> = {
  /** The recipe's tone op: contrast, then saturation, each emitted only when
   *  the recipe moved it off 1. Both samplers draw these two terms and nothing
   *  else (brightness and gamma left the recipes because they lift black or
   *  darken the picture), and both draw them up only.
   *
   *  Not ffmpeg's `eq`, although the op keeps the name. `eq` does both in
   *  integer arithmetic that truncates: its saturation maps neutral chroma 128
   *  to 127 on both planes, which pushes every pixel of every copy the same
   *  small way towards green-yellow (a real clip's R-G fell from +8.21 to +5.67
   *  at `saturation=1.005`), and its contrast takes a level off mid-grey and
   *  pivots on 127.5 whatever the range, which put limited-range black at 10.
   *
   *  So contrast is a luma lookup that pivots on the middle of the plane's own
   *  range, rounds, and clips to that range — black stays on the floor (16
   *  limited, 0 full) and white on the ceiling for every contrast from 1 up —
   *  and saturation is `hue`'s, which rounds about 128 and leaves a neutral
   *  pixel neutral. The chroma planes are not touched by the lookup at all. */
  eq: (p) => {
    const parts: string[] = [];
    const contrast = n(p.contrast);
    if (p.contrast !== undefined && contrast !== 1) {
      parts.push(`lutyuv=y='clip(round((val-${MID})*${contrast}+${MID}),minval,maxval)'`);
    }
    const saturation = n(p.saturation);
    if (p.saturation !== undefined && saturation !== 1) parts.push(`hue=s=${saturation}`);
    return parts.length > 0 ? parts.join(",") : null;
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
    // Luma only, as a still's is: uniform noise of an even strength has a mean
    // of -0.5, and on the chroma planes that moved every pixel of a clip
    // towards green (R-G -1.05, B-G -1.2 at strength 8). PDQ reads luma alone,
    // so the chroma grain bought no distance for it.
    if (p.temporal !== false) return `noise=c0s=${s}:c0f=t+u`;
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

  /** User-controlled perspective tilt («distortion»): `h` warps the frame around
   *  its vertical axis, `v` around its horizontal axis. Both are signed keystone
   *  fractions; the sign picks which edge is pulled in, so copies made from the
   *  same slider value but different seeds tilt in different directions. ffmpeg's
   *  `perspective` (default `sense=source`) maps this inset quad of the INPUT
   *  onto the output's corners, so the warped picture fills the frame with no
   *  black wedge — the pulled-in edge is simply stretched. Coordinates are W/H
   *  expressions, so the warp is exact whatever size the earlier ops left the
   *  frame. */
  tilt: (p) => {
    const h = n(p.h);
    const v = n(p.v);
    if (h === 0 && v === 0) return null;
    const ah = round(Math.abs(h) / 2, 4); // vertical-edge inset, as a fraction of H
    const av = round(Math.abs(v) / 2, 4); // horizontal-edge inset, as a fraction of W
    let tlx = "0", tly = "0", trx = "W", tryy = "0", blx = "0", bly = "H", brx = "W", bry = "H";
    if (h > 0) { tryy = `H*${ah}`; bry = `H-H*${ah}`; }       // right edge pulled in
    else if (h < 0) { tly = `H*${ah}`; bly = `H-H*${ah}`; }   // left edge pulled in
    if (v > 0) { tlx = `W*${av}`; trx = `W-W*${av}`; }        // top edge pulled in
    else if (v < 0) { blx = `W*${av}`; brx = `W-W*${av}`; }   // bottom edge pulled in
    return `perspective=${tlx}:${tly}:${trx}:${tryy}:${blx}:${bly}:${brx}:${bry}:interpolation=linear`;
  },

  hflip: (p) => (p.on ? "hflip" : null),
};
