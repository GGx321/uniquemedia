# Segmented Speed (Temporal Fingerprint Break) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single global speed change with N per-segment speed changes over the timeline (video + audio cut on the same boundaries), breaking the temporal fingerprint while staying visually subtle.

**Architecture:** The recipe gains a `segments: SpeedSegment[]` list (drawn in `sampler.ts`). `filterGraph.ts` moves from `-vf` to `-filter_complex`: the spatial chain runs once, is `split`/`asplit` into N time windows, each window gets its own `setpts`/`atempo`, then `concat` rejoins them and the result is mapped via `-map [outv]`/`-map [outa]`. Point 1's encoder args (CFR/GOP/preset/crf/cap/spoof) are untouched.

**Tech Stack:** Bun, TypeScript, `bun test`, ffmpeg 6.0 (ffmpeg-static), ffprobe-static.

**Design spec:** `docs/superpowers/specs/2026-07-12-segmented-speed-design.md`

## Global Constraints

- **Determinism invariant:** same `seed` + same `opts` ⇒ same recipe.
- **Point 1 encoder behavior unchanged:** CFR (`-r/-fps_mode cfr/-g/-keyint_min`), preset, crf, 50 MB `-maxrate`/`-bufsize` cap, spoof `-f mov` (must stay the LAST flag).
- **Audio always segmented** on the same boundaries as video (A/V sync). `keepTrendAudio` gates only the EQ op, never segmentation.
- **Per-segment speed** via existing `PARAMS.speed` (clamp 0.9–1.1); segment count via `SEGMENT_COUNTS = [3,4,5]`. Both are tunable constants for the deferred aggressive/micro-cut follow-up.
- **Per-segment speeds stay within atempo's 0.5–2.0 range** — no atempo chaining needed.
- English code/comments/commits; gitmoji, atomic, subject < 72 chars, no `Co-Authored-By`. `bun test` green before each commit.

---

## File Structure

- `src/core/types.ts` — **Modify.** Add `SpeedSegment` interface; add `segments: SpeedSegment[]` to `Recipe`.
- `src/core/sampler.ts` — **Modify.** Add `SEGMENT_COUNTS`; replace the single `speed` draw + `{ id: "speed" }` op with segment generation; return `segments` on the recipe.
- `src/core/sampler.test.ts` — **Modify.** Assert `segments` shape/ranges/determinism; assert no leftover `speed` op.
- `src/core/filterGraph.ts` — **Modify (rewrite).** Replace `videoChain`/`audioChain` with `spatialChain` + `boundaries` + `videoComplex` + `audioComplex`; rewrite `buildArgs` filter/map/audio section.
- `src/core/filterGraph.test.ts` — **Modify (rewrite).** Update shared recipe (segments, no speed op); rewrite `-vf`/`-af` tests to `-filter_complex`; keep encoder/spoof/cap tests.
- `src/node/ffmpegExecutor.segments.test.ts` — **Create.** Real-clip: render a fixed 2-segment recipe on `testClip`, ffprobe CFR + A/V duration parity + full (non-truncated) duration.

---

### Task 1: Segments in the recipe (types + sampler)

**Files:**
- Modify: `src/core/types.ts`
- Modify: `src/core/sampler.ts`
- Test: `src/core/sampler.test.ts`

**Interfaces:**
- Produces: `Recipe.segments: SpeedSegment[]` where `SpeedSegment = { fraction: number; speed: number }`, length ∈ {3,4,5}, `fraction`s sum to ~1, each `speed ∈ [0.9,1.1]`. The `video` array no longer contains a `{ id: "speed" }` op. Task 2 consumes `recipe.segments`.

- [ ] **Step 1: Add the types**

In `src/core/types.ts`, add the `SpeedSegment` interface directly above `export interface Recipe` and add the field to `Recipe`:

```ts
export interface SpeedSegment {
  fraction: number; // portion of source duration; fractions sum to ~1
  speed: number;    // playback speed for this segment (ffmpeg-safe 0.5..2.0)
}

export interface Recipe {
  seed: number;
  intensity: number; // 1.0 baseline; raised on auto-strengthen
  exportFormat: ExportFormat;
  keepTrendAudio: boolean;
  spoof: boolean;
  segments: SpeedSegment[];
  video: Operation[];
  audio: Operation[];
}
```

- [ ] **Step 2: Write the failing sampler tests**

Append to `src/core/sampler.test.ts`:

