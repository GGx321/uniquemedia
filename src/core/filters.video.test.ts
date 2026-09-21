import { test, expect } from "bun:test";
import { FRAGMENTS } from "./filters";
import { sampleRecipe } from "./sampler";
import type { CopyOptions, MediaInfo, Operation } from "./types";

/**
 * `filters.ts` is now shared: the photo path added branches inside fragments
 * the video path has shipped for months (`noise` gained a temporal switch,
 * `vignette` gained an off-centre form, `pancrop` appeared beside `zoomcrop`).
 * Nothing pinned the video strings byte-for-byte, so a change to a shared
 * fragment could alter every rendered clip while the whole suite stayed green.
 *
 * These tests pin the exact parameter shapes the VIDEO sampler emits. They are
 * characterisation tests: they encode what ships today, and their only job is
 * to fail loudly if it ever stops shipping.
 */

const info: MediaInfo = { kind: "video", durationSec: 5, width: 1280, height: 720, hasAudio: true };

const opts: CopyOptions = {
  strength: 1.0,
  exportFormat: "reels",
  keepTrendAudio: false,
  allowMirror: false,
  targetDistance: 38,
  identity: "engine",
  edgeMode: "auto",
  blackFirstFrame: false,
};

/** The spatial chain exactly as `buildArgs` assembles it from the fragments. */
function spatialChain(ops: Operation[]): string {
  return ops
    .map((op) => FRAGMENTS[op.id]?.(op.params, info))
    .filter((frag): frag is string => frag !== null && frag !== undefined)
    .join(",");
}

test("the video sampler's vignette shape stays the bare filter", () => {
  // `{ on }` with no centre is the video shape. The photo path passes
  // angle/x0/y0 and gets a pad/vignette/crop sandwich; that branch must stay
  // unreachable from a video recipe.
  expect(FRAGMENTS.vignette({ on: true }, info)).toBe("vignette");
  expect(FRAGMENTS.vignette({ on: false }, info)).toBeNull();
});

test("the video sampler's noise shape keeps the temporal flag", () => {
  // Video omits `temporal` entirely; a still passes `temporal: false` and drops
  // the `t`. Getting `allf=u` into a clip would change every frame of grain.
  expect(FRAGMENTS.noise({ strength: 14 }, info)).toBe("noise=alls=14:allf=t+u");
  expect(FRAGMENTS.noise({ strength: 1 }, info)).toBe("noise=alls=1:allf=t+u");
  expect(FRAGMENTS.noise({ strength: 0 }, info)).toBeNull();
});

test("the whole video spatial chain is byte-identical for seed 1", () => {
  // Seed 1 draws vignette ON and the top noise strength the sampler produces.
  expect(spatialChain(sampleRecipe(opts, 1, 1).video)).toBe(
    "eq=brightness=0.0127:contrast=0.9403:saturation=1.0044:gamma=1.0577," +
      "hue=h=5.6205," +
      "scale=iw*1.0584:ih*1.0584,crop=1280:720," +
      "rotate=0.000197:ow=rotw(0.000197):oh=roth(0.000197):c=black," +
      "perspective=1.8:1:1278.2:1:0:720:1280:720:interpolation=linear," +
      "lenscorrection=k1=-0.0022:k2=0," +
      "noise=alls=14:allf=t+u," +
      "vignette"
  );
});

test("the whole video spatial chain is byte-identical for seed 2", () => {
  // Seed 2 draws vignette OFF, so the chain simply ends after the noise.
  expect(spatialChain(sampleRecipe(opts, 2, 1).video)).toBe(
    "eq=brightness=0.0234:contrast=0.979:saturation=0.9656:gamma=1.0046," +
      "hue=h=4.5035," +
      "scale=iw*1.0689:ih*1.0689,crop=1280:720," +
      "rotate=-0.000002:ow=rotw(-0.000002):oh=roth(-0.000002):c=black," +
      "perspective=0.9:0.5:1279.1:0.5:0:720:1280:720:interpolation=linear," +
      "lenscorrection=k1=0.0084:k2=0," +
      "noise=alls=2:allf=t+u"
  );
});

test("no photo-only branch is reachable from a video recipe, across 200 seeds", () => {
  // The two pinned seeds cover the strings; this covers the branches. A shared
  // fragment that started answering a video recipe with the photo form would
  // show up here whatever the numbers in it.
  for (let seed = 1; seed <= 200; seed++) {
    for (const op of sampleRecipe(opts, seed, 1).video) {
      const frag = FRAGMENTS[op.id]?.(op.params, info);
      if (frag === null || frag === undefined) continue;
      if (op.id === "vignette") expect(frag).toBe("vignette");
      if (op.id === "noise") expect(frag).toMatch(/^noise=alls=\d+:allf=t\+u$/);
      // `pad`/`crop=W:H:X:Y` belong to the still's off-centre vignette and
      // pancrop; the only crop a clip draws is the zoom-crop's `crop=W:H`.
      expect(frag).not.toContain("pad=");
      expect(frag.includes("crop=") && !frag.includes(`crop=${info.width}:${info.height}`)).toBe(
        false
      );
    }
  }
});
