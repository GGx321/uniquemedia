# Electron UI — Design Spec (Plan 2)

- **Date:** 2026-06-06
- **Status:** Approved (pending user review of this document)
- **Builds on:** Plan 1 (headless engine + CLI), which is complete on `main`.

## 1. Overview

A desktop Electron app wrapping the finished `core` engine. Single screen, "studio
dark" theme. Left column: drag & drop a source video, set N copies, export format,
choose a preset (Light / Medium / Aggressive), open an advanced panel, press
**Uniquify**. Right column: a live queue of copy cards (thumbnail, uniqueness badge
"91% ✓", PDQ distance, Open / Reveal-in-folder buttons) with an overall batch
counter (7/30) and a real percentage for the copy currently rendering.

## 2. Resolved UI decisions

| Topic | Decision |
|---|---|
| Screen structure | Single screen (settings left, live queue right) — not a wizard |
| Visual style | Studio dark (deep dark bg, single violet accent) |
| Copy card | Thumbnail + badge + actions (Open / Reveal). No embedded player |
| Progress | Real % parsed from FFmpeg `-progress` + batch counter N/total |
| Integration approach | Thin IPC + minimal `core` extensions (reuse `uniquify`) |

## 3. Architecture

- **`electron/main.ts`** — creates the BrowserWindow, owns a single `FfmpegExecutor`
  instance, runs `uniquify` from `src/core/pipeline.ts`, and relays progress to the
  renderer via `webContents.send`. Hosts all IPC handlers.
- **`electron/preload.ts`** — `contextBridge` exposes a typed, minimal `window.api`.
  No Node APIs leak into the renderer (`contextIsolation: true`, `nodeIntegration:
  false`).
- **`src/renderer/`** — React + TypeScript. Studio-dark theme via CSS custom
  properties (no heavy UI kit). Calls `window.api` only.
- **`electron.vite.config.ts`** — three build targets (main, preload, renderer).

`core` and `src/node/ffmpegExecutor.ts` are reused as-is except for the three
additive extensions in §4.

## 4. Core extensions (touching reviewed, tested Plan 1 code — additively)

All changes are backward compatible; existing Plan 1 tests must stay green.

1. **Render progress.** `RenderExecutor.render(input, info, recipe, output, onProgress?)`
   gains an optional `onProgress(fraction: number)` (0..1). `FfmpegExecutor` adds
   `-progress pipe:1` and parses `out_time_us` ÷ `(info.durationSec * 1e6)`.
   Callers that omit the callback behave exactly as before.
2. **Thumbnail.** New `FfmpegExecutor.extractThumbnail(path): Promise<string>` returns
   a JPEG data-URL of an early frame, scaled down (e.g. height 180), for copy cards.
   (Not part of the `RenderExecutor` interface — it is host-side convenience.)
3. **Pipeline passthrough.** `uniquify(...)` config gains optional
   `onProgress(index, attempt, fraction)` and `onCopyDone(result: CopyResult)`. The
   batch logic (auto-strengthen, dedup, re-render-best) is unchanged.

## 5. React component tree

`App` (owns batch state) →
- `DropZone` — drag&drop / click-to-pick; shows source filename + dims.
- `SettingsPanel` → `NField` (count), `FormatSelect` (reels/feed/square),
  `PresetButtons` (Light/Medium/Aggressive), `AdvancedPanel` (collapsible:
  per-category toggles, intensity sliders, mirror toggle, keep-trend-audio toggle,
  target-distance), output-folder picker.
- `RunButton` — disabled until a valid source + N ≥ 1.
- `BatchProgress` — "7/30" + current-copy progress bar.
- `CopyQueue` → `CopyCard` (thumbnail, `copy_NN.mp4`, badge with uniqueness % and
  pass/fail, `dist`, Open / Reveal buttons; error state if a copy failed).

Presentational components are separate from state; each has one responsibility.

## 6. IPC contract (`window.api`)

- `pickFile(): Promise<string | null>` and drop → file path.
- `probe(path): Promise<MediaInfo>`.
- `chooseOutDir(): Promise<string | null>`.
- `start(input, opts: CopyOptions, count, outDir): Promise<void>` — begins a batch.
- `cancel(): Promise<void>` — graceful stop; kills the in-flight ffmpeg child.
- `openFile(path)` / `revealInFolder(path)`.
- Events (main → renderer): `onBatchProgress({index, count, fraction})`,
  `onCopyDone({index, path, thumb, verify})`, `onBatchDone(summary)`,
  `onError({message})`.

## 7. Data flow

drop/pick → `probe` shows dims → user sets N/preset/format/advanced → **Uniquify**
calls `start` → main runs `uniquify`, emitting `onBatchProgress` per render tick and
`onCopyDone` (with a freshly extracted thumbnail + verify result) as each copy
finishes → renderer appends/updates `CopyCard`s → `onBatchDone` enables a "reveal
all" action.

## 8. Error handling

- Invalid source (ffprobe fails) → inline toast, no batch start.
- No disk space / permission error → toast; batch aborts cleanly.
- A single copy throwing → its card shows an error state; the batch continues
  (per-copy isolation already in `pipeline`).
- Cancel → main stops after the current ffmpeg child is killed; temp files cleaned.

## 9. Testing

- **core extensions (unit):** FFmpeg `-progress` line parser tested against captured
  fixture lines; `render` without callback still passes Plan 1 tests; `extractThumbnail`
  integration on the test clip returns a non-empty `data:image/jpeg` URL.
- **renderer (component):** Testing Library tests for `PresetButtons` (selection),
  `CopyCard` (badge pass/fail rendering, button wiring), `AdvancedPanel` (toggle state).
- **e2e (optional):** launch Electron, drop the synthetic test clip, run a 2-copy
  batch, assert two cards appear with badges.

## 10. Visual style tokens (studio dark)

CSS custom properties: `--bg:#0f0f14`, `--panel:#1f1f29`, `--border:#2a2a36`,
`--text:#e8e8ef`, `--muted:#8a8a99`, `--accent:#6d6df5`, `--ok:#5ad19a`,
`--ok-bg:#1f3d2c`, `--warn:#e0b24a`. Rounded 8px panels, generous spacing,
system font stack.

## 11. Scope / non-goals (Plan 2)

- No parallel rendering (sequential, as Plan 1). Worker-thread fan-out is Plan 3+ if
  needed.
- No depth-3D (Plan 3).
- No saved settings profiles in v1 (easy to add later).
- No in-app video player (open in the system player instead).
