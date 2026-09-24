import { app, BrowserWindow, ipcMain } from "electron";
import { join } from "node:path";
import { CH } from "../shared/ipc";

// The dev server is trusted only in an unpackaged run: a packaged app never
// loads a URL taken from the environment.
const devServerUrl = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL;

// In dev Electron runs the bare out-studio/main/main.js with no package name
// of Studio's own, so userData would default to the shared "Electron" folder.
if (!app.isPackaged) app.setPath("userData", join(app.getPath("appData"), "uniquemedia-studio-dev"));

function isDevServer(url: string): boolean {
  return devServerUrl !== undefined && new URL(url).origin === new URL(devServerUrl).origin;
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1200,
    minHeight: 760,
    backgroundColor: "#09090c",
    title: "Studio",
    webPreferences: {
      // Sandboxed preloads must be CommonJS, hence the .cjs build.
      preload: join(import.meta.dirname, "../preload/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => {
    if (!isDevServer(event.url)) event.preventDefault();
  });
  if (devServerUrl) win.loadURL(devServerUrl);
  else win.loadFile(join(import.meta.dirname, "../renderer/index.html"));
}

// Compiled in rather than app.getVersion(): in dev there is no package.json of
// Studio's own, and the root package.json version belongs to the uniquifier.
ipcMain.handle(CH.version, () => __APP_VERSION__);

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
