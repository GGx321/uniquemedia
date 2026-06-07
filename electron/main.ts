import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { join, basename } from "node:path";
import { mkdirSync } from "node:fs";
import { FfmpegExecutor } from "../src/node/ffmpegExecutor";
import { uniquify } from "../src/core/pipeline";
import { CH } from "./ipc";

const executor = new FfmpegExecutor();
let abortController: AbortController | null = null;
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
ipcMain.handle(CH.cancel, () => { abortController?.abort(); executor.cancel(); });

ipcMain.handle(CH.start, async (_e, req: { input: string; opts: Parameters<typeof uniquify>[1]; count: number; outDir: string }) => {
  abortController = new AbortController();
  const { input, opts, count, outDir } = req;
  mkdirSync(outDir, { recursive: true });
  const stem = basename(input).replace(/\.[^.]+$/, "");
  const send = (ch: string, payload: unknown) => win?.webContents.send(ch, payload);
  try {
    const results = await uniquify(input, opts, executor, count, {
      seedBase: Date.now() % 1e6,
      outputPath: (i) => join(outDir, `${stem}_${i + 1}.mp4`),
      signal: abortController.signal,
      onProgress: (index, _attempt, fraction) =>
        send(CH.evtProgress, { index, count, fraction }),
      onCopyDone: async (r) => {
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

app.whenReady().then(() => {
  createWindow();
  executor.warmup().catch(() => {});
  import("exiftool-vendored").then((m) => m.exiftool.version()).catch(() => {});
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("will-quit", async () => {
  const { exiftool } = await import("exiftool-vendored");
  await exiftool.end();
});
