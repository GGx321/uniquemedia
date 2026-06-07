import { sampleRecipe } from "./sampler";
import { sampleDeviceProfile } from "./deviceProfile";
import { computePdqHash } from "./pdq/pdq";
import { verifyCopy, interCopyDistance } from "./verification";
import { hammingDistance } from "./pdq/hamming";
import type { RenderExecutor } from "./executor";
import type { CopyOptions, Recipe, VerifyResult } from "./types";

export interface CopyResult {
  index: number;
  outputPath: string;
  recipe: Recipe;
  verify: VerifyResult;
}

export interface UniquifyConfig {
  seedBase: number;
  framesPerCopy?: number;
  maxAttempts?: number;
  interThreshold?: number;
  nowMs?: number;
  outputPath?: (index: number) => string;
  onProgress?: (index: number, attempt: number, fraction: number) => void;
  onCopyDone?: (result: CopyResult) => void;
  signal?: AbortSignal;
  /** Copies processed concurrently (one ffmpeg per worker). Default 1 (sequential). */
  concurrency?: number;
}

const hashFrames = (frames: Uint8Array[]) => frames.map(computePdqHash);

export async function uniquify(
  input: string,
  opts: CopyOptions,
  executor: RenderExecutor,
  count: number,
  config: UniquifyConfig
): Promise<CopyResult[]> {
  const framesPerCopy = config.framesPerCopy ?? 4;
  const maxAttempts = config.maxAttempts ?? 3;
  const interThreshold = config.interThreshold ?? 15;
  const outputPath = config.outputPath ?? ((i) => `out/copy_${i + 1}.mp4`);

  const info = await executor.probe(input);
  const originalHashes = hashFrames(await executor.extractGrayFrames(input, framesPerCopy));

  // Shared across concurrent workers. Reads/pushes are intentionally lock-free:
  // each copy uses a distinct seed (seedBase + i*1000), so copies differ by
  // construction; the inter-copy check is a best-effort safety net.
  const acceptedSignatures: Uint8Array[][] = [];

  // Produces the best CopyResult for copy `i`, or null when aborted / no best.
  // Does NOT push to results or fire onCopyDone — the worker owns that.
  async function processCopy(i: number): Promise<CopyResult | null> {
    let seed = config.seedBase + i * 1000;
    let intensity = 1;
    let best: CopyResult | null = null;
    let lastRecipe: Recipe | null = null;
    const out = outputPath(i);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (config.signal?.aborted) break;
      const recipe = sampleRecipe(opts, seed, intensity);
      try {
        await executor.render(input, info, recipe, out, (f) =>
          config.onProgress?.(i, attempt, f)
        );
      } catch (err) {
        if (config.signal?.aborted) break;
        throw err;
      }
      lastRecipe = recipe;

      const copyHashes = hashFrames(await executor.extractGrayFrames(out, framesPerCopy));
      const verify = verifyCopy(originalHashes, copyHashes, opts.targetDistance);
      // Snapshot the current accepted set; concurrent races are acceptable.
      const interOk = acceptedSignatures.every(
        (sig) => interCopyDistance(sig, copyHashes) >= interThreshold
      );

      const candidate: CopyResult = { index: i, outputPath: out, recipe, verify };
      if (!best || verify.minDistance > best.verify.minDistance) best = candidate;

      if (verify.passed && interOk) {
        acceptedSignatures.push(copyHashes);
        best = candidate;
        break;
      }
      intensity *= 1.4;
      seed = (seed * 1103515245 + 12345) >>> 0; // re-seed so retries differ
    }

    // Don't ship a half-done copy on cancel; also guards best being null if
    // the very first render was killed.
    if (config.signal?.aborted || !best) return null;

    // Disk may hold a later (worse) attempt than `best`; re-render best so the
    // file on disk matches the reported metric.
    if (best.recipe !== lastRecipe) {
      if (config.signal?.aborted) return null;
      try {
        await executor.render(input, info, best.recipe, out);
      } catch (err) {
        if (config.signal?.aborted) return null; // killed by Stop — clean exit
        throw err;
      }
    }

    if (opts.spoofMetadata && executor.applyDeviceMetadata) {
      const profile = sampleDeviceProfile(config.seedBase + i * 1000, config.nowMs ?? 0);
      await executor.applyDeviceMetadata(out, profile);
    }

    return best;
  }

  const concurrency = Math.max(1, config.concurrency ?? 1);
  const results: CopyResult[] = [];
  let nextIndex = 0;
  async function worker() {
    while (true) {
      if (config.signal?.aborted) return;
      const i = nextIndex++;
      if (i >= count) return;
      const r = await processCopy(i);
      if (r) {
        results.push(r);
        config.onCopyDone?.(r);
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, count) }, () => worker())
  );
  results.sort((a, b) => a.index - b.index);

  // Inter-copy uniqueness post-pass: parallel workers may have produced copies
  // that are too similar to each other (they skip the live inter-copy check when
  // processing at the same time). We do a final O(n²) comparison on frame-0 PDQ
  // hashes and regenerate any copy that is too close to an earlier accepted copy.
  if (count > 1 && !config.signal?.aborted) {
    const interThresholdFinal = interThreshold;
    // Collect frame-0 PDQ hashes for every result (1 raw frame each — cheap).
    const sigs: Uint8Array[] = await Promise.all(
      results.map(async (r) => {
        const frames = await executor.extractGrayFrames(r.outputPath, 1);
        return computePdqHash(frames[0]);
      })
    );

    const maxRegen = count; // cap total regenerations to avoid infinite loops
    let regenCount = 0;
    for (let i = 1; i < results.length && regenCount < maxRegen; i++) {
      if (config.signal?.aborted) break;
      // Check if result[i] is too close to any earlier accepted result.
      let tooClose = false;
      for (let j = 0; j < i; j++) {
        if (hammingDistance(sigs[i], sigs[j]) < interThresholdFinal) {
          tooClose = true;
          break;
        }
      }
      if (!tooClose) continue;

      // Regenerate with a fresh seed that differs from the original slot.
      const freshSeed = (config.seedBase + results[i].index * 1000 + 7919) >>> 0;
      const freshRecipe = sampleRecipe(opts, freshSeed, 1);
      const out = results[i].outputPath;
      try {
        await executor.render(input, info, freshRecipe, out);
      } catch (err) {
        if (config.signal?.aborted) break;
        throw err;
      }
      regenCount++;
      const newRawFrames = await executor.extractGrayFrames(out, framesPerCopy);
      const newHashes = hashFrames(newRawFrames);
      const newVerify = verifyCopy(originalHashes, newHashes, opts.targetDistance);
      const newResult: CopyResult = {
        index: results[i].index,
        outputPath: out,
        recipe: freshRecipe,
        verify: newVerify,
      };
      results[i] = newResult;
      sigs[i] = newHashes[0];
    }
  }

  return results;
}
