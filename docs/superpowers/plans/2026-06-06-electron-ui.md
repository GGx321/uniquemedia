# Electron UI — Implementation Plan (Plan 2 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wrap the finished `core` engine in a studio-dark Electron desktop app: drop a video, set N + preset + format, press Uniquify, watch a live queue of verified-unique copies with real per-render progress.

**Architecture:** Three additive, backward-compatible `core` extensions (render progress, thumbnail, pipeline event passthrough); a thin Electron `main`/`preload` that runs `uniquify` and relays IPC events; a React renderer (presentational components + one stateful `App`).

**Tech Stack:** Electron, electron-vite, React + TypeScript, bun (pm + `bun test`), `@testing-library/react` + `@happy-dom/global-registrator` for component tests. Reuses Plan 1 `core` + `FfmpegExecutor`.

---

## File Structure (Plan 2)

**Core extensions (modify existing):**
- `src/node/ffmpegProgress.ts` — pure parser for FFmpeg `-progress` output → fraction (new).
- `src/core/executor.ts` — add optional `onProgress` to `RenderExecutor.render` (modify).
- `src/node/ffmpegExecutor.ts` — emit progress; add `extractThumbnail` (modify).
- `src/core/pipeline.ts` — add `onProgress(index,attempt,fraction)` + `onCopyDone` to config (modify).

**Electron shell (new):**
- `electron.vite.config.ts`, `index.html`
- `electron/ipc.ts` — channel names + shared `Api` type.
- `electron/preload.ts` — `contextBridge` → `window.api`.
- `electron/main.ts` — window, IPC handlers, runs `uniquify`, emits events.

**Renderer (new, under `src/renderer/`):**
- `main.tsx`, `App.tsx`, `theme.css`, `types.ts`, `api.ts`
- `components/DropZone.tsx`, `NField.tsx`, `FormatSelect.tsx`, `PresetButtons.tsx`, `AdvancedPanel.tsx`, `RunButton.tsx`, `BatchProgress.tsx`, `CopyQueue.tsx`, `CopyCard.tsx`, `SettingsPanel.tsx`
- co-located `*.test.tsx` for `PresetButtons`, `FormatSelect`, `NField`, `AdvancedPanel`, `CopyCard`, `BatchProgress`, `RunButton`.

**Test infra (new):**
- `testSetup.ts` — registers happy-dom; referenced from `bunfig.toml`.

---

## Task 1: FFmpeg progress parser

**Files:** Create `src/node/ffmpegProgress.ts`, `src/node/ffmpegProgress.test.ts`

- [ ] **Step 1: Write `src/node/ffmpegProgress.test.ts`**

```ts
import { test, expect } from "bun:test";
import { parseProgressFraction } from "./ffmpegProgress";

test("parses out_time_us into a fraction of duration", () => {
  const chunk = "frame=10\nout_time_us=1000000\nprogress=continue\n";
  expect(parseProgressFraction(chunk, 2)).toBeCloseTo(0.5, 5);
});

test("uses the LAST out_time_us in a multi-block chunk", () => {
  const chunk =
    "out_time_us=500000\nprogress=continue\nout_time_us=1500000\nprogress=continue\n";
  expect(parseProgressFraction(chunk, 2)).toBeCloseTo(0.75, 5);
});

test("clamps to 1 and returns 1 on progress=end", () => {
  expect(parseProgressFraction("out_time_us=9999999999\nprogress=end\n", 2)).toBe(1);
});

test("returns null when no parseable time or bad duration", () => {
  expect(parseProgressFraction("out_time_us=N/A\nprogress=continue\n", 2)).toBeNull();
  expect(parseProgressFraction("out_time_us=1000000\n", 0)).toBeNull();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/node/ffmpegProgress.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `src/node/ffmpegProgress.ts`**

```ts
/**
 * Parse a chunk of FFmpeg `-progress` output into a 0..1 fraction.
 * FFmpeg emits repeating key=value blocks ending in `progress=continue|end`.
 * Returns null if no usable `out_time_us` is present or duration is non-positive.
 */
