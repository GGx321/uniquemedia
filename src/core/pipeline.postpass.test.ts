import { test, expect } from "bun:test";
import { stagedPath, uniquify } from "./pipeline";
import type { RenderExecutor } from "./executor";
import type { IdentityMode, MediaInfo, UniquifyOptions } from "./types";
import type { DeviceProfile } from "./deviceProfile";

/**
 * The inter-copy post-pass, on a fake disk.
 *
 * Every test here models what reached the file system rather than what the
 * pipeline believed: `render` writes a recipe under the output path, `replace`
 * moves it, `discard` removes it, and `extractGrayFrames` reads the frame back
 * from that map — and throws when nothing is there, which is what makes a
 * verification of the wrong path a failure instead of a silent pass.
 *
 * The defects this guards were reproduced on a real 50-copy run: a post-pass
 * that re-rendered 27 copies for 3 min 40 s in silence, a Stop that deleted a
 * finished copy because the regeneration was writing straight over it, and a
 * regeneration that shipped below the target because it skipped verification.
 */

interface SeedRecipe {
  seed: number;
  intensity: number;
}

const info: MediaInfo = { kind: "photo", durationSec: 0, width: 1080, height: 1080, hasAudio: false };
const opts: UniquifyOptions = { targetDistance: 40, identity: "iphone" };

const SEED_BASE = 1;
/** Copy `i` is first drawn from `seedBase + i * 1000`. */
const initialSeed = (i: number): number => SEED_BASE + i * 1000;
/** Regeneration round `r` (1-based) of copy `i` is drawn from `+ 7919 * r`. */
const regenSeed = (i: number, r: number): number => (SEED_BASE + i * 1000 + 7919 * r) >>> 0;

/** Any non-blank frame hashes 128 bits away from the blank original, and two
 *  different `d` values hash ~100+ bits apart, so every value here clears the
 *  target — while two frames built from the SAME `d` are identical and collide
 *  at any threshold. (Seeds are reduced mod 7 below because the three initial
 *  seeds 1, 1001 and 2001 are congruent mod 5.) */
function frameOfDistance(d: number): Uint8Array {
  const f = new Uint8Array(64 * 64);
  for (let i = 0; i < d * 30; i++) f[i] = 255;
  return f;
}

const blank = new Uint8Array(64 * 64);

interface Touch {
  op: "render" | "identity" | "replace" | "discard";
  path: string;
  to?: string;
}

class DiskMock implements RenderExecutor<SeedRecipe> {
  disk = new Map<string, SeedRecipe>();
  log: Touch[] = [];
  constructor(private readonly frameFor: (recipe: SeedRecipe) => Uint8Array) {}
  async probe(): Promise<MediaInfo> {
    return info;
  }
  async render(
    _input: string,
    _info: MediaInfo,
    recipe: SeedRecipe,
    output: string,
    onProgress?: (fraction: number) => void
  ): Promise<void> {
    this.log.push({ op: "render", path: output });
    this.disk.set(output, recipe);
    onProgress?.(1);
  }
  async extractGrayFrames(input: string, count: number): Promise<Uint8Array[]> {
    if (input === "ORIGINAL") return Array.from({ length: count }, () => blank);
    const recipe = this.disk.get(input);
    if (!recipe) throw new Error(`nothing on disk at ${input}`);
    return Array.from({ length: count }, () => this.frameFor(recipe));
  }
  async applyIdentity(output: string, _identity: IdentityMode, _profile: DeviceProfile): Promise<void> {
    if (!this.disk.has(output)) throw new Error(`identity written to a missing file ${output}`);
    this.log.push({ op: "identity", path: output });
  }
  async replace(from: string, to: string): Promise<void> {
    const recipe = this.disk.get(from);
    if (!recipe) throw new Error(`replace from a missing file ${from}`);
    this.disk.delete(from);
    this.disk.set(to, recipe);
    this.log.push({ op: "replace", path: from, to });
  }
  async discard(path: string): Promise<void> {
    this.disk.delete(path);
    this.log.push({ op: "discard", path });
  }
}

