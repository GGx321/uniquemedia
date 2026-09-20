import { test, expect } from "bun:test";
import { buildPhotoArgs } from "./filterGraph";
import type { PhotoRecipe } from "./types";
import type { MediaInfo } from "../types";

const info: MediaInfo = {
  kind: "photo",
  durationSec: 0,
  width: 1200,
  height: 900,
  hasAudio: false,
};

const recipe: PhotoRecipe = {
  seed: 1,
  intensity: 1,
  exportFormat: "original",
  ops: [
    { id: "eq", params: { brightness: 0.01, contrast: 1.02, saturation: 0.99, gamma: 1 } },
    { id: "hue", params: { h: -2 } },
    { id: "pancrop", params: { windowPct: 0.96, panX: 0.5, panY: -0.5 } },
    { id: "rotate", params: { deg: 0.1 } },
    { id: "lenscorrection", params: { k1: 0.008 } },
    { id: "vignette", params: { angle: 0.5, x0: 0.4, y0: 0.6 } },
    { id: "noise", params: { strength: 4, temporal: false } },
  ],
  encode: { quality: 5, subsampling: "420" },
};

const vfOf = (args: string[]): string => {
  const i = args.indexOf("-vf");
  if (i < 0) throw new Error(`no -vf in ${args.join(" ")}`);
  return args[i + 1];
};

const valueOf = (args: string[], flag: string): string => {
  const i = args.indexOf(flag);
  if (i < 0) throw new Error(`no ${flag} in ${args.join(" ")}`);
  return args[i + 1];
};

test("uses a plain -vf chain, never filter_complex", () => {
  const args = buildPhotoArgs(recipe, info);
  expect(args).toContain("-vf");
  expect(args).not.toContain("-filter_complex");
});

test("the chain keeps recipe order and ends with setsar=1", () => {
  const vf = vfOf(buildPhotoArgs(recipe, info));
  const parts = vf.split(",");
  expect(parts[parts.length - 1]).toBe("setsar=1");
  expect(vf.indexOf("eq=brightness=0.01")).toBeLessThan(vf.indexOf("crop=1152:864"));
  expect(vf.indexOf("crop=1152:864")).toBeLessThan(vf.indexOf("vignette="));
  expect(vf).toContain("hue=h=-2");
  expect(vf).toContain("lenscorrection=k1=0.008");
  expect(vf).toContain("rotate=");
});

test("pancrop renders as an off-centre crop scaled back to the source size", () => {
  const vf = vfOf(buildPhotoArgs(recipe, info));
  // 1200x900 * 0.96 -> 1152x864, free margin 48x36, panX 0.5 -> x=36, panY -0.5 -> y=9
  expect(vf).toContain("crop=1152:864:36:9,scale=1200:900");
});

test("the off-centre vignette centre is resolved against the frame size", () => {
  const vf = vfOf(buildPhotoArgs(recipe, info));
  const m = vf.match(/pad=\d+:\d+:(\d+):(\d+),vignette=angle=0\.5:x0=(\d+):y0=(\d+)/);
  if (!m) throw new Error(`no padded vignette in ${vf}`);
  expect((Number(m[3]) - Number(m[1])) / info.width).toBeCloseTo(0.4, 2);
  expect((Number(m[4]) - Number(m[2])) / info.height).toBeCloseTo(0.6, 2);
});

test("photo noise carries no temporal component", () => {
  const vf = vfOf(buildPhotoArgs(recipe, info));
  expect(vf).toContain("noise=alls=4:allf=u");
  expect(vf).not.toContain("allf=t");
});

test("no-op fragments are skipped", () => {
  const flat: PhotoRecipe = {
    ...recipe,
    ops: [
      { id: "noise", params: { strength: 0, temporal: false } },
      { id: "rotate", params: { deg: 0 } },
      { id: "lenscorrection", params: { k1: 0 } },
      { id: "pancrop", params: { windowPct: 1, panX: 0, panY: 0 } },
    ],
  };
  const vf = vfOf(buildPhotoArgs(flat, info));
  expect(vf).not.toContain("noise");
  expect(vf).not.toContain("rotate");
  expect(vf).not.toContain("lenscorrection");
  expect(vf).not.toContain("scale=1200:900");
});