export function parseProgressFraction(chunk: string, durationSec: number): number | null {
  if (durationSec <= 0) return null;
  if (/\bprogress=end\b/.test(chunk)) return 1;
  const matches = [...chunk.matchAll(/out_time_us=(\d+)/g)];
  const last = matches.at(-1);
  if (!last) return null;
  const us = Number(last[1]);
  return Math.min(1, us / (durationSec * 1e6));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test src/node/ffmpegProgress.test.ts`
Expected: 4 pass.

- [ ] **Step 5: Commit**

```bash
git add src/node/ffmpegProgress.ts src/node/ffmpegProgress.test.ts
git commit -m "✨ add ffmpeg progress parser"
```

---

## Task 2: Render progress in executor

**Files:** Modify `src/core/executor.ts`, `src/node/ffmpegExecutor.ts`; Create `src/node/ffmpegExecutor.progress.test.ts`

- [ ] **Step 1: Update the interface `src/core/executor.ts`**

Replace the `render` line in the `RenderExecutor` interface with (add the optional `onProgress`):

```ts
  render(
    input: string,
    info: MediaInfo,
    recipe: Recipe,
    output: string,
    onProgress?: (fraction: number) => void
  ): Promise<void>;
```

- [ ] **Step 2: Write the failing test `src/node/ffmpegExecutor.progress.test.ts`**

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
  dir = mkdtempSync(join(tmpdir(), "uniq-prog-"));
  input = join(dir, "in.mp4");
  makeTestClip(input);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("render reports increasing progress ending near 1", async () => {
  const info = await exec.probe(input);
  const recipe = sampleRecipe(
    { preset: "medium", exportFormat: "square", keepTrendAudio: false, allowMirror: false, targetDistance: 90 },
    7, 1
  );
  const seen: number[] = [];
  await exec.render(input, info, recipe, join(dir, "out.mp4"), (f) => seen.push(f));
  expect(seen.length).toBeGreaterThan(0);
  expect(Math.max(...seen)).toBeGreaterThan(0.5);
  expect(seen[seen.length - 1]).toBe(1);
}, 60000);
```

- [ ] **Step 3: Run to verify it fails**

Run: `bun test src/node/ffmpegExecutor.progress.test.ts`
Expected: FAIL (render ignores onProgress / `seen` empty).

- [ ] **Step 4: Rewrite `render` in `src/node/ffmpegExecutor.ts`**

Add the import at the top (next to existing imports):

```ts
import { parseProgressFraction } from "./ffmpegProgress";
```

Replace the existing `render` method with:

```ts
  render(
    input: string,
    info: MediaInfo,
    recipe: Recipe,
    output: string,
    onProgress?: (fraction: number) => void
  ): Promise<void> {
    const args = ["-y", "-i", input, ...buildArgs(recipe, info)];
    if (onProgress) args.push("-progress", "pipe:1", "-nostats");
    args.push(output);

    return new Promise<void>((resolve, reject) => {
      const child = spawn(FFMPEG, args);
      const err: Buffer[] = [];
      child.stderr.on("data", (d) => err.push(d));
      if (onProgress) {
        child.stdout.on("data", (d) => {
          const f = parseProgressFraction(d.toString(), info.durationSec);
          if (f !== null) onProgress(f);
        });
      }
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`ffmpeg exited ${code}: ${Buffer.concat(err).toString().slice(-500)}`))
      );
    });
  }
```

- [ ] **Step 5: Run to verify it passes**

Run: `bun test src/node/ffmpegExecutor.progress.test.ts`
Expected: 1 pass.

- [ ] **Step 6: Verify backward compatibility**

Run: `bun test src/node/ffmpegExecutor.test.ts && bun test src/core/pipeline.test.ts`
Expected: all pass (render without `onProgress` still produces valid output).

- [ ] **Step 7: Commit**

```bash
git add src/core/executor.ts src/node/ffmpegExecutor.ts src/node/ffmpegExecutor.progress.test.ts
git commit -m "✨ stream render progress from ffmpeg executor"
```

---

## Task 3: Thumbnail extraction

**Files:** Modify `src/node/ffmpegExecutor.ts`; Create `src/node/ffmpegExecutor.thumb.test.ts`

- [ ] **Step 1: Write the failing test `src/node/ffmpegExecutor.thumb.test.ts`**

```ts
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FfmpegExecutor } from "./ffmpegExecutor";
import { makeTestClip } from "./testClip";

let dir: string;
let input: string;
const exec = new FfmpegExecutor();

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "uniq-thumb-"));
  input = join(dir, "in.mp4");
  makeTestClip(input);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("extractThumbnail returns a non-empty jpeg data url", async () => {
  const url = await exec.extractThumbnail(input);
  expect(url.startsWith("data:image/jpeg;base64,")).toBe(true);
  expect(url.length).toBeGreaterThan(200);
}, 60000);
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/node/ffmpegExecutor.thumb.test.ts`
Expected: FAIL (`extractThumbnail` not a function).

- [ ] **Step 3: Add `extractThumbnail` to `FfmpegExecutor` (after `extractGrayFrames`)**

```ts
  async extractThumbnail(input: string): Promise<string> {
    const buf = await run(FFMPEG, [
      "-ss", "0.5", "-i", input, "-frames:v", "1",
      "-vf", "scale=-2:180", "-f", "image2pipe", "-vcodec", "mjpeg", "-",
    ]);
    return "data:image/jpeg;base64," + buf.toString("base64");
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test src/node/ffmpegExecutor.thumb.test.ts`
Expected: 1 pass.

- [ ] **Step 5: Commit**

```bash
git add src/node/ffmpegExecutor.ts src/node/ffmpegExecutor.thumb.test.ts
git commit -m "✨ add thumbnail extraction to ffmpeg executor"
```

---

## Task 4: Pipeline event passthrough

**Files:** Modify `src/core/pipeline.ts`; Create `src/core/pipeline.events.test.ts`

- [ ] **Step 1: Write the failing test `src/core/pipeline.events.test.ts`**

```ts
import { test, expect } from "bun:test";
import { uniquify } from "./pipeline";
import type { RenderExecutor } from "./executor";
import type { CopyOptions, MediaInfo, Recipe } from "./types";

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
  preset: "medium", exportFormat: "reels", keepTrendAudio: false, allowMirror: false, targetDistance: 40,
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/core/pipeline.events.test.ts`
Expected: FAIL (config has no `onProgress`/`onCopyDone`; callbacks never fire).

- [ ] **Step 3: Edit `src/core/pipeline.ts`**

Add to the `UniquifyConfig` interface (after `onProgress?: ...` if present, else add both):

```ts
  onProgress?: (index: number, attempt: number, fraction: number) => void;
  onCopyDone?: (result: CopyResult) => void;
```

Note: the Plan 1 `UniquifyConfig` already declared `onProgress?: (index, attempt) => void`. REPLACE that line with the 3-arg version above (the extra `fraction` arg is additive — existing CLI usage that ignores it still type-checks because it passes a 2-arg lambda, which is assignable).

In the render call inside the attempts loop, pass the progress callback:

```ts
      await executor.render(input, info, recipe, out, (f) =>
        config.onProgress?.(i, attempt, f)
      );
```

After `results.push(best!);` (end of the per-copy loop body), add:

```ts
    config.onCopyDone?.(best!);
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test src/core/pipeline.events.test.ts`
Expected: 1 pass.

- [ ] **Step 5: Verify nothing else broke**

Run: `bun test src/core/pipeline.test.ts && bun test src/cli.test.ts`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/core/pipeline.ts src/core/pipeline.events.test.ts
git commit -m "✨ pass progress and copy-done events out of pipeline"
```

---

## Task 5: Electron scaffold (window opens)

**Files:** Modify `package.json`; Create `electron.vite.config.ts`, `index.html`, `electron/main.ts`, `electron/preload.ts`, `src/renderer/main.tsx`, `src/renderer/App.tsx`, `src/renderer/theme.css`

- [ ] **Step 1: Add deps**

Run:
```bash
bun add -d electron electron-vite vite @vitejs/plugin-react electron-builder
bun add react react-dom
bun add -d @types/react @types/react-dom
```

- [ ] **Step 2: Edit `package.json`** — add `"main"` and scripts (merge with existing):

```jsonc
{
  "main": "out/main/main.js",
  "scripts": {
    "test": "bun test",
    "uniquify": "bun run src/cli.ts",
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "preview": "electron-vite preview"
  }
}
```

- [ ] **Step 3: Write `electron.vite.config.ts`**

```ts
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  main: { build: { lib: { entry: "electron/main.ts" } } },
  preload: { build: { lib: { entry: "electron/preload.ts" } } },
  renderer: {
    root: ".",
    build: { rollupOptions: { input: resolve(import.meta.dirname, "index.html") } },
    plugins: [react()],
  },
});
```

- [ ] **Step 4: Write `index.html`**

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'" />
    <title>uniquemedia</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/renderer/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 5: Write `electron/main.ts`** (minimal window for now; IPC added in Task 7)

```ts
import { app, BrowserWindow } from "electron";
import { join } from "node:path";

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    backgroundColor: "#0f0f14",
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    win.loadFile(join(import.meta.dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
```

- [ ] **Step 6: Write `electron/preload.ts`** (stub; filled in Task 6)

```ts
import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("api", {});
```

- [ ] **Step 7: Write `src/renderer/theme.css`**

```css
:root {
  --bg: #0f0f14;
  --panel: #1f1f29;
  --border: #2a2a36;
  --text: #e8e8ef;
  --muted: #8a8a99;
  --accent: #6d6df5;
  --ok: #5ad19a;
  --ok-bg: #1f3d2c;
  --warn: #e0b24a;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
}
button { font: inherit; cursor: pointer; }
```

- [ ] **Step 8: Write `src/renderer/main.tsx`**

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./theme.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
```

- [ ] **Step 9: Write `src/renderer/App.tsx`** (placeholder; real UI in Task 14)

```tsx
export function App() {
  return <h1 style={{ padding: 24 }}>uniquemedia</h1>;
}
```

- [ ] **Step 10: Add `jsx` to `tsconfig.json`**

In `compilerOptions`, add: `"jsx": "react-jsx"`.

- [ ] **Step 11: Manual verify the window opens**

Run: `bun run dev`
Expected: an Electron window opens showing "uniquemedia" on a dark background. Close it. (If the renderer URL env var differs, electron-vite prints it; the app should still load.)

**Robustness note (expected adjustment point, not a plan bug):** This project is ESM (`"type": "module"`). Depending on the installed electron-vite / Electron versions, you may need to adjust:
- Path resolution in `main.ts`/`preload.ts`: `import.meta.dirname` (Node ≥20.11, ESM) vs `__dirname` (CJS). Use whatever matches electron-vite's actual output for this version; the goal is that the preload path and `loadFile` path resolve to the real `out/preload/*.js` and `out/renderer/index.html`.
- The `main` field in `package.json` must point at electron-vite's actual main output (commonly `out/main/main.js` or `out/main/index.js` — check the build output and correct it).
- If Electron requires CJS for this setup, electron-vite handles the transform; don't fight it. Do NOT change the whole project away from ESM — only adjust these Electron entry specifics.
If the window does not open, treat it as a config task: read the electron-vite error, fix the path/entry, and re-run until the window appears. Report any version-specific change you made.

- [ ] **Step 12: Commit**

```bash
git add package.json bun.lock tsconfig.json electron.vite.config.ts index.html electron/main.ts electron/preload.ts src/renderer/main.tsx src/renderer/App.tsx src/renderer/theme.css
git commit -m "🔧 scaffold electron + react shell"
```

---

## Task 6: IPC contract + preload bridge

**Files:** Create `electron/ipc.ts`, `src/renderer/types.ts`; Modify `electron/preload.ts`

- [ ] **Step 1: Write `src/renderer/types.ts`** (shared UI types)

```ts
import type { CopyOptions, MediaInfo } from "../core/types";

export type CopyStatus = "pending" | "rendering" | "done" | "error";

export interface UiCopy {
  index: number;
  name: string;
  status: CopyStatus;
  fraction?: number;
  thumb?: string;
  verify?: { minDistance: number; passed: boolean };
  error?: string;
}

export interface StartRequest {
  input: string;
  opts: CopyOptions;
  count: number;
  outDir: string;
}

export type { CopyOptions, MediaInfo };
```

- [ ] **Step 2: Write `electron/ipc.ts`** (channel names + Api type)

```ts
import type { CopyOptions, MediaInfo } from "../src/core/types";

export const CH = {
  pickFile: "pick-file",
  probe: "probe",
  chooseOutDir: "choose-out-dir",
  start: "start",
  cancel: "cancel",
  openFile: "open-file",
  reveal: "reveal-in-folder",
  // events (main -> renderer):
  evtProgress: "evt:batch-progress",
  evtCopyDone: "evt:copy-done",
  evtBatchDone: "evt:batch-done",
  evtError: "evt:error",
} as const;

export interface Api {
  pickFile(): Promise<string | null>;
  probe(path: string): Promise<MediaInfo>;
  chooseOutDir(): Promise<string | null>;
  start(req: { input: string; opts: CopyOptions; count: number; outDir: string }): Promise<void>;
  cancel(): Promise<void>;
  openFile(path: string): Promise<void>;
  revealInFolder(path: string): Promise<void>;
  onBatchProgress(cb: (p: { index: number; count: number; fraction: number }) => void): void;
  onCopyDone(cb: (c: { index: number; path: string; thumb: string; verify: { minDistance: number; passed: boolean } }) => void): void;
  onBatchDone(cb: (s: { passed: number; total: number }) => void): void;
  onError(cb: (e: { message: string }) => void): void;
}
```

- [ ] **Step 3: Write `electron/preload.ts`**

```ts
import { contextBridge, ipcRenderer } from "electron";
import { CH, type Api } from "./ipc";

const api: Api = {
  pickFile: () => ipcRenderer.invoke(CH.pickFile),
  probe: (path) => ipcRenderer.invoke(CH.probe, path),
  chooseOutDir: () => ipcRenderer.invoke(CH.chooseOutDir),
  start: (req) => ipcRenderer.invoke(CH.start, req),
  cancel: () => ipcRenderer.invoke(CH.cancel),
  openFile: (path) => ipcRenderer.invoke(CH.openFile, path),
  revealInFolder: (path) => ipcRenderer.invoke(CH.reveal, path),
  onBatchProgress: (cb) => ipcRenderer.on(CH.evtProgress, (_e, p) => cb(p)),
  onCopyDone: (cb) => ipcRenderer.on(CH.evtCopyDone, (_e, c) => cb(c)),
  onBatchDone: (cb) => ipcRenderer.on(CH.evtBatchDone, (_e, s) => cb(s)),
  onError: (cb) => ipcRenderer.on(CH.evtError, (_e, x) => cb(x)),
};

contextBridge.exposeInMainWorld("api", api);
```

- [ ] **Step 4: Type-check**

Run: `bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add electron/ipc.ts electron/preload.ts src/renderer/types.ts
git commit -m "🔌 define ipc contract and preload bridge"
```

---

## Task 7: Main process IPC handlers

**Files:** Modify `electron/main.ts`

- [ ] **Step 1: Replace `electron/main.ts` with the full handler-wired version**

```ts
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { FfmpegExecutor } from "../src/node/ffmpegExecutor";
import { uniquify } from "../src/core/pipeline";
import { CH } from "./ipc";

const executor = new FfmpegExecutor();
let cancelled = false;
let win: BrowserWindow | null = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 720,
    backgroundColor: "#0f0f14",
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else win.loadFile(join(import.meta.dirname, "../renderer/index.html"));
}

ipcMain.handle(CH.pickFile, async () => {
  const r = await dialog.showOpenDialog({
    properties: ["openFile"],
    filters: [{ name: "Video", extensions: ["mp4", "mov", "mkv", "webm", "avi"] }],
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle(CH.probe, (_e, path: string) => executor.probe(path));

ipcMain.handle(CH.chooseOutDir, async () => {
  const r = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle(CH.openFile, (_e, path: string) => shell.openPath(path));
ipcMain.handle(CH.reveal, (_e, path: string) => shell.showItemInFolder(path));
ipcMain.handle(CH.cancel, () => { cancelled = true; });

ipcMain.handle(CH.start, async (_e, req) => {
  cancelled = false;
  const { input, opts, count, outDir } = req;
  mkdirSync(outDir, { recursive: true });
  const send = (ch: string, payload: unknown) => win?.webContents.send(ch, payload);
  try {
    const results = await uniquify(input, opts, executor, count, {
      seedBase: Date.now() % 1e6,
      outputPath: (i) => join(outDir, `copy_${i + 1}.mp4`),
      onProgress: (index, _attempt, fraction) =>
        send(CH.evtProgress, { index, count, fraction }),
      onCopyDone: async (r) => {
        if (cancelled) return;
        const thumb = await executor.extractThumbnail(r.outputPath).catch(() => "");
        send(CH.evtCopyDone, {
          index: r.index, path: r.outputPath, thumb, verify: r.verify,
        });
      },
    });
    const passed = results.filter((r) => r.verify.passed).length;
    send(CH.evtBatchDone, { passed, total: count });
  } catch (err) {
    send(CH.evtError, { message: err instanceof Error ? err.message : String(err) });
  }
});

app.whenReady().then(createWindow);
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
```

Note: `Date.now()` is used here for a per-batch random seed — that's correct in the real Electron runtime (only the Workflow sandbox forbids it; this is app code).

- [ ] **Step 2: Type-check**

Run: `bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Manual smoke (optional but recommended)**

Run: `bun run dev`. The window opens (UI still placeholder). No crash on launch. Close it.

- [ ] **Step 4: Commit**

```bash
git add electron/main.ts
git commit -m "🔌 wire main process ipc handlers to uniquify"
```

---

## Task 8: Renderer test setup + api wrapper

**Files:** Create `testSetup.ts`, `src/renderer/api.ts`; Modify `bunfig.toml`

- [ ] **Step 1: Add deps**

Run: `bun add -d @happy-dom/global-registrator @testing-library/react @testing-library/dom`

- [ ] **Step 2: Write `testSetup.ts`**

```ts
import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();
```

- [ ] **Step 3: Edit `bunfig.toml`** — add a preload so DOM exists in tests (keep the existing `timeout`):

```toml
[test]
timeout = 60000
preload = ["./testSetup.ts"]
```

- [ ] **Step 4: Write a sanity DOM test `src/renderer/dom.smoke.test.tsx`**

```tsx
import { test, expect } from "bun:test";
import { render, screen } from "@testing-library/react";

test("happy-dom + testing-library render works", () => {
  render(<div>hello</div>);
  expect(screen.getByText("hello")).toBeDefined();
});
```

- [ ] **Step 5: Run it**

Run: `bun test src/renderer/dom.smoke.test.tsx`
Expected: 1 pass. (If it fails because `document` is undefined, confirm `bunfig.toml` preload path and that `@happy-dom/global-registrator` installed.)

- [ ] **Step 6: Write `src/renderer/api.ts`** (typed accessor)

```ts
import type { Api } from "../../electron/ipc";

declare global {
  interface Window {
    api: Api;
  }
}

export const api: Api = window.api;
```

- [ ] **Step 7: Commit**

```bash
git add bunfig.toml testSetup.ts src/renderer/api.ts src/renderer/dom.smoke.test.tsx
git commit -m "✅ set up renderer component testing with happy-dom"
```

---

## Task 9: PresetButtons + FormatSelect + NField

**Files:** Create `src/renderer/components/PresetButtons.tsx` (+ `.test.tsx`), `FormatSelect.tsx` (+ `.test.tsx`), `NField.tsx` (+ `.test.tsx`)

- [ ] **Step 1: Write `src/renderer/components/PresetButtons.test.tsx`**

```tsx
import { test, expect } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { PresetButtons } from "./PresetButtons";

test("renders three presets and reports clicks", () => {
  let chosen = "medium";
  render(<PresetButtons value="medium" onChange={(v) => (chosen = v)} />);
  fireEvent.click(screen.getByText("Aggressive"));
  expect(chosen).toBe("aggressive");
});

test("marks the active preset", () => {
  render(<PresetButtons value="light" onChange={() => {}} />);
  expect(screen.getByText("Light").getAttribute("aria-pressed")).toBe("true");
});
```

- [ ] **Step 2: Run — expect FAIL.**

Run: `bun test src/renderer/components/PresetButtons.test.tsx`

- [ ] **Step 3: Write `src/renderer/components/PresetButtons.tsx`**

```tsx
import type { PresetName } from "../../core/types";

const PRESETS: { id: PresetName; label: string }[] = [
  { id: "light", label: "Light" },
  { id: "medium", label: "Medium" },
  { id: "aggressive", label: "Aggressive" },
];

export function PresetButtons({
  value,
  onChange,
}: {
  value: PresetName;
  onChange: (p: PresetName) => void;
}) {
  return (
    <div style={{ display: "flex", gap: 6 }}>
      {PRESETS.map((p) => (
        <button
          key={p.id}
          aria-pressed={value === p.id}
          onClick={() => onChange(p.id)}
          style={{
            flex: 1,
            padding: "8px 0",
            borderRadius: 8,
            border: "1px solid var(--border)",
            background: value === p.id ? "var(--accent)" : "var(--panel)",
            color: value === p.id ? "#fff" : "var(--text)",
          }}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Run — expect 2 pass.**

- [ ] **Step 5: Write `src/renderer/components/FormatSelect.test.tsx`**

```tsx
import { test, expect } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { FormatSelect } from "./FormatSelect";

test("changes format on selection", () => {
  let v = "reels";
  render(<FormatSelect value="reels" onChange={(x) => (v = x)} />);
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "square" } });
  expect(v).toBe("square");
});
```

- [ ] **Step 6: Run — expect FAIL, then write `src/renderer/components/FormatSelect.tsx`**

```tsx
import type { ExportFormat } from "../../core/types";

const OPTS: { id: ExportFormat; label: string }[] = [
  { id: "reels", label: "Reels 9:16" },
  { id: "feed", label: "Feed 4:5" },
  { id: "square", label: "Square 1:1" },
];

export function FormatSelect({
  value,
  onChange,
}: {
  value: ExportFormat;
  onChange: (f: ExportFormat) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as ExportFormat)}
      style={{
        width: "100%", padding: 8, borderRadius: 8,
        background: "var(--panel)", color: "var(--text)", border: "1px solid var(--border)",
      }}
    >
      {OPTS.map((o) => (
        <option key={o.id} value={o.id}>{o.label}</option>
      ))}
    </select>
  );
}
```

- [ ] **Step 7: Run FormatSelect test — expect 1 pass.**

- [ ] **Step 8: Write `src/renderer/components/NField.test.tsx`**

```tsx
import { test, expect } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { NField } from "./NField";

test("reports numeric changes, clamps to >= 1", () => {
  let n = 5;
  render(<NField value={5} onChange={(x) => (n = x)} />);
  const input = screen.getByLabelText("copies") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "30" } });
  expect(n).toBe(30);
  fireEvent.change(input, { target: { value: "0" } });
  expect(n).toBe(1);
});
```

- [ ] **Step 9: Run — expect FAIL, then write `src/renderer/components/NField.tsx`**

```tsx
export function NField({
  value,
  onChange,
}: {
  value: number;
  onChange: (n: number) => void;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 12, color: "var(--muted)" }}>Copies</span>
      <input
        aria-label="copies"
        type="number"
        min={1}
        value={value}
        onChange={(e) => onChange(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
        style={{
          padding: 8, borderRadius: 8, background: "var(--panel)",
          color: "var(--text)", border: "1px solid var(--border)",
        }}
      />
    </label>
  );
}
```

- [ ] **Step 10: Run NField test — expect 1 pass.**

- [ ] **Step 11: Commit**

```bash
git add src/renderer/components/PresetButtons.tsx src/renderer/components/PresetButtons.test.tsx src/renderer/components/FormatSelect.tsx src/renderer/components/FormatSelect.test.tsx src/renderer/components/NField.tsx src/renderer/components/NField.test.tsx
git commit -m "✨ add preset, format and count controls"
```

---

## Task 10: AdvancedPanel

**Files:** Create `src/renderer/components/AdvancedPanel.tsx`, `AdvancedPanel.test.tsx`

Scope note: this panel exposes only the knobs the `sampler` actually supports — `keepTrendAudio`, `allowMirror`, `targetDistance`. Per-category toggles / intensity sliders are deferred until `sampler` supports them (Plan 3+).

- [ ] **Step 1: Write `src/renderer/components/AdvancedPanel.test.tsx`**

```tsx
import { test, expect } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { AdvancedPanel } from "./AdvancedPanel";

const base = { keepTrendAudio: false, allowMirror: false, targetDistance: 90 };

test("toggles keep-trend-audio", () => {
  let v = { ...base };
  render(<AdvancedPanel value={v} onChange={(x) => (v = x)} />);
  fireEvent.click(screen.getByLabelText("Keep trend audio"));
  expect(v.keepTrendAudio).toBe(true);
});

test("edits target distance", () => {
  let v = { ...base };
  render(<AdvancedPanel value={v} onChange={(x) => (v = x)} />);
  fireEvent.change(screen.getByLabelText("Target distance"), { target: { value: "120" } });
  expect(v.targetDistance).toBe(120);
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Write `src/renderer/components/AdvancedPanel.tsx`**

```tsx
export interface AdvancedValue {
  keepTrendAudio: boolean;
  allowMirror: boolean;
  targetDistance: number;
}

export function AdvancedPanel({
  value,
  onChange,
}: {
  value: AdvancedValue;
  onChange: (v: AdvancedValue) => void;
}) {
  const set = (patch: Partial<AdvancedValue>) => onChange({ ...value, ...patch });
  const row = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 } as const;
  return (
    <details style={{ background: "var(--panel)", borderRadius: 8, padding: "8px 12px" }}>
      <summary style={{ cursor: "pointer", color: "var(--muted)" }}>Advanced</summary>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 10 }}>
        <label style={row}>
          Keep trend audio
          <input
            aria-label="Keep trend audio"
            type="checkbox"
            checked={value.keepTrendAudio}
            onChange={(e) => set({ keepTrendAudio: e.target.checked })}
          />
        </label>
        <label style={row}>
          Allow mirror (flips text)
          <input
            aria-label="Allow mirror"
            type="checkbox"
            checked={value.allowMirror}
            onChange={(e) => set({ allowMirror: e.target.checked })}
          />
        </label>
        <label style={row}>
          Target distance
          <input
            aria-label="Target distance"
            type="number"
            min={1}
            max={256}
            value={value.targetDistance}
            onChange={(e) => set({ targetDistance: Math.max(1, Math.min(256, Number(e.target.value) || 1)) })}
            style={{ width: 80, background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 6, padding: 4 }}
          />
        </label>
      </div>
    </details>
  );
}
```

- [ ] **Step 4: Run — expect 2 pass.**

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/AdvancedPanel.tsx src/renderer/components/AdvancedPanel.test.tsx
git commit -m "✨ add advanced settings panel"
```

---

## Task 11: CopyCard + BatchProgress + RunButton

**Files:** Create `src/renderer/components/CopyCard.tsx` (+ `.test.tsx`), `BatchProgress.tsx` (+ `.test.tsx`), `RunButton.tsx` (+ `.test.tsx`)

- [ ] **Step 1: Write `src/renderer/components/CopyCard.test.tsx`**

```tsx
import { test, expect } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { CopyCard } from "./CopyCard";
import type { UiCopy } from "../types";

const done: UiCopy = {
  index: 6, name: "copy_07.mp4", status: "done",
  verify: { minDistance: 118, passed: true }, thumb: "data:image/jpeg;base64,AAAA",
};

test("renders pass badge and distance", () => {
  render(<CopyCard copy={done} onOpen={() => {}} onReveal={() => {}} />);
  expect(screen.getByText(/118/)).toBeDefined();
  expect(screen.getByText(/✓/)).toBeDefined();
});

test("open button fires with the copy name", () => {
  let opened = "";
  render(<CopyCard copy={done} onOpen={() => (opened = done.name)} onReveal={() => {}} />);
  fireEvent.click(screen.getByText(/Open/));
  expect(opened).toBe("copy_07.mp4");
});

test("shows a warning badge when not passed", () => {
  render(
    <CopyCard
      copy={{ ...done, verify: { minDistance: 40, passed: false } }}
      onOpen={() => {}}
      onReveal={() => {}}
    />
  );
  expect(screen.getByText(/warn/i)).toBeDefined();
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Write `src/renderer/components/CopyCard.tsx`**

```tsx
import type { UiCopy } from "../types";

export function CopyCard({
  copy,
  onOpen,
  onReveal,
}: {
  copy: UiCopy;
  onOpen: (path: string) => void;
  onReveal: (path: string) => void;
}) {
  const passed = copy.verify?.passed;
  const badge =
    copy.status === "error"
      ? { text: "error", bg: "#3d1f1f", fg: "#e08a8a" }
      : passed
      ? { text: `${copy.verify!.minDistance} ✓ pass`, bg: "var(--ok-bg)", fg: "var(--ok)" }
      : copy.verify
      ? { text: `${copy.verify.minDistance} warn`, bg: "#3a3320", fg: "var(--warn)" }
      : { text: "…", bg: "var(--panel)", fg: "var(--muted)" };

  return (
    <div style={{ display: "flex", gap: 10, alignItems: "center", background: "var(--panel)", borderRadius: 8, padding: 8 }}>
      {copy.thumb ? (
        <img src={copy.thumb} alt="" style={{ width: 54, height: 96, objectFit: "cover", borderRadius: 8 }} />
      ) : (
        <div style={{ width: 54, height: 96, borderRadius: 8, background: "var(--bg)" }} />
      )}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
        <b style={{ fontSize: 13 }}>{copy.name}</b>
        {copy.status === "rendering" ? (
          <div style={{ height: 6, borderRadius: 3, background: "var(--border)" }}>
            <div style={{ width: `${Math.round((copy.fraction ?? 0) * 100)}%`, height: 6, borderRadius: 3, background: "var(--accent)" }} />
          </div>
        ) : (
          <span style={{ alignSelf: "flex-start", background: badge.bg, color: badge.fg, borderRadius: 6, padding: "2px 8px", fontSize: 11 }}>
            {badge.text}
          </span>
        )}
        {copy.status === "done" && (
          <div style={{ display: "flex", gap: 6 }}>
            <button onClick={() => onOpen(copy.name)} style={btn}>▶ Open</button>
            <button onClick={() => onReveal(copy.name)} style={btn}>📁 Folder</button>
          </div>
        )}
      </div>
    </div>
  );
}

const btn = {
  fontSize: 11, padding: "3px 8px", borderRadius: 6,
  background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)",
} as const;
```

- [ ] **Step 4: Run — expect 3 pass.**

- [ ] **Step 5: Write `src/renderer/components/BatchProgress.test.tsx`**

```tsx
import { test, expect } from "bun:test";
import { render, screen } from "@testing-library/react";
import { BatchProgress } from "./BatchProgress";

test("shows counter and percent", () => {
  render(<BatchProgress index={6} count={30} fraction={0.4} />);
  expect(screen.getByText(/7\/30/)).toBeDefined();
});

test("renders nothing when idle (count 0)", () => {
  const { container } = render(<BatchProgress index={0} count={0} fraction={0} />);
  expect(container.textContent).toBe("");
});
```

- [ ] **Step 6: Run — expect FAIL, then write `src/renderer/components/BatchProgress.tsx`**

```tsx
export function BatchProgress({
  index,
  count,
  fraction,
}: {
  index: number;
  count: number;
  fraction: number;
}) {
  if (count <= 0) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 12, color: "var(--muted)" }}>
        copy {Math.min(index + 1, count)}/{count}
      </span>
      <div style={{ height: 6, borderRadius: 3, background: "var(--border)" }}>
        <div style={{ width: `${Math.round(fraction * 100)}%`, height: 6, borderRadius: 3, background: "var(--accent)" }} />
      </div>
    </div>
  );
}
```

- [ ] **Step 7: Run BatchProgress test — expect 2 pass.**

- [ ] **Step 8: Write `src/renderer/components/RunButton.test.tsx`**

```tsx
import { test, expect } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { RunButton } from "./RunButton";