```ts
test("recipe has 3-5 speed segments with fractions summing to ~1", () => {
  const r = sampleRecipe(opts, 11, 1);
  expect(r.segments.length).toBeGreaterThanOrEqual(3);
  expect(r.segments.length).toBeLessThanOrEqual(5);
  const sum = r.segments.reduce((a, seg) => a + seg.fraction, 0);
  expect(Math.abs(sum - 1)).toBeLessThan(1e-6);
  for (const seg of r.segments) {
    expect(seg.fraction).toBeGreaterThan(0);
    expect(seg.speed).toBeGreaterThanOrEqual(0.9);
    expect(seg.speed).toBeLessThanOrEqual(1.1);
  }
});

test("no leftover single speed op in the video chain", () => {
  const r = sampleRecipe(opts, 5, 1);
  expect(r.video.some((o) => o.id === "speed")).toBe(false);
});

test("segments vary across seeds", () => {
  const a = sampleRecipe(opts, 1, 1).segments;
  const b = sampleRecipe(opts, 2, 1).segments;
  expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test src/core/sampler.test.ts`
Expected: FAIL — `r.segments` is `undefined` (`.length` throws / reduce on undefined).

- [ ] **Step 4: Implement segment generation**

In `src/core/sampler.ts`, add the constant alongside the others (after `AUDIO_KBPS_CHOICES`):

```ts
const SEGMENT_COUNTS = [3, 4, 5] as const;
```

Replace the single speed draw:

```ts
  const speed = round(clamp(dev(rng, "speed", s), 0.9, 1.1));
  const crf = Math.round(clamp(dev(rng, "crf", s), 18, 26));
```

with segment generation (keep the `crf` line):

```ts
  // Per-segment speed changes break the temporal fingerprint. Non-uniform
  // fractions so segment boundaries aren't a fixed pattern and no segment is
  // vanishingly small; each keeps the subtle PARAMS.speed spread (~±5%).
  const segCount = pick(rng, SEGMENT_COUNTS);
  const weights = Array.from({ length: segCount }, () => 0.5 + rng());
  const weightSum = weights.reduce((a, b) => a + b, 0);
  const segments = weights.map((w) => ({
    fraction: w / weightSum,
    speed: round(clamp(dev(rng, "speed", s), 0.9, 1.1)),
  }));
  const crf = Math.round(clamp(dev(rng, "crf", s), 18, 26));
```

Then change the returned object: remove the `{ id: "speed", params: { speed } }` op and add `segments`:

```ts
  return {
    seed,
    intensity,
    exportFormat: opts.exportFormat,
    keepTrendAudio: opts.keepTrendAudio,
    spoof: opts.spoofMetadata,
    segments,
    video: [...video, { id: "encode", params: { crf, fps, gop, keyintMin, preset, audioKbps } }],
    audio,
  };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test src/core/sampler.test.ts`
Expected: PASS (all sampler tests, including the pre-existing determinism/encoder tests).

- [ ] **Step 6: Commit**

```bash
git add src/core/types.ts src/core/sampler.ts src/core/sampler.test.ts
git commit -m "✨ sample per-segment speeds into the recipe"
```

---

### Task 2: filter_complex refactor (segmented render)

**Files:**
- Modify: `src/core/filterGraph.ts`
- Modify: `src/core/filterGraph.test.ts`

**Interfaces:**
- Consumes: `recipe.segments` (Task 1); `recipe.video` (spatial ops + `encode`); `recipe.audio` (optional `aeq`).
- Produces: `buildArgs(recipe, info)` returns `-filter_complex <graph> -map [outv]` (+ `-map [outa]` and audio codec args when `info.hasAudio`, else `-an`), followed by the unchanged Point-1 encoder args. The graph splits the spatial chain into N segments, applies `setpts`/`atempo` per segment, and `concat`s them.

- [ ] **Step 1: Rewrite the shared test recipe and the filter tests**

Replace the entire contents of `src/core/filterGraph.test.ts` with:

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
  spoof: false,
  segments: [
    { fraction: 0.5, speed: 1.03 },
    { fraction: 0.5, speed: 0.97 },
  ],
  video: [
    { id: "eq", params: { brightness: 0.01, contrast: 1.02, saturation: 0.99, gamma: 1 } },
    { id: "noise", params: { strength: 0 } }, // no-op, must be skipped
    { id: "encode", params: { crf: 21, fps: 30, gop: 60, keyintMin: 30, preset: "faster", audioKbps: 128 } },
  ],
  audio: [{ id: "aeq", params: { gain: 1.5 } }],
};

