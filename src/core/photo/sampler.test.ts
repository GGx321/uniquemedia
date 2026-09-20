import { test, expect } from "bun:test";
import { samplePhotoRecipe } from "./sampler";
import type { PhotoRecipe, ResolvedPhotoOptions } from "./types";
import type { Operation } from "../types";

/** The sampler never sees `auto` and never sees pixels: the route decides the
 *  mode where the image is available and hands down a concrete one. */
const opts: ResolvedPhotoOptions = {
  strength: 1.0,
  exportFormat: "original",
  allowMirror: false,
  targetDistance: 90,
  spoofMetadata: false,
  edge: { mode: "crop" },
};

const fitOpts: ResolvedPhotoOptions = {
  ...opts,
  edge: { mode: "fit", padColor: "0x0A0B0C" },
};

/** Op lookup that fails loudly instead of leaning on a non-null assertion. */
function opFor(recipe: PhotoRecipe, id: string): Operation {
  const op = recipe.ops.find((o) => o.id === id);
  if (!op) throw new Error(`recipe has no "${id}" op`);
  return op;
}

const num = (recipe: PhotoRecipe, id: string, key: string): number =>
  Number(opFor(recipe, id).params[key]);

/** Every intensity the auto-strengthen loop can realistically reach, plus absurd ones. */
const INTENSITIES = [1, 1.4, 3.8, 10, 100];

test("same seed and options produce an identical recipe", () => {
  expect(samplePhotoRecipe(opts, 42, 1)).toEqual(samplePhotoRecipe(opts, 42, 1));
  expect(samplePhotoRecipe(opts, 42, 2.5)).toEqual(samplePhotoRecipe(opts, 42, 2.5));
});

test("different seeds produce different recipes", () => {
  expect(samplePhotoRecipe(opts, 1, 1)).not.toEqual(samplePhotoRecipe(opts, 2, 1));
});

test("recipe carries the caller's seed, intensity and export format", () => {
  const r = samplePhotoRecipe({ ...opts, exportFormat: "square", spoofMetadata: true }, 9, 1.4);
  expect(r.seed).toBe(9);
  expect(r.intensity).toBe(1.4);
  expect(r.exportFormat).toBe("square");
});

test("the recipe carries no field the photo graph does not read", () => {
  // `spoof` used to sit here, copied from `opts.spoofMetadata` and read by
  // nobody: `buildPhotoArgs` never looked at it, and the pipeline drives
  // spoofing from the options directly. A recipe field that nothing consumes
  // reads as a setting the renderer honours, and the next person to add one
  // finds precedent for it. Pinning the whole key set is what makes the next
  // dead field visible the moment it appears.
  const r = samplePhotoRecipe({ ...opts, spoofMetadata: true }, 9, 1.4);
  expect(Object.keys(r).sort()).toEqual([
    "encode",
    "exportFormat",
    "intensity",
    "ops",
    "seed",
  ]);
});

test("every recipe carries the primary geometric levers", () => {
  for (let seed = 0; seed < 25; seed++) {
    const ids = samplePhotoRecipe(opts, seed, 1).ops.map((o) => o.id);
    expect(ids).toContain("pancrop");
    expect(ids).toContain("vignette");
    expect(ids).toContain("rotate");
    expect(ids).toContain("lenscorrection");
  }
});

test("recipe has no video-only temporal ops", () => {
  const ids = samplePhotoRecipe(opts, 3, 1).ops.map((o) => o.id);
  expect(ids).not.toContain("speed");
  expect(ids).not.toContain("encode");
  expect(ids).not.toContain("aeq");
});

test("photo noise is spatial only: temporal is explicitly off", () => {
  for (let seed = 0; seed < 25; seed++) {
    expect(opFor(samplePhotoRecipe(opts, seed, 1), "noise").params.temporal).toBe(false);
  }
});

test("pancrop tightens on average as intensity rises", () => {
  let soft = 0;
  let hard = 0;
  for (let seed = 0; seed < 60; seed++) {
    soft += num(samplePhotoRecipe(opts, seed, 1), "pancrop", "windowPct");
    hard += num(samplePhotoRecipe(opts, seed, 3), "pancrop", "windowPct");
  }
  expect(hard).toBeLessThan(soft);
});

test("the vignette centre varies across seeds", () => {
  const centres = new Set<string>();
  for (let seed = 0; seed < 50; seed++) {
    const r = samplePhotoRecipe(opts, seed, 1);
    centres.add(`${num(r, "vignette", "x0")}/${num(r, "vignette", "y0")}`);
  }
  expect(centres.size).toBeGreaterThan(40);
});