test("disabled blocks clicks", () => {
  let clicked = false;
  render(<RunButton disabled running={false} onClick={() => (clicked = true)} />);
  fireEvent.click(screen.getByRole("button"));
  expect(clicked).toBe(false);
});

test("shows running label", () => {
  render(<RunButton disabled={false} running onClick={() => {}} />);
  expect(screen.getByText(/Processing/)).toBeDefined();
});
```

- [ ] **Step 9: Run — expect FAIL, then write `src/renderer/components/RunButton.tsx`**

```tsx
export function RunButton({
  disabled,
  running,
  onClick,
}: {
  disabled: boolean;
  running: boolean;
  onClick: () => void;
}) {
  return (
    <button
      disabled={disabled || running}
      onClick={onClick}
      style={{
        padding: "10px 0", borderRadius: 8, border: "none",
        background: disabled || running ? "var(--border)" : "var(--accent)",
        color: "#fff", fontWeight: 600,
      }}
    >
      {running ? "Processing…" : "Uniquify"}
    </button>
  );
}
```

- [ ] **Step 10: Run RunButton test — expect 2 pass.**

- [ ] **Step 11: Commit**

```bash
git add src/renderer/components/CopyCard.tsx src/renderer/components/CopyCard.test.tsx src/renderer/components/BatchProgress.tsx src/renderer/components/BatchProgress.test.tsx src/renderer/components/RunButton.tsx src/renderer/components/RunButton.test.tsx
git commit -m "✨ add copy card, batch progress and run button"
```

---

## Task 12: DropZone + SettingsPanel + CopyQueue (composition)

**Files:** Create `src/renderer/components/DropZone.tsx` (+ `.test.tsx`), `SettingsPanel.tsx`, `CopyQueue.tsx`

- [ ] **Step 1: Write `src/renderer/components/DropZone.test.tsx`**

```tsx
import { test, expect } from "bun:test";
import { render, screen } from "@testing-library/react";
import { DropZone } from "./DropZone";

