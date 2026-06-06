import { sampleRecipe } from "./sampler";
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
  outputPath?: (index: number) => string;
  onProgress?: (index: number, attempt: number) => void;
}

const hashFrames = (frames: Uint8Array[]) => frames.map(computePdqHash);

export async function uniquify(
  input: string,
  opts: CopyOptions,
  executor: RenderExecutor,
  count: number,
  config: UniquifyConfig
): Promise<CopyResult[]> {
  const framesPerCopy = config.framesPerCopy ?? 6;
  const maxAttempts = config.maxAttempts ?? 3;
  const interThreshold = config.interThreshold ?? 15;
  const outputPath = config.outputPath ?? ((i) => `out/copy_${i + 1}.mp4`);

  const info = await executor.probe(input);
  const originalHashes = hashFrames(await executor.extractGrayFrames(input, framesPerCopy));

  const results: CopyResult[] = [];
  const acceptedSignatures: Uint8Array[][] = [];

  for (let i = 0; i < count; i++) {
    let seed = config.seedBase + i * 1000;
    let intensity = 1;
    let best: CopyResult | null = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      config.onProgress?.(i, attempt);
      const recipe = sampleRecipe(opts, seed, intensity);
      const out = outputPath(i);
      await executor.render(input, info, recipe, out);

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

    results.push(best!);
  }

  return results;
}
