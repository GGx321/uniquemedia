# Segmented Speed (Temporal Fingerprint Break) — Design

**Date:** 2026-07-12
**Status:** Approved (design), pending implementation plan.
**Scope:** Point 2 of the uniquifier roadmap — the temporal layer. See [[uniquemedia-roadmap]].

## Goal

Replace the single global speed change (`setpts=PTS/speed` + `atempo=speed`, applied to
the whole clip) with **N per-segment speed changes over the timeline**. Each source segment
plays at its own speed, so the output's inter-frame timing no longer matches the source —
breaking the temporal fingerprint — while staying visually subtle. Video and audio are cut on
the **same time boundaries** so they stay in sync.

## Non-Goals (deferred fast-follow, once this infra lands)

- **Micro-cuts** (dropping/removing short windows) — adds visible micro-jumps; separate increment.
- **Aggressive spread** (shorter segments, 0.85–1.15 range) — dial up only after eyeballing real output.

The design keeps segment count and speed spread as constants so widening them later is a one-line change,
and structures the filtergraph so micro-cuts can be added without another refactor.

## Key Decisions

- **Audio is always segmented, no special cases.** Per the client, trend-sound matching does not matter
  ("тренд саунд нас не ебёт"), so `keepTrendAudio` no longer gates segmentation. `keepTrendAudio` continues
  to mean only "skip the EQ op"; the per-segment `atempo` applies regardless.
- **Video fidelity stays subtle** ("незаметно глазу") for this increment — per-segment speed via the existing
  `PARAMS.speed` deviation (~±5% at default strength, wider with the strength multiplier).
- **Point 1 (encoder) is untouched.** Only the filter portion moves from `-vf` to `-filter_complex` + `-map`.
  CFR/GOP/preset/crf/50 MB cap/spoof all stay exactly as they are.

## Recipe Changes (`src/core/types.ts`)

Add a segment list to the recipe and remove the single `speed` operation:

```ts
export interface SpeedSegment {
  fraction: number; // portion of source duration; fractions sum to ~1
  speed: number;    // playback speed for this segment (ffmpeg-safe 0.5..2.0)
}

export interface Recipe {
  // ...existing fields...
  segments: SpeedSegment[]; // NEW — replaces the old { id: "speed" } video op
  video: Operation[];       // no longer contains a "speed" op; still has "encode"
  audio: Operation[];
}
```

`segments` lives on `Recipe` directly (not inside an `Operation`) because `Operation.params` is
`Record<string, number | boolean | string>` and cannot hold an array of objects.

## Sampler Changes (`src/core/sampler.ts`)

- `SEGMENT_COUNTS = [3, 4, 5] as const`; draw `N = pick(rng, SEGMENT_COUNTS)`.
- **Fractions (non-uniform):** draw `N` raw weights `w_i = 0.5 + rng()` (each in `[0.5, 1.5)`), normalize
  to fractions summing to 1. Non-uniform so segment boundaries aren't themselves a fixed pattern, and no
  segment is vanishingly small.
- **Per-segment speed:** `round(clamp(dev(rng, "speed", s), 0.9, 1.1))` — the same `PARAMS.speed`
  deviation used today (~±5% at `s=1`, up to the clamp at high strength).
- Remove the `{ id: "speed", params: { speed } }` op; return `segments` on the recipe instead.
- Determinism invariant preserved: same seed + same opts ⇒ same recipe.

## filterGraph Changes (`src/core/filterGraph.ts`) — the core refactor

Move from `-vf <chain>` to `-filter_complex`. Extract the spatial filters into a
`spatialChain(recipe, info)` that produces everything **except** the speed `setpts`
(eq, hue, zoomcrop, rotate, perspective, lens, noise, vignette, hflip, export scale/crop, setsar).

Boundaries: `t_0 = 0`, `t_i = (Σ fractions[0..i-1]) × durationSec`, last segment ends at `durationSec`.

**Video branch:**
```
[0:v] <spatialChain>, split=N [v0][v1]...[vN-1];
[v0] trim=start=0:end=t1,      setpts=(PTS-STARTPTS)/speed0 [s0];
[v1] trim=start=t1:end=t2,     setpts=(PTS-STARTPTS)/speed1 [s1];
...
[s0][s1]...[sN-1] concat=n=N:v=1:a=0 [outv]
```

**Audio branch** (only when `info.hasAudio`; EQ applied once before `asplit`, `atempo` per segment):
```
[0:a] <equalizer if aeq op present>, asplit=N [a0]...[aN-1];
[a0] atrim=start=0:end=t1,  asetpts=PTS-STARTPTS, atempo=speed0 [b0];
...
[b0][b1]...[bN-1] concat=n=N:v=0:a=1 [outa]
```

**buildArgs output shape:**
```
["-filter_complex", <complex>, "-map", "[outv]",
 ...(hasAudio ? ["-map", "[outa]"] : []),
 ...(hasAudio ? ["-c:a", "aac", "-b:a", `${aBitrate}k`] : ["-an"]),
 "-c:v", "libx264", "-preset", preset, ...(spoof color tags),
 "-crf", crf, "-maxrate", ..., "-bufsize", ..., "-pix_fmt", "yuv420p",
 "-r", fps, "-fps_mode", "cfr", "-g", gop, "-keyint_min", keyintMin,
 "-movflags", "+faststart", "-map_metadata", "-1",
 ...(spoof handler_name + "-f", "mov")]
```
`-map` comes before the output path (appended by the caller). Spoof `-f mov` stays the last flag.
Per-segment speeds stay within atempo's 0.5–2.0 range, so no atempo chaining is needed.

## Testing Strategy

- **sampler unit:** `segments` length ∈ {3,4,5}; fractions sum ≈ 1 (±1e-6); each speed ∈ [0.9,1.1];
  determinism (same seed ⇒ equal); variation across seeds; not strength-scaled where applicable.
- **filterGraph unit:** args use `-filter_complex` (no `-vf`); the complex string contains `split=`,
  `asplit=` (with audio), `N` `trim=`/`setpts=` and `atrim=`/`atempo=`, `concat=n=N`; `-map [outv]`
  present, `-map [outa]` present iff audio; spatial filters (e.g. `eq=`) appear before `split`; Point-1
  encoder flags (`-fps_mode cfr`, `-r`, `-g`, preset) still present; spoof `-f mov` still last; no-audio
  path has `-an` and no `[outa]`.
- **real-clip integration:** render a segmented recipe on `src/node/testClip.ts` → ffprobe asserts CFR at
  the recipe fps, AAC audio present, and A/V stream durations within 200 ms (proves multi-segment
  `trim`/`atempo`/`concat` stays in sync). Extends the Point-1 `ffmpegExecutor.cfr.test.ts` pattern.

## Global Constraints

- Determinism: same seed + same opts ⇒ same recipe.
- Point 1 encoder behavior (CFR/GOP/preset/crf/50 MB cap/spoof) unchanged.
- `keepTrendAudio` gates only the EQ op, never segmentation.
- Segment count and speed spread are tunable constants (`SEGMENT_COUNTS`, `PARAMS.speed`) for the
  deferred aggressive/micro-cut follow-up.
- English code/comments/commits; gitmoji, atomic, `bun test` green before each commit.
```
