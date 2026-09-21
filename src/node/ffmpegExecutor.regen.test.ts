import { test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FfmpegExecutor } from "./ffmpegExecutor";
import { makeTestClip } from "./testClip";
import { sampleRecipe } from "../core/sampler";
import { uniquify, type CopyResult } from "../core/pipeline";
import type { CopyOptions, MediaInfo, Recipe } from "../core/types";

/**
 * Stop during the inter-copy post-pass, on the real executor and real files.
 *
 * `FfmpegExecutor.cancel` SIGKILLs the active child and removes the path it
 * was writing. During the post-pass that path used to be a copy that was
 * already complete and already shown as done: the user pressed Stop on a
 * 50-copy run, every card stayed green, and 49 files were on disk. This runs
 * the whole thing end to end because the defect was in what the executor
 * did to the disk, not in what the pipeline believed.
 */

const opts: CopyOptions = {
  strength: 1.0,
  exportFormat: "original",
  keepTrendAudio: false,
  allowMirror: false,
  // Low enough that no copy needs a retry: this test is about the post-pass.
  targetDistance: 10,
  identity: "engine",
  edgeMode: "crop",
  blackFirstFrame: false,
};

const COPIES = 2;

let dir: string;
let input: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "uniq-regen-"));
  input = join(dir, "in.mp4");
  makeTestClip(input);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** The executor under test, with Stop pressed the instant a regeneration
 *  starts. No timer and so no flake: `render` spawns synchronously, so the
 *  child is registered by the time the promise is handed back. */
class StopOnRegen extends FfmpegExecutor {
  constructor(private readonly controller: AbortController) {
    super();
  }
  stopped = 0;
  render(
    input: string,
    info: MediaInfo,
    recipe: Recipe,
    output: string,
    onProgress?: (fraction: number) => void
  ): Promise<void> {
    const pending = super.render(input, info, recipe, output, onProgress);
    if (recipe.seed >= 7919) {
      this.stopped++;
      this.controller.abort();
      this.cancel();
    }
    return pending;
  }
}

test("Stop mid-regeneration leaves every finished copy on disk, byte for byte", async () => {
  const controller = new AbortController();
  const exec = new StopOnRegen(controller);
  // What each copy looked like the moment it was reported done, before the
  // post-pass began. Read here rather than after the run, so the comparison
  // is against the file the user was shown as finished.
  const finished = new Map<string, Buffer>();
  const done: CopyResult<Recipe>[] = [];

  const results = await uniquify(input, opts, exec, COPIES, {
    seedBase: 4100,
    framesPerCopy: 4,
    // Every pair counts as too close, so the post-pass is guaranteed to fire.
    interThreshold: 256,
    outputPath: (i) => join(dir, `copy_${i + 1}.mp4`),
    sampleRecipe,
    signal: controller.signal,
    onCopyDone: (r) => {
      done.push(r);
      // First report only: the aborted regeneration reports the slot again.
      if (!finished.has(r.outputPath)) finished.set(r.outputPath, readFileSync(r.outputPath));
    },
  });

  // The premise: a regeneration started and Stop hit it.
  expect(exec.stopped).toBe(1);
  // Both copies reported once, then the interrupted slot once more — with the
  // result it had, so the host's card matches the file that is still there.
  expect(done.map((r) => r.index)).toEqual([0, 1, 1]);
  expect(done[2].recipe.seed).toBe(done[1].recipe.seed);
  expect(finished.size).toBe(COPIES);

  for (const [path, bytes] of finished) {
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path).equals(bytes)).toBe(true);
  }
  // Nothing half-written is left beside them.
  expect(readdirSync(dir).filter((f) => f.includes(".regen"))).toEqual([]);
  // And the batch still reports the copies that exist, not the one it lost.
  expect(results.map((r) => r.outputPath).sort()).toEqual([...finished.keys()].sort());
}, 120_000);
