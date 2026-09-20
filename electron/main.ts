import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { join, basename } from "node:path";
import { mkdirSync } from "node:fs";
import { cpus } from "node:os";
import {
  createBackends,
  outputName,
  routeForInput,
  uniquifyRoute,
  type MediaRoute,
} from "../src/node/mediaRoute";
import type { StartOptions } from "../src/core/types";
import { PICKER_FILTERS, probeForHost } from "./handlers";
import { CH } from "./ipc";

const backends = createBackends();
let abortController: AbortController | null = null;
// The route of the batch currently in flight, so Stop kills the executor that
// is actually running rather than both of them.
let activeRoute: MediaRoute | null = null;
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
      // ESM preload (.mjs) only runs in a non-sandboxed renderer; contextIsolation
      // still isolates the bridge, so window.api stays the only exposed surface.
      sandbox: false,
    },
  });
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else win.loadFile(join(import.meta.dirname, "../renderer/index.html"));
}

const send = (ch: string, payload: unknown) => win?.webContents.send(ch, payload);

ipcMain.handle(CH.pickFile, async () => {
  const r = await dialog.showOpenDialog({
    properties: ["openFile"],
    filters: PICKER_FILTERS,
  });
  return r.canceled ? null : r.filePaths[0];
});

// Symmetric with CH.start: a failure here is reported to the renderer, not
// thrown across the IPC boundary where Electron would wrap the message.
ipcMain.handle(CH.probe, (_e, path: string) =>
  probeForHost(path, backends, (message) => send(CH.evtError, { message }))
);

ipcMain.handle(CH.chooseOutDir, async () => {
  const r = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle(CH.openFile, (_e, path: string) => shell.openPath(path));
ipcMain.handle(CH.reveal, (_e, path: string) => shell.showItemInFolder(path));
ipcMain.handle(CH.cancel, () => { abortController?.abort(); activeRoute?.executor.cancel(); });

ipcMain.handle(CH.start, async (_e, req: { input: string; opts: StartOptions; count: number; outDir: string }) => {
  abortController = new AbortController();
  const { input, opts, count, outDir } = req;
  mkdirSync(outDir, { recursive: true });
  const stem = basename(input).replace(/\.[^.]+$/, "");
  try {
    // The kind is decided from the file's own bytes, not from whatever the
    // renderer believed when it probed.
    const route = await routeForInput(input, backends);
    activeRoute = route;
    const results = await uniquifyRoute(route, input, opts, count, {
      seedBase: Date.now() % 1e6,
      // The clock the spoofed capture dates are measured back from. Omitting it
      // is what dated every GUI copy to 1969; the CLI passed it from day one.
      nowMs: Date.now(),
      concurrency: Math.max(1, cpus().length - 1), // leave one core free
      outputPath: (i) => join(outDir, outputName(stem, i, route)),
      signal: abortController.signal,
      onProgress: (index, _attempt, fraction) =>
        send(CH.evtProgress, { index, count, fraction }),
      onCopyDone: async (r) => {
        const thumb = await route.executor.extractThumbnail(r.outputPath).catch(() => "");
        send(CH.evtCopyDone, {
          index: r.index, path: r.outputPath, thumb, verify: r.verify,
        });
      },
    });
    const passed = results.filter((r) => r.verify.passed).length;
    send(CH.evtBatchDone, { passed, total: count });
  } catch (err) {
    send(CH.evtError, { message: err instanceof Error ? err.message : String(err) });
  } finally {
    activeRoute = null;
  }
});

app.whenReady().then(() => {
  createWindow();
  // Both backends spawn the same two static binaries; warming them here is what
  // keeps Gatekeeper's first-launch check off the user's first Run.
  backends.video.warmup().catch(() => {});
  backends.photo.warmup().catch(() => {});
  import("exiftool-vendored").then((m) => m.exiftool.version()).catch(() => {});
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("will-quit", async () => {
  const { exiftool } = await import("exiftool-vendored");
  await exiftool.end();
});
