import { test, expect } from "bun:test";
import { FRAGMENTS } from "./filters";
import { sampleRecipe } from "./sampler";
import type { ResolvedCopyOptions, MediaInfo, Operation } from "./types";

/**
 * `filters.ts` is now shared: the photo path added branches inside fragments
 * the video path has shipped for months (`noise` gained a temporal switch,
 * `pancrop` appeared beside `zoomcrop`).
 * Nothing pinned the video strings byte-for-byte, so a change to a shared
 * fragment could alter every rendered clip while the whole suite stayed green.
 *
 * These tests pin the exact parameter shapes the VIDEO sampler emits. They are
 * characterisation tests: they encode what ships today, and their only job is
 * to fail loudly if it ever stops shipping.
 */

const info: MediaInfo = { kind: "video", durationSec: 5, width: 1280, height: 720, hasAudio: true };

const opts: ResolvedCopyOptions = {
  strength: 1.0,
  exportFormat: "reels",
  keepTrendAudio: false,
  allowMirror: false,
  targetDistance: 38,
  identity: "engine",
  edgeMode: "auto",
  firstFrame: { mode: "off" },
};

/** The spatial chain exactly as `buildArgs` assembles it from the fragments. */
function spatialChain(ops: Operation[]): string {
  return ops
    .map((op) => FRAGMENTS[op.id]?.(op.params, info))
    .filter((frag): frag is string => frag !== null && frag !== undefined)
    .join(",");
}

test("the video sampler's noise shape keeps the temporal flag", () => {
  // Video omits `temporal` entirely; a still passes `temporal: false` and drops
  // the `t`. Getting `c0f=u` into a clip would change every frame of grain.
  // Luma only since even strengths were found to move both chroma planes by
  // -0.5 on average — a green cast (`videoNoise.test.ts`).
  expect(FRAGMENTS.noise({ strength: 14 }, info)).toBe("noise=c0s=14:c0f=t+u");
  expect(FRAGMENTS.noise({ strength: 1 }, info)).toBe("noise=c0s=1:c0f=t+u");
  expect(FRAGMENTS.noise({ strength: 0 }, info)).toBeNull();
});

test("the whole video spatial chain is byte-identical for seed 1", () => {
  // Re-pinned when hue, vignette, brightness and gamma left the video recipe,
  // and again when `eq` gave way to an exact contrast lookup and `hue`'s
  // saturation (eq's turned neutral chroma 128 into 127, a green-yellow cast).
  expect(spatialChain(sampleRecipe(opts, 1, 1).video)).toBe(
    "lutyuv=y='clip(round((val-(minval+maxval)/2)*1.0376+(minval+maxval)/2),minval,maxval)',hue=s=1.0002," +
      "scale=iw*1.0658:ih*1.0658,crop=1280:720," +
      "rotate=0.00084:ow=rotw(0.00084):oh=roth(0.00084):c=black," +
      "perspective=2.4:1.4:1277.6:1.4:0:720:1280:720:interpolation=linear," +
      "lenscorrection=k1=-0.0066:k2=0," +
      "noise=c0s=9:c0f=t+u"
  );
});

test("the whole video spatial chain is byte-identical for seed 2", () => {
  expect(spatialChain(sampleRecipe(opts, 2, 1).video)).toBe(
    "lutyuv=y='clip(round((val-(minval+maxval)/2)*1.0441+(minval+maxval)/2),minval,maxval)',hue=s=1.026," +
      "scale=iw*1.0586:ih*1.0586,crop=1280:720," +
      "rotate=0.000066:ow=rotw(0.000066):oh=roth(0.000066):c=black," +
      "perspective=2.3:1.3:1277.7:1.3:0:720:1280:720:interpolation=linear," +
      "lenscorrection=k1=0.0039:k2=0," +
      "noise=c0s=7:c0f=t+u"
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
      if (op.id === "noise") expect(frag).toMatch(/^noise=c0s=\d+:c0f=t\+u$/);
      // `pad`/`crop=W:H:X:Y` belong to a still's pancrop; the only crop a
      // clip draws is the zoom-crop's `crop=W:H`.
      expect(frag).not.toContain("pad=");
      expect(frag.includes("crop=") && !frag.includes(`crop=${info.width}:${info.height}`)).toBe(
        false
      );
    }
  }
});
