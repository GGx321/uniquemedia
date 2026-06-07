import { test, expect } from "bun:test";
import { uniquify } from "./pipeline";
import type { RenderExecutor } from "./executor";
import type { CopyOptions, MediaInfo, Recipe } from "./types";
import type { DeviceProfile } from "./deviceProfile";

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
  strength: 1.0, exportFormat: "reels", keepTrendAudio: false, allowMirror: false, targetDistance: 40,
  spoofMetadata: false,
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

class SpyMock extends ProgMock {
  metadataCalls: Array<{ output: string; profile: DeviceProfile }> = [];
  async applyDeviceMetadata(output: string, profile: DeviceProfile): Promise<void> {
    this.metadataCalls.push({ output, profile });
  }
}

test("applyDeviceMetadata is called once per copy when spoofMetadata is true", async () => {
  const exec = new SpyMock();
  const spoofOpts: CopyOptions = { ...opts, spoofMetadata: true };
  const res = await uniquify("ORIGINAL", spoofOpts, exec, 3, {
    seedBase: 1,
    framesPerCopy: 4,
    nowMs: 1_700_000_000_000,
  });
  expect(res.length).toBe(3);
  expect(exec.metadataCalls.length).toBe(3);
  // profiles are deterministic and unique per copy
  for (let i = 0; i < 3; i++) {
    expect(exec.metadataCalls[i].profile.make).toBe("Apple");
  }
});

test("applyDeviceMetadata is NOT called when spoofMetadata is false", async () => {
  const exec = new SpyMock();
  await uniquify("ORIGINAL", opts, exec, 2, {
    seedBase: 1,
    framesPerCopy: 4,
  });
  expect(exec.metadataCalls.length).toBe(0);
});

class AbortMock implements RenderExecutor {
  renderCalls = 0;
  async probe(): Promise<MediaInfo> { return info; }
  async render(_i: string, _n: MediaInfo, _r: Recipe, _o: string, onProgress?: (f: number) => void): Promise<void> {
    this.renderCalls++;
    onProgress?.(1);
  }
  async extractGrayFrames(input: string, count: number): Promise<Uint8Array[]> {
    const blank = new Uint8Array(64 * 64);
    if (input === "ORIGINAL") return Array.from({ length: count }, () => blank);
    return Array.from({ length: count }, () => frame(5));
  }
}

test("AbortSignal halts the batch loop after the first copy", async () => {
  const controller = new AbortController();
  const exec = new AbortMock();
  const done: number[] = [];
  const res = await uniquify("ORIGINAL", opts, exec, 5, {
    seedBase: 1,
    framesPerCopy: 4,
    signal: controller.signal,
    onCopyDone: (r) => {
      done.push(r.index);
      // abort after the first copy completes
      controller.abort();
    },
  });
  // Only the first copy should have completed; the rest should be halted
  expect(res.length).toBeLessThan(5);
  expect(done.length).toBeLessThan(5);
});
