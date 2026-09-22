import { test, expect } from "bun:test";
import { sampleRecipe } from "./sampler";
import { samplePhotoRecipe } from "./photo/sampler";
import type { MediaInfo, Operation, Recipe, ResolvedCopyOptions, ResolvedCover } from "./types";
import type { PhotoRecipe } from "./photo/types";

/**
 * The first-frame mode is a setting, copied into the recipe; the cover recipe
 * inside the `photo` arm is a DRAW. The two facts have to hold together: the
 * draw happens on the photo sampler's own rng stream, so switching a batch
 * from `off` to `photo` changes what frame 0 is and nothing else about the
 * copy. If it ever shared the video rng, the same seed would stop meaning the
 * same copy the moment the mode changed.
 */

const coverInfo: MediaInfo = { kind: "photo", durationSec: 0, width: 1200, height: 900, hasAudio: false };

const cover: ResolvedCover = { path: "/covers/one.jpg", edge: { mode: "crop" }, info: coverInfo };

const base: ResolvedCopyOptions = {
  strength: 1.0,
  exportFormat: "reels",
  keepTrendAudio: false,
  allowMirror: false,
  targetDistance: 90,
  identity: "engine",
  edgeMode: "auto",
  firstFrame: { mode: "off" },
};

const withPhoto = (c: ResolvedCover = cover): ResolvedCopyOptions => ({
  ...base,
  firstFrame: { mode: "photo", cover: c },
});

/** The cover as the photo sampler would draw it for this copy: the video's
 *  strength, never mirrored, framed as it is, edge as resolved. */
function expectedCover(opts: ResolvedCopyOptions, c: ResolvedCover, seed: number, intensity: number): PhotoRecipe {
  return samplePhotoRecipe(
    {
      strength: opts.strength,
      exportFormat: "original",
      allowMirror: false,
      targetDistance: opts.targetDistance,
      identity: opts.identity,
      edge: c.edge,
    },
    seed,
    intensity
  );
}

function coverRecipe(recipe: Recipe): PhotoRecipe {
  if (recipe.firstFrame.mode !== "photo") throw new Error(`first frame is ${recipe.firstFrame.mode}, not photo`);
  return recipe.firstFrame.recipe;
}

function opFor(recipe: PhotoRecipe, id: string): Operation {
  const op = recipe.ops.find((o) => o.id === id);
  if (!op) throw new Error(`recipe has no "${id}" op`);
  return op;
}

const withoutFirstFrame = ({ firstFrame: _f, ...rest }: Recipe): Omit<Recipe, "firstFrame"> => rest;

test("mode off is carried as {mode: off} and nothing more", () => {
  expect(sampleRecipe(base, 5, 1).firstFrame).toEqual({ mode: "off" });
});

test("mode black is carried as {mode: black} and nothing more", () => {
  expect(sampleRecipe({ ...base, firstFrame: { mode: "black" } }, 5, 1).firstFrame).toEqual({ mode: "black" });
});

test("mode photo carries the cover's path and dimensions with a recipe drawn from the copy's seed", () => {
  const recipe = sampleRecipe(withPhoto(), 5, 1);
  expect(recipe.firstFrame).toEqual({
    mode: "photo",
    path: "/covers/one.jpg",
    info: coverInfo,
    recipe: expectedCover(base, cover, 5, 1),
  });
});

test("the cover recipe is drawn at the copy's intensity, so auto-strengthen escalates the cover too", () => {
  const recipe = sampleRecipe(withPhoto(), 5, 1.96);
  expect(coverRecipe(recipe).intensity).toBe(1.96);
  expect(coverRecipe(recipe)).toEqual(expectedCover(base, cover, 5, 1.96));
});

test("every field but firstFrame is identical between off, black and photo for the same seed", () => {
  // The rng invariant. The photo sampler is seeded on its own, so however
  // many draws the cover takes, the video draws — eq, geometry, segments,
  // encode — come out the same.
  for (let seed = 1; seed <= 100; seed++) {
    const off = sampleRecipe(base, seed, 1);
    const black = sampleRecipe({ ...base, firstFrame: { mode: "black" } }, seed, 1);
    const photo = sampleRecipe(withPhoto(), seed, 1);
    expect(withoutFirstFrame(black)).toEqual(withoutFirstFrame(off));
    expect(withoutFirstFrame(photo)).toEqual(withoutFirstFrame(off));
  }
});

test("the same seed and options draw the same cover recipe", () => {
  expect(coverRecipe(sampleRecipe(withPhoto(), 42, 1))).toEqual(coverRecipe(sampleRecipe(withPhoto(), 42, 1)));
});

test("different copy seeds draw different covers: the crop window moves between copies", () => {
  // What keeps two copies' first frames apart is the pan/window draw, not
  // the tone — see the photo design notes. So it is the window that has to
  // differ, not merely "something".
  const a = opFor(coverRecipe(sampleRecipe(withPhoto(), 1000, 1)), "pancrop").params;
  const b = opFor(coverRecipe(sampleRecipe(withPhoto(), 2000, 1)), "pancrop").params;
  expect([a.windowPct, a.panX, a.panY]).not.toEqual([b.windowPct, b.panX, b.panY]);
});

test("the cover is never mirrored, even when the video is allowed to be", () => {
  // A mirrored cover flips any text on it; the video's own mirror draw is
  // unaffected either way.
  for (let seed = 1; seed <= 60; seed++) {
    const recipe = sampleRecipe({ ...withPhoto(), allowMirror: true }, seed, 1);
    expect(coverRecipe(recipe).ops.some((o) => o.id === "hflip")).toBe(false);
  }
});

test("the cover keeps its own framing whatever the video exports as", () => {
  // The graph fits the cover to the video afterwards; sampling it as `reels`
  // would frame it to EXPORT_DIMS before the fit and crop it twice.
  for (const exportFormat of ["reels", "feed", "square", "original"] as const) {
    const recipe = sampleRecipe({ ...withPhoto(), exportFormat }, 3, 1);
    expect(coverRecipe(recipe).exportFormat).toBe("original");
    expect(recipe.exportFormat).toBe(exportFormat);
  }
});

test("the cover takes the video's strength", () => {
  const strong = sampleRecipe({ ...withPhoto(), strength: 1.5 }, 7, 1);
  expect(coverRecipe(strong)).toEqual(expectedCover({ ...base, strength: 1.5 }, cover, 7, 1));
});

test("a cover resolved to fit pads with the colour the route measured", () => {
  const fit: ResolvedCover = { ...cover, edge: { mode: "fit", padColor: "0x0A0B0C" } };
  const recipe = sampleRecipe(withPhoto(fit), 5, 1);
  const pad = opFor(coverRecipe(recipe), "fitpad").params;
  expect(pad.padColor).toBe("0x0A0B0C");
  expect(coverRecipe(recipe).ops.some((o) => o.id === "pancrop")).toBe(false);
});

test("a cover resolved to crop is cropped, never padded", () => {
  const recipe = sampleRecipe(withPhoto(), 5, 1);
  expect(coverRecipe(recipe).ops.some((o) => o.id === "pancrop")).toBe(true);
  expect(coverRecipe(recipe).ops.some((o) => o.id === "fitpad")).toBe(false);
});

test("the recipe carries no blackFirstFrame field any more", () => {
  // The boolean became a mode. A recipe still carrying the old field would be
  // read by nobody and would read as a setting the graph honours.
  expect("blackFirstFrame" in sampleRecipe(base, 5, 1)).toBe(false);
});