test("original format keeps the native size but forces even dimensions", () => {
  const vf = vfOf(buildPhotoArgs(recipe, info));
  expect(vf).toContain("crop=trunc(iw/2)*2:trunc(ih/2)*2");
  expect(vf).not.toContain("force_original_aspect_ratio");
});

test("a fixed export format scales and crops to the target dimensions", () => {
  const vf = vfOf(buildPhotoArgs({ ...recipe, exportFormat: "reels" }, info));
  expect(vf).toContain("scale=1080:1920:force_original_aspect_ratio=increase");
  expect(vf).toContain("crop=1080:1920");
  expect(vf).not.toContain("trunc(iw/2)");
  const parts = vf.split(",");
  expect(parts[parts.length - 1]).toBe("setsar=1");
});

/** The cover step is the last `crop=A:B,scale=W:H` pair in the chain; it has no
 *  x/y offset, unlike pancrop. Returns the kept fraction of the frame. */
function coverFraction(vf: string): number {
  const matches = [...vf.matchAll(/crop=(\d+):(\d+),scale=(\d+):(\d+)/g)];
  const last = matches[matches.length - 1];
  if (!last) return 1;
  return Number(last[1]) / info.width;
}

const geometry = (ops: PhotoRecipe["ops"]): PhotoRecipe => ({ ...recipe, ops });

// Bounds below are the largest centred crop measured clean (no black wedge) on
// a white 4:3 source rendered through real ffmpeg. See the report for the sweep.
test("rotation at the safety ceiling is covered, so no black wedge survives", () => {
  const vf = vfOf(buildPhotoArgs(geometry([{ id: "rotate", params: { deg: 0.6 } }]), info));
  expect(coverFraction(vf)).toBeLessThanOrEqual(0.988);
  expect(coverFraction(vf)).toBeGreaterThan(0.93);
});

test("a baseline-sized rotation is covered too", () => {
  const vf = vfOf(buildPhotoArgs(geometry([{ id: "rotate", params: { deg: 0.15 } }]), info));
  expect(coverFraction(vf)).toBeLessThanOrEqual(0.996);
  expect(coverFraction(vf)).toBeGreaterThan(0.97);
});

test("positive lens distortion at the safety ceiling is covered", () => {
  const vf = vfOf(buildPhotoArgs(geometry([{ id: "lenscorrection", params: { k1: 0.04 } }]), info));
  expect(coverFraction(vf)).toBeLessThanOrEqual(0.964);
  expect(coverFraction(vf)).toBeGreaterThan(0.93);
});

/**
 * The exact largest safe fraction under `lenscorrection` with k1 > 0, solved
 * here independently of the implementation.
 *
 * ffmpeg normalises the radius against the frame's own half-diagonal, so the
 * corner of the picture sits at r = 0.5 and a source point lands at
 * r * (1 + k1*r²) — which for the corner is t * (1 + 0.25*k1*t²), i.e.
 * `t + 0.25*k1*t³ = 1`. The implementation solves the stricter `t + k1*t³ = 1`
 * and therefore crops slightly MORE than geometry demands: deliberate slack,
 * on the safe side, since interpolation can still leave a soft pixel at the
 * very edge.
 */
function exactLensCover(k1: number): number {
  let lo = 0.5;
  let hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (mid + 0.25 * k1 * mid ** 3 > 1) hi = mid;
    else lo = mid;
  }
  return lo;
}

test("the lens cover never keeps more of the frame than geometry allows", () => {
  // The invariant the slack exists to protect: cropping more than necessary
  // costs a sliver of picture, cropping less puts a black wedge in the corner.
  // Anything at or inside the exact bound is safe; anything outside it is not.
  for (const k1 of [0.004, 0.01, 0.02, 0.03, 0.04]) {
    const vf = vfOf(buildPhotoArgs(geometry([{ id: "lenscorrection", params: { k1 } }]), info));
    expect(coverFraction(vf)).toBeLessThanOrEqual(exactLensCover(k1));
    // ...and the slack stays a sliver rather than quietly eating the picture.
    expect(coverFraction(vf)).toBeGreaterThan(exactLensCover(k1) * 0.95);
  }
});

test("rotation and lens distortion combine into a single tighter cover", () => {
  const vf = vfOf(
    buildPhotoArgs(
      geometry([
        { id: "rotate", params: { deg: -0.6 } },
        { id: "lenscorrection", params: { k1: 0.04 } },
      ]),
      info
    )
  );
  expect(coverFraction(vf)).toBeLessThanOrEqual(0.954);
  expect(coverFraction(vf)).toBeGreaterThan(0.9);
});

