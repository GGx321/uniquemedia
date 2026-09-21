import { test, expect } from "bun:test";
import { uniquify } from "./pipeline";
import { sampleRecipe } from "./sampler";
import { sampleDeviceProfile } from "./deviceProfile";
import type { RenderExecutor } from "./executor";
import { IDENTITY_MODES } from "./types";
import type { CopyOptions, IdentityMode, MediaInfo, Recipe } from "./types";
import type { DeviceProfile } from "./deviceProfile";

const info: MediaInfo = { kind: "video", durationSec: 4, width: 640, height: 480, hasAudio: true };

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
  identity: "engine",
  edgeMode: "auto",
  blackFirstFrame: false,
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
    sampleRecipe,
  });
  expect(res.length).toBe(2);
  expect(progress).toContain(1);
  expect(done).toEqual([0, 1]);
});

interface IdentityCall {
  output: string;
  identity: IdentityMode;
  profile: DeviceProfile;
}

class SpyMock extends ProgMock {
  metadataCalls: IdentityCall[] = [];
  async applyIdentity(output: string, identity: IdentityMode, profile: DeviceProfile): Promise<void> {
    this.metadataCalls.push({ output, identity, profile });
  }
}

test("applyIdentity is called once per copy with the iphone mode from the options", async () => {
  const exec = new SpyMock();
  const spoofOpts: CopyOptions = { ...opts, identity: "iphone" };
  const res = await uniquify("ORIGINAL", spoofOpts, exec, 3, {
    seedBase: 1,
    framesPerCopy: 4,
    nowMs: 1_700_000_000_000,
    // Every mock copy carries the same frame, so the default threshold would
    // make the inter-copy post-pass re-render two of them — and a re-render
    // gets its own metadata write. Pinned to 0 (no collision is ever "too
    // close") so this test measures the per-copy call and nothing else; the
    // post-pass is the subject of its own test below.
    interThreshold: 0,
    sampleRecipe,
  });
  expect(res.length).toBe(3);
  expect(exec.metadataCalls.length).toBe(3);
  // profiles are deterministic and unique per copy
  for (let i = 0; i < 3; i++) {
    expect(exec.metadataCalls[i].identity).toBe("iphone");
    expect(exec.metadataCalls[i].profile.make).toBe("Apple");
  }
});

test.each([...IDENTITY_MODES])(
  "applyIdentity reaches the executor for every shipped copy in %s mode — the pipeline never decides what a mode means",
  async (identity) => {
    // `engine` used to short-circuit here as "spoofing off". The executor is
    // the only place that knows what each mode does to a file (nothing, for a
    // video in engine mode; a JFIF strip for a still in clean mode), so the
    // pipeline hands every mode down and decides none of them.
    const exec = new SpyMock();
    const res = await uniquify("ORIGINAL", { ...opts, identity }, exec, 3, {
      seedBase: 1,
      framesPerCopy: 4,
      nowMs: 1_700_000_000_000,
      interThreshold: 0,
      sampleRecipe,
    });
    expect(res.length).toBe(3);
    expect(exec.metadataCalls.map((c) => c.identity)).toEqual([identity, identity, identity]);
    expect(exec.metadataCalls.map((c) => c.output)).toEqual(res.map((r) => r.outputPath));
  }
);

/** Logs renders and metadata writes in the order they happen, per output file.
 *  The invariant is about ordering, not counting: whatever else happens, the
 *  last thing to touch a file that ships must be the metadata write. */
class OrderMock extends ProgMock {
  log: Array<{ op: "render" | "metadata"; output: string }> = [];
  metadataCalls: IdentityCall[] = [];
  async render(
    input: string,
    info: MediaInfo,
    recipe: Recipe,
    output: string,
    onProgress?: (f: number) => void
  ): Promise<void> {
    this.log.push({ op: "render", output });
    await super.render(input, info, recipe, output, onProgress);
  }
  async applyIdentity(output: string, identity: IdentityMode, profile: DeviceProfile): Promise<void> {
    this.log.push({ op: "metadata", output });
    this.metadataCalls.push({ output, identity, profile });
  }
}

test.each([...IDENTITY_MODES])(
  "re-applies the %s identity after the inter-copy post-pass re-renders a copy",
  async (identity) => {
    // The photo graph always passes `-map_metadata -1` and the encoder-signature
    // scrub lives in the executor's identity pass, so a copy whose last touch
    // was a render ships with NO EXIF and with the encoder's own comment still
    // on it. A batch where some files claim to be an iPhone and others carry
    // `Lavc60.3.100` is a stronger tell than not spoofing at all — and the same
    // holds for `clean`, where the re-rendered file would be the one member of
    // the batch still signed by the encoder.
    const exec = new OrderMock();
    const res = await uniquify("ORIGINAL", { ...opts, identity }, exec, 3, {
      seedBase: 1,
      framesPerCopy: 4,
      nowMs: 1_700_000_000_000,
      outputPath: (i) => `copy_${i + 1}.mp4`,
      sampleRecipe,
    });

    expect(res.length).toBe(3);
    // Guard the premise: identical frames must actually have tripped the
    // post-pass, or the ordering assertion below proves nothing.
    expect(exec.log.filter((e) => e.op === "render").length).toBeGreaterThan(3);

    for (const r of res) {
      const touches = exec.log.filter((e) => e.output === r.outputPath);
      expect(touches[touches.length - 1]).toEqual({ op: "metadata", output: r.outputPath });
    }
    expect(exec.metadataCalls.every((c) => c.identity === identity)).toBe(true);
  }
);

