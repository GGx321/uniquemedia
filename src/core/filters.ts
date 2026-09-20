import type { MediaInfo } from "./types";
import { clamp, round } from "./util";

type Params = Record<string, number | boolean | string>;
type Fragment = (p: Params, info: MediaInfo) => string | null;

const n = (v: unknown) => Number(v);

/** Round down to the chroma grid — subsampled formats need even geometry. */
const even = (v: number) => Math.floor(v / 2) * 2;

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

  hue: (p) => `hue=h=${n(p.h)}`,

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
    const flags = p.temporal === false ? "u" : "t+u";
    return `noise=alls=${s}:allf=${flags}`;
  },

  /** `{ on }` alone keeps the video path's bare `vignette`, unchanged.
   *
   *  `angle`/`x0`/`y0` produce an off-centre vignette, with `x0`/`y0` given as
   *  fractions of the frame. ffmpeg's vignette hard-blacks every pixel further
   *  than hypot(w/2, h/2) from its centre (`dnorm > 1` returns 0), so moving the
   *  centre by as little as 3% puts a pure-black wedge in the far corner —
   *  measured. Padding the canvas first pushes that cutoff outside the visible
   *  area; the pad is cropped back off immediately after. */
  vignette: (p, info) => {
    if (p.on === false) return null;
    if (p.angle === undefined || p.x0 === undefined || p.y0 === undefined) {
      return p.on ? "vignette" : null;
    }
    const { width: w, height: h } = info;
    const dx = (n(p.x0) - 0.5) * w;
    const dy = (n(p.y0) - 0.5) * h;
    // Farthest visible corner from the vignette centre, plus 2% headroom for
    // integer rounding; the pad must reach at least that far.
    const reach = Math.hypot(w / 2 + Math.abs(dx), h / 2 + Math.abs(dy)) * 1.02;
    const factor = reach / Math.hypot(w / 2, h / 2);
    const padW = even(Math.max(w + 2, Math.ceil(w * factor)));
    const padH = even(Math.max(h + 2, Math.ceil(h * factor)));
    // Same offset for pad and crop, so the frame comes back pixel-identical.
    const padX = even(Math.floor((padW - w) / 2));
    const padY = even(Math.floor((padH - h) / 2));
    const x0 = Math.round(padX + w / 2 + dx);
    const y0 = Math.round(padY + h / 2 + dy);
    return (
      `pad=${padW}:${padH}:${padX}:${padY},` +
      `vignette=angle=${n(p.angle)}:x0=${x0}:y0=${y0},` +
      `crop=${w}:${h}:${padX}:${padY}`
    );
  },

  hflip: (p) => (p.on ? "hflip" : null),
};