test("shows prompt when no source", () => {
  render(<DropZone source={null} onPick={() => {}} onDropFile={() => {}} />);
  expect(screen.getByText(/Drop a video/i)).toBeDefined();
});

test("shows source name and dims when set", () => {
  render(
    <DropZone
      source={{ name: "clip.mp4", info: { durationSec: 5, width: 1080, height: 1920, hasAudio: true } }}
      onPick={() => {}}
      onDropFile={() => {}}
    />
  );
  expect(screen.getByText(/clip.mp4/)).toBeDefined();
  expect(screen.getByText(/1080×1920/)).toBeDefined();
});
```

- [ ] **Step 2: Run — expect FAIL, then write `src/renderer/components/DropZone.tsx`**

```tsx
import type { MediaInfo } from "../types";

export interface Source {
  name: string;
  info: MediaInfo;
}

export function DropZone({
  source,
  onPick,
  onDropFile,
}: {
  source: Source | null;
  onPick: () => void;
  onDropFile: (path: string) => void;
}) {
  return (
    <div
      onClick={onPick}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const f = e.dataTransfer.files[0] as (File & { path?: string }) | undefined;
        if (f?.path) onDropFile(f.path);
      }}
      style={{
        border: "1px dashed var(--border)", borderRadius: 8, padding: 18,
        textAlign: "center", color: "var(--muted)", cursor: "pointer",
      }}
    >
      {source ? (
        <div>
          <div style={{ color: "var(--text)", fontWeight: 600 }}>{source.name}</div>
          <div style={{ fontSize: 12 }}>{source.info.width}×{source.info.height}</div>
        </div>
      ) : (
        "⬇︎ Drop a video or click to pick"
      )}
    </div>
  );
}
```

- [ ] **Step 3: Run DropZone test — expect 2 pass.**

- [ ] **Step 4: Write `src/renderer/components/SettingsPanel.tsx`** (pure composition, no test — exercised by App)

```tsx
import type { CopyOptions, PresetName, ExportFormat } from "../../core/types";
import { DropZone, type Source } from "./DropZone";
import { NField } from "./NField";
import { FormatSelect } from "./FormatSelect";
import { PresetButtons } from "./PresetButtons";
import { AdvancedPanel, type AdvancedValue } from "./AdvancedPanel";
import { RunButton } from "./RunButton";