test("a re-rendered copy keeps the device identity of its own slot", async () => {
  // The post-pass re-draws the picture, not the phone. Deriving the profile
  // from the copy index (not from the fresh render seed) is what keeps one file
  // from claiming two different handsets across its own renders.
  const exec = new OrderMock();
  const spoofOpts: CopyOptions = { ...opts, identity: "iphone" };
  const res = await uniquify("ORIGINAL", spoofOpts, exec, 3, {
    seedBase: 1,
    framesPerCopy: 4,
    nowMs: 1_700_000_000_000,
    outputPath: (i) => `copy_${i + 1}.mp4`,
    sampleRecipe,
  });

  const regenerated = res.filter(
    (r) => exec.metadataCalls.filter((c) => c.output === r.outputPath).length > 1
  );
  expect(regenerated.length).toBeGreaterThan(0);
  for (const r of regenerated) {
    const models = exec.metadataCalls
      .filter((c) => c.output === r.outputPath)
      .map((c) => `${c.profile.model}|${c.profile.creationLocal}`);
    expect(new Set(models).size).toBe(1);
  }
});

test("dates the spoofed capture from the wall clock when the host configures no nowMs", async () => {
  // A missing nowMs used to resolve to 0 — the Unix epoch — so every copy
  // claimed to have been shot in December 1969. Absurd EXIF, written silently,
  // and it took a host forgetting one field (Electron did) to get there. The
  // fallback is the same clock the host would have passed, so the worst case of
  // forgetting is a batch that is merely non-deterministic, never nonsensical.
  const exec = new SpyMock();
  const spoofOpts: CopyOptions = { ...opts, identity: "iphone" };
  const before = Date.now();
  await uniquify("ORIGINAL", spoofOpts, exec, 1, {
    seedBase: 1,
    framesPerCopy: 4,
    sampleRecipe,
  });

  expect(exec.metadataCalls.length).toBe(1);
  const captured = Date.parse(exec.metadataCalls[0].profile.creationUtc);
  // The generator places the capture 1..46 days before the clock it was given.
  expect(captured).toBeLessThan(Date.now());
  expect(captured).toBeGreaterThan(before - 47 * 86_400_000);
});

test("uses the host's clock, not the wall clock, when nowMs is configured", async () => {
  // The fallback must not cost determinism: a host that states the time still
  // gets a profile derived from exactly that instant.
  const exec = new SpyMock();
  const spoofOpts: CopyOptions = { ...opts, identity: "iphone" };
  await uniquify("ORIGINAL", spoofOpts, exec, 1, {
    seedBase: 1,
    framesPerCopy: 4,
    nowMs: 1_700_000_000_000,
    sampleRecipe,
  });
  expect(exec.metadataCalls[0].profile).toEqual(sampleDeviceProfile(1, 1_700_000_000_000));
});

test.each([...IDENTITY_MODES])(
  "an executor with no identity hook still ships every copy in %s mode",
  async (identity) => {
    // The hook is optional on the interface: a backend that has nothing to say
    // about identity (a wasm renderer, a test double) must not be a crash.
    const exec = new ProgMock();
    const res = await uniquify("ORIGINAL", { ...opts, identity }, exec, 2, {
      seedBase: 1,
      framesPerCopy: 4,
      sampleRecipe,
    });
    expect(res.length).toBe(2);
  }
);

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

// Records how many render() calls are in flight at once. Each render resolves
// on a microtask so multiple workers genuinely overlap when concurrency > 1.
class ConcurrencyMock implements RenderExecutor {
  inFlight = 0;
  maxInFlight = 0;
  async probe(): Promise<MediaInfo> { return info; }
  async render(_i: string, _n: MediaInfo, _r: Recipe, _o: string, onProgress?: (f: number) => void): Promise<void> {
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    onProgress?.(1);
    await Promise.resolve(); // yield so peers can enter before we exit
    this.inFlight--;
  }
  async extractGrayFrames(input: string, count: number): Promise<Uint8Array[]> {
    const blank = new Uint8Array(64 * 64);
    if (input === "ORIGINAL") return Array.from({ length: count }, () => blank);
    return Array.from({ length: count }, () => frame(5));
  }
}

test("processes copies in parallel under a bounded worker pool", async () => {
  const exec = new ConcurrencyMock();
  const res = await uniquify("ORIGINAL", opts, exec, 8, {
    seedBase: 1,
    framesPerCopy: 4,
    concurrency: 4,
    sampleRecipe,
  });
  // all 8 copies returned, sorted by index
  expect(res.length).toBe(8);
  expect(res.map((r) => r.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  // it actually parallelized (more than one render in flight at some point)
  expect(exec.maxInFlight).toBeGreaterThan(1);
  // and never exceeded the configured concurrency
  expect(exec.maxInFlight).toBeLessThanOrEqual(4);
});

test("AbortSignal halts the batch loop after the first copy", async () => {
  const controller = new AbortController();
  const exec = new AbortMock();
  const done: number[] = [];
  const res = await uniquify("ORIGINAL", opts, exec, 5, {
    seedBase: 1,
    framesPerCopy: 4,
    signal: controller.signal,
    sampleRecipe,
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