const complexOf = (args: string[]) => args[args.indexOf("-filter_complex") + 1];

test("uses filter_complex (not -vf): spatial chain before split, N trims, concat", () => {
  const args = buildArgs(recipe, info);
  expect(args).not.toContain("-vf");
  const fc = complexOf(args);
  expect(fc.indexOf("eq=brightness=0.01")).toBeGreaterThanOrEqual(0);
  expect(fc.indexOf("eq=brightness=0.01")).toBeLessThan(fc.indexOf("split=2"));
  expect(fc).not.toContain("noise"); // no-op skipped
  expect(fc).toContain("scale=1080:1920:force_original_aspect_ratio=increase");
  expect(fc).toContain("crop=1080:1920");
  expect(fc).toContain("setsar=1");
  expect(fc).toContain("split=2");
  expect((fc.match(/trim=start=/g) || []).length).toBe(2);
  expect(fc).toContain("setpts=(PTS-STARTPTS)/1.03");
  expect(fc).toContain("setpts=(PTS-STARTPTS)/0.97");
  expect(fc).toContain("concat=n=2:v=1:a=0[outv]");
});

test("maps [outv] and [outa]; audio segmented with per-segment atempo + eq", () => {
  const args = buildArgs(recipe, info);
  expect(args[args.indexOf("-map") + 1]).toBe("[outv]");
  expect(args).toContain("[outa]");
  const fc = complexOf(args);
  expect(fc).toContain("asplit=2");
  expect(fc).toContain("atempo=1.03");
  expect(fc).toContain("atempo=0.97");
  expect(fc).toContain("equalizer=f=3000");
  expect(fc).toContain("concat=n=2:v=0:a=1[outa]");
});

test("segment boundaries scale with duration", () => {
  const fc = complexOf(buildArgs(recipe, { ...info, durationSec: 10 }));
  // first segment is 50% of 10s -> 0.000..5.000
  expect(fc).toContain("trim=start=0.000:end=5.000");
});

test("no audio source omits the audio branch and adds -an", () => {
  const args = buildArgs(recipe, { ...info, hasAudio: false });
  expect(args).toContain("-an");
  expect(args).not.toContain("[outa]");
  expect(complexOf(args)).not.toContain("asplit");
  expect(args.filter((a) => a === "-map").length).toBe(1);
});

const originalRecipe: Recipe = { ...recipe, exportFormat: "original" };

test("original format: skips fixed scale/crop, keeps setsar + effect filters", () => {
  const fc = complexOf(buildArgs(originalRecipe, info));
  expect(fc).not.toContain("scale=1080");
  expect(fc).not.toContain("crop=1080");
  expect(fc).toContain("setsar=1");
  expect(fc).toContain("eq=brightness=0.01");
  expect(fc).toContain("crop=trunc(iw/2)*2:trunc(ih/2)*2");
});

test("strips metadata and sets crf", () => {
  const args = buildArgs(recipe, info);
  expect(args).toContain("-map_metadata");
  expect(args).toContain("-1");
  expect(args[args.indexOf("-crf") + 1]).toBe("21");
});

test("emits CFR normalization: -r, -fps_mode cfr, -g, -keyint_min", () => {
  const args = buildArgs(recipe, info);
  expect(args[args.indexOf("-r") + 1]).toBe("30");
  expect(args[args.indexOf("-fps_mode") + 1]).toBe("cfr");
  expect(args[args.indexOf("-g") + 1]).toBe("60");
  expect(args[args.indexOf("-keyint_min") + 1]).toBe("30");
});

test("uses the recipe preset and never ultrafast", () => {
  const args = buildArgs(recipe, info);
  expect(args[args.indexOf("-preset") + 1]).toBe("faster");
  expect(args).not.toContain("ultrafast");
});

test("uses the per-copy audio bitrate for -b:a", () => {
  const hi = {
    ...recipe,
    video: recipe.video.map((o) =>
      o.id === "encode" ? { ...o, params: { ...o.params, audioKbps: 160 } } : o
    ),
  };
  expect(buildArgs(hi, info)[buildArgs(hi, info).indexOf("-b:a") + 1]).toBe("160k");
});

const spoofRecipe: Recipe = { ...recipe, spoof: true };