export interface SettingsState {
  count: number;
  preset: PresetName;
  format: ExportFormat;
  advanced: AdvancedValue;
}

export function settingsToOptions(s: SettingsState): CopyOptions {
  return {
    preset: s.preset,
    exportFormat: s.format,
    keepTrendAudio: s.advanced.keepTrendAudio,
    allowMirror: s.advanced.allowMirror,
    targetDistance: s.advanced.targetDistance,
  };
}

export function SettingsPanel({
  source,
  state,
  running,
  onPick,
  onDropFile,
  onChange,
  onRun,
}: {
  source: Source | null;
  state: SettingsState;
  running: boolean;
  onPick: () => void;
  onDropFile: (path: string) => void;
  onChange: (s: SettingsState) => void;
  onRun: () => void;
}) {
  const set = (patch: Partial<SettingsState>) => onChange({ ...state, ...patch });
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, width: 360 }}>
      <DropZone source={source} onPick={onPick} onDropFile={onDropFile} />
      <div style={{ display: "flex", gap: 6 }}>
        <div style={{ flex: 1 }}><NField value={state.count} onChange={(count) => set({ count })} /></div>
        <div style={{ flex: 1, alignSelf: "flex-end" }}><FormatSelect value={state.format} onChange={(format) => set({ format })} /></div>
      </div>
      <PresetButtons value={state.preset} onChange={(preset) => set({ preset })} />
      <AdvancedPanel value={state.advanced} onChange={(advanced) => set({ advanced })} />
      <RunButton disabled={!source} running={running} onClick={onRun} />
    </div>
  );
}
```

- [ ] **Step 5: Write `src/renderer/components/CopyQueue.tsx`**

```tsx
import type { UiCopy } from "../types";
import { CopyCard } from "./CopyCard";

