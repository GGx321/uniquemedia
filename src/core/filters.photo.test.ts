import { test, expect } from "bun:test";
import { FRAGMENTS } from "./filters";
import type { MediaInfo } from "./types";

const info: MediaInfo = {
  kind: "photo",
  durationSec: 0,
  width: 1280,
  height: 720,
  hasAudio: false,
};

interface Window {
  w: number;
  h: number;
  x: number;
  y: number;
  sw: number;
  sh: number;
}

function parsePancrop(out: string | null): Window {
  if (out === null) throw new Error("pancrop returned null");
  const m = out.match(/^crop=(\d+):(\d+):(\d+):(\d+),scale=(\d+):(\d+)$/);
  if (!m) throw new Error(`unexpected pancrop output: ${out}`);
  return {
    w: Number(m[1]),
    h: Number(m[2]),
    x: Number(m[3]),
    y: Number(m[4]),
    sw: Number(m[5]),
    sh: Number(m[6]),
  };
}

test("pancrop crops a centred window and scales it back to the source size", () => {
  const out = FRAGMENTS.pancrop({ windowPct: 0.955, panX: 0, panY: 0 }, info);
  expect(out).toBe("crop=1222:688:29:16,scale=1280:720");
});

test("pancrop offsets the window towards the requested corner", () => {
  const right = parsePancrop(FRAGMENTS.pancrop({ windowPct: 0.9, panX: 1, panY: 1 }, info));
  const left = parsePancrop(FRAGMENTS.pancrop({ windowPct: 0.9, panX: -1, panY: -1 }, info));
  expect(left.x).toBe(0);
  expect(left.y).toBe(0);
  expect(right.x).toBe(info.width - right.w);
  expect(right.y).toBe(info.height - right.h);
});

test("pancrop window never leaves the frame for extreme pan values", () => {
  for (const windowPct of [0.88, 0.9, 0.955, 0.999]) {
    for (const panX of [-9, -1.5, -1, -0.3, 0, 0.7, 1, 4, 100]) {
      for (const panY of [-100, -1, 0, 1, 12]) {
        const win = parsePancrop(FRAGMENTS.pancrop({ windowPct, panX, panY }, info));
        expect(win.x).toBeGreaterThanOrEqual(0);
        expect(win.y).toBeGreaterThanOrEqual(0);
        expect(win.x + win.w).toBeLessThanOrEqual(info.width);
        expect(win.y + win.h).toBeLessThanOrEqual(info.height);
        expect(win.sw).toBe(info.width);
        expect(win.sh).toBe(info.height);
      }
    }
  }
});

test("pancrop is a no-op when the window covers the whole frame", () => {
  expect(FRAGMENTS.pancrop({ windowPct: 1, panX: 0.5, panY: 0.5 }, info)).toBeNull();
  expect(FRAGMENTS.pancrop({ windowPct: 1.4, panX: 0, panY: 0 }, info)).toBeNull();
});

test("noise keeps the temporal flag when `temporal` is not specified (video path)", () => {
  expect(FRAGMENTS.noise({ strength: 7 }, info)).toBe("noise=alls=7:allf=t+u");
  expect(FRAGMENTS.noise({ strength: 7, temporal: true }, info)).toBe("noise=alls=7:allf=t+u");
});

test("noise drops the temporal flag when `temporal` is false", () => {
  expect(FRAGMENTS.noise({ strength: 5, temporal: false }, info)).toContain("noise=c0s=5:c0f=u");
});

/** Uniform noise lifts pure black (measured peak per RGB channel:
 *  1 per channel at 6, 4 at 12, with luma-only noise) and clamps the
 *  other half away. On a still that
 *  glows on an AMOLED screen, so a knee takes the lift back out: only the
 *  floor the noise lifted is remapped, everything above twice the lift stays. */
test("a still's noise is followed by a luma knee over the lifted floor only", () => {
  const out = FRAGMENTS.noise({ strength: 5, temporal: false }, info);
  const luma = "if(lt(val,minval+4),max(minval,minval+2*(val-minval-2)),val)";
  expect(out).toBe(`noise=c0s=5:c0f=u,lutyuv=y='${luma}'`);
});

test("the video's noise carries no black point", () => {
  expect(FRAGMENTS.noise({ strength: 5 }, info)).not.toContain("lut");
});

test("noise stays a no-op at zero strength regardless of the temporal flag", () => {
  expect(FRAGMENTS.noise({ strength: 0, temporal: false }, info)).toBeNull();
});

/** `eq` is the one fragment shared with the video path that a still now feeds
 *  differently: a photo draws no `brightness` at all. ffmpeg's `eq` brightness
 *  is ADDITIVE, so it lifts pure black off zero — measured at 5/255 for
 *  brightness=0.03 — while contrast, gamma and saturation are multiplicative
 *  and leave zero at zero. On an AMOLED phone, which is where a story is read,
 *  a black pixel is an off pixel and 7/255 glows. It buys nothing in exchange:
 *  the whole `eq` block moves PDQ by 0 on real content. */
test("eq omits brightness entirely when the recipe draws none", () => {
  expect(FRAGMENTS.eq({ contrast: 1.02, saturation: 0.99, gamma: 1.01 }, info)).toBe(
    "eq=contrast=1.02:saturation=0.99:gamma=1.01"
  );
});

test("eq still emits every term in the order the video path pins", () => {
  expect(
    FRAGMENTS.eq({ brightness: 0.01, contrast: 1.02, saturation: 0.99, gamma: 1.01 }, info)
  ).toBe("eq=brightness=0.01:contrast=1.02:saturation=0.99:gamma=1.01");
});

