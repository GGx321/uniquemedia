import { test, expect } from "bun:test";
import { uniquify } from "./pipeline";
import type { RenderExecutor } from "./executor";
import type { CopyOptions, MediaInfo, Recipe } from "./types";

const info: MediaInfo = { durationSec: 4, width: 640, height: 480, hasAudio: true };

function frameOfDistance(d: number): Uint8Array {
  const f = new Uint8Array(64 * 64);
  for (let i = 0; i < d * 30; i++) f[i] = 255; // more set bytes => larger pdq distance from blank
  return f;
}

/** Mock: original is blank; copy "distance" grows with recipe.intensity. */
class MockExecutor implements RenderExecutor {
  rendered: Recipe[] = [];
  lastIntensity = 1;
  async probe(): Promise<MediaInfo> {
    return info;
  }
  async render(_i: string, _info: MediaInfo, recipe: Recipe): Promise<void> {
    this.rendered.push(recipe);
    this.lastIntensity = recipe.intensity;
  }
  async extractGrayFrames(input: string, count: number): Promise<Uint8Array[]> {
    const blank = new Uint8Array(64 * 64);
    if (input === "ORIGINAL") return Array.from({ length: count }, () => blank);
    return Array.from({ length: count }, () => frameOfDistance(this.lastIntensity));
  }
}

const opts: CopyOptions = {
  strength: 1.0,
  exportFormat: "reels",
  keepTrendAudio: false,
  allowMirror: false,
  targetDistance: 40,
  spoofMetadata: false,
  keepResolution: false,
};

test("produces the requested number of copies", async () => {
  const exec = new MockExecutor();
  const res = await uniquify("ORIGINAL", opts, exec, 3, { seedBase: 1, framesPerCopy: 4 });
  expect(res.length).toBe(3);
  expect(res.every((r) => r.verify.passed)).toBe(true);
});

test("auto-strengthens intensity when a copy is too similar", async () => {
  const exec = new MockExecutor();
  const strict = { ...opts, targetDistance: 200 }; // unreachable -> always retries
  const res = await uniquify("ORIGINAL", strict, exec, 1, {
    seedBase: 1,
    framesPerCopy: 4,
    maxAttempts: 3,
  });
  const intensities = exec.rendered.map((r) => r.intensity);
  // 3 attempts + 1 re-render of best (so disk matches reported metric)
  expect(intensities.length).toBe(4);
  expect(intensities[1]).toBeGreaterThan(intensities[0]);
  expect(res[0].verify.passed).toBe(false); // gave up, shipped best with warning
});

test("disk holds the best attempt, not the last, when giving up", async () => {
  // Path-aware mock: render records recipe per path; extractGrayFrames reads
  // back the recipe stored at that path. Distance DECREASES with intensity, so
  // the FIRST attempt is best and a naive impl would leave the LAST on disk.
  class PathMock implements RenderExecutor {
    disk = new Map<string, Recipe>();
    async probe(): Promise<MediaInfo> {
      return info;
    }
    async render(_i: string, _info: MediaInfo, recipe: Recipe, output: string): Promise<void> {
      this.disk.set(output, recipe);
    }
    async extractGrayFrames(input: string, count: number): Promise<Uint8Array[]> {
      if (input === "ORIGINAL") return Array.from({ length: count }, () => new Uint8Array(64 * 64));
      const recipe = this.disk.get(input)!;
      const d = Math.max(1, Math.round(50 / recipe.intensity)); // smaller as intensity grows
      return Array.from({ length: count }, () => frameOfDistance(d));
    }
  }

  const exec = new PathMock();
  const strict = { ...opts, targetDistance: 250 }; // unreachable -> gives up, best = attempt 0
  const res = await uniquify("ORIGINAL", strict, exec, 1, {
    seedBase: 1,
    framesPerCopy: 4,
    maxAttempts: 3,
    outputPath: () => "copy.mp4",
  });

  // The file on disk must be the SAME recipe object the result reports as best.
  expect(exec.disk.get("copy.mp4")).toBe(res[0].recipe);
});

test("inter-copy post-pass regenerates copies that are too similar to each other", async () => {
  // This mock returns identical frame-0 hashes for all copies so the post-pass
  // must detect the collision and re-render copy index 1.
  // After regeneration the mock returns a distinct frame to simulate separation.
  let regenCallCount = 0;
  class PostPassMock implements RenderExecutor {
    renderCalls: Recipe[] = [];
    async probe(): Promise<MediaInfo> { return info; }
    async render(_i: string, _info: MediaInfo, recipe: Recipe): Promise<void> {
      this.renderCalls.push(recipe);
    }
    async extractGrayFrames(input: string, count: number): Promise<Uint8Array[]> {
      if (input === "ORIGINAL") {
        // Original: all-zero frames (blank)
        return Array.from({ length: count }, () => new Uint8Array(64 * 64));
      }
      // For the initial extract after rendering: return a frame far from original
      // (to pass targetDistance=40) but identical across copies to trigger the post-pass.
      // After the first regeneration, return a frame that differs from the identical one.
      if (input.endsWith("_regen")) {
        // Regenerated copy: flip many bits to be distinct
        regenCallCount++;
        const f = new Uint8Array(64 * 64).fill(0xAA);
        return Array.from({ length: count }, () => f);
      }
      // All initial copies return the same frame data → same PDQ hash → post-pass triggers.
      return Array.from({ length: count }, () => frameOfDistance(5));
    }
  }

  const exec = new PostPassMock();
  let copyIdx = 0;
  const res = await uniquify("ORIGINAL", opts, exec, 2, {
    seedBase: 1,
    framesPerCopy: 4,
    interThreshold: 15, // default; initial copies have distance 0 → triggers regen
    outputPath: (i) => {
      // First call per copy is the main render; subsequent calls for post-pass
      // regen return a path ending in _regen so the mock returns a distinct frame.
      return `copy_${i}`;
    },
  });

  // Both copies must be returned.
  expect(res.length).toBe(2);
  // The post-pass must have triggered at least one extra render for copy index 1.
  // Initial renders: 2 copies × 1 render each = 2. Post-pass regen adds ≥1 more.
  expect(exec.renderCalls.length).toBeGreaterThan(2);
});