export function CopyQueue({
  copies,
  onOpen,
  onReveal,
}: {
  copies: UiCopy[];
  onOpen: (path: string) => void;
  onReveal: (path: string) => void;
}) {
  if (copies.length === 0) {
    return <div style={{ color: "var(--muted)", padding: 24 }}>Queue is empty — drop a video and press Uniquify.</div>;
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, overflowY: "auto" }}>
      {copies.map((c) => (
        <CopyCard key={c.index} copy={c} onOpen={onOpen} onReveal={onReveal} />
      ))}
    </div>
  );
}
```

- [ ] **Step 6: Type-check + run full renderer suite**

Run: `bunx tsc --noEmit && bun test src/renderer/`
Expected: clean + all pass.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/components/DropZone.tsx src/renderer/components/DropZone.test.tsx src/renderer/components/SettingsPanel.tsx src/renderer/components/CopyQueue.tsx
git commit -m "✨ add dropzone, settings panel and copy queue"
```

---

## Task 13: App wiring (state + IPC events)

**Files:** Modify `src/renderer/App.tsx`

- [ ] **Step 1: Replace `src/renderer/App.tsx`**

```tsx
import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { UiCopy } from "./types";
import type { Source } from "./components/DropZone";
import { SettingsPanel, settingsToOptions, type SettingsState } from "./components/SettingsPanel";
import { CopyQueue } from "./components/CopyQueue";
import { BatchProgress } from "./components/BatchProgress";
import { basename } from "./util";

const initial: SettingsState = {
  count: 10,
  preset: "medium",
  format: "reels",
  advanced: { keepTrendAudio: false, allowMirror: false, targetDistance: 90 },
};

export function App() {
  const [source, setSource] = useState<Source | null>(null);
  const [sourcePath, setSourcePath] = useState<string | null>(null);
  const [state, setState] = useState<SettingsState>(initial);
  const [copies, setCopies] = useState<UiCopy[]>([]);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ index: 0, count: 0, fraction: 0 });
  const pathByIndex = useRef(new Map<number, string>());

  useEffect(() => {
    api.onBatchProgress((p) => {
      setProgress(p);
      setCopies((cs) => upsert(cs, { index: p.index, name: `copy_${p.index + 1}.mp4`, status: "rendering", fraction: p.fraction }));
    });
    api.onCopyDone((c) => {
      pathByIndex.current.set(c.index, c.path);
      setCopies((cs) => upsert(cs, {
        index: c.index, name: basename(c.path), status: "done",
        thumb: c.thumb, verify: c.verify,
      }));
    });
    api.onBatchDone(() => { setRunning(false); setProgress((p) => ({ ...p, count: 0 })); });
    api.onError((e) => { setRunning(false); alert(e.message); });
  }, []);

  async function loadSource(path: string) {
    const info = await api.probe(path);
    setSourcePath(path);
    setSource({ name: basename(path), info });
  }

  async function run() {
    if (!sourcePath) return;
    const outDir = await api.chooseOutDir();
    if (!outDir) return;
    setCopies([]);
    setRunning(true);
    setProgress({ index: 0, count: state.count, fraction: 0 });
    await api.start({ input: sourcePath, opts: settingsToOptions(state), count: state.count, outDir });
  }

  const open = (name: string) => {
    const entry = [...pathByIndex.current.values()].find((p) => p.endsWith(name));
    if (entry) api.openFile(entry);
  };
  const reveal = (name: string) => {
    const entry = [...pathByIndex.current.values()].find((p) => p.endsWith(name));
    if (entry) api.revealInFolder(entry);
  };

  return (
    <div style={{ display: "flex", gap: 16, padding: 16, height: "100vh" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <SettingsPanel
          source={source}
          state={state}
          running={running}
          onPick={async () => { const p = await api.pickFile(); if (p) loadSource(p); }}
          onDropFile={loadSource}
          onChange={setState}
          onRun={run}
        />
        <BatchProgress index={progress.index} count={progress.count} fraction={progress.fraction} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <CopyQueue copies={copies} onOpen={open} onReveal={reveal} />
      </div>
    </div>
  );
}

function upsert(list: UiCopy[], item: UiCopy): UiCopy[] {
  const i = list.findIndex((c) => c.index === item.index);
  if (i === -1) return [...list, item].sort((a, b) => a.index - b.index);
  const next = list.slice();
  next[i] = { ...next[i], ...item };
  return next;
}
```

