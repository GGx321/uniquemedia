import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { join } from "node:path";
import { cpus } from "node:os";
import { createBackends, type MediaRoute } from "../src/node/mediaRoute";
import {
  COVER_FILTERS,
  PICKER_FILTERS,
  pickCoverForHost,
  probeForHost,
  runBatchForHost,
  type StartRequest,
} from "./handlers";
import { CH } from "./ipc";
import { extractFramePack } from "./framePack";
import { detectMediaKind } from "../src/node/detectKind";

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

// The cover for the photo first frame: stills only, checked as it is chosen
// so a file the build cannot open is named now rather than at Run.
ipcMain.handle(CH.pickCover, async () => {
  const r = await dialog.showOpenDialog({
    properties: ["openFile"],
    filters: COVER_FILTERS,
  });
  if (r.canceled) return null;
  return pickCoverForHost(r.filePaths[0], backends, (message) => send(CH.evtError, { message }));
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

/**
 * Where frame mode reads its backgrounds. Unpackaged, the repo's own pack
 * (undefined = the default). Packaged, the pack travels inside the archive as
 * part of the renderer build and is extracted once to a real folder.
 */
async function framePackDir(): Promise<string | undefined> {
  if (!app.isPackaged) return undefined;
  return extractFramePack(
    join(app.getAppPath(), "out", "renderer", "frame-backgrounds"),
    join(app.getPath("userData"), "frame-backgrounds")
  );
}

ipcMain.handle(CH.start, async (_e, req: StartRequest) => {
  let packDir: string | undefined;
  // Only a video with the frame on needs the pack; a photo batch never waits on
  // it and cannot be stopped by it. A file the kind of which cannot be read
  // falls through: the batch reports that itself.
  const kind = req.opts.frame ? await detectMediaKind(req.input).catch(() => null) : null;
  if (kind === "video") {
    try {
      packDir = await framePackDir();
    } catch (err) {
      send(CH.evtError, { message: err instanceof Error ? err.message : String(err) });
      return;
    }
  }
  abortController = new AbortController();
  await runBatchForHost(req, {
    framePackDir: packDir,
    backends,
    send,
    signal: abortController.signal,
    nowMs: Date.now,
    concurrency: Math.max(1, cpus().length - 1), // leave one core free
    onRoute: (route) => { activeRoute = route; },
  });
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
