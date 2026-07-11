# Encoder Normalization & Randomization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the `ultrafast` x264 signature and constant fps/GOP/audio-bitrate fingerprint by making the encoder emit constant-frame-rate output with per-copy randomized preset, fps, GOP and audio bitrate.

**Architecture:** The `encode` operation already lives in the recipe and carries `crf`. We extend it with `fps`, `gop`, `keyintMin`, `preset`, `audioKbps` — drawn in `sampler.ts` from small discrete choice sets (independent of strength/intensity), and consumed in `filterGraph.ts/buildArgs` which emits `-r`, `-fps_mode cfr`, `-g`, `-keyint_min`, a per-copy `-preset`, and a per-copy `-b:a`. A real-clip test proves CFR is actually applied and A/V stays in sync.

**Tech Stack:** Bun, TypeScript, `bun test`, ffmpeg 6.0 (ffmpeg-static), ffprobe-static.

## Global Constraints

- **Determinism invariant:** same `seed` + same `opts` ⇒ same recipe. New draws use the same `rng` stream; do not break existing draws' order for params before `crf`.
- **50 MB Instagram ceiling:** the `-maxrate`/`-bufsize` cap must stay correct — it must subtract the *actual* per-copy audio bitrate, not a hardcoded 128.
- **Preset choices are limited to `faster` and `veryfast`** — never `ultrafast` (signature) and never `slow`/`slower` (kills batch throughput).
- **CFR flag is `-fps_mode cfr`** (ffmpeg 6.0; `-vsync cfr` is deprecated). Verified working on the bundled build.
- **Encoder params are NOT strength-scaled** — they are a container/bitstream signature spread, decoupled from the visual "invisible to the eye" budget.
- Git-tracked code/comments/commit messages in **English**; gitmoji commits, atomic, imperative, subject < 72 chars, no `Co-Authored-By`.
- Run `bun test` before each commit.

---

## File Structure

- `src/core/sampler.ts` — **Modify.** Add discrete choice sets + `pick` helper; draw `fps/gop/keyintMin/preset/audioKbps`; put them in the `encode` op params.
- `src/core/sampler.test.ts` — **Modify.** Assert the new encode params: ranges, seed-variation, intensity-independence.
- `src/core/filterGraph.ts` — **Modify.** `buildArgs` reads the new params (with safe defaults) and emits CFR/GOP/preset/audio-bitrate flags; cap uses the per-copy audio bitrate.
- `src/core/filterGraph.test.ts` — **Modify.** Update the shared test recipe's `encode` params; add assertions for the new flags.
- `src/node/ffmpegExecutor.cfr.test.ts` — **Create.** Real-clip integration test: render a sampled recipe, ffprobe the output for CFR at the chosen fps + intact audio + A/V duration parity.
- `README.md` — **Modify.** Update section 7 ("Кодек, размер, формат файла") to describe the new encoder behavior.