const sampleRecipe = (_o: UniquifyOptions, seed: number, intensity: number): SeedRecipe => ({
  seed,
  intensity,
});

const outputPath = (i: number): string => `/out/copy_${i + 1}.jpg`;

/** Every initial copy lands on the same frame (a collision); every regeneration
 *  lands on a frame of its own, far from both the original and the others. */
const collideOnce = (r: SeedRecipe): Uint8Array =>
  r.seed === initialSeed(0) || r.seed === initialSeed(1) ? frameOfDistance(5) : frameOfDistance(5 + (r.seed % 7));

// ── item 5: maxAttempts of 0 ────────────────────────────────────────────────

test("maxAttempts of 0 still yields a copy rather than silently returning none", async () => {
  // Zero attempts used to fall straight through the retry loop with no best
  // candidate, and `processCopy` returned null for every copy — no error, no
  // result, a batch that finished with nothing to show.
  const exec = new DiskMock((r) => frameOfDistance(5 + (r.seed % 7)));
  const res = await uniquify("ORIGINAL", opts, exec, 1, {
    seedBase: SEED_BASE,
    framesPerCopy: 1,
    maxAttempts: 0,
    outputPath,
    sampleRecipe,
  });
  expect(res.length).toBe(1);
  expect(exec.disk.has(outputPath(0))).toBe(true);
});

// ── item 1: the post-pass has a voice ───────────────────────────────────────

test("reports the inter-copy check as done/total, from nothing settled to every copy settled", async () => {
  // Distinct frame per seed: no collision, so the phase is one sweep.
  const exec = new DiskMock((r) => frameOfDistance(5 + (r.seed % 7)));
  const phases: Array<[number, number]> = [];
  await uniquify("ORIGINAL", opts, exec, 3, {
    seedBase: SEED_BASE,
    framesPerCopy: 1,
    outputPath,
    sampleRecipe,
    onPostPass: (done, total) => phases.push([done, total]),
  });
  // 0/3 when the phase begins, 1/3 once the reference signatures are in hand
  // (copy 0 is never regenerated), then one step per copy checked.
  expect(phases).toEqual([[0, 3], [1, 3], [2, 3], [3, 3]]);
});

test("drives the regeneration render through onProgress under the copy's own index", async () => {
  // The card for the copy being regenerated goes back to "rendering" in the
  // UI through this callback; without it the whole post-pass is silent.
  const exec = new DiskMock(collideOnce);
  const events: string[] = [];
  await uniquify("ORIGINAL", opts, exec, 2, {
    seedBase: SEED_BASE,
    framesPerCopy: 1,
    outputPath,
    sampleRecipe,
    onProgress: (index) => events.push(`progress:${index}`),
    onPostPass: (done, total) => events.push(`postpass:${done}/${total}`),
  });
  const phaseStart = events.indexOf("postpass:0/2");
  expect(phaseStart).toBeGreaterThan(-1);
  expect(events.slice(phaseStart)).toContain("progress:1");
});

test("fires onCopyDone again for a regenerated copy, carrying its fresh recipe", async () => {
  // The renderer put the card back into "rendering" on the progress tick; it
  // is this second completion that returns it to "done" with the new
  // verification and thumbnail.
  const exec = new DiskMock(collideOnce);
  const done: Array<{ index: number; seed: number; path: string }> = [];
  const res = await uniquify("ORIGINAL", opts, exec, 2, {
    seedBase: SEED_BASE,
    framesPerCopy: 1,
    outputPath,
    sampleRecipe,
    onCopyDone: (r) => done.push({ index: r.index, seed: r.recipe.seed, path: r.outputPath }),
  });
  expect(done.map((d) => d.index)).toEqual([0, 1, 1]);
  expect(done[2].seed).toBe(regenSeed(1, 1));
  expect(done[2].path).toBe(outputPath(1));
  expect(res[1].recipe.seed).toBe(regenSeed(1, 1));
});

// ── item 2: a finished copy is never the target of a regeneration ───────────

