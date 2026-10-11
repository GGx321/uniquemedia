import { test, expect } from "bun:test";
import { uniquify } from "./pipeline";
import type { RenderExecutor } from "./executor";
import type { MediaInfo, UniquifyOptions } from "./types";

interface TagRecipe {
  tag: string;
}

class CountingExecutor implements RenderExecutor<TagRecipe> {
  renders = 0;
  frameReads = 0;
  constructor(private readonly info: MediaInfo) {}
  async probe(): Promise<MediaInfo> {
    return this.info;
  }
  async render(): Promise<void> {
    this.renders++;
  }
  async extractGrayFrames(input: string, count: number): Promise<Uint8Array[]> {
    this.frameReads++;
    const f = new Uint8Array(64 * 64);
    if (input !== "ORIGINAL") for (let i = 0; i < 150; i++) f[i] = 255;
    return Array.from({ length: count }, () => f);
  }
}

const videoOf = (durationSec: number): MediaInfo => ({
  kind: "video",
  durationSec,
  width: 1080,
  height: 1920,
  hasAudio: true,
});

const opts: UniquifyOptions = { targetDistance: 40, identity: "engine" };
const run = (exec: CountingExecutor) =>
  uniquify("ORIGINAL", opts, exec, 1, {
    seedBase: 1,
    framesPerCopy: 4,
    sampleRecipe: (_o, seed) => ({ tag: `tag-${seed}` }),
  });

test("accepts a video of exactly 10 minutes", async () => {
  const exec = new CountingExecutor(videoOf(600));
  const res = await run(exec);
  expect(res.length).toBe(1);
  expect(exec.renders).toBe(1);
});

test("refuses a 10:01 video with a clear message and starts no encode", async () => {
  const exec = new CountingExecutor(videoOf(601));
  await expect(run(exec)).rejects.toThrow(/Видео длиннее 10 минут/);
  expect(exec.renders).toBe(0);
  expect(exec.frameReads).toBe(0);
});
