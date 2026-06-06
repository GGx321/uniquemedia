# Uniquifier Engine + CLI — Implementation Plan (Plan 1 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a headless video-uniquification engine that turns one source video into N verified-unique copies, driven by a CLI.

**Architecture:** Pure-TS `core` (no Electron) samples a per-copy recipe from a preset+seed, a `filterGraph` compiles it to a single-pass FFmpeg command, a node `FfmpegExecutor` runs FFmpeg/FFprobe, and a `verification` step computes PDQ-style perceptual hashes to guarantee each copy crosses a Hamming-distance threshold (auto-strengthening on failure).

**Tech Stack:** TypeScript (ESM), bun (package manager + test runner via `bun test`), `ffmpeg-static`, `ffprobe-static`.

---

## File Structure (Plan 1)

- `src/core/rng.ts` — seeded RNG (mulberry32) + sampling helpers.
- `src/core/util.ts` — `round`, `clamp` numeric helpers.
- `src/core/types.ts` — `MediaInfo`, `Recipe`, `Operation`, `CopyOptions`, `ExportFormat`, `VerifyResult`, `EXPORT_DIMS`.
- `src/core/presets.ts` — per-parameter neutral/deviation table + preset scalars.
- `src/core/filters.ts` — one fragment function per FFmpeg op id + registry.
- `src/core/sampler.ts` — `sampleRecipe(opts, seed, intensity)`.
- `src/core/filterGraph.ts` — `buildArgs(recipe, info)` → FFmpeg argument array.
- `src/core/executor.ts` — `RenderExecutor` interface.
- `src/core/pdq/pdq.ts` — `computePdqHash(gray64)` → 32-byte hash.
- `src/core/pdq/hamming.ts` — `hammingDistance(a, b)`.
- `src/core/verification.ts` — `verifyCopy`, `interCopyDistance`.
- `src/core/pipeline.ts` — `uniquify(...)` orchestrator (render → verify → auto-strengthen → inter-copy dedup).
- `src/node/ffmpegExecutor.ts` — `FfmpegExecutor implements RenderExecutor`.
- `src/cli.ts` — argument parsing + progress output.
- Tests are co-located as `*.test.ts` next to each module.

---

## Task 1: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `src/smoke.test.ts`

- [ ] **Step 1: Init git + bun**

```bash
git init
bun init -y
```

- [ ] **Step 2: Write `package.json`**

```json
{
  "name": "uniquemedia",
  "version": "0.1.0",
  "type": "module",
  "bin": { "uniquify": "./src/cli.ts" },
  "scripts": {
    "test": "bun test",
    "uniquify": "bun run src/cli.ts"
  },
  "dependencies": {
    "ffmpeg-static": "^5.2.0",
    "ffprobe-static": "^3.1.0"
  },
  "devDependencies": {
    "@types/ffprobe-static": "^2.0.3",
    "typescript": "^5.6.0"
  }
}
```

- [ ] **Step 3: Install deps**

Run: `bun install`
Expected: dependencies installed, `bun.lock` created.

- [ ] **Step 4: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["bun-types"],
    "noEmit": true
  },
  "include": ["src"]
}
```

- [ ] **Step 5: Write `.gitignore`**

```
node_modules/
dist/
out/
*.tmp.mp4
.DS_Store
```

- [ ] **Step 6: Write smoke test `src/smoke.test.ts`**

```ts
import { test, expect } from "bun:test";

test("toolchain works", () => {
  expect(1 + 1).toBe(2);
});
```

- [ ] **Step 7: Run the smoke test**

Run: `bun test src/smoke.test.ts`
Expected: 1 pass.

- [ ] **Step 8: Commit**

```bash
git add package.json tsconfig.json .gitignore bun.lock src/smoke.test.ts
git commit -m "🔧 scaffold bun + typescript project"
```

---

## Task 2: Seeded RNG

**Files:**
- Create: `src/core/rng.ts`, `src/core/rng.test.ts`

- [ ] **Step 1: Write the failing test `src/core/rng.test.ts`**

```ts
import { test, expect } from "bun:test";
import { makeRng, rngRange, rngInt, rngBool, rngPick } from "./rng";

test("same seed produces same sequence", () => {
  const a = makeRng(42);
  const b = makeRng(42);
  expect([a(), a(), a()]).toEqual([b(), b(), b()]);
});

test("different seeds diverge", () => {
  const a = makeRng(1);
  const b = makeRng(2);
  expect(a()).not.toBe(b());
});

test("rng() stays in [0,1)", () => {
  const r = makeRng(7);
  for (let i = 0; i < 1000; i++) {
    const v = r();
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(1);
  }
});

test("rngRange respects bounds", () => {
  const r = makeRng(7);
  for (let i = 0; i < 1000; i++) {
    const v = rngRange(r, -2, 5);
    expect(v).toBeGreaterThanOrEqual(-2);
    expect(v).toBeLessThan(5);
  }
});

test("rngInt is inclusive of max", () => {
  const r = makeRng(3);
  const seen = new Set<number>();
  for (let i = 0; i < 500; i++) seen.add(rngInt(r, 1, 3));
  expect([...seen].sort()).toEqual([1, 2, 3]);
});

