import type { MediaInfo } from "./types";
import { round } from "./util";

type Params = Record<string, number | boolean | string>;
type Fragment = (p: Params, info: MediaInfo) => string | null;

const n = (v: unknown) => Number(v);

export const FRAGMENTS: Record<string, Fragment> = {
  eq: (p) =>
    `eq=brightness=${n(p.brightness)}:contrast=${n(p.contrast)}:saturation=${n(
      p.saturation
    )}:gamma=${n(p.gamma)}`,

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

  noise: (p) => {
    const s = Math.round(n(p.strength));
    if (s <= 0) return null;
    return `noise=alls=${s}:allf=t+u`;
  },

  vignette: (p) => (p.on ? "vignette" : null),

  hflip: (p) => (p.on ? "hflip" : null),
};