test("negative lens distortion leaves no wedge and gets no cover", () => {
  const vf = vfOf(buildPhotoArgs(geometry([{ id: "lenscorrection", params: { k1: -0.04 } }]), info));
  expect(vf).toBe("lenscorrection=k1=-0.04:k2=0,crop=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1");
});

test("a recipe with no edge-eating geometry gets no cover step", () => {
  const vf = vfOf(
    buildPhotoArgs(
      geometry([
        { id: "eq", params: { brightness: 0.01, contrast: 1, saturation: 1, gamma: 1 } },
        { id: "rotate", params: { deg: 0 } },
        { id: "lenscorrection", params: { k1: 0 } },
      ]),
      info
    )
  );
  expect(vf).toBe("eq=brightness=0.01:contrast=1:saturation=1:gamma=1,crop=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1");
});

/** The vignette pads the canvas and crops it back at a fixed offset, which is
 *  only correct if the frame still has its nominal size — so the cover has to
 *  close the geometry section, not trail at the end of the chain. */
test("the cover closes the geometry section before the vignette pads the canvas", () => {
  const vf = vfOf(buildPhotoArgs(recipe, info));
  // The cover is the offset-less `crop=A:B,scale=W:H`; pancrop's crop carries x/y.
  const cover = vf.search(new RegExp(`crop=\\d+:\\d+,scale=${info.width}:${info.height}`));
  expect(cover).toBeGreaterThan(vf.indexOf("lenscorrection="));
  expect(cover).toBeLessThan(vf.indexOf("pad="));
});

test("the padded vignette crop matches the frame the cover restores", () => {
  const vf = vfOf(buildPhotoArgs(recipe, info));
  const m = vf.match(/pad=(\d+):(\d+):(\d+):(\d+)/);
  if (!m) throw new Error(`no pad in ${vf}`);
  expect(Number(m[1])).toBeGreaterThanOrEqual(info.width + Number(m[3]));
  expect(Number(m[2])).toBeGreaterThanOrEqual(info.height + Number(m[4]));
  expect(vf).toContain(`crop=${info.width}:${info.height}:${m[3]}:${m[4]}`);
});

test("the cover runs after the geometry ops and before the export framing", () => {
  const vf = vfOf(buildPhotoArgs({ ...recipe, exportFormat: "reels" }, info));
  const cover = vf.lastIndexOf(`,scale=${info.width}:${info.height}`);
  expect(cover).toBeGreaterThan(vf.indexOf("rotate="));
  expect(cover).toBeLessThan(vf.indexOf("scale=1080:1920"));
});

test("emits the recipe jpeg quality", () => {
  expect(valueOf(buildPhotoArgs(recipe, info), "-q:v")).toBe("5");
  const q3 = { ...recipe, encode: { quality: 3, subsampling: "444" as const } };
  expect(valueOf(buildPhotoArgs(q3, info), "-q:v")).toBe("3");
});

test("subsampling maps to the matching jpeg pixel format", () => {
  expect(valueOf(buildPhotoArgs(recipe, info), "-pix_fmt")).toBe("yuvj420p");
  const p444 = { ...recipe, encode: { quality: 5, subsampling: "444" as const } };
  expect(valueOf(buildPhotoArgs(p444, info), "-pix_fmt")).toBe("yuvj444p");
});

test("strips source metadata", () => {
  const args = buildPhotoArgs(recipe, info);
  expect(valueOf(args, "-map_metadata")).toBe("-1");
});

test("emits nothing temporal, nothing audio and no video-encoder flags", () => {
  const args = buildPhotoArgs(recipe, info);
  const vf = vfOf(args);
  for (const banned of ["setpts", "atempo", "asplit", "split=", "concat", "trim=", "fps"]) {
    expect(vf).not.toContain(banned);
  }
  for (const flag of [
    "-filter_complex",
    "-c:a",
    "-b:a",
    "-an",
    "-r",
    "-g",
    "-crf",
    "-fps_mode",
    "-keyint_min",
    "-preset",
    "-maxrate",
    "-movflags",
  ]) {
    expect(args).not.toContain(flag);
  }
});