test("renders a regenerated copy beside the original and replaces it only once verified", async () => {
  const exec = new DiskMock(collideOnce);
  const res = await uniquify("ORIGINAL", opts, exec, 2, {
    seedBase: SEED_BASE,
    framesPerCopy: 1,
    outputPath,
    sampleRecipe,
  });

  const final = outputPath(1);
  const temp = "/out/copy_2.regen.jpg";
  const touches = exec.log.filter((t) => t.path === temp || t.path === final);
  // The initial render and identity on the final path; then the regeneration
  // render and its identity on the temp; then the swap. Nothing writes to the
  // final path between its first completion and the swap.
  expect(touches).toEqual([
    { op: "render", path: final },
    { op: "identity", path: final },
    { op: "render", path: temp },
    { op: "identity", path: temp },
    { op: "replace", path: temp, to: final },
  ]);
  expect(res[1].outputPath).toBe(final);
  expect(exec.disk.get(final)?.seed).toBe(regenSeed(1, 1));
  expect(exec.disk.has(temp)).toBe(false);
});

test("a regeneration aborted mid-render leaves the finished copy on disk and discards the temp", async () => {
  // What `FfmpegExecutor.cancel` does to the file its child was writing:
  // SIGKILL, then rmSync. Modelled here on the mock so the pipeline's part of
  // the contract — which path that child is writing — is what is under test.
  const controller = new AbortController();
  class AbortingMock extends DiskMock {
    async render(
      input: string,
      info: MediaInfo,
      recipe: SeedRecipe,
      output: string,
      onProgress?: (fraction: number) => void
    ): Promise<void> {
      if (recipe.seed >= 7919) {
        controller.abort();
        this.disk.delete(output);
        throw new Error("ffmpeg exited null: killed");
      }
      await super.render(input, info, recipe, output, onProgress);
    }
  }
  const exec = new AbortingMock(collideOnce);
  const res = await uniquify("ORIGINAL", opts, exec, 2, {
    seedBase: SEED_BASE,
    framesPerCopy: 1,
    outputPath,
    sampleRecipe,
    signal: controller.signal,
  });

  const final = outputPath(1);
  expect(exec.disk.get(final)?.seed).toBe(initialSeed(1));
  expect([...exec.disk.keys()].filter((p) => p.includes(".regen"))).toEqual([]);
  expect(exec.log.some((t) => t.op === "replace")).toBe(false);
  expect(exec.log).toContainEqual({ op: "discard", path: "/out/copy_2.regen.jpg" });
  expect(res.map((r) => r.recipe.seed)).toEqual([initialSeed(0), initialSeed(1)]);
});

test("an aborted regeneration reports the untouched copy done again, so the host's card matches the disk", async () => {
  // The host put the card back into "rendering" on the regeneration's
  // progress ticks; Stop then drops every card that is not done. The file is
  // still there, so the card has to come back — with the result it had.
  const controller = new AbortController();
  class AbortingMock extends DiskMock {
    async render(
      input: string,
      info: MediaInfo,
      recipe: SeedRecipe,
      output: string,
      onProgress?: (fraction: number) => void
    ): Promise<void> {
      if (recipe.seed >= 7919) {
        controller.abort();
        this.disk.delete(output);
        throw new Error("ffmpeg exited null: killed");
      }
      await super.render(input, info, recipe, output, onProgress);
    }
  }
  const exec = new AbortingMock(collideOnce);
  const done: Array<{ index: number; seed: number }> = [];
  await uniquify("ORIGINAL", opts, exec, 2, {
    seedBase: SEED_BASE,
    framesPerCopy: 1,
    outputPath,
    sampleRecipe,
    signal: controller.signal,
    onCopyDone: (r) => done.push({ index: r.index, seed: r.recipe.seed }),
  });
  expect(done).toEqual([
    { index: 0, seed: initialSeed(0) },
    { index: 1, seed: initialSeed(1) },
    { index: 1, seed: initialSeed(1) },
  ]);
});

