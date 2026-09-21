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
  /**
   * Fires for every copy that is accepted — and AGAIN for a copy the
   * inter-copy post-pass regenerates, with the fresh result. A host that put
   * the card back into "rendering" on the regeneration's progress ticks is
   * told here that it is done a second time.
   */
  onCopyDone?: (result: CopyResult<R>) => void;
  /**
   * The inter-copy check that follows the last copy, as `done` copies settled
   * out of `total`. A 22.6 s clip at 50 copies re-rendered 27 of them here for
   * 3 min 40 s with every card showing done and nothing else moving; the host
   * uses this to say what the batch is still doing.
   */
  onPostPass?: (done: number, total: number) => void;
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
 * Where the post-pass renders a replacement for `final`: a sibling with the
 * same extension, since the video executor picks its container from the
 * extension whenever the graph does not force one. A dot inside a directory
 * name is not an extension, and neither is the leading dot of a dotfile.
 */
export function stagedPath(final: string): string {
  const slash = Math.max(final.lastIndexOf("/"), final.lastIndexOf("\\"));
  const dot = final.lastIndexOf(".");
  if (dot <= slash + 1) return `${final}.regen`;
  return `${final.slice(0, dot)}.regen${final.slice(dot)}`;
}

interface Staging {
  replace: (from: string, to: string) => Promise<void>;
  discard: (path: string) => Promise<void>;
}

/**
 * Both halves or neither. A backend with neither (a test double) keeps the
 * pre-staging contract and is regenerated in place; one with only half a pair
 * is a defect and is refused before anything renders, because staging with no
 * way to swap the file in would leave every regeneration beside the copy it
 * was meant to replace, and no way to clean up would leave it there on Stop.
 */
function stagingOf<R>(executor: RenderExecutor<R>): Staging | null {
  const { replace, discard } = executor;
  if (!replace && !discard) return null;
  if (!replace || !discard) {
    throw new Error("RenderExecutor must implement both replace and discard, or neither.");
  }
  return { replace: replace.bind(executor), discard: discard.bind(executor) };
}

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
  // At least one: zero attempts fell through the retry loop with no candidate
  // and every copy came back null, with no error to say why.
  const maxAttempts = Math.max(1, config.maxAttempts ?? 3);
  const interThreshold = config.interThreshold ?? 8;
  const outputPath = config.outputPath ?? ((i) => `out/copy_${i + 1}.mp4`);

  const staging = stagingOf(executor);

  const info = await executor.probe(input);
  const originalHashes = hashFrames(await executor.extractGrayFrames(input, framesPerCopy));

  /**
   * Gives a file that is finished being rendered the identity the batch asked
   * for. EVERY path that writes a shipped file has to end here: the graph
   * strips metadata on its way out (`-map_metadata -1`) and the scrub of the
   * encoder's own signature lives inside the executor's identity pass, so a
   * file whose last touch was a render ships with no EXIF and the encoder's
   * comment still on it. One such file in a batch of spoofed ones is a stronger
   * tell than no spoofing at all — which is why this is a helper and not two
   * call sites that have to be remembered separately.
   *
   * Every mode goes down, `engine` included: what a mode means for a medium is
   * the executor's call, and skipping one here would be making it for them.
   *
   * The profile comes from the copy's own index, never from the seed of the
   * render that produced the file: re-rendering a copy re-draws the picture,
   * not the phone, and a second identity on the same file would contradict the
   * first. Media-agnostic by construction — video and photo both land here.
   */
  async function applyIdentity(index: number, output: string): Promise<void> {
    if (!executor.applyIdentity) return;
    const profile = sampleDeviceProfile(config.seedBase + index * 1000, config.nowMs ?? Date.now());
    await executor.applyIdentity(output, opts.identity, profile);
  }

  // Produces the best CopyResult for copy `i`, or null when aborted / no best.
  // Does NOT push to results or fire onCopyDone — the worker owns that.
  //
  // `seedStart` and `out` are what the post-pass varies: a regeneration is the
  // same render — verification against the target, the auto-strengthen retry,
  // the identity pass — from a different seed into a staged file. It used to be
  // a one-shot render with none of that, and 2 of 27 regenerations on a real
  // run shipped below target because of it.
  async function processCopy(
    i: number,
    seedStart: number = config.seedBase + i * 1000,
    out: string = outputPath(i)
  ): Promise<CopyResult<R> | null> {
    let seed = seedStart;
    let intensity = 1;
    let best: CopyResult<R> | null = null;
    let lastRecipe: R | null = null;

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

    await applyIdentity(i, out);

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
  // processing at the same time). We do a final O(n²) comparison on one PDQ
  // hash per copy and regenerate any copy that is too close to an earlier
  // accepted copy — then check the regeneration the same way, because a fresh
  // draw can land on a collision of its own.
  if (count > 1 && !config.signal?.aborted) {
    const total = results.length;
    config.onPostPass?.(0, total);
    // One frame per copy — the SAME one frame for every signature, whether it
    // was taken before or after a regeneration. Frame 0 of `framesPerCopy`
    // sits at a different timestamp than frame 0 of 1, and comparing the two
    // would compare different pictures.
    const signatureOf = async (path: string): Promise<Uint8Array> =>
      computePdqHash((await executor.extractGrayFrames(path, 1))[0]);
    const sigs: Uint8Array[] = await Promise.all(results.map((r) => signatureOf(r.outputPath)));
    config.onPostPass?.(1, total); // copy 0 is the reference: settled by definition

    const collides = (i: number): boolean => {
      for (let j = 0; j < i; j++) {
        if (hammingDistance(sigs[i], sigs[j]) < interThreshold) return true;
      }
      return false;
    };
    const maxRegen = count; // cap total regenerations to avoid infinite loops
    let regenCount = 0;

    outer: for (let i = 1; i < results.length; i++) {
      let round = 0;
      while (collides(i)) {
        if (config.signal?.aborted || regenCount >= maxRegen) break outer;
        round++;
        regenCount++;
        const { index, outputPath: final } = results[i];
        // A fresh seed that differs from the original slot and from every
        // earlier round of the same slot.
        const seed = (config.seedBase + index * 1000 + 7919 * round) >>> 0;
        // The finished copy stays where it is until its replacement has been
        // verified and given its identity. While the regeneration is being
        // written, `cancel` can only ever delete the temp: Stop used to leave
        // 49 files behind 50 green cards, because the child it killed was
        // writing over a copy that was already done.
        const out = staging ? stagedPath(final) : final;
        let fresh: CopyResult<R> | null;
        try {
          fresh = await processCopy(index, seed, out);
          if (fresh && staging) await staging.replace(out, final);
        } catch (err) {
          if (staging) {
            // The finished copy is untouched; only the temp goes. Reported
            // done once more so a host that put its card back into
            // "rendering" on the regeneration's progress ticks shows what is
            // actually on disk — its error handler does not touch cards.
            await staging.discard(out);
            config.onCopyDone?.(results[i]);
          }
          throw err;
        }
        if (!fresh) {
          // Killed by Stop. Staged, the finished copy is untouched and is
          // reported done again for the same reason as above. In place, the
          // regeneration was writing over it and a deleting `cancel` may
          // already have taken it — so nothing is claimed.
          if (staging) {
            await staging.discard(out);
            config.onCopyDone?.(results[i]);
          }
          break outer;
        }
        results[i] = { ...fresh, outputPath: final };
        sigs[i] = await signatureOf(final);
        config.onCopyDone?.(results[i]);
      }
      config.onPostPass?.(i + 1, total);
    }
  }

  return results;
}