- [ ] **Step 2: Write `src/renderer/util.ts`**

```ts
export function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}
```

- [ ] **Step 3: Write `src/renderer/util.test.ts`**

```ts
import { test, expect } from "bun:test";
import { basename } from "./util";

test("basename strips directory on both separators", () => {
  expect(basename("/a/b/copy_1.mp4")).toBe("copy_1.mp4");
  expect(basename("C:\\x\\copy_2.mp4")).toBe("copy_2.mp4");
});
```

- [ ] **Step 4: Type-check + run**

Run: `bunx tsc --noEmit && bun test src/renderer/util.test.ts`
Expected: clean + 1 pass.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/App.tsx src/renderer/util.ts src/renderer/util.test.ts
git commit -m "✨ wire app state to ipc batch events"
```

---

## Task 14: Full suite, manual end-to-end, README

**Files:** Modify `README.md`

- [ ] **Step 1: Full suite + type-check**

Run: `bun test && bunx tsc --noEmit`
Expected: all pass (Plan 1 + Plan 2 tests), tsc clean.

- [ ] **Step 2: Manual end-to-end in the real app**

Run: `bun run dev`. Then in the window:
1. Click the drop zone → pick a real video (or generate one: `bun -e 'import("./src/node/testClip.ts").then(m=>m.makeTestClip("sample.tmp.mp4"))'` and pick `sample.tmp.mp4`).
2. Set Copies = 3, preset Aggressive, format Reels.
3. Press Uniquify → choose an output folder.
4. Expected: batch progress advances with a real percentage; three cards appear with thumbnails and pass/warn badges; Open and Folder buttons work.
Clean up: `rm -f sample.tmp.mp4`.

Report what you observed (badges, whether progress was smooth). If a card shows "error", paste the error from the renderer console (`View → Toggle Developer Tools`).

- [ ] **Step 3: Update `README.md`** — append a Desktop App section after the Usage section:

```markdown
## Desktop app (Electron UI)

    bun install
    bun run dev      # launches the Electron app