test("spoof: -f mov is the last flag, plus profile/bt709/handlers", () => {
  const args = buildArgs(spoofRecipe, info);
  const lastFIdx = args.lastIndexOf("-f");
  expect(args[lastFIdx + 1]).toBe("mov");
  expect(args.length).toBe(lastFIdx + 2); // nothing after "mov"
  expect(args[args.indexOf("-profile:v") + 1]).toBe("high");
  expect(args).toContain("bt709");
  expect(args[args.indexOf("-metadata:s:v") + 1]).toContain("Core Media Video");
  expect(args[args.indexOf("-metadata:s:a") + 1]).toContain("Core Media Audio");
});

test("no-spoof: no -f mov, no -profile:v, no handlers", () => {
  const args = buildArgs(recipe, info);
  expect(args.includes("-f")).toBe(false);
  expect(args.includes("-profile:v")).toBe(false);
  expect(args.includes("-metadata:s:v")).toBe(false);
});

test("spoof without audio: no audio handler, -f mov still present", () => {
  const args = buildArgs(spoofRecipe, { ...info, hasAudio: false });
  expect(args[args.lastIndexOf("-f") + 1]).toBe("mov");
  expect(args).not.toContain("-metadata:s:a");
});

test("caps the bitrate so a long video stays under the 50MB ceiling", () => {
  const args = buildArgs(recipe, { ...info, durationSec: 120 });
  const i = args.indexOf("-maxrate");
  expect(i).toBeGreaterThan(-1);
  expect(args).toContain("-bufsize");
  const kbps = parseInt(args[i + 1], 10);
  expect((kbps * 120) / 8 / 1024).toBeLessThanOrEqual(50);
});