test("a regeneration that fails outright discards its temp and surfaces the error", async () => {
  class FailingMock extends DiskMock {
    async render(
      input: string,
      info: MediaInfo,
      recipe: SeedRecipe,
      output: string,
      onProgress?: (fraction: number) => void
    ): Promise<void> {
      if (recipe.seed >= 7919) throw new Error("ffmpeg exited 1: disk full");
      await super.render(input, info, recipe, output, onProgress);
    }
  }
  const exec = new FailingMock(collideOnce);
  const done: number[] = [];
  const err = await uniquify("ORIGINAL", opts, exec, 2, {
    seedBase: SEED_BASE,
    framesPerCopy: 1,
    outputPath,
    sampleRecipe,
    onCopyDone: (r) => done.push(r.index),
  }).then(
    () => null,
    (e: unknown) => e
  );

  expect(err).toBeInstanceOf(Error);
  expect(err instanceof Error ? err.message : "").toContain("disk full");
  expect(exec.disk.get(outputPath(1))?.seed).toBe(initialSeed(1));
  expect(exec.log).toContainEqual({ op: "discard", path: "/out/copy_2.regen.jpg" });
  // Same as the abort path: the card went to "rendering" on the regeneration's
  // ticks, and the host's error handler does not touch cards, so the slot is
  // reported done again with what is still on disk.
  expect(done).toEqual([0, 1, 1]);
});

test("a replace that fails discards the temp and surfaces the error", async () => {
  // The one await with a verified temp on disk: if the swap itself fails, the
  // temp must not be left beside the copy it was meant to replace.
  class UnswappableMock extends DiskMock {
    async replace(from: string, _to: string): Promise<void> {
      this.log.push({ op: "replace", path: from, to: _to });
      throw new Error("EPERM: target is open");
    }
  }
  const exec = new UnswappableMock(collideOnce);
  const err = await uniquify("ORIGINAL", opts, exec, 2, {
    seedBase: SEED_BASE,
    framesPerCopy: 1,
    outputPath,
    sampleRecipe,
  }).then(
    () => null,
    (e: unknown) => e
  );
  expect(err instanceof Error ? err.message : "").toContain("EPERM");
  expect(exec.disk.get(outputPath(1))?.seed).toBe(initialSeed(1));
  expect(exec.disk.has("/out/copy_2.regen.jpg")).toBe(false);
  expect(exec.log).toContainEqual({ op: "discard", path: "/out/copy_2.regen.jpg" });
});

// ── executors without staging ───────────────────────────────────────────────

/** A double with no way to move files: the pre-staging contract, in place. */
class InPlaceMock implements RenderExecutor<SeedRecipe> {
  disk = new Map<string, SeedRecipe>();
  constructor(private readonly frameFor: (recipe: SeedRecipe) => Uint8Array) {}
  async probe(): Promise<MediaInfo> {
    return info;
  }
  async render(_i: string, _n: MediaInfo, recipe: SeedRecipe, output: string): Promise<void> {
    this.disk.set(output, recipe);
  }
  async extractGrayFrames(input: string, count: number): Promise<Uint8Array[]> {
    if (input === "ORIGINAL") return Array.from({ length: count }, () => blank);
    const recipe = this.disk.get(input);
    if (!recipe) throw new Error(`nothing on disk at ${input}`);
    return Array.from({ length: count }, () => this.frameFor(recipe));
  }
}