No changes to `presets.ts` (the new params are discrete picks, not continuous `dev`-based deviations, so they don't belong in `PARAMS`).

---

### Task 1: Randomized encoder params in the recipe

**Files:**
- Modify: `src/core/sampler.ts`
- Test: `src/core/sampler.test.ts`

**Interfaces:**
- Consumes: `sampleRecipe(opts: CopyOptions, seed: number, intensity?: number): Recipe`, `makeRng`, `type Rng` (existing).
- Produces: the `encode` operation now has `params: { crf, fps, gop, keyintMin, preset, audioKbps }` where `fps ∈ {24,25,30}`, `gop = fps × {2,3,4}`, `keyintMin = fps`, `preset ∈ {"faster","veryfast"}`, `audioKbps ∈ {96,112,128,160}`. Task 2 reads these exact keys.

- [ ] **Step 1: Write the failing tests**

Append to `src/core/sampler.test.ts`:

```ts
test("encode op carries randomized fps/gop/preset/audio params in range", () => {
  const enc = sampleRecipe(opts, 7, 1).video.find((o) => o.id === "encode")!.params;
  expect([24, 25, 30]).toContain(enc.fps);
  expect(["faster", "veryfast"]).toContain(enc.preset);
  expect([96, 112, 128, 160]).toContain(enc.audioKbps);
  expect(enc.keyintMin).toBe(enc.fps);
  const mult = Number(enc.gop) / Number(enc.fps);
  expect([2, 3, 4]).toContain(mult);
});

test("encoder params vary across seeds", () => {
  const fpsSet = new Set<number>();
  const presetSet = new Set<string>();
  for (let s = 0; s < 60; s++) {
    const enc = sampleRecipe(opts, s, 1).video.find((o) => o.id === "encode")!.params;
    fpsSet.add(Number(enc.fps));
    presetSet.add(String(enc.preset));
  }
  expect(fpsSet.size).toBeGreaterThan(1);
  expect(presetSet.size).toBeGreaterThan(1);
});

test("encoder params are not strength-scaled (same for intensity 1 and 2)", () => {
  const a = sampleRecipe(opts, 3, 1).video.find((o) => o.id === "encode")!.params;
  const b = sampleRecipe(opts, 3, 2).video.find((o) => o.id === "encode")!.params;
  expect(a.fps).toBe(b.fps);
  expect(a.preset).toBe(b.preset);
  expect(a.audioKbps).toBe(b.audioKbps);
  expect(a.gop).toBe(b.gop);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/core/sampler.test.ts`
Expected: FAIL — `enc.fps` is `undefined`, so `[24,25,30]` does not contain it.

- [ ] **Step 3: Implement the draws**

In `src/core/sampler.ts`, add the choice sets and helper near the top (after the imports, before `dev`):

```ts
const FPS_CHOICES = [24, 25, 30] as const;
const GOP_SECONDS = [2, 3, 4] as const;
const PRESET_CHOICES = ["faster", "veryfast"] as const;
const AUDIO_KBPS_CHOICES = [96, 112, 128, 160] as const;

function pick<T>(rng: Rng, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}
```

Then, in `sampleRecipe`, right after the `crf` line and before the `audio` block, add:

```ts
  // Container/bitstream signature spread. Drawn here (before the conditional
  // audio draw) so they stay independent of `keepTrendAudio`, and they ignore
  // `s` so the encoder fingerprint is decoupled from the visual-change budget.
  const fps = pick(rng, FPS_CHOICES);
  const gop = fps * pick(rng, GOP_SECONDS);
  const keyintMin = fps;
  const preset = pick(rng, PRESET_CHOICES);
  const audioKbps = pick(rng, AUDIO_KBPS_CHOICES);
```

And change the `encode` op in the returned `video` array from:

```ts
    video: [...video, { id: "speed", params: { speed } }, { id: "encode", params: { crf } }],
```

to:

```ts
    video: [
      ...video,
      { id: "speed", params: { speed } },
      { id: "encode", params: { crf, fps, gop, keyintMin, preset, audioKbps } },
    ],
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/core/sampler.test.ts`
Expected: PASS (all sampler tests, including the pre-existing determinism/crf tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/sampler.ts src/core/sampler.test.ts
git commit -m "✨ randomize encoder fps/gop/preset/audio bitrate per copy"
```

---

### Task 2: Emit CFR/GOP/preset/audio-bitrate in buildArgs

**Files:**
- Modify: `src/core/filterGraph.ts`
- Modify: `src/core/filterGraph.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: the `encode` op params from Task 1 (`crf, fps, gop, keyintMin, preset, audioKbps`). Reads them with safe defaults so a recipe missing them still yields valid args.
- Produces: `buildArgs(recipe, info)` output now contains `-r <fps>`, `-fps_mode cfr`, `-g <gop>`, `-keyint_min <keyintMin>`, `-preset <preset>` (never `ultrafast`), and `-b:a <audioKbps>k`; the 50 MB cap subtracts `audioKbps`. `-f mov` (spoof) stays the last flag.

- [ ] **Step 1: Update the shared test recipe and write failing assertions**

In `src/core/filterGraph.test.ts`, change the `encode` op in the shared `recipe` from:

```ts
    { id: "encode", params: { crf: 21 } },
```

to:

```ts
    { id: "encode", params: { crf: 21, fps: 30, gop: 60, keyintMin: 30, preset: "faster", audioKbps: 128 } },
```

Then append:

```ts
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
  const args = buildArgs(hi, info);
  expect(args[args.indexOf("-b:a") + 1]).toBe("160k");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/core/filterGraph.test.ts`
Expected: FAIL — `-fps_mode` not found (`indexOf` returns -1), `-preset` is still `ultrafast`, `-b:a` is `128k`.

- [ ] **Step 3: Rewrite `buildArgs`**

Replace the whole `buildArgs` function in `src/core/filterGraph.ts` with:

```ts
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
  const args: string[] = ["-vf", videoChain(recipe, info)];

  if (info.hasAudio) {
    const af = audioChain(recipe);
    if (af) args.push("-af", af);
    args.push("-c:a", "aac", "-b:a", `${aBitrate}k`);
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
Expected: PASS — including the pre-existing spoof "`-f mov` is the last flag" test (new flags are added before the spoof `-f mov` block) and both cap tests (audioKbps default 128 keeps the math unchanged for the shared recipe).

- [ ] **Step 5: Update the README encoder section**

In `README.md`, section **"### 7. Кодек, размер, формат файла"**, replace the two lines:

```markdown
- **Видеокодек** — H.264 (libx264), preset `ultrafast`, **CRF случайный 18–26** →
  у каждой копии разный битрейт/качество/битовый профиль
```

with:

```markdown
- **Видеокодек** — H.264 (libx264), preset случайный (`faster`/`veryfast`),
  **CRF случайный 18–26** → у каждой копии разный битрейт/качество/битовый профиль
- **Частота кадров** — принудительный CFR, fps случайный 24/25/30, GOP 2–4 сек
  (`-fps_mode cfr -r -g -keyint_min`) — ломает GOP-структуру исходника
- **Аудио-битрейт** — случайный 96/112/128/160 кбит/с (не константа)
```

- [ ] **Step 6: Run the full suite and commit**

Run: `bun test`
Expected: PASS (whole suite).

```bash
git add src/core/filterGraph.ts src/core/filterGraph.test.ts README.md
git commit -m "✨ normalize encoder to CFR with per-copy preset and audio bitrate"
```

---

### Task 3: Real-clip CFR + A/V-sync integration test

**Files:**
- Create: `src/node/ffmpegExecutor.cfr.test.ts`

**Interfaces:**
- Consumes: `makeTestClip(path)` (existing, 2s 320×240 15fps + 440 Hz tone), `sampleRecipe`, `buildArgs`, `ffmpeg-static`, `ffprobe-static`.
- Produces: proof that a rendered copy is CFR at the recipe's chosen fps, keeps its AAC audio, and video/audio durations stay within 200 ms (A/V sync sanity for the `-r` + `atempo` + `setpts` interaction).

- [ ] **Step 1: Write the failing test**

Create `src/node/ffmpegExecutor.cfr.test.ts`:

```ts
import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import { makeTestClip } from "./testClip";
import { sampleRecipe } from "../core/sampler";
import { buildArgs } from "../core/filterGraph";
import type { CopyOptions, MediaInfo } from "../core/types";

const FFMPEG = ffmpegPath as string;
const FFPROBE = ffprobeStatic.path;

// makeTestClip is a fixed 2s 320x240 clip with audio.
const info: MediaInfo = { durationSec: 2, width: 320, height: 240, hasAudio: true };

function probeField(file: string, entry: string, stream: "v" | "a"): string {
  const r = spawnSync(
    FFPROBE,
    ["-v", "error", "-select_streams", stream, "-show_entries", entry,
     "-of", "default=nw=1:nk=1", file],
    { encoding: "utf8" }
  );
  return r.stdout.trim();
}

function evalRate(rate: string): number {
  const [num, den] = rate.split("/").map(Number);
  return den ? num / den : num;
}

test("rendered copy is CFR at the recipe fps with intact, in-sync audio", () => {
  const dir = mkdtempSync(join(tmpdir(), "uniq-cfr-"));
  try {
    const input = join(dir, "in.mp4");
    const output = join(dir, "out.mp4");
    makeTestClip(input);

    const opts: CopyOptions = {
      strength: 1, exportFormat: "original", keepTrendAudio: false,
      allowMirror: false, targetDistance: 60, spoofMetadata: false,
    };
    const recipe = sampleRecipe(opts, 42, 1);
    const enc = recipe.video.find((o) => o.id === "encode")!.params;

    const r = spawnSync(FFMPEG, ["-y", "-i", input, ...buildArgs(recipe, info), output],
      { encoding: "buffer" });
    expect(r.status).toBe(0);

    // Output frame rate equals the chosen fps (CFR applied).
    expect(evalRate(probeField(output, "stream=r_frame_rate", "v"))).toBe(Number(enc.fps));
    // Audio survived and is AAC at the chosen bitrate family.
    expect(probeField(output, "stream=codec_name", "a")).toContain("aac");
    // A/V durations stay within 200ms (setpts + atempo + -r kept in sync).
    const vd = Number(probeField(output, "stream=duration", "v"));
    const ad = Number(probeField(output, "stream=duration", "a"));
    expect(Math.abs(vd - ad)).toBeLessThan(0.2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `bun test src/node/ffmpegExecutor.cfr.test.ts`
Expected: PASS. (This test only makes sense after Tasks 1–2; if `r.status !== 0`, read the ffmpeg stderr via `r.stderr.toString()` to debug — most likely a flag-ordering issue.)

- [ ] **Step 3: Run the full suite**

Run: `bun test`
Expected: PASS (whole suite, real-ffmpeg tests included).

- [ ] **Step 4: Commit**

```bash
git add src/node/ffmpegExecutor.cfr.test.ts
git commit -m "✅ verify CFR output and A/V sync on a real clip"
```

---

## Self-Review

**1. Spec coverage** (Point 1 from the discussion):
- ultrafast → faster/veryfast ✓ Task 1 (draw) + Task 2 (emit).
- CFR + fps/GOP normalization (`-r/-fps_mode cfr/-g/-keyint_min`) ✓ Task 2, proven in Task 3.
- Randomize fps/GOP/audio bitrate (kill constants) ✓ Task 1.
- 50 MB cap uses real audio bitrate ✓ Task 2 (`aBitrate`).
- A/V-sync verification on a real clip ✓ Task 3.

**2. Placeholder scan:** No TBD/"handle edge cases"/"similar to Task N". Every code step shows full code.

**3. Type consistency:** `encode` params keys `{ crf, fps, gop, keyintMin, preset, audioKbps }` are identical across Task 1 (produced), Task 2 (consumed), and Task 3 (`enc.fps`). `preset` is a string both places; `fps/gop/keyintMin/audioKbps` are numbers. `pick<T>(rng: Rng, ...)` uses the existing `Rng` import.

**Deferred (not in scope — Point 2):** segmented speed / micro-cuts / `-filter_complex` refactor is a separate plan.
