import { test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PhotoExecutor } from "./photoExecutor";
import { makeTestPhoto } from "./testClip";
import { samplePhotoRecipe } from "../core/photo/sampler";
import { uniquify, type CopyResult } from "../core/pipeline";
import type { MediaInfo } from "../core/types";
import type { PhotoRecipe, ResolvedPhotoOptions } from "../core/photo/types";

/**
 * The still half of what ffmpegExecutor.regen.test.ts guards: Stop during the
 * inter-copy post-pass must take only the regeneration that was being written,
 * never a copy already reported done. Both executors delete the path their
 * child was writing on `cancel`, so both are audited on real files.
 */

const opts: ResolvedPhotoOptions = {
  strength: 1.0,
  exportFormat: "original",
  allowMirror: false,
  targetDistance: 10,
  identity: "iphone",
  edge: { mode: "crop" },
};

const COPIES = 2;

let dir: string;
let input: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "uniq-photo-regen-"));
  input = join(dir, "in.jpg");
  makeTestPhoto(input, 640, 480);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

class StopOnRegen extends PhotoExecutor {
  constructor(private readonly controller: AbortController) {
    super();
  }
  stopped = 0;
  render(
    input: string,
    info: MediaInfo,
    recipe: PhotoRecipe,
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

test("Stop mid-regeneration leaves every finished still on disk, byte for byte", async () => {
  const controller = new AbortController();
  const exec = new StopOnRegen(controller);
  const finished = new Map<string, Buffer>();
  const done: CopyResult<PhotoRecipe>[] = [];

  const results = await uniquify(input, opts, exec, COPIES, {
    seedBase: 4100,
    framesPerCopy: 1,
    nowMs: 1_748_000_000_000,
    interThreshold: 256,
    outputPath: (i) => join(dir, `copy_${i + 1}.jpg`),
    sampleRecipe: samplePhotoRecipe,
    signal: controller.signal,
    onCopyDone: (r) => {
      done.push(r);
      // First report only: the aborted regeneration reports the slot again.
      if (!finished.has(r.outputPath)) finished.set(r.outputPath, readFileSync(r.outputPath));
    },
  });

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
  expect(readdirSync(dir).filter((f) => f.includes(".regen"))).toEqual([]);
  expect(results.map((r) => r.outputPath).sort()).toEqual([...finished.keys()].sort());
}, 120_000);
