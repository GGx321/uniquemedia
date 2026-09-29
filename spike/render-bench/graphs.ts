// Filter-graph builders for the SP1 bench. Everything here is a spike helper, not the
// production graph builder (3a.5); it exists to compare techniques on equal terms.
import { W, H, FPS } from "./common";

export type Tech =
  | "zp1" | "zp2" | "zp4" // zoompan on a 1x / 2x / 4x lanczos upscale of the cover-cropped photo
  | "sc" | "sc2" | "sc4" | "sc2e" | "sc4e" // per-frame scale(eval=frame)+crop on a kx canvas; e = crop exact=1 (zoom only)
  | "cv1" | "cv2" | "cv4" | "cv2e" | "cv4e"; // one pre-scaled kx canvas + crop over time; e = exact=1 (pan only)
export type Motion = "kb" | "pan" | "static";
export type Kind = "photo" | "collage2" | "collage3" | "collage4";

export interface ClipSpec {
  kind: Kind;
  seconds: number;
  motion: Motion;
  photos: string[]; // one per cell
  stagger: boolean; // collages only
  dir?: 1 | -1;     // pan direction
}

export const frames = (seconds: number) => Math.round(seconds * FPS);

const GAP = 12;
export type Rect = [x: number, y: number, w: number, h: number];
export const LAYOUT: Record<Kind, Rect[]> = {
  photo: [[0, 0, W, H]],
  collage2: [[0, 0, W, 954], [0, 954 + GAP, W, 954]],
  collage3: [[0, 0, W, 1106], [0, 1106 + GAP, 534, 802], [534 + GAP, 1106 + GAP, 534, 802]],
  collage4: [
    [0, 0, 534, 954], [534 + GAP, 0, 534, 954],
    [0, 954 + GAP, 534, 954], [534 + GAP, 954 + GAP, 534, 954],
  ],
};

export const FOCUS = { fx: 0.5, fy: 0.38 };
const KB_ZOOM = 0.1;
const PAN_ZOOM = 1.15;

// Photo (full-range BT.601 JPEG) -> limited-range BT.709, tagged. First step of every cell.
export const CONV =
  "scale=in_range=pc:in_color_matrix=bt601:out_range=tv:out_color_matrix=bt709,format=yuv420p," +
  "setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv";

const even = (n: number) => 2 * Math.round(n / 2);

/** Cover-crop of a srcW x srcH photo to the cell aspect, placed by the focus. Even sides. */
export function coverCrop(srcW: number, srcH: number, cw: number, ch: number, fx: number, fy: number) {
  const ca = cw / ch;
  let w = srcW, h = srcH;
  if (srcW / srcH > ca) w = even(srcH * ca);
  else h = even(srcW / ca);
  return { w, h, x: Math.round((srcW - w) * fx), y: Math.round((srcH - h) * fy) };
}