test("the vignette centre is off-centre for most copies", () => {
  let offCentre = 0;
  for (let seed = 0; seed < 50; seed++) {
    const r = samplePhotoRecipe(opts, seed, 1);
    if (Math.abs(num(r, "vignette", "x0") - 0.5) > 0.02) offCentre++;
  }
  expect(offCentre).toBeGreaterThan(40);
});

for (const intensity of INTENSITIES) {
  test(`safety ceilings hold at intensity ${intensity}`, () => {
    for (let seed = 0; seed < 150; seed++) {
      const r = samplePhotoRecipe({ ...opts, strength: 1.5 }, seed, intensity);
      const windowPct = num(r, "pancrop", "windowPct");
      expect(windowPct).toBeGreaterThanOrEqual(0.88);
      expect(windowPct).toBeLessThanOrEqual(1);

      expect(Math.abs(num(r, "pancrop", "panX"))).toBeLessThanOrEqual(1);
      expect(Math.abs(num(r, "pancrop", "panY"))).toBeLessThanOrEqual(1);

      expect(Math.abs(num(r, "rotate", "deg"))).toBeLessThanOrEqual(0.6);

      const angle = num(r, "vignette", "angle");
      expect(angle).toBeGreaterThan(0);
      expect(angle).toBeLessThanOrEqual(0.6);

      const strength = num(r, "noise", "strength");
      expect(strength).toBeGreaterThanOrEqual(0);
      expect(strength).toBeLessThanOrEqual(12);
    }
  });

  test(`secondary levers stay inside visible-damage limits at intensity ${intensity}`, () => {
    for (let seed = 0; seed < 150; seed++) {
      const r = samplePhotoRecipe({ ...opts, strength: 1.5 }, seed, intensity);
      // brightness is not bounded here, it is absent — see the dedicated test.
      // contrast and gamma are one-sided, so their neutral value IS a bound.
      expect(num(r, "eq", "contrast")).toBeGreaterThanOrEqual(1);
      expect(num(r, "eq", "contrast")).toBeLessThanOrEqual(1.25);
      expect(num(r, "eq", "saturation")).toBeGreaterThanOrEqual(0.7);
      expect(num(r, "eq", "saturation")).toBeLessThanOrEqual(1.3);
      expect(num(r, "eq", "gamma")).toBeGreaterThanOrEqual(0.8);
      expect(num(r, "eq", "gamma")).toBeLessThanOrEqual(1);
      expect(Math.abs(num(r, "hue", "h"))).toBeLessThanOrEqual(12);
      expect(Math.abs(num(r, "lenscorrection", "k1"))).toBeLessThanOrEqual(0.04);

      // The off-centre vignette is rendered on a padded canvas whose size grows
      // with the offset, so the offset is capped to keep that canvas sane.
      const x0 = num(r, "vignette", "x0");
      const y0 = num(r, "vignette", "y0");
      expect(x0).toBeGreaterThanOrEqual(0.38);
      expect(x0).toBeLessThanOrEqual(0.62);
      expect(y0).toBeGreaterThanOrEqual(0.38);
      expect(y0).toBeLessThanOrEqual(0.62);
    }
  });
}

test("the baseline is soft: at intensity 1 no ceiling is reached", () => {
  for (let seed = 0; seed < 100; seed++) {
    const r = samplePhotoRecipe(opts, seed, 1);
    expect(num(r, "pancrop", "windowPct")).toBeGreaterThan(0.93);
    expect(Math.abs(num(r, "rotate", "deg"))).toBeLessThan(0.2);
    expect(num(r, "noise", "strength")).toBeLessThanOrEqual(6);
    // The vignette is the one lever whose baseline tail now touches its ceiling
    // exactly (0.45 + 0.15 = 0.6); everything else stays clear of its limit.
    expect(num(r, "vignette", "angle")).toBeLessThanOrEqual(0.6);
  }
});

test("mirror disabled never emits hflip", () => {
  for (let seed = 0; seed < 60; seed++) {
    expect(samplePhotoRecipe(opts, seed, 1).ops.some((o) => o.id === "hflip")).toBe(false);
  }
});

test("mirror allowed emits hflip for roughly half the seeds", () => {
  let mirrored = 0;
  for (let seed = 0; seed < 100; seed++) {
    const r = samplePhotoRecipe({ ...opts, allowMirror: true }, seed, 1);
    if (r.ops.some((o) => o.id === "hflip" && o.params.on === true)) mirrored++;
  }
  expect(mirrored).toBeGreaterThan(25);
  expect(mirrored).toBeLessThan(75);
});

test("jpeg quality stays in 3..7 and is a whole number", () => {
  for (let seed = 0; seed < 60; seed++) {
    const q = samplePhotoRecipe(opts, seed, 1).encode.quality;
    expect(Number.isInteger(q)).toBe(true);
    expect(q).toBeGreaterThanOrEqual(3);
    expect(q).toBeLessThanOrEqual(7);
  }
});

