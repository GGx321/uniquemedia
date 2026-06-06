# Instagram Video Uniquifier — Design Spec

- **Date:** 2026-06-06
- **Status:** Approved (pending user review of this document)
- **Author:** brainstorming session

## 1. Overview

Desktop application (Electron) that takes **one** source video and produces **N
unique copies** suitable for posting across multiple Instagram accounts. Each
copy gets a randomized set of 2D and pseudo-3D transformations, then is
**verified with a PDQ perceptual hash** (Meta's open-sourced algorithm). If a
copy is too close to the original, effects are auto-strengthened and the copy is
re-rendered until it crosses a target distance threshold.

The core value is **measurability**: instead of "hopefully this passes", every
copy ships with a measured perceptual-hash distance from the original (and from
its sibling copies).

## 2. Resolved decisions

| Topic | Decision |
|---|---|
| Primary workflow | 1 video → N unique copies (SMM uniquifier), per-copy randomization |
| Platform | Electron desktop, bundled FFmpeg, local processing |
| 3D scope (v1) | 2D + pseudo-3D (perspective/lens/tilt via FFmpeg). Real depth-parallax = Phase 2 |
| Control model | Intensity presets (Light / Medium / Aggressive) + advanced manual mode |
| Verification | PDQ check + auto-guarantee of threshold (auto-strengthen + re-render) |
| Engine architecture | Recipe-based, single FFmpeg pass per copy, filters as reusable modules |
| Package manager | bun; build with electron-builder; primary target macOS, cross-platform-ready |

## 3. Non-goals (v1)

- Real depth-map parallax / neural depth estimation (Phase 2).
- Server/SaaS hosting (web portability is *designed for* but not *built* in v1 — see §9).
- Direct posting to Instagram / account automation. The tool only produces files.
- Guaranteeing platform acceptance — see §10.

## 4. Architecture

Three layers, deliberately isolated:

- **`main` (Electron main process)** — orchestration: a pool of FFmpeg workers
  (sized to CPU core count), the per-copy job queue, file I/O, IPC. Owns the
  `ElectronExecutor` (see §9).
- **`renderer` (React + TypeScript)** — all UI; communicates with `main` via a
  typed IPC bridge (preload). No business logic here.
- **`core` (pure TypeScript, NO Electron dependency)** — the brains, fully
  unit-testable in isolation:
  - recipe sampler (preset ranges + seed → concrete recipe)
  - filter-graph builder (recipe → FFmpeg `filter_complex` string)
  - PDQ hashing + Hamming distance
  - verification loop logic (thresholds, auto-strengthen, inter-copy uniqueness)
  - `RenderExecutor` **interface** (implementations injected by the host)

**Per-copy isolation:** a failure in one copy must not abort the batch.

## 5. Uniquification engine (recipe → single FFmpeg pass)

A **recipe** is a JSON object: an ordered list of operations with concrete
parameter values sampled from preset ranges using a **seed**. The seed makes
recipes reproducible and logged ("what was applied to copy #7").

Transformation module catalog (each module knows its randomization range and how
to append itself to the filter graph):

| Category | FFmpeg tools | Effect |
|---|---|---|
| Color/tone | `eq`, `hue`, `colorbalance`, `colortemperature`, `curves` | brightness, contrast, saturation, gamma, temperature |
| Geometry 2D | `scale`+`crop` (1–6% zoom + reframe), `rotate` (0.3–1.5°) | reframing, micro-rotation |
| Pseudo-3D | `perspective` (plane tilt), `lenscorrection`/`v360` (barrel/pincushion, slight curvature) | "3D-like" geometry; strongly shifts the hash |
| Detail/noise | `noise`, `unsharp`, grain overlay | micro-grain, sharpen/blur |
| Composition | `vignette`, light-leak/gradient overlay, "framed zoom" (blurred bg + centered zoomed video) | radically changes composition |
| Temporal | `setpts`+`atempo` (0.94–1.06×), micro length trim, slight fps shift | speed, duration |
| Audio | `atempo` (±2–5%), micro-EQ, optional pitch | breaks audio fingerprint. **"Keep trend audio"** toggle disables all audio changes except re-encode |
| Metadata | `-map_metadata -1`, randomized `creation_time`/encoder tag | strips device/EXIF traces |
| Container/codec | randomized CRF/bitrate, GOP/keyint, profile, preset | changes the bitstream profile |

Notes:
- **Mirror (`hflip`)** lives in advanced mode, **off by default** (it mirrors
  text/logos).
- **Instagram export presets:** Reels 9:16 (1080×1920), Feed 4:5 (1080×1350),
  1:1 (1080×1080); auto-fit source via crop/pad; H.264 + AAC, mp4.

## 6. Verification loop (the "100% works" core)

1. Render the copy from its recipe.
2. FFmpeg extracts M evenly-spaced keyframes from the copy and from the original
   (original is extracted once and cached).
3. `core` computes the **PDQ hash** (256-bit) of each frame → Hamming distance
   copy↔original, per frame.
4. Take the **worst (minimum) shift** across frames (conservative). If it is
   `< target threshold`, the copy is too similar → raise the recipe's intensity
   multiplier and **re-render** (cap ~3 attempts; otherwise ship the best result
   with a warning).
5. **Inter-copy uniqueness:** pairwise distance between produced copies — if two
   copies are too similar, re-sample the seed (so Instagram cannot flag the
   series by mutual similarity).

PDQ is implemented in `core` as pure TS (64×64 luminance → DCT → 16×16 → median →
256-bit hash); this approximates the per-frame component of Meta's TMK+PDQF video
fingerprint.

## 7. UI/UX

- Drag & drop the source video → **N copies** field → choose **preset**
  (Light/Medium/Aggressive) + **export format** → **"Uniquify"** button.
- **Advanced** (collapsible): per-category toggles, intensity sliders, mirror
  toggle, "keep trend audio" toggle, target PDQ threshold.
- Copy queue with progress, mini-preview, a **uniqueness badge** per copy
  ("87% • passed threshold"), output folder, recipe export.

## 8. Error handling & testing

**Error handling**
- Validate the source with `ffprobe` on input.
- Check available disk space before a batch.
- Graceful cancel + temp cleanup on abort.
- Retry a failed copy; on verification attempt-cap, ship best result with a
  warning.

**Testing strategy**
- **Unit (`core`):** sampler determinism by seed; correctness of generated filter
  strings; PDQ against known vectors; threshold / auto-strengthen logic.
- **Integration:** real FFmpeg on a short test clip → output valid per `ffprobe`,
  PDQ distance > threshold, copies mutually distinct.
- **E2E (optional):** launch Electron, drag&drop, 2-copy batch.

## 9. Web portability (designed-in, not built in v1)

The whole `core` is platform-agnostic and ports 1:1. The only platform-specific
piece is **where FFmpeg physically runs**, abstracted behind a single interface:

```ts
interface RenderExecutor {
  probe(input): Promise<MediaInfo>
  render(input, recipe, output): Promise<void>
  extractFrames(input, timestamps): Promise<Frame[]>
}
```

`core` depends only on `RenderExecutor`. Implementations are swappable:
- `ElectronExecutor` — spawns the bundled `ffmpeg-static` binary (v1).
- `ServerExecutor` — FFmpeg on a Node server / serverless function (web/SaaS).
- `WasmExecutor` — `ffmpeg.wasm` in the browser (private, slower, no depth-3D).

Porting to a website then = write one new executor + a Next.js shell around the
existing `core`. React components are reusable; only the thin Electron IPC layer
is replaced.

## 10. Phase 2 — real depth-3D (out of v1 scope)

ONNX Runtime + Depth-Anything-V2 (small) → per-frame depth map → parallax render
(displacement via `remap` or an offscreen WebGL pass) → back to video. A separate
module that does not block the v1 MVP.

## 11. Honest caveats

- This is a "grey-area" SMM tool. It does not attack Instagram; it transforms the
  user's **own** content. However, mass-posting copies may violate the platform's
  Terms of Service — that risk is on the user.
- A literal "100%" guarantee against an evolving black-box ML system is not
  possible. The value is **measurability** (a verified PDQ threshold per copy),
  not a promise of acceptance.