/** One cell: conversion, cover-crop, motion. Output label `out`, exactly `n` frames of cw x ch. */
export function cellChain(
  inLabel: string, out: string, tech: Tech, motion: Motion,
  cw: number, ch: number, n: number, dir: 1 | -1, srcW = 720, srcH = 1280,
): string {
  const { fx, fy } = FOCUS;
  // sc/sc2 are zoom-only and cv1/cv2 pan-only: a mixed timeline maps each clip to its sibling.
  if (motion === "pan") tech = tech.replace(/^sc(\d?)(e?)$/, (_, k, e) => `cv${k || 1}${e}`) as Tech;
  if (motion === "kb") tech = tech.replace(/^cv(\d)(e?)$/, (_, k, e) => (k === "1" ? "sc" : `sc${k}`) + e) as Tech;
  const c = coverCrop(srcW, srcH, cw, ch, fx, fy);
  const head = `[${inLabel}]${CONV},crop=${c.w}:${c.h}:${c.x}:${c.y}`;
  const last = n - 1;
  // settb first: setpts=N/(30*TB) on the image demuxer's 1/25 base truncates to duplicate pts
  const rep = `loop=loop=${last}:size=1,settb=1/${FPS},setpts=N`;
  const p = dir === 1 ? `n/${last}` : `(1-n/${last})`;

  if (motion === "static") return `${head},scale=${cw}:${ch}:flags=lanczos,${rep}[${out}]`;

  if (tech === "zp1" || tech === "zp2" || tech === "zp4") {
    const u = Number(tech[2]);
    const pre = u > 1 ? `,scale=iw*${u}:ih*${u}:flags=lanczos` : "";
    const z = motion === "kb" ? `1+${KB_ZOOM}*on/${last}` : `${PAN_ZOOM}`;
    const px = motion === "kb" ? fx : dir === 1 ? `on/${last}` : `(1-on/${last})`;
    return (
      `${head}${pre},zoompan=z='${z}':x='(iw-iw/zoom)*${px}':y='(ih-ih/zoom)*${fy}'` +
      `:d=${n}:s=${cw}x${ch}:fps=${FPS}[${out}]`
    );
  }
  const m = /^(sc|cv)(\d?)(e?)$/.exec(tech);
  if (!m) throw new Error(`unknown technique ${tech}`);
  const k = Number(m[2] || 1);
  const exact = m[3] ? ":exact=1" : "";
  if (m[1] === "sc") {
    if (motion !== "kb") throw new Error("sc* are the zoom techniques");
    const pre = k > 1 ? `,scale=${k * cw}:${k * ch}:flags=lanczos` : "";
    const z = `(1+${KB_ZOOM}*n/${last})`;
    const post = k > 1 ? `,scale=${cw}:${ch}:flags=bicubic` : "";
    return (
      `${head}${pre},${rep},scale=w='2*trunc(${k * cw}*${z}/2)':h='2*trunc(${k * ch}*${z}/2)':eval=frame:flags=bicubic,` +
      `crop=${k * cw}:${k * ch}:x='(in_w-${k * cw})*${fx}':y='(in_h-${k * ch})*${fy}'${exact}${post}[${out}]`
    );
  }
  // cv*: canvas at PAN_ZOOM (x k), cropped over time (pan only: crop w/h cannot change per frame)
  if (motion !== "pan") throw new Error("cv* are the pan techniques");
  const post = k > 1 ? `,scale=${cw}:${ch}:flags=bicubic` : "";
  return (
    `${head},scale=${even(k * cw * PAN_ZOOM)}:${even(k * ch * PAN_ZOOM)}:flags=lanczos,${rep},` +
    `crop=${k * cw}:${k * ch}:x='(in_w-${k * cw})*${p}':y='(in_h-${k * ch})*${fy}'${exact}${post}[${out}]`
  );
}

/** Stagger step in seconds: min(300 ms, duration/(n+1)), rounded down to a whole frame. */
export function staggerStep(seconds: number, cells: number): number {
  return Math.floor(Math.min(0.3, seconds / (cells + 1)) * FPS) / FPS;
}

export interface Part {
  inputs: string[]; // ffmpeg input args (-i ...)
  filters: string[];
  out: string;      // label of the clip output
  frames: number;
}

/** The graph of one clip. `base` = first input index it uses, `tag` prefixes every label. */
export function clipPart(spec: ClipSpec, tech: Tech, base: number, tag: string): Part {
  const n = frames(spec.seconds);
  const cells = LAYOUT[spec.kind];
  const dir = spec.dir ?? 1;
  const inputs = spec.photos.slice(0, cells.length).flatMap((p) => ["-i", p]);
  const filters: string[] = [];
  const step = staggerStep(spec.seconds, cells.length);
  cells.forEach(([, , cw, ch], k) => {
    const cellOut = `${tag}c${k}`;
    filters.push(cellChain(`${base + k}:v`, `${tag}raw${k}`, tech, spec.motion, cw, ch, n, dir));
    if (spec.kind === "photo") {
      filters.push(`[${tag}raw${k}]null[${cellOut}]`);
    } else if (spec.stagger) {
      filters.push(`[${tag}raw${k}]format=yuva420p,fade=t=in:st=${(k * step).toFixed(4)}:d=${step.toFixed(4)}:alpha=1[${cellOut}]`);
    } else {
      filters.push(`[${tag}raw${k}]null[${cellOut}]`);
    }
  });
  if (spec.kind === "photo") return { inputs, filters, out: `${tag}c0`, frames: n };
  const bg =
    `color=c=black:s=${W}x${H}:r=${FPS}:d=${spec.seconds},format=yuv420p,` +
    `setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv[${tag}bg]`;
  filters.push(bg);
  let prev = `${tag}bg`;
  cells.forEach(([x, y], k) => {
    const o = `${tag}o${k}`;
    filters.push(`[${prev}][${tag}c${k}]overlay=x=${x}:y=${y}:format=yuv420[${o}]`);
    prev = o;
  });
  return { inputs, filters, out: prev, frames: n };
}