test("subsampling is drawn from 420/444 and both appear across seeds", () => {
  const seen = new Set<string>();
  for (let seed = 0; seed < 60; seed++) {
    const sub = samplePhotoRecipe(opts, seed, 1).encode.subsampling;
    expect(["420", "444"]).toContain(sub);
    seen.add(sub);
  }
  expect(seen.size).toBe(2);
});

test("jpeg quality varies across seeds", () => {
  const seen = new Set<number>();
  for (let seed = 0; seed < 60; seed++) seen.add(samplePhotoRecipe(opts, seed, 1).encode.quality);
  expect(seen.size).toBeGreaterThan(1);
});

test("the encoder fingerprint is decoupled from the strength scalar", () => {
  for (let seed = 0; seed < 30; seed++) {
    const a = samplePhotoRecipe(opts, seed, 1).encode;
    const b = samplePhotoRecipe(opts, seed, 4).encode;
    const c = samplePhotoRecipe({ ...opts, strength: 1.5 }, seed, 1).encode;
    expect(a).toEqual(b);
    expect(a).toEqual(c);
  }
});

/** ffmpeg's `eq` brightness is additive, so it moves pure black off zero — the
 *  one tonal term that is visible on the flat background a story is built on,
 *  and worth nothing in exchange (the whole eq block shifts PDQ by 0 on real
 *  content). Bounding it is not enough: any non-zero value lifts black, and the
 *  sampler's draw is symmetric, so half of all seeds lift it. It has to be
 *  gone. The video sampler keeps it — that path is pinned byte-for-byte. */
test("the photo eq carries no brightness term at any intensity", () => {
  for (const intensity of INTENSITIES) {
    for (let seed = 0; seed < 150; seed++) {
      const r = samplePhotoRecipe({ ...opts, strength: 1.5 }, seed, intensity);
      expect(opFor(r, "eq").params.brightness).toBeUndefined();
      expect(Object.keys(opFor(r, "eq").params).sort()).toEqual([
        "contrast",
        "gamma",
        "saturation",
      ]);
    }
  }
});

const ids = (r: PhotoRecipe): string[] => r.ops.map((o) => o.id);

test("crop mode cuts the window out and never pads", () => {
  for (let seed = 0; seed < 25; seed++) {
    const got = ids(samplePhotoRecipe(opts, seed, 1));
    expect(got).toContain("pancrop");
    expect(got).not.toContain("fitpad");
  }
});

test("fit mode pads the window back and never crops", () => {
  for (let seed = 0; seed < 25; seed++) {
    const got = ids(samplePhotoRecipe(fitOpts, seed, 1));
    expect(got).toContain("fitpad");
    expect(got).not.toContain("pancrop");
  }
});

test("both modes place the same window from the same seed", () => {
  // One draw, two directions. If the modes drew separately, switching the
  // option would silently change which part of the frame carries the shift.
  for (let seed = 0; seed < 40; seed++) {
    const crop = opFor(samplePhotoRecipe(opts, seed, 1), "pancrop").params;
    const fit = opFor(samplePhotoRecipe(fitOpts, seed, 1), "fitpad").params;
    expect(fit.scalePct).toBe(crop.windowPct);
    expect(fit.panX).toBe(crop.panX);
    expect(fit.panY).toBe(crop.panY);
  }
});

test("fit mode carries the padding colour it was resolved with", () => {
  expect(opFor(samplePhotoRecipe(fitOpts, 5, 1), "fitpad").params.padColor).toBe("0x0A0B0C");
});

test("the fitpad window honours the same floor as the crop window", () => {
  // 0.88 is the most a still may shrink before the change stops being
  // unremarkable, whichever direction the window is drawn in.
  for (const intensity of INTENSITIES) {
    for (let seed = 0; seed < 150; seed++) {
      const pct = num(samplePhotoRecipe({ ...fitOpts, strength: 1.5 }, seed, intensity), "fitpad", "scalePct");
      expect(pct).toBeGreaterThanOrEqual(0.88);
      expect(pct).toBeLessThanOrEqual(1);
    }
  }
});

/**
 * Fit mode exists so that nothing is lost. `rotate` widens the canvas and
 * `lenscorrection` pulls the picture off the edge, and the photo graph covers
 * both by cropping the largest guaranteed-real rectangle and scaling it back —
 * measured at ~2% of the frame for a baseline draw, i.e. 11 px off a 1080-wide
 * still. That crop is centred, so on the side the fitpad pushed flush against
 * the frame it eats real picture, which is the very thing fit mode is for.
 *
 * The values are still DRAWN, so both modes consume the rng identically and a
 * copy keeps its identity when the mode flips; they are just not applied.
 */