test("an executor with replace but no discard is a defect, not a quiet fallback", async () => {
  // Half a staging pair would leave every regeneration beside the copy it
  // was meant to replace; refusing up front is what keeps that from shipping.
  class HalfMock extends InPlaceMock {
    async replace(_from: string, _to: string): Promise<void> {}
  }
  const err = await uniquify("ORIGINAL", opts, new HalfMock(collideOnce), 1, {
    seedBase: SEED_BASE,
    framesPerCopy: 1,
    outputPath,
    sampleRecipe,
  }).then(
    () => null,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(Error);
  expect(err instanceof Error ? err.message : "").toMatch(/replace.*discard|discard.*replace/);
});

test("without staging, an aborted regeneration does not report a copy that may be gone", async () => {
  // In place, the regeneration was writing over the finished copy, and a
  // deleting `cancel` has already taken it; claiming it done would be a lie.
  const controller = new AbortController();
  class AbortingInPlace extends InPlaceMock {
    async render(i: string, n: MediaInfo, recipe: SeedRecipe, output: string): Promise<void> {
      if (recipe.seed >= 7919) {
        controller.abort();
        this.disk.delete(output);
        throw new Error("ffmpeg exited null: killed");
      }
      await super.render(i, n, recipe, output);
    }
  }
  const done: number[] = [];
  await uniquify("ORIGINAL", opts, new AbortingInPlace(collideOnce), 2, {
    seedBase: SEED_BASE,
    framesPerCopy: 1,
    outputPath,
    sampleRecipe,
    signal: controller.signal,
    onCopyDone: (r) => done.push(r.index),
  });
  expect(done).toEqual([0, 1]);
});

// ── item 3: a regeneration is verified like a first render ──────────────────

test("a regeneration that lands below the target is strengthened and retried like a first render", async () => {
  // The first regeneration draw is too close to the original; only a
  // strengthened one clears the target. On the real run 2 of 27 regenerations
  // shipped below target because this loop was skipped.
  const frameFor = (r: SeedRecipe): Uint8Array => {
    if (r.seed === initialSeed(0) || r.seed === initialSeed(1)) return frameOfDistance(5);
    // The blank frame IS the original: distance 0, the clearest miss there is.
    return r.intensity > 1 ? frameOfDistance(9) : blank;
  };
  const exec = new DiskMock(frameFor);
  const res = await uniquify("ORIGINAL", opts, exec, 2, {
    seedBase: SEED_BASE,
    framesPerCopy: 1,
    outputPath,
    sampleRecipe,
  });
  expect(res[1].verify.passed).toBe(true);
  expect(res[1].recipe.intensity).toBeGreaterThan(1);
  expect(exec.disk.get(outputPath(1))?.intensity).toBe(res[1].recipe.intensity);
});

test("re-checks a regenerated copy against the earlier copies and draws again when it still collides", async () => {
  // Round 1 lands on the very frame copy 0 has; round 2 is the first draw
  // that is actually distinct. Shipping round 1 would have "fixed" a
  // collision by creating the same one.
  const frameFor = (r: SeedRecipe): Uint8Array =>
    r.seed === regenSeed(1, 2) ? frameOfDistance(9) : frameOfDistance(5);
  const exec = new DiskMock(frameFor);
  const res = await uniquify("ORIGINAL", opts, exec, 2, {
    seedBase: SEED_BASE,
    framesPerCopy: 1,
    outputPath,
    sampleRecipe,
  });
  expect(res[1].recipe.seed).toBe(regenSeed(1, 2));
  expect(exec.disk.get(outputPath(1))?.seed).toBe(regenSeed(1, 2));
});

test("stops regenerating at maxRegen (the copy count) when copies keep colliding", async () => {
  // Every draw lands on the same frame, so nothing can ever separate them.
  // The bound is what keeps that from being an infinite loop.
  const exec = new DiskMock(() => frameOfDistance(5));
  const res = await uniquify("ORIGINAL", opts, exec, 3, {
    seedBase: SEED_BASE,
    framesPerCopy: 1,
    outputPath,
    sampleRecipe,
  });
  expect(res.length).toBe(3);
  const regenerations = exec.log.filter((t) => t.op === "render" && t.path.includes(".regen"));
  expect(regenerations.length).toBe(3);
});

// ── stagedPath ──────────────────────────────────────────────────────────────

test("stagedPath keeps the extension, since the video executor picks its container from it", () => {
  expect(stagedPath("/out/copy_2.mp4")).toBe("/out/copy_2.regen.mp4");
  expect(stagedPath("C:\\out\\copy_2.jpg")).toBe("C:\\out\\copy_2.regen.jpg");
});

test("stagedPath appends the marker when the file has no extension of its own", () => {
  // A dot in a directory name is not an extension.
  expect(stagedPath("/out.d/copy_2")).toBe("/out.d/copy_2.regen");
  expect(stagedPath("copy_2")).toBe("copy_2.regen");
});