export const TAGS = "-colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv".split(" ");

/** Pass-1 intermediate encode settings. */
export type Inter = { name: string; args: string[] };
export const INTERS: Inter[] = [
  { name: "qp0", args: ["-qp", "0"] },
  { name: "crf8", args: ["-crf", "8"] },
  { name: "crf10", args: ["-crf", "10"] },
];

export function interArgs(i: Inter, preset = "ultrafast"): string[] {
  return ["-c:v", "libx264", "-preset", preset, ...i.args, "-pix_fmt", "yuv420p", ...TAGS, "-r", String(FPS), "-fps_mode", "cfr", "-threads", "2"];
}

export function finalVideoArgs(preset: string): string[] {
  return [
    "-c:v", "libx264", "-profile:v", "high", "-preset", preset, "-crf", "20",
    "-maxrate", "3500k", "-bufsize", "7000k", "-g", "60", "-keyint_min", "30", "-threads", "2",
    "-pix_fmt", "yuv420p", ...TAGS, "-r", String(FPS), "-fps_mode", "cfr",
  ];
}

export function audioArgs(): string[] {
  return ["-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2"];
}

/** Pass-1 run for one clip: a graph -> an mkv intermediate. */
export function pass1Args(spec: ClipSpec, tech: Tech, out: string, inter: Inter, preset = "ultrafast"): string[] {
  const part = clipPart(spec, tech, 0, "a");
  return [
    ...part.inputs,
    "-filter_complex", part.filters.join(";"),
    "-map", `[${part.out}]`,
    ...interArgs(inter, preset),
    out,
  ];
}

export const SILENCE = (seconds: number) =>
  `anullsrc=r=48000:cl=stereo,atrim=end_sample=${Math.round(seconds * 48000)}`;

export interface Overlay { file: string; x: number; y: number; start: number; end: number }

/** Sticker overlay chain: explicit BT.709 limited-range conversion to yuva420p, then overlay. */
export function overlayFilters(base: string, o: Overlay, idx: number, total: number, out: string, explicit = true): string[] {
  const conv = explicit
    ? `format=rgba,scale=in_range=full:out_range=tv:out_color_matrix=bt709,format=yuva420p`
    : `format=yuva420p`;
  return [
    `[${idx}:v]${conv}[st]`,
    `[${base}][st]overlay=x=${o.x}:y=${o.y}:eof_action=endall:format=yuv420:enable='between(t,${o.start},${o.end})'[${out}]`,
  ];
}
export const stickerInput = (file: string, seconds: number) => ["-loop", "1", "-framerate", String(FPS), "-t", String(seconds), "-i", file];

export function mixedTimeline(photos: string[]): ClipSpec[] {
  const p = (...i: number[]) => i.map((k) => photos[k % photos.length]!);
  return [
    { kind: "photo", seconds: 4, motion: "kb", photos: p(0), stagger: false },
    { kind: "collage3", seconds: 3, motion: "kb", photos: p(0, 1, 2), stagger: true },
    { kind: "photo", seconds: 3, motion: "pan", photos: p(1), stagger: false, dir: 1 },
    { kind: "collage2", seconds: 3, motion: "kb", photos: p(2, 0), stagger: true },
    { kind: "collage4", seconds: 2, motion: "kb", photos: p(1, 2, 0, 1), stagger: true },
  ];
}