test("short clips get a high cap that doesn't fight CRF", () => {
  const kbps = parseInt(buildArgs(recipe, { ...info, durationSec: 5 })[buildArgs(recipe, { ...info, durationSec: 5 }).indexOf("-maxrate") + 1], 10);
  expect(kbps).toBeGreaterThan(10000);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/core/filterGraph.test.ts`
Expected: FAIL — `buildArgs` still emits `-vf`; `complexOf` returns `undefined` so `-filter_complex` assertions fail.

- [ ] **Step 3: Rewrite filterGraph.ts**

Replace the entire contents of `src/core/filterGraph.ts` with:

```ts
import { FRAGMENTS } from "./filters";
import { EXPORT_DIMS, type MediaInfo, type Recipe } from "./types";

/** Spatial filter chain (everything except per-segment speed). Applied once to
 *  the source before it is split into time segments. */
function spatialChain(recipe: Recipe, info: MediaInfo): string {
  const parts: string[] = [];
  for (const op of recipe.video) {
    if (op.id === "encode") continue;
    const frag = FRAGMENTS[op.id]?.(op.params, info);
    if (frag) parts.push(frag);
  }
  if (recipe.exportFormat !== "original") {
    const { w, h } = EXPORT_DIMS[recipe.exportFormat];
    parts.push(`scale=${w}:${h}:force_original_aspect_ratio=increase`);
    parts.push(`crop=${w}:${h}`);
  } else {
    parts.push("crop=trunc(iw/2)*2:trunc(ih/2)*2");
  }
  parts.push("setsar=1");
  return parts.join(",");
}

/** Cumulative segment boundaries in seconds: [0, t1, ..., duration]. */
function boundaries(recipe: Recipe, info: MediaInfo): number[] {
  const bounds = [0];
  let acc = 0;
  for (const seg of recipe.segments) {
    acc += seg.fraction;
    bounds.push(acc * info.durationSec);
  }
  bounds[bounds.length - 1] = info.durationSec; // guard float drift on the tail
  return bounds;
}

const splitLabels = (prefix: string, n: number): string =>
  Array.from({ length: n }, (_, i) => `[${prefix}${i}]`).join("");

/** Video graph: spatial -> split -> per-segment trim+setpts -> concat -> [outv]. */
function videoComplex(recipe: Recipe, info: MediaInfo): string {
  const n = recipe.segments.length;
  const b = boundaries(recipe, info);
  const spatial = spatialChain(recipe, info);
  const lines = [`[0:v]${spatial ? spatial + "," : ""}split=${n}${splitLabels("v", n)}`];
  recipe.segments.forEach((seg, i) => {
    lines.push(
      `[v${i}]trim=start=${b[i].toFixed(3)}:end=${b[i + 1].toFixed(3)},` +
        `setpts=(PTS-STARTPTS)/${seg.speed}[s${i}]`
    );
  });
  lines.push(`${splitLabels("s", n)}concat=n=${n}:v=1:a=0[outv]`);
  return lines.join(";");
}

/** Audio graph: optional EQ -> asplit -> per-segment atrim+atempo -> concat -> [outa].
 *  Same boundaries as video so A/V stays in sync. */
function audioComplex(recipe: Recipe, info: MediaInfo): string {
  const n = recipe.segments.length;
  const b = boundaries(recipe, info);
  const eq = recipe.audio.find((o) => o.id === "aeq");
  const gain = eq ? Number(eq.params.gain) : 0;
  const pre = gain !== 0 ? `equalizer=f=3000:t=q:w=1:g=${gain},` : "";
  const lines = [`[0:a]${pre}asplit=${n}${splitLabels("a", n)}`];
  recipe.segments.forEach((seg, i) => {
    lines.push(
      `[a${i}]atrim=start=${b[i].toFixed(3)}:end=${b[i + 1].toFixed(3)},` +
        `asetpts=PTS-STARTPTS,atempo=${seg.speed}[b${i}]`
    );
  });
  lines.push(`${splitLabels("b", n)}concat=n=${n}:v=0:a=1[outa]`);
  return lines.join(";");
}

/** Instagram rejects video files over 50 MB — cap the bitrate so the encode can't exceed it. */
const MAX_FILE_MB = 50;

export function buildArgs(recipe: Recipe, info: MediaInfo): string[] {
  const enc = recipe.video.find((o) => o.id === "encode")?.params ?? {};
  const crf = String(enc.crf ?? 21);
  const preset = String(enc.preset ?? "faster");
  const fps = Number(enc.fps ?? 30);
  const gop = Number(enc.gop ?? 60);
  const keyintMin = Number(enc.keyintMin ?? 30);
  const aBitrate = Number(enc.audioKbps ?? 128);

  // Bitrate ceiling derived from duration: total bits for ~46 MB (8% safety
  // margin) minus the audio track, capped per second. CRF still rules for short
  // clips (the cap only kicks in when content would blow past 50 MB).
  const audioKbps = info.hasAudio ? aBitrate : 0;
  const capKbps = Math.max(
    600,
    Math.floor((MAX_FILE_MB * 1024 * 8 * 0.92) / Math.max(1, info.durationSec)) - audioKbps
  );

  const complex = info.hasAudio
    ? `${videoComplex(recipe, info)};${audioComplex(recipe, info)}`
    : videoComplex(recipe, info);
  const args: string[] = ["-filter_complex", complex, "-map", "[outv]"];

  if (info.hasAudio) {
    args.push("-map", "[outa]", "-c:a", "aac", "-b:a", `${aBitrate}k`);
  } else {
    args.push("-an");
  }

  args.push("-c:v", "libx264", "-preset", preset);

  if (recipe.spoof) {
    args.push(
      "-profile:v", "high",
      "-colorspace", "bt709",
      "-color_primaries", "bt709",
      "-color_trc", "bt709",
    );
  }

  args.push(
    "-crf", crf,
    "-maxrate", `${capKbps}k`,
    "-bufsize", `${capKbps * 2}k`,
    "-pix_fmt", "yuv420p",
    "-r", String(fps),
    "-fps_mode", "cfr",
    "-g", String(gop),
    "-keyint_min", String(keyintMin),
    "-movflags", "+faststart",
    "-map_metadata", "-1"
  );

  if (recipe.spoof) {
    args.push("-metadata:s:v", "handler_name=Core Media Video");
    if (info.hasAudio) {
      args.push("-metadata:s:a", "handler_name=Core Media Audio");
    }
    args.push("-f", "mov");
  }

  return args;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/core/filterGraph.test.ts`
Expected: PASS (all 14 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/filterGraph.ts src/core/filterGraph.test.ts
git commit -m "✨ render segmented speed via filter_complex split/concat"
```

---

### Task 3: Real-clip segmented render (CFR + A/V sync)

**Files:**
- Create: `src/node/ffmpegExecutor.segments.test.ts`

**Interfaces:**
- Consumes: `makeTestClip` (2s 320×240 + tone), `buildArgs`, `ffmpeg-static`, `ffprobe-static`.
- Produces: proof that a 2-segment recipe renders a valid, full-duration, CFR, A/V-synced file (multi-segment `trim`/`atempo`/`concat` works end-to-end).

- [ ] **Step 1: Write the failing test**

Create `src/node/ffmpegExecutor.segments.test.ts`:

```ts
import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import { makeTestClip } from "./testClip";
import { buildArgs } from "../core/filterGraph";
import type { MediaInfo, Recipe } from "../core/types";

const FFMPEG = ffmpegPath as string;
const FFPROBE = ffprobeStatic.path;

// makeTestClip is a fixed 2s 320x240 clip with audio.
const info: MediaInfo = { durationSec: 2, width: 320, height: 240, hasAudio: true };

const recipe: Recipe = {
  seed: 1,
  intensity: 1,
  exportFormat: "original",
  keepTrendAudio: false,
  spoof: false,
  segments: [
    { fraction: 0.5, speed: 1.03 },
    { fraction: 0.5, speed: 0.97 },
  ],
  video: [
    { id: "eq", params: { brightness: 0.01, contrast: 1.0, saturation: 1.0, gamma: 1 } },
    { id: "encode", params: { crf: 23, fps: 30, gop: 60, keyintMin: 30, preset: "faster", audioKbps: 128 } },
  ],
  audio: [{ id: "aeq", params: { gain: 1.0 } }],
};

function probeField(file: string, entry: string, stream: "v" | "a"): string {
  const r = spawnSync(
    FFPROBE,
    ["-v", "error", "-select_streams", stream, "-show_entries", entry,
     "-of", "default=nw=1:nk=1", file],
    { encoding: "utf8" }
  );
  return r.stdout.trim();
}

const evalRate = (rate: string) => {
  const [num, den] = rate.split("/").map(Number);
  return den ? num / den : num;
};

test("segmented recipe renders a full-duration, CFR, in-sync clip", () => {
  const dir = mkdtempSync(join(tmpdir(), "uniq-seg-"));
  try {
    const input = join(dir, "in.mp4");
    const output = join(dir, "out.mp4");
    makeTestClip(input);

    const r = spawnSync(FFMPEG, ["-y", "-i", input, ...buildArgs(recipe, info), output],
      { encoding: "buffer" });
    expect(r.status).toBe(0);

    // CFR at the recipe fps.
    expect(evalRate(probeField(output, "stream=r_frame_rate", "v"))).toBe(30);
    // Audio survived.
    expect(probeField(output, "stream=codec_name", "a")).toContain("aac");
    // Full duration (concat didn't truncate): ~2s within a generous window.
    const vd = Number(probeField(output, "stream=duration", "v"));
    expect(vd).toBeGreaterThan(1.7);
    expect(vd).toBeLessThan(2.3);
    // A/V stays in sync across the segment joins.
    const ad = Number(probeField(output, "stream=duration", "a"));
    expect(Math.abs(vd - ad)).toBeLessThan(0.2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `bun test src/node/ffmpegExecutor.segments.test.ts`
Expected: PASS. (If `r.status !== 0`, print `r.stderr.toString()` — most likely a filter_complex label typo.)

- [ ] **Step 3: Run the full suite**

Run: `bun test`
Expected: PASS (whole suite, including the pre-existing `ffmpegExecutor.cfr.test.ts`, which now also exercises segmentation via a sampled recipe).

- [ ] **Step 4: Commit**

```bash
git add src/node/ffmpegExecutor.segments.test.ts
git commit -m "✅ verify segmented render is full-length, CFR and A/V synced"
```

---

## Self-Review

**1. Spec coverage:**
- `Recipe.segments` + `SpeedSegment` ✓ Task 1.
- Non-uniform fractions, 3–5 segments, per-segment `PARAMS.speed` ✓ Task 1.
- `-vf` → `-filter_complex` (spatial → split → per-segment setpts → concat) ✓ Task 2.
- Audio segmented on same boundaries (asplit/atrim/atempo/concat), EQ once before asplit ✓ Task 2.
- `keepTrendAudio` gates only EQ (the `aeq` op presence), never segmentation ✓ Task 2 (`audioComplex` always runs when `hasAudio`).
- Point-1 encoder args unchanged, spoof `-f mov` last ✓ Task 2 (assertions retained).
- Real-clip CFR + A/V-sync + full-duration ✓ Task 3.

**2. Placeholder scan:** No TBD/vague steps; every code step shows full code.

**3. Type consistency:** `SpeedSegment = { fraction, speed }` produced in Task 1, consumed in Task 2 (`recipe.segments`, `seg.fraction`, `seg.speed`) and Task 3 (literal recipe). `boundaries`/`videoComplex`/`audioComplex`/`splitLabels` signatures are internal to `filterGraph.ts` and self-consistent. `buildArgs` signature unchanged.

**Deferred (not in scope):** micro-cuts, aggressive spread (0.85–1.15, shorter segments) — a follow-up once real output is eyeballed.
```
