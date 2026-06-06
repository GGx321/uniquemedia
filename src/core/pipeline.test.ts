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
  preset: "medium",
  exportFormat: "reels",
  keepTrendAudio: false,
  allowMirror: false,
  targetDistance: 40,
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