test("eq keeps a brightness of exactly zero when one is drawn", () => {
  // Absent and zero are different statements: the video sampler can legitimately
  // draw 0.0 and its chain is pinned byte-for-byte including that term.
  expect(FRAGMENTS.eq({ brightness: 0, contrast: 1, saturation: 1, gamma: 1 }, info)).toBe(
    "eq=brightness=0:contrast=1:saturation=1:gamma=1"
  );
});

interface FitPad {
  sw: number;
  sh: number;
  padW: number;
  padH: number;
  x: number;
  y: number;
  colour: string;
}

function parseFitpad(out: string | null): FitPad {
  if (out === null) throw new Error("fitpad returned null");
  const m = out.match(/^scale=(\d+):(\d+),pad=(\d+):(\d+):(\d+):(\d+):(.+)$/);
  if (!m) throw new Error(`unexpected fitpad output: ${out}`);
  return {
    sw: Number(m[1]),
    sh: Number(m[2]),
    padW: Number(m[3]),
    padH: Number(m[4]),
    x: Number(m[5]),
    y: Number(m[6]),
    colour: m[7],
  };
}

/** `fitpad` is `pancrop` run backwards: the same window is drawn in the same
 *  free margin, but instead of throwing away everything outside it, the picture
 *  is shrunk INTO it and the margin is filled. Measured on the user's story it
 *  shifts PDQ just as far (46 at 0.97, 62 at 0.96, against the crop's 38 at
 *  0.98 and 82 at 0.95) while losing no content at all. */
test("fitpad scales the frame down and pads it back to the source size", () => {
  expect(
    FRAGMENTS.fitpad({ scalePct: 0.955, panX: 0, panY: 0, padColor: "black" }, info)
  ).toBe("scale=1222:688,pad=1280:720:29:16:black");
});

test("fitpad places the shrunken frame where pancrop would have cut", () => {
  // Same draw, opposite direction: for one window and one pan, both fragments
  // put the same rectangle in the same place. That is what lets the sampler
  // feed either from a single set of numbers and stay deterministic.
  for (const pct of [0.88, 0.94, 0.97, 0.999]) {
    for (const panX of [-1, -0.4, 0, 0.6, 1]) {
      for (const panY of [-1, 0, 1]) {
        const crop = parsePancrop(FRAGMENTS.pancrop({ windowPct: pct, panX, panY }, info));
        const fit = parseFitpad(
          FRAGMENTS.fitpad({ scalePct: pct, panX, panY, padColor: "black" }, info)
        );
        expect(fit.sw).toBe(crop.w);
        expect(fit.sh).toBe(crop.h);
        expect(fit.x).toBe(crop.x);
        expect(fit.y).toBe(crop.y);
      }
    }
  }
});

test("fitpad offsets the frame towards the requested corner", () => {
  const far = parseFitpad(
    FRAGMENTS.fitpad({ scalePct: 0.9, panX: 1, panY: 1, padColor: "black" }, info)
  );
  const near = parseFitpad(
    FRAGMENTS.fitpad({ scalePct: 0.9, panX: -1, panY: -1, padColor: "black" }, info)
  );
  expect(near.x).toBe(0);
  expect(near.y).toBe(0);
  expect(far.x).toBe(info.width - far.sw);
  expect(far.y).toBe(info.height - far.sh);
});

test("the padded frame never leaves the canvas for extreme pan values", () => {
  for (const scalePct of [0.88, 0.9, 0.955, 0.999]) {
    for (const panX of [-9, -1.5, -1, -0.3, 0, 0.7, 1, 4, 100]) {
      for (const panY of [-100, -1, 0, 1, 12]) {
        const fit = parseFitpad(
          FRAGMENTS.fitpad({ scalePct, panX, panY, padColor: "0x101010" }, info)
        );
        expect(fit.padW).toBe(info.width);
        expect(fit.padH).toBe(info.height);
        expect(fit.x).toBeGreaterThanOrEqual(0);
        expect(fit.y).toBeGreaterThanOrEqual(0);
        expect(fit.x + fit.sw).toBeLessThanOrEqual(info.width);
        expect(fit.y + fit.sh).toBeLessThanOrEqual(info.height);
      }
    }
  }
});

test("fitpad geometry is whole pixels", () => {
  const out = FRAGMENTS.fitpad({ scalePct: 0.9371, panX: 0.37, panY: -0.61, padColor: "black" }, info);
  expect(out).toMatch(/^scale=\d+:\d+,pad=\d+:\d+:\d+:\d+:[^:]+$/);
});

test("fitpad fills the margin with the colour it was given", () => {
  const fit = parseFitpad(
    FRAGMENTS.fitpad({ scalePct: 0.96, panX: 0, panY: 0, padColor: "0x1A2B3C" }, info)
  );
  expect(fit.colour).toBe("0x1A2B3C");
});

test("fitpad falls back to black when no colour is given", () => {
  // A missing colour must not become the string "undefined" in a filter chain.
  const fit = parseFitpad(FRAGMENTS.fitpad({ scalePct: 0.96, panX: 0, panY: 0 }, info));
  expect(fit.colour).toBe("black");
});

test("fitpad is a no-op when the frame is not shrunk at all", () => {
  expect(FRAGMENTS.fitpad({ scalePct: 1, panX: 0.5, panY: 0.5, padColor: "black" }, info)).toBeNull();
  expect(FRAGMENTS.fitpad({ scalePct: 1.4, panX: 0, panY: 0, padColor: "black" }, info)).toBeNull();
  expect(FRAGMENTS.fitpad({ scalePct: 0, panX: 0, panY: 0, padColor: "black" }, info)).toBeNull();
});