test("fit mode emits no lever that would need a cover crop", () => {
  for (const intensity of INTENSITIES) {
    for (let seed = 0; seed < 100; seed++) {
      const r = samplePhotoRecipe({ ...fitOpts, strength: 1.5 }, seed, intensity);
      expect(num(r, "rotate", "deg")).toBe(0);
      expect(num(r, "lenscorrection", "k1")).toBe(0);
    }
  }
});

test("crop mode still uses rotation and lens distortion", () => {
  let moved = 0;
  for (let seed = 0; seed < 60; seed++) {
    const r = samplePhotoRecipe(opts, seed, 1);
    if (num(r, "rotate", "deg") !== 0 && num(r, "lenscorrection", "k1") !== 0) moved++;
  }
  expect(moved).toBeGreaterThan(55);
});

test("fit mode keeps every lever that costs no picture", () => {
  const got = ids(samplePhotoRecipe(fitOpts, 3, 1));
  for (const id of ["eq", "hue", "vignette", "noise"]) expect(got).toContain(id);
});

test("a fit recipe is as reproducible as a crop one", () => {
  expect(samplePhotoRecipe(fitOpts, 42, 1)).toEqual(samplePhotoRecipe(fitOpts, 42, 1));
  expect(samplePhotoRecipe(fitOpts, 42, 2.5)).toEqual(samplePhotoRecipe(fitOpts, 42, 2.5));
});

test("the fit window tightens on average as intensity rises", () => {
  let soft = 0;
  let hard = 0;
  for (let seed = 0; seed < 60; seed++) {
    soft += num(samplePhotoRecipe(fitOpts, seed, 1), "fitpad", "scalePct");
    hard += num(samplePhotoRecipe(fitOpts, seed, 3), "fitpad", "scalePct");
  }
  expect(hard).toBeLessThan(soft);
});

/**
 * `eq` is multiplicative about MID-GREY, not about zero, so each of these two
 * terms has one side that lifts pure black and one that cannot:
 *
 *   contrast c — the floor becomes (0 - 0.5)*c + 0.5, which is <= 0 exactly
 *     when c >= 1. Measured 24/255 at c = 0.8, worse than the additive
 *     brightness that was removed for the same reason, and reachable by
 *     auto-strengthen.
 *   gamma g — measured 13/255 at g = 1.25 and 0 at g = 0.8.
 *
 * Probing either from above alone hides it: contrast 1.06 clamps the floor back
 * to 0 and reads perfectly clean. So the guard is arithmetic rather than
 * "rendered it and saw zero" — a batch of seeds can draw the safe side by luck,
 * as the brightness case demonstrated.
 *
 * `saturation` stays two-sided: it scales chroma and leaves a grey of any level
 * exactly where it was.
 */
test("the photo eq never draws a contrast below 1 or a gamma above 1", () => {
  for (const intensity of INTENSITIES) {
    for (let seed = 0; seed < 150; seed++) {
      const r = samplePhotoRecipe({ ...opts, strength: 1.5 }, seed, intensity);
      expect(num(r, "eq", "contrast")).toBeGreaterThanOrEqual(1);
      expect(num(r, "eq", "gamma")).toBeLessThanOrEqual(1);
    }
  }
});

test("one-sided halves each range rather than dropping the lever", () => {
  // "Never below 1" would also be satisfied by never moving at all, which would
  // quietly cost two levers instead of half of two. So the claim is that each
  // one still reaches across its remaining half: the intensity-1 deviation is
  // 0.036, and a hundred seeds should get close to the far end of it.
  const contrasts: number[] = [];
  const gammas: number[] = [];
  for (let seed = 0; seed < 100; seed++) {
    const r = samplePhotoRecipe(opts, seed, 1);
    contrasts.push(num(r, "eq", "contrast"));
    gammas.push(num(r, "eq", "gamma"));
  }
  expect(Math.max(...contrasts)).toBeGreaterThan(1.03);
  expect(Math.min(...gammas)).toBeLessThan(0.97);
  // And spread across it, not clustered at one value. Not ~100 distinct: the
  // values are rounded to 4 digits over a range only 0.036 wide, so collisions
  // are expected and are not the lever standing still.
  expect(new Set(contrasts).size).toBeGreaterThan(60);
  expect(new Set(gammas).size).toBeGreaterThan(60);
});

test("saturation stays two-sided, because it cannot lift black", () => {
  let below = 0;
  let above = 0;
  for (let seed = 0; seed < 100; seed++) {
    const sat = num(samplePhotoRecipe(opts, seed, 1), "eq", "saturation");
    if (sat < 1) below++;
    if (sat > 1) above++;
  }
  expect(below).toBeGreaterThan(25);
  expect(above).toBeGreaterThan(25);
});