Drop a video, set the number of copies, pick a preset and format, press Uniquify,
and watch the queue fill with verified-unique copies (live progress + uniqueness
badges). Build a distributable with `bun run build`.
```

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "📝 document the electron desktop app"
```

---

## Self-Review notes (addressed)

- **Spec coverage:** single-screen layout (Task 12/13), studio-dark tokens (Task 5 theme.css), thumbnail+badge cards (Task 11), real FFmpeg progress (Tasks 1-2, surfaced Tasks 11/13), Electron main/preload/renderer split (Tasks 5-7), IPC contract (Task 6), core extensions render-progress/thumbnail/pipeline-events (Tasks 2-4), error handling (Task 7 try/catch + onError; CopyCard error state Task 11), component + integration tests (Tasks 9-13), open/reveal in system (Task 7). Non-goals (parallel render, depth-3D, saved profiles, in-app player) excluded.
- **Known deviation from spec §5:** AdvancedPanel exposes only `keepTrendAudio`/`allowMirror`/`targetDistance` (what `sampler` supports), NOT per-category toggles/intensity sliders. Flagged in Task 10; richer controls need a `sampler` extension (future plan).
- **Type consistency:** `CopyOptions`/`MediaInfo`/`PresetName`/`ExportFormat` reused from `src/core/types.ts`; `UiCopy`/`Source`/`AdvancedValue`/`SettingsState` defined once and imported; `Api` shape matches between `electron/ipc.ts`, `electron/preload.ts`, and `src/renderer/api.ts`; `render` 5-arg signature consistent across `executor.ts`, `ffmpegExecutor.ts`, `pipeline.ts`.
- **Electron caveat:** `main.ts`/`preload.ts` are verified manually (Electron runtime), not via `bun test`; all pure logic (progress parser, components, pipeline events) is unit-tested.
```
