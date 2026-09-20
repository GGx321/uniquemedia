import { sampleDeviceProfile } from "./deviceProfile";
import { computePdqHash } from "./pdq/pdq";
import { verifyCopy } from "./verification";
import { hammingDistance } from "./pdq/hamming";
import type { RenderExecutor } from "./executor";
import type { UniquifyOptions, VerifyResult } from "./types";

/** `R` is deliberately not defaulted to the video `Recipe`: a bare `CopyResult`
 *  on the photo path would silently claim a video recipe, and the mismatch
 *  would only surface wherever the recipe was finally read. Dropping the
 *  default is what lets this module stop naming a media type at all. */
export interface CopyResult<R> {
  index: number;
  outputPath: string;
  recipe: R;
  verify: VerifyResult;
}

export interface UniquifyConfig<R, O extends UniquifyOptions> {
  seedBase: number;
  framesPerCopy?: number;
  maxAttempts?: number;
  interThreshold?: number;
  /**
   * The instant the spoofed capture dates are measured back from. A host states
   * it so that a batch is reproducible from its seed alone; when none is given
   * the wall clock stands in.
   *
   * It is NOT defaulted to 0. It was, and the Unix epoch is a real-looking
   * number that produces a capture date in December 1969 — absurd EXIF written
   * in silence, which is what an Electron host that simply omitted the field
   * shipped. `Date.now()` is the same value the host would have passed, so the
   * cost of forgetting is a batch that is merely non-reproducible instead of
   * one that is nonsensical. Hosts still pass it explicitly: `RouteBatchConfig`
   * makes it required, so the omission cannot happen there again.
   */
  nowMs?: number;
  outputPath?: (index: number) => string;
  onProgress?: (index: number, attempt: number, fraction: number) => void;
  onCopyDone?: (result: CopyResult<R>) => void;
  signal?: AbortSignal;
  /** Copies processed concurrently (one ffmpeg per worker). Default 1 (sequential). */
  concurrency?: number;
  /**
   * Builds the recipe for one attempt. The pipeline always passes its own
   * `opts` in, so the default wiring samples against exactly the options
   * `verifyCopy` checks. A sampler that ignores this argument and closes over
   * a different options object re-opens the very bug the parameter exists to
   * prevent. Treat the argument as read-only: it is the live object, shared
   * across workers when `concurrency > 1`.
   */
  sampleRecipe: (opts: O, seed: number, intensity: number) => R;
}

const hashFrames = (frames: Uint8Array[]) => frames.map(computePdqHash);

/**
 * `O` has no default either. With one, `uniquify<PhotoRecipe>(…)` resolved `O`
 * to the bare `UniquifyOptions` instead of inferring the caller's options type,
 * so a sampler needing `strength` failed inside the config object rather than
 * at the type argument that was actually wrong. Without it, either give both
 * arguments or give none and let both infer.
 */
export async function uniquify<R, O extends UniquifyOptions>(
  input: string,
  opts: O,
  executor: RenderExecutor<R>,
  count: number,
  config: UniquifyConfig<R, O>
): Promise<CopyResult<R>[]> {
  const framesPerCopy = config.framesPerCopy ?? 4;
  const maxAttempts = config.maxAttempts ?? 3;
  const interThreshold = config.interThreshold ?? 8;
  const outputPath = config.outputPath ?? ((i) => `out/copy_${i + 1}.mp4`);

  const info = await executor.probe(input);
  const originalHashes = hashFrames(await executor.extractGrayFrames(input, framesPerCopy));

  /**
   * Stamps the spoofed device identity onto a file that is finished being
   * rendered. EVERY path that writes a shipped file has to end here: the graph
   * strips metadata on its way out (`-map_metadata -1`) and the scrub of the
   * encoder's own signature lives inside `applyDeviceMetadata`, so a file whose
   * last touch was a render ships with no EXIF and the encoder's comment still
   * on it. One such file in a batch of spoofed ones is a stronger tell than no
   * spoofing at all — which is why this is a helper and not two call sites that
   * have to be remembered separately.
   *
   * The profile comes from the copy's own index, never from the seed of the
   * render that produced the file: re-rendering a copy re-draws the picture,
   * not the phone, and a second identity on the same file would contradict the
   * first. Media-agnostic by construction — video and photo both land here.
   */
  async function applySpoofedIdentity(index: number, output: string): Promise<void> {
    if (!opts.spoofMetadata || !executor.applyDeviceMetadata) return;
    const profile = sampleDeviceProfile(config.seedBase + index * 1000, config.nowMs ?? Date.now());
    await executor.applyDeviceMetadata(output, profile);
  }

  // Produces the best CopyResult for copy `i`, or null when aborted / no best.
  // Does NOT push to results or fire onCopyDone — the worker owns that.
  async function processCopy(i: number): Promise<CopyResult<R> | null> {
    let seed = config.seedBase + i * 1000;
    let intensity = 1;
    let best: CopyResult<R> | null = null;
    let lastRecipe: R | null = null;
    const out = outputPath(i);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (config.signal?.aborted) break;
      const recipe = config.sampleRecipe(opts, seed, intensity);
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

      const candidate: CopyResult<R> = { index: i, outputPath: out, recipe, verify };
      if (!best || verify.minDistance > best.verify.minDistance) best = candidate;

      if (verify.passed) {
        best = candidate;
        break;
      }
      // Copy not yet different enough from the original — strengthen and retry.
      intensity *= 1.4;
      // Re-seed so retries differ. NOTE: from the second retry on, `seed *
      // 1103515245` exceeds 2^53 and the low bits are lost, so this is not a
      // true LCG (attempt 3 yields 2524885248 where exact integer maths gives
      // 2524885223). That drift is part of the shipped video output — switching
      // to Math.imul would change every rendered copy, so it must not be
      // "fixed" here. See the pinned sequence in pipeline.test.ts.
      seed = (seed * 1103515245 + 12345) >>> 0;
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

    await applySpoofedIdentity(i, out);

    return best;
  }

  const concurrency = Math.max(1, config.concurrency ?? 1);
  const results: CopyResult<R>[] = [];
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
      const freshRecipe = config.sampleRecipe(opts, freshSeed, 1);
      const out = results[i].outputPath;
      try {
        await executor.render(input, info, freshRecipe, out);
      } catch (err) {
        if (config.signal?.aborted) break;
        throw err;
      }
      regenCount++;
      // The render above overwrote whatever `processCopy` stamped on this file.
      await applySpoofedIdentity(results[i].index, out);
      const newRawFrames = await executor.extractGrayFrames(out, framesPerCopy);
      const newHashes = hashFrames(newRawFrames);
      const newVerify = verifyCopy(originalHashes, newHashes, opts.targetDistance);
      const newResult: CopyResult<R> = {
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
