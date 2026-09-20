import { test, expect } from "bun:test";
import { uniquify } from "./pipeline";
import type { RenderExecutor } from "./executor";
import type { MediaInfo, UniquifyOptions } from "./types";

/** A recipe shape that has nothing in common with the video `Recipe`. */
interface TagRecipe {
  tag: string;
}

const info: MediaInfo = {
  kind: "photo",
  durationSec: 0,
  width: 1080,
  height: 1080,
  hasAudio: false,
};

function frameOfDistance(d: number): Uint8Array {
  const f = new Uint8Array(64 * 64);
  for (let i = 0; i < d * 30; i++) f[i] = 255; // more set bytes => larger pdq distance from blank
  return f;
}

class TagExecutor implements RenderExecutor<TagRecipe> {
  rendered: TagRecipe[] = [];
  async probe(): Promise<MediaInfo> {
    return info;
  }
  async render(_input: string, _info: MediaInfo, recipe: TagRecipe): Promise<void> {
    this.rendered.push(recipe);
  }
  async extractGrayFrames(input: string, count: number): Promise<Uint8Array[]> {
    const blank = new Uint8Array(64 * 64);
    if (input === "ORIGINAL") return Array.from({ length: count }, () => blank);
    return Array.from({ length: count }, () => frameOfDistance(5));
  }
}

const opts: UniquifyOptions = { targetDistance: 40, spoofMetadata: false };

test("drives an executor whose recipe type is not the video Recipe", async () => {
  const exec = new TagExecutor();

  // No explicit type argument: R must be inferred from the executor and the
  // sampleRecipe closure, which is the point of the generic signature.
  const res = await uniquify("ORIGINAL", opts, exec, 1, {
    seedBase: 1,
    framesPerCopy: 4,
    sampleRecipe: (_o, seed) => ({ tag: `tag-${seed}` }),
  });

  expect(res.length).toBe(1);
  expect(res[0].verify.passed).toBe(true);
  // The recipe the pipeline handed to the executor is the one config.sampleRecipe built.
  expect(exec.rendered).toEqual([{ tag: "tag-1" }]);
  expect(res[0].recipe).toEqual({ tag: "tag-1" });
});

test("sources the inter-copy regeneration recipe from config.sampleRecipe too", async () => {
  // Every copy yields the same frame, so the post-pass sees a collision and
  // regenerates copy 1 with the fresh seed `seedBase + index * 1000 + 7919`.
  const exec = new TagExecutor();

  const res = await uniquify("ORIGINAL", opts, exec, 2, {
    seedBase: 1,
    framesPerCopy: 4,
    interThreshold: 15,
    sampleRecipe: (_o, seed) => ({ tag: `tag-${seed}` }),
  });

  expect(res.length).toBe(2);
  expect(exec.rendered).toEqual([{ tag: "tag-1" }, { tag: "tag-1001" }, { tag: "tag-8920" }]);
  expect(res[1].recipe).toEqual({ tag: "tag-8920" });
});

test("hands sampleRecipe the very options object it verifies against", async () => {
  // The pipeline verifies against opts.targetDistance, so a recipe sampled from
  // a different options object would chase a target it was never sampled to reach.
  // Unreachable target + colliding frames exercise BOTH call sites: the retry
  // loop and the inter-copy regeneration.
  const exec = new TagExecutor();
  const strictOpts: UniquifyOptions = { targetDistance: 200, spoofMetadata: false };
  const seen: UniquifyOptions[] = [];

  await uniquify("ORIGINAL", strictOpts, exec, 2, {
    seedBase: 1,
    framesPerCopy: 4,
    maxAttempts: 2,
    interThreshold: 15,
    sampleRecipe: (o, seed) => {
      seen.push(o);
      return { tag: `tag-${seed}` };
    },
  });

  // 2 copies x 2 attempts, plus 1 regeneration in the post-pass. The exact
  // count is what proves the post-pass call site fired, and it assumes the
  // default sequential execution — adding `concurrency` here would change it.
  expect(seen.length).toBe(5);
  expect(seen.every((o) => o === strictOpts)).toBe(true);
});