test("rngBool and rngPick are deterministic", () => {
  const r = makeRng(9);
  expect(typeof rngBool(r)).toBe("boolean");
  expect(["a", "b", "c"]).toContain(rngPick(r, ["a", "b", "c"]));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/rng.test.ts`
Expected: FAIL ("Cannot find module './rng'").

- [ ] **Step 3: Write `src/core/rng.ts`**

```ts
export type Rng = () => number;

export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function rngRange(rng: Rng, min: number, max: number): number {
  return min + rng() * (max - min);
}

export function rngInt(rng: Rng, min: number, max: number): number {
  return Math.floor(min + rng() * (max - min + 1));
}

export function rngBool(rng: Rng, p = 0.5): boolean {
  return rng() < p;
}

export function rngPick<T>(rng: Rng, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/core/rng.test.ts`
Expected: 6 pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/rng.ts src/core/rng.test.ts
git commit -m "✨ add seeded rng with sampling helpers"
```

---

## Task 3: Types, util, presets

**Files:**
- Create: `src/core/util.ts`, `src/core/types.ts`, `src/core/presets.ts`, `src/core/presets.test.ts`

- [ ] **Step 1: Write `src/core/util.ts`**

```ts
export function round(n: number, digits = 4): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}
```

- [ ] **Step 2: Write `src/core/types.ts`**

```ts
export interface MediaInfo {
  durationSec: number;
  width: number;
  height: number;
  hasAudio: boolean;
}

export type PresetName = "light" | "medium" | "aggressive";
export type ExportFormat = "reels" | "feed" | "square";

export const EXPORT_DIMS: Record<ExportFormat, { w: number; h: number }> = {
  reels: { w: 1080, h: 1920 },
  feed: { w: 1080, h: 1350 },
  square: { w: 1080, h: 1080 },
};

export interface CopyOptions {
  preset: PresetName;
  exportFormat: ExportFormat;
  keepTrendAudio: boolean;
  allowMirror: boolean;
  targetDistance: number; // Hamming distance (0..256) the copy must exceed
}

export interface Operation {
  id: string;
  params: Record<string, number | boolean | string>;
}

export interface Recipe {
  seed: number;
  intensity: number; // 1.0 baseline; raised on auto-strengthen
  exportFormat: ExportFormat;
  keepTrendAudio: boolean;
  video: Operation[];
  audio: Operation[];
}

export interface VerifyResult {
  minDistance: number;
  passed: boolean;
  perFrame: number[];
}
```

- [ ] **Step 3: Write the failing test `src/core/presets.test.ts`**

```ts
import { test, expect } from "bun:test";
import { PARAMS, PRESET_SCALAR } from "./presets";

test("every param has neutral and positive deviation", () => {
  for (const [key, spec] of Object.entries(PARAMS)) {
    expect(typeof spec.neutral).toBe("number");
    expect(spec.dev).toBeGreaterThan(0);
    expect(key.length).toBeGreaterThan(0);
  }
});

test("preset scalars increase light < medium < aggressive", () => {
  expect(PRESET_SCALAR.light).toBeLessThan(PRESET_SCALAR.medium);
  expect(PRESET_SCALAR.medium).toBeLessThan(PRESET_SCALAR.aggressive);
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `bun test src/core/presets.test.ts`
Expected: FAIL ("Cannot find module './presets'").

- [ ] **Step 5: Write `src/core/presets.ts`**

```ts
import type { PresetName } from "./types";

export interface ParamSpec {
  neutral: number;
  dev: number; // base max absolute deviation at scalar 1.0
}

export const PARAMS = {
  brightness: { neutral: 0, dev: 0.05 },
  contrast: { neutral: 1, dev: 0.06 },
  saturation: { neutral: 1, dev: 0.08 },
  gamma: { neutral: 1, dev: 0.06 },
  hueDeg: { neutral: 0, dev: 6 },
  zoomPct: { neutral: 0, dev: 5 }, // one-sided (positive zoom)
  rotateDeg: { neutral: 0, dev: 1.2 },
  perspective: { neutral: 0, dev: 0.025 }, // one-sided corner offset fraction
  lens: { neutral: 0, dev: 0.04 },
  noise: { neutral: 0, dev: 10 }, // one-sided strength
  speed: { neutral: 1, dev: 0.05 },
  eqGain: { neutral: 0, dev: 2.5 },
  crf: { neutral: 21, dev: 2 },
} satisfies Record<string, ParamSpec>;

export const PRESET_SCALAR: Record<PresetName, number> = {
  light: 0.5,
  medium: 1.0,
  aggressive: 1.7,
};
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test src/core/presets.test.ts`
Expected: 2 pass.

- [ ] **Step 7: Commit**

```bash
git add src/core/util.ts src/core/types.ts src/core/presets.ts src/core/presets.test.ts
git commit -m "✨ add core types, util, and preset parameter table"
```

---

## Task 4: Filter fragment functions

**Files:**
- Create: `src/core/filters.ts`, `src/core/filters.test.ts`

- [ ] **Step 1: Write the failing test `src/core/filters.test.ts`**

```ts
import { test, expect } from "bun:test";
import { FRAGMENTS } from "./filters";

const info = { durationSec: 5, width: 1280, height: 720, hasAudio: true };

test("eq fragment formats params", () => {
  const out = FRAGMENTS.eq({ brightness: 0.02, contrast: 1.03, saturation: 0.97, gamma: 1.01 }, info);
  expect(out).toBe("eq=brightness=0.02:contrast=1.03:saturation=0.97:gamma=1.01");
});

test("hue fragment", () => {
  expect(FRAGMENTS.hue({ h: -4 }, info)).toBe("hue=h=-4");
});

test("zoomcrop scales then crops to source size", () => {
  expect(FRAGMENTS.zoomcrop({ zoomPct: 4 }, info)).toBe(
    "scale=iw*1.04:ih*1.04,crop=1280:720"
  );
});

test("rotate converts degrees to radians", () => {
  const out = FRAGMENTS.rotate({ deg: 1 }, info);
  expect(out.startsWith("rotate=")).toBe(true);
  expect(out).toContain("ow=rotw");
});

test("noise zero strength is a no-op (null)", () => {
  expect(FRAGMENTS.noise({ strength: 0 }, info)).toBeNull();
});

test("vignette off is null, on emits filter", () => {
  expect(FRAGMENTS.vignette({ on: false }, info)).toBeNull();
  expect(FRAGMENTS.vignette({ on: true }, info)).toBe("vignette");
});

test("perspective emits 8 coordinates", () => {
  const out = FRAGMENTS.perspective({ off: 0.02 }, info);
  expect(out).toContain("perspective=");
  expect((out!.match(/:/g) || []).length).toBe(8);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/filters.test.ts`
Expected: FAIL ("Cannot find module './filters'").

- [ ] **Step 3: Write `src/core/filters.ts`**

```ts
import type { MediaInfo } from "./types";
import { round } from "./util";

type Params = Record<string, number | boolean | string>;
type Fragment = (p: Params, info: MediaInfo) => string | null;

const n = (v: unknown) => Number(v);

export const FRAGMENTS: Record<string, Fragment> = {
  eq: (p) =>
    `eq=brightness=${n(p.brightness)}:contrast=${n(p.contrast)}:saturation=${n(
      p.saturation
    )}:gamma=${n(p.gamma)}`,

  hue: (p) => `hue=h=${n(p.h)}`,

  zoomcrop: (p, info) => {
    const f = round(1 + n(p.zoomPct) / 100, 4);
    if (f <= 1) return null;
    return `scale=iw*${f}:ih*${f},crop=${info.width}:${info.height}`;
  },

  rotate: (p) => {
    const rad = round((n(p.deg) * Math.PI) / 180, 6);
    if (rad === 0) return null;
    // ow/oh keep frame size; corners covered by the export over-zoom.
    return `rotate=${rad}:ow=rotw(${rad}):oh=roth(${rad}):c=black`;
  },

  perspective: (p, info) => {
    const off = n(p.off);
    if (off === 0) return null;
    const dx = round(info.width * off, 1);
    const dy = round(info.height * off, 1);
    const w = info.width;
    const h = info.height;
    // slight tilt: push top edge inward, bottom edge outward
    return (
      `perspective=` +
      `${dx}:${dy}:${w - dx}:${dy}:` +
      `0:${h}:${w}:${h}:interpolation=linear`
    );
  },

  lenscorrection: (p) => {
    const k1 = n(p.k1);
    if (k1 === 0) return null;
    return `lenscorrection=k1=${k1}:k2=0`;
  },

  noise: (p) => {
    const s = Math.round(n(p.strength));
    if (s <= 0) return null;
    return `noise=alls=${s}:allf=t+u`;
  },

  vignette: (p) => (p.on ? "vignette" : null),

  hflip: (p) => (p.on ? "hflip" : null),
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/core/filters.test.ts`
Expected: 7 pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/filters.ts src/core/filters.test.ts
git commit -m "✨ add ffmpeg filter fragment functions"
```

---

## Task 5: Recipe sampler

**Files:**
- Create: `src/core/sampler.ts`, `src/core/sampler.test.ts`

- [ ] **Step 1: Write the failing test `src/core/sampler.test.ts`**

```ts
import { test, expect } from "bun:test";
import { sampleRecipe } from "./sampler";
import type { CopyOptions } from "./types";

const opts: CopyOptions = {
  preset: "medium",
  exportFormat: "reels",
  keepTrendAudio: false,
  allowMirror: false,
  targetDistance: 90,
};

test("same seed and intensity is deterministic", () => {
  const a = sampleRecipe(opts, 100, 1);
  const b = sampleRecipe(opts, 100, 1);
  expect(a).toEqual(b);
});

test("different seeds produce different recipes", () => {
  const a = sampleRecipe(opts, 1, 1);
  const b = sampleRecipe(opts, 2, 1);
  expect(a).not.toEqual(b);
});

test("higher intensity widens eq deviations on average", () => {
  let lowSum = 0;
  let highSum = 0;
  for (let s = 0; s < 40; s++) {
    const low = sampleRecipe(opts, s, 1).video.find((o) => o.id === "eq")!;
    const high = sampleRecipe(opts, s, 2).video.find((o) => o.id === "eq")!;
    lowSum += Math.abs(Number(low.params.brightness));
    highSum += Math.abs(Number(high.params.brightness));
  }
  expect(highSum).toBeGreaterThan(lowSum);
});

test("keepTrendAudio yields no audio ops", () => {
  const r = sampleRecipe({ ...opts, keepTrendAudio: true }, 5, 1);
  expect(r.audio.length).toBe(0);
});

test("mirror disabled never emits hflip", () => {
  for (let s = 0; s < 50; s++) {
    const r = sampleRecipe(opts, s, 1);
    expect(r.video.some((o) => o.id === "hflip" && o.params.on === true)).toBe(false);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/sampler.test.ts`
Expected: FAIL ("Cannot find module './sampler'").

- [ ] **Step 3: Write `src/core/sampler.ts`**

```ts
import { makeRng, type Rng } from "./rng";
import { PARAMS, PRESET_SCALAR } from "./presets";
import { round, clamp } from "./util";
import type { CopyOptions, Operation, Recipe } from "./types";

function dev(rng: Rng, key: keyof typeof PARAMS, scalar: number, oneSided = false): number {
  const spec = PARAMS[key];
  const mag = (oneSided ? rng() : rng() * 2 - 1) * spec.dev * scalar;
  return spec.neutral + mag;
}

export function sampleRecipe(opts: CopyOptions, seed: number, intensity = 1): Recipe {
  const rng = makeRng(seed);
  const s = PRESET_SCALAR[opts.preset] * intensity;

  const video: Operation[] = [
    {
      id: "eq",
      params: {
        brightness: round(dev(rng, "brightness", s)),
        contrast: round(dev(rng, "contrast", s)),
        saturation: round(dev(rng, "saturation", s)),
        gamma: round(clamp(dev(rng, "gamma", s), 0.5, 2)),
      },
    },
    { id: "hue", params: { h: round(dev(rng, "hueDeg", s)) } },
    { id: "zoomcrop", params: { zoomPct: round(dev(rng, "zoomPct", s, true)) } },
    { id: "rotate", params: { deg: round(dev(rng, "rotateDeg", s)) } },
    { id: "perspective", params: { off: round(dev(rng, "perspective", s, true)) } },
    { id: "lenscorrection", params: { k1: round(dev(rng, "lens", s)) } },
    { id: "noise", params: { strength: Math.round(dev(rng, "noise", s, true)) } },
    { id: "vignette", params: { on: rng() < 0.6 * Math.min(1, s) } },
  ];

  if (opts.allowMirror && rng() < 0.5) {
    video.push({ id: "hflip", params: { on: true } });
  }

  const speed = round(clamp(dev(rng, "speed", s), 0.9, 1.1));
  const crf = Math.round(clamp(dev(rng, "crf", s), 18, 26));

  const audio: Operation[] = opts.keepTrendAudio
    ? []
    : [{ id: "aeq", params: { gain: round(dev(rng, "eqGain", s)) } }];

  return {
    seed,
    intensity,
    exportFormat: opts.exportFormat,
    keepTrendAudio: opts.keepTrendAudio,
    video: [...video, { id: "speed", params: { speed } }, { id: "encode", params: { crf } }],
    audio,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/core/sampler.test.ts`
Expected: 5 pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/sampler.ts src/core/sampler.test.ts
git commit -m "✨ add per-copy recipe sampler"
```

---

## Task 6: Filter-graph / FFmpeg arg builder

**Files:**
- Create: `src/core/filterGraph.ts`, `src/core/filterGraph.test.ts`

- [ ] **Step 1: Write the failing test `src/core/filterGraph.test.ts`**

```ts
import { test, expect } from "bun:test";
import { buildArgs } from "./filterGraph";
import type { MediaInfo, Recipe } from "./types";

const info: MediaInfo = { durationSec: 5, width: 1280, height: 720, hasAudio: true };

const recipe: Recipe = {
  seed: 1,
  intensity: 1,
  exportFormat: "reels",
  keepTrendAudio: false,
  video: [
    { id: "eq", params: { brightness: 0.01, contrast: 1.02, saturation: 0.99, gamma: 1 } },
    { id: "noise", params: { strength: 0 } }, // no-op, must be skipped
    { id: "speed", params: { speed: 1.05 } },
    { id: "encode", params: { crf: 21 } },
  ],
  audio: [{ id: "aeq", params: { gain: 1.5 } }],
};

test("builds a single -vf chain skipping no-ops and appending export scale", () => {
  const args = buildArgs(recipe, info);
  const vf = args[args.indexOf("-vf") + 1];
  expect(vf).toContain("eq=brightness=0.01");
  expect(vf).not.toContain("noise");
  expect(vf).toContain("setpts=PTS/1.05");
  expect(vf).toContain("scale=1080:1920:force_original_aspect_ratio=increase");
  expect(vf).toContain("crop=1080:1920");
  expect(vf).toContain("setsar=1");
});

test("audio chain derives atempo from speed and applies eq", () => {
  const af = buildArgs(recipe, info)[buildArgs(recipe, info).indexOf("-af") + 1];
  expect(af).toContain("atempo=1.05");
  expect(af).toContain("equalizer=");
});

test("strips metadata and sets crf", () => {
  const args = buildArgs(recipe, info);
  expect(args).toContain("-map_metadata");
  expect(args).toContain("-1");
  expect(args[args.indexOf("-crf") + 1]).toBe("21");
});

test("no audio source omits -af and adds -an", () => {
  const args = buildArgs(recipe, { ...info, hasAudio: false });
  expect(args).not.toContain("-af");
  expect(args).toContain("-an");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/filterGraph.test.ts`
Expected: FAIL ("Cannot find module './filterGraph'").

- [ ] **Step 3: Write `src/core/filterGraph.ts`**

```ts
import { FRAGMENTS } from "./filters";
import { EXPORT_DIMS, type MediaInfo, type Recipe } from "./types";

function videoChain(recipe: Recipe, info: MediaInfo): string {
  const parts: string[] = [];
  let speed = 1;

  for (const op of recipe.video) {
    if (op.id === "speed") {
      speed = Number(op.params.speed);
      continue;
    }
    if (op.id === "encode") continue;
    const frag = FRAGMENTS[op.id]?.(op.params, info);
    if (frag) parts.push(frag);
  }

  const { w, h } = EXPORT_DIMS[recipe.exportFormat];
  parts.push(`scale=${w}:${h}:force_original_aspect_ratio=increase`);
  parts.push(`crop=${w}:${h}`);
  parts.push("setsar=1");
  if (speed !== 1) parts.push(`setpts=PTS/${speed}`);

  return parts.join(",");
}

function audioChain(recipe: Recipe): string | null {
  const speed = Number(
    recipe.video.find((o) => o.id === "speed")?.params.speed ?? 1
  );
  const parts: string[] = [];
  if (speed !== 1) parts.push(`atempo=${speed}`);
  for (const op of recipe.audio) {
    if (op.id === "aeq") {
      const g = Number(op.params.gain);
      if (g !== 0) parts.push(`equalizer=f=3000:t=q:w=1:g=${g}`);
    }
  }
  return parts.length ? parts.join(",") : null;
}

export function buildArgs(recipe: Recipe, info: MediaInfo): string[] {
  const crf = String(
    recipe.video.find((o) => o.id === "encode")?.params.crf ?? 21
  );
  const args: string[] = ["-vf", videoChain(recipe, info)];

  if (info.hasAudio) {
    const af = audioChain(recipe);
    if (af) args.push("-af", af);
    args.push("-c:a", "aac", "-b:a", "128k");
  } else {
    args.push("-an");
  }

  args.push(
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", crf,
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    "-map_metadata", "-1"
  );
  return args;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/core/filterGraph.test.ts`
Expected: 4 pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/filterGraph.ts src/core/filterGraph.test.ts
git commit -m "✨ compile recipe to single-pass ffmpeg arguments"
```

---

## Task 7: RenderExecutor interface

**Files:**
- Create: `src/core/executor.ts`

- [ ] **Step 1: Write `src/core/executor.ts`**

```ts
import type { MediaInfo, Recipe } from "./types";

/**
 * Host-provided FFmpeg backend. core depends only on this interface so the same
 * engine runs under Electron (spawn), a Node server, or ffmpeg.wasm.
 */
export interface RenderExecutor {
  probe(input: string): Promise<MediaInfo>;
  render(input: string, info: MediaInfo, recipe: Recipe, output: string): Promise<void>;
  /** Returns `count` evenly-spaced frames as 64x64 grayscale buffers (4096 bytes each). */
  extractGrayFrames(input: string, count: number): Promise<Uint8Array[]>;
}
```

- [ ] **Step 2: Type-check**

Run: `bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/core/executor.ts
git commit -m "✨ define RenderExecutor interface"
```

---

## Task 8: PDQ-style perceptual hash

**Files:**
- Create: `src/core/pdq/pdq.ts`, `src/core/pdq/pdq.test.ts`

- [ ] **Step 1: Write the failing test `src/core/pdq/pdq.test.ts`**

```ts
import { test, expect } from "bun:test";
import { computePdqHash } from "./pdq";

function gradient(): Uint8Array {
  const g = new Uint8Array(64 * 64);
  for (let y = 0; y < 64; y++)
    for (let x = 0; x < 64; x++) g[y * 64 + x] = (x * 4) & 0xff;
  return g;
}

test("hash is 32 bytes (256 bits)", () => {
  expect(computePdqHash(gradient()).length).toBe(32);
});

test("identical input yields identical hash", () => {
  expect([...computePdqHash(gradient())]).toEqual([...computePdqHash(gradient())]);
});

test("a strong change flips many bits", () => {
  const a = computePdqHash(gradient());
  const inverted = gradient().map((v) => 255 - v) as Uint8Array;
  const b = computePdqHash(inverted);
  let diff = 0;
  for (let i = 0; i < 32; i++) {
    let x = a[i] ^ b[i];
    while (x) { diff += x & 1; x >>= 1; }
  }
  expect(diff).toBeGreaterThan(20);
});

test("rejects wrong input length", () => {
  expect(() => computePdqHash(new Uint8Array(100))).toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/pdq/pdq.test.ts`
Expected: FAIL ("Cannot find module './pdq'").

- [ ] **Step 3: Write `src/core/pdq/pdq.ts`**

```ts
const N = 64;
const K = 16; // low-frequency block edge

// Precompute DCT-II basis: COS[u][x] = cos((2x+1)uπ / 2N)
const COS: number[][] = Array.from({ length: N }, (_, u) =>
  Array.from({ length: N }, (_, x) => Math.cos(((2 * x + 1) * u * Math.PI) / (2 * N)))
);

function dct2dLowFreq(pixels: Float64Array): Float64Array {
  // Rows: full 64-pt DCT, keep only first K frequencies.
  const rows = new Float64Array(N * K);
  for (let y = 0; y < N; y++) {
    for (let u = 0; u < K; u++) {
      let sum = 0;
      const cu = COS[u];
      for (let x = 0; x < N; x++) sum += pixels[y * N + x] * cu[x];
      rows[y * K + u] = sum;
    }
  }
  // Columns over the K kept frequencies.
  const out = new Float64Array(K * K);
  for (let u = 0; u < K; u++) {
    for (let v = 0; v < K; v++) {
      let sum = 0;
      const cv = COS[v];
      for (let y = 0; y < N; y++) sum += rows[y * K + u] * cv[y];
      out[v * K + u] = sum;
    }
  }
  return out;
}

function median(values: Float64Array): number {
  const sorted = Float64Array.from(values).sort();
  const mid = sorted.length >> 1;
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

export function computePdqHash(gray64: Uint8Array): Uint8Array {
  if (gray64.length !== N * N) {
    throw new Error(`expected ${N * N} grayscale bytes, got ${gray64.length}`);
  }
  const pixels = Float64Array.from(gray64);
  const coeffs = dct2dLowFreq(pixels); // 256 values
  const med = median(coeffs);

  const hash = new Uint8Array(32);
  for (let i = 0; i < 256; i++) {
    if (coeffs[i] > med) hash[i >> 3] |= 1 << (i & 7);
  }
  return hash;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/core/pdq/pdq.test.ts`
Expected: 4 pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/pdq/pdq.ts src/core/pdq/pdq.test.ts
git commit -m "✨ add pdq-style perceptual hash"
```

---

## Task 9: Hamming distance

**Files:**
- Create: `src/core/pdq/hamming.ts`, `src/core/pdq/hamming.test.ts`

- [ ] **Step 1: Write the failing test `src/core/pdq/hamming.test.ts`**

```ts
import { test, expect } from "bun:test";
import { hammingDistance } from "./hamming";

test("identical buffers have distance 0", () => {
  const a = new Uint8Array([0b10101010, 0xff]);
  expect(hammingDistance(a, a)).toBe(0);
});

test("counts differing bits", () => {
  const a = new Uint8Array([0b00000000]);
  const b = new Uint8Array([0b00001111]);
  expect(hammingDistance(a, b)).toBe(4);
});

test("throws on length mismatch", () => {
  expect(() => hammingDistance(new Uint8Array(1), new Uint8Array(2))).toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/pdq/hamming.test.ts`
Expected: FAIL ("Cannot find module './hamming'").

- [ ] **Step 3: Write `src/core/pdq/hamming.ts`**

```ts
export function hammingDistance(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) throw new Error("hamming: length mismatch");
  let dist = 0;
  for (let i = 0; i < a.length; i++) {
    let x = a[i] ^ b[i];
    while (x) {
      dist += x & 1;
      x >>= 1;
    }
  }
  return dist;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/core/pdq/hamming.test.ts`
Expected: 3 pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/pdq/hamming.ts src/core/pdq/hamming.test.ts
git commit -m "✨ add hamming distance"
```

---

## Task 10: FfmpegExecutor (real FFmpeg integration)

**Files:**
- Create: `src/node/ffmpegExecutor.ts`, `src/node/testClip.ts`, `src/node/ffmpegExecutor.test.ts`

- [ ] **Step 1: Write the test-clip helper `src/node/testClip.ts`**

```ts
import { spawnSync } from "node:child_process";
import ffmpegPath from "ffmpeg-static";

/** Creates a 2s 320x240 test clip with a 440Hz tone at `path`. */
export function makeTestClip(path: string): void {
  const r = spawnSync(
    ffmpegPath as string,
    [
      "-y",
      "-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=15",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
      path,
    ],
    { encoding: "buffer" }
  );
  if (r.status !== 0) throw new Error("makeTestClip failed: " + r.stderr.toString());
}
```

- [ ] **Step 2: Write the failing test `src/node/ffmpegExecutor.test.ts`**

```ts
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FfmpegExecutor } from "./ffmpegExecutor";
import { makeTestClip } from "./testClip";
import { sampleRecipe } from "../core/sampler";

let dir: string;
let input: string;
const exec = new FfmpegExecutor();

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "uniq-"));
  input = join(dir, "in.mp4");
  makeTestClip(input);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("probe returns duration, dims and audio flag", async () => {
  const info = await exec.probe(input);
  expect(info.durationSec).toBeGreaterThan(1.5);
  expect(info.width).toBe(320);
  expect(info.height).toBe(240);
  expect(info.hasAudio).toBe(true);
});

test("extractGrayFrames returns 64x64 buffers", async () => {
  const frames = await exec.extractGrayFrames(input, 4);
  expect(frames.length).toBe(4);
  for (const f of frames) expect(f.length).toBe(64 * 64);
});

test("render produces a valid playable mp4", async () => {
  const info = await exec.probe(input);
  const recipe = sampleRecipe(
    { preset: "medium", exportFormat: "square", keepTrendAudio: false, allowMirror: false, targetDistance: 90 },
    7,
    1
  );
  const out = join(dir, "out.mp4");
  await exec.render(input, info, recipe, out);
  const outInfo = await exec.probe(out);
  expect(outInfo.width).toBe(1080);
  expect(outInfo.height).toBe(1080);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test src/node/ffmpegExecutor.test.ts`
Expected: FAIL ("Cannot find module './ffmpegExecutor'").

- [ ] **Step 4: Write `src/node/ffmpegExecutor.ts`**

```ts
import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import { buildArgs } from "../core/filterGraph";
import type { RenderExecutor } from "../core/executor";
import type { MediaInfo, Recipe } from "../core/types";

const FFMPEG = ffmpegPath as string;
const FFPROBE = ffprobeStatic.path;

function run(bin: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(Buffer.concat(out))
        : reject(new Error(`${bin} exited ${code}: ${Buffer.concat(err).toString().slice(-500)}`))
    );
  });
}

export class FfmpegExecutor implements RenderExecutor {
  async probe(input: string): Promise<MediaInfo> {
    const raw = await run(FFPROBE, [
      "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", input,
    ]);
    const json = JSON.parse(raw.toString());
    const v = json.streams.find((s: any) => s.codec_type === "video");
    const a = json.streams.find((s: any) => s.codec_type === "audio");
    return {
      durationSec: Number(json.format.duration) || 0,
      width: Number(v?.width) || 0,
      height: Number(v?.height) || 0,
      hasAudio: Boolean(a),
    };
  }

  async render(input: string, info: MediaInfo, recipe: Recipe, output: string): Promise<void> {
    await run(FFMPEG, ["-y", "-i", input, ...buildArgs(recipe, info), output]);
  }

  async extractGrayFrames(input: string, count: number): Promise<Uint8Array[]> {
    const { durationSec } = await this.probe(input);
    const frames: Uint8Array[] = [];
    for (let i = 0; i < count; i++) {
      const t = (durationSec * (i + 0.5)) / count;
      const buf = await run(FFMPEG, [
        "-ss", t.toFixed(3), "-i", input, "-frames:v", "1",
        "-vf", "scale=64:64,format=gray", "-f", "rawvideo", "-",
      ]);
      frames.push(new Uint8Array(buf.subarray(0, 64 * 64)));
    }
    return frames;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test src/node/ffmpegExecutor.test.ts`
Expected: 3 pass (may take several seconds — real FFmpeg).

- [ ] **Step 6: Commit**

```bash
git add src/node/ffmpegExecutor.ts src/node/testClip.ts src/node/ffmpegExecutor.test.ts
git commit -m "🔌 add ffmpeg-static executor with probe, render, frame extraction"
```

---

## Task 11: Verification

**Files:**
- Create: `src/core/verification.ts`, `src/core/verification.test.ts`

- [ ] **Step 1: Write the failing test `src/core/verification.test.ts`**

```ts
import { test, expect } from "bun:test";
import { verifyCopy, interCopyDistance } from "./verification";

function hash(bits: number): Uint8Array {
  const h = new Uint8Array(32);
  for (let i = 0; i < bits; i++) h[i >> 3] |= 1 << (i & 7);
  return h;
}

test("passes when worst frame exceeds target", () => {
  const orig = [hash(0), hash(0)];
  const copy = [hash(100), hash(120)];
  const r = verifyCopy(orig, copy, 90);
  expect(r.minDistance).toBe(100);
  expect(r.passed).toBe(true);
});

test("fails when any frame is too close", () => {
  const orig = [hash(0), hash(0)];
  const copy = [hash(100), hash(40)];
  const r = verifyCopy(orig, copy, 90);
  expect(r.minDistance).toBe(40);
  expect(r.passed).toBe(false);
});

test("interCopyDistance compares first-frame signatures", () => {
  expect(interCopyDistance([hash(0)], [hash(30)])).toBe(30);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/verification.test.ts`
Expected: FAIL ("Cannot find module './verification'").

- [ ] **Step 3: Write `src/core/verification.ts`**

```ts
import { hammingDistance } from "./pdq/hamming";
import type { VerifyResult } from "./types";

export function verifyCopy(
  originalHashes: Uint8Array[],
  copyHashes: Uint8Array[],
  targetDistance: number
): VerifyResult {
  const perFrame: number[] = [];
  const n = Math.min(originalHashes.length, copyHashes.length);
  for (let i = 0; i < n; i++) {
    perFrame.push(hammingDistance(originalHashes[i], copyHashes[i]));
  }
  const minDistance = perFrame.length ? Math.min(...perFrame) : 0;
  return { minDistance, passed: minDistance >= targetDistance, perFrame };
}

/** Distance between two copies, by their first-frame signature. */
export function interCopyDistance(a: Uint8Array[], b: Uint8Array[]): number {
  return hammingDistance(a[0], b[0]);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/core/verification.test.ts`
Expected: 3 pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/verification.ts src/core/verification.test.ts
git commit -m "✨ add pdq verification and inter-copy distance"
```

---

## Task 12: Pipeline orchestrator

**Files:**
- Create: `src/core/pipeline.ts`, `src/core/pipeline.test.ts`

- [ ] **Step 1: Write the failing test `src/core/pipeline.test.ts`**

```ts
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
  async probe(): Promise<MediaInfo> {
    return info;
  }
  async render(_i: string, _info: MediaInfo, recipe: Recipe): Promise<void> {
    this.rendered.push(recipe);
    this.lastIntensity = recipe.intensity;
  }
  lastIntensity = 1;
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
  // 3 attempts, each with rising intensity
  const intensities = exec.rendered.map((r) => r.intensity);
  expect(intensities.length).toBe(3);
  expect(intensities[1]).toBeGreaterThan(intensities[0]);
  expect(res[0].verify.passed).toBe(false); // gave up, shipped best with warning
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/pipeline.test.ts`
Expected: FAIL ("Cannot find module './pipeline'").

- [ ] **Step 3: Write `src/core/pipeline.ts`**

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/core/pipeline.test.ts`
Expected: 2 pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/pipeline.ts src/core/pipeline.test.ts
git commit -m "✨ add uniquify pipeline with auto-strengthen and dedup"
```

---

## Task 13: CLI

**Files:**
- Create: `src/cli.ts`, `src/cli.test.ts`

- [ ] **Step 1: Write the failing test `src/cli.test.ts`**

```ts
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { makeTestClip } from "./node/testClip";

let dir: string;
let input: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "uniq-cli-"));
  input = join(dir, "in.mp4");
  makeTestClip(input);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("CLI produces N output files", () => {
  const outDir = join(dir, "out");
  const r = spawnSync(
    "bun",
    ["run", "src/cli.ts", input, "--count", "2", "--preset", "aggressive",
     "--out", outDir, "--format", "square", "--seed", "1"],
    { encoding: "utf8" }
  );
  expect(r.status).toBe(0);
  expect(existsSync(join(outDir, "copy_1.mp4"))).toBe(true);
  expect(existsSync(join(outDir, "copy_2.mp4"))).toBe(true);
  expect(r.stdout).toContain("copy 2/2");
}, 60000);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/cli.test.ts`
Expected: FAIL (CLI does not exist / exits non-zero).

- [ ] **Step 3: Write `src/cli.ts`**

```ts
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { FfmpegExecutor } from "./node/ffmpegExecutor";
import { uniquify } from "./core/pipeline";
import type { CopyOptions, ExportFormat, PresetName } from "./core/types";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

async function main() {
  const input = process.argv[2];
  if (!input || input.startsWith("--")) {
    console.error("usage: uniquify <input.mp4> --count N [--preset light|medium|aggressive] " +
      "[--format reels|feed|square] [--out DIR] [--target 90] [--seed 1]");
    process.exit(1);
  }

  const count = Number(arg("count", "5"));
  const outDir = arg("out", "out")!;
  const opts: CopyOptions = {
    preset: (arg("preset", "medium") as PresetName),
    exportFormat: (arg("format", "reels") as ExportFormat),
    keepTrendAudio: arg("keep-audio") !== undefined,
    allowMirror: arg("mirror") !== undefined,
    targetDistance: Number(arg("target", "90")),
  };
  const seedBase = Number(arg("seed", String(Math.floor(Date.now() % 1e6))));

  mkdirSync(outDir, { recursive: true });
  const executor = new FfmpegExecutor();

  const results = await uniquify(input, opts, executor, count, {
    seedBase,
    outputPath: (i) => join(outDir, `copy_${i + 1}.mp4`),
    onProgress: (i, attempt) =>
      process.stdout.write(`\rcopy ${i + 1}/${count} (attempt ${attempt + 1})   `),
  });

  process.stdout.write("\n");
  for (const r of results) {
    const tag = r.verify.passed ? "OK " : "WARN";
    console.log(`[${tag}] copy ${r.index + 1}: distance=${r.verify.minDistance} -> ${r.outputPath}`);
  }
  const passed = results.filter((r) => r.verify.passed).length;
  console.log(`done: ${passed}/${results.length} passed target ${opts.targetDistance}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/cli.test.ts`
Expected: 1 pass (real FFmpeg; up to ~1 min).

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts src/cli.test.ts
git commit -m "✨ add uniquify cli"
```

---

## Task 14: Full suite, manual run, README

**Files:**
- Create: `README.md`

- [ ] **Step 1: Run the entire test suite**

Run: `bun test`
Expected: all tests pass.

- [ ] **Step 2: Type-check**

Run: `bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Manual end-to-end run on a real video**

Run: `bun run src/cli.ts sample.mp4 --count 5 --preset medium --format reels --out out --target 90`
Expected: 5 files in `out/`, console shows distances and `5/5 passed` (or warnings if the source is extremely flat/short).

- [ ] **Step 4: Write `README.md`**

```markdown
# uniquemedia — Instagram Video Uniquifier (engine + CLI)

Turns one source video into N verified-unique copies using randomized 2D and
pseudo-3D FFmpeg transforms, then verifies each copy with a PDQ-style perceptual
hash so it provably crosses a Hamming-distance threshold.

## Requirements
- bun

## Install
    bun install

## Usage
    bun run src/cli.ts <input.mp4> --count 30 --preset aggressive --format reels --out out --target 90

Flags:
- `--count N` number of copies
- `--preset light|medium|aggressive`
- `--format reels|feed|square`
- `--target` minimum PDQ Hamming distance each copy must exceed (0..256)
- `--keep-audio` keep trend audio (no audio modification)
- `--mirror` allow horizontal flip
- `--seed` base seed for reproducible batches

## Test
    bun test

## Notes
This transforms your own content; mass-posting may violate Instagram ToS — risk
is on the user. "Uniqueness" is measured, not guaranteed against a black box.
```

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "📝 add readme and run instructions"
```

---

## Self-Review notes (addressed)

- **Spec coverage:** recipe engine (Tasks 4–6), PDQ verification + auto-guarantee (Tasks 8–12), presets + intensity (Tasks 3,5), export formats (Task 6), metadata strip (Task 6), audio incl. keep-trend-audio (Tasks 5,6), error/exit handling (Tasks 10,13), executor abstraction for web portability (Task 7). UI and depth-3D are intentionally Plan 2 / Plan 3.
- **Type consistency:** `RenderExecutor` methods (`probe`, `render`, `extractGrayFrames`) are used identically in Tasks 10 and 12; `Recipe`/`Operation`/`CopyOptions`/`VerifyResult` shapes match across sampler, filterGraph, verification, pipeline.
- **Threshold default:** `--target 90` (PDQ match is typically ≤31/256; 90 is a comfortable margin). Tunable per run.
```
