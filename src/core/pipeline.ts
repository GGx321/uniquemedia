import { sampleRecipe } from "./sampler";
import { sampleDeviceProfile } from "./deviceProfile";
import { computePdqHash } from "./pdq/pdq";
import { verifyCopy, interCopyDistance } from "./verification";
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

  const results: CopyResult[] = [];
  const acceptedSignatures: Uint8Array[][] = [];

  for (let i = 0; i < count; i++) {
    if (config.signal?.aborted) break;
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

    // Don't push a half-done copy on cancel; also guards best being null if
    // the very first render was killed.
    if (config.signal?.aborted || !best) break;

    // Disk may hold a later (worse) attempt than `best`; re-render best so the
    // file on disk matches the reported metric.
    if (best.recipe !== lastRecipe) {
      await executor.render(input, info, best.recipe, out);
    }

    if (opts.spoofMetadata && executor.applyDeviceMetadata) {
      const profile = sampleDeviceProfile(config.seedBase + i * 1000, config.nowMs ?? 0);
      await executor.applyDeviceMetadata(out, profile);
    }

    results.push(best);
    config.onCopyDone?.(best);
  }

  return results;
}
