import { test, expect } from "bun:test";
import { uniquify } from "./pipeline";
import type { RenderExecutor } from "./executor";
import type { CopyOptions, MediaInfo, Recipe } from "./types";

const info: MediaInfo = { durationSec: 4, width: 640, height: 480, hasAudio: true };

function frame(d: number): Uint8Array {
  const f = new Uint8Array(64 * 64);
  for (let i = 0; i < d * 30; i++) f[i] = 255;
  return f;
}

class ProgMock implements RenderExecutor {
  async probe(): Promise<MediaInfo> { return info; }
  async render(_i: string, _n: MediaInfo, _r: Recipe, _o: string, onProgress?: (f: number) => void) {
    onProgress?.(0.5);
    onProgress?.(1);
  }
  async extractGrayFrames(input: string, count: number): Promise<Uint8Array[]> {
    const blank = new Uint8Array(64 * 64);
    if (input === "ORIGINAL") return Array.from({ length: count }, () => blank);
    return Array.from({ length: count }, () => frame(5));
  }
}

const opts: CopyOptions = {
  preset: "medium", exportFormat: "reels", keepTrendAudio: false, allowMirror: false, targetDistance: 40,
};

test("fires onProgress per render tick and onCopyDone per accepted copy", async () => {
  const exec = new ProgMock();
  const progress: number[] = [];
  const done: number[] = [];
  const res = await uniquify("ORIGINAL", opts, exec, 2, {
    seedBase: 1,
    framesPerCopy: 4,
    onProgress: (_i, _a, f) => progress.push(f),
    onCopyDone: (r) => done.push(r.index),
  });
  expect(res.length).toBe(2);
  expect(progress).toContain(1);
  expect(done).toEqual([0, 1]);
});
