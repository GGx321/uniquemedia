import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  MessageChannelMain,
  protocol,
  safeStorage,
  utilityProcess,
  type IpcMainInvokeEvent,
  type MessagePortMain,
  type OpenDialogOptions,
} from "electron";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { EventMessage } from "../shared/engine";
import { STUDIO_E2E } from "../engine/buildFlags";
import { CH } from "../preload/api";
import { engineEnv } from "./engineEnv";
import { EngineHost } from "./engineHost";
import { handleKeyCommand, KeyStore, SECRETS_FILE, type SafeStorageLike } from "./keyFlow";
import { handleMediaRequest, MEDIA_SCHEME } from "./mediaProtocol";
import { HostNotices } from "./notices";
import { handleRendererRequest, isTrustedSender, type SenderFrame, type TrustedRenderer } from "./requests";
import { handleSettingsCommand } from "./settingsFlow";
import { SettingsStore } from "./settingsStore";

// A packaged production build keeps no debugging door open: DevTools are off
// (see createWindow), --inspect is disabled by a fuse, and the remote
// debugging switches are dropped here, before Chromium reads them. An E2E
// build (STUDIO_E2E=1, never shipped) keeps them for the smoke test.
const DEBUGGABLE = !app.isPackaged || STUDIO_E2E;
if (!DEBUGGABLE) {
  for (const name of ["remote-debugging-port", "remote-debugging-pipe", "remote-debugging-address"]) app.commandLine.removeSwitch(name);
}

// The dev server is trusted only in an unpackaged run: a packaged app never
// loads a URL taken from the environment.
const devServerUrl = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL;

// --user-data-dir wins, so the smoke test runs against a temp folder.
// Otherwise, in dev Electron runs the bare out-studio/main/main.js with no
// package name of Studio's own, so userData would default to the shared
// "Electron" folder.
const userDataSwitch = app.commandLine.getSwitchValue("user-data-dir");
if (userDataSwitch !== "") app.setPath("userData", resolve(userDataSwitch));
else if (!app.isPackaged) app.setPath("userData", join(app.getPath("appData"), "uniquemedia-studio-dev"));

// Must run before `ready`. No bypassCSP: the renderer CSP allows the scheme in img-src.
protocol.registerSchemesAsPrivileged([
  { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

const RENDERER_FILE = join(import.meta.dirname, "../renderer/index.html");
// Inside app.asar when packaged; utilityProcess loads it from there.
const ENGINE_ENTRY = join(import.meta.dirname, "../engine/main.js");
const TRUSTED: TrustedRenderer = { devServerUrl, fileUrl: pathToFileURL(RENDERER_FILE).href };

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
      devTools: DEBUGGABLE,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => {
    if (!isDevServer(event.url)) event.preventDefault();
  });
  if (devServerUrl) win.loadURL(devServerUrl);
  else win.loadFile(RENDERER_FILE);
}

function senderFrameOf(event: IpcMainInvokeEvent): SenderFrame {
  const frame = event.senderFrame;
  const top = event.sender.mainFrame;
  return {
    url: frame?.url ?? null,
    isTopFrame: frame !== null && frame.parent === null,
    isAppWindow:
      frame !== null &&
      BrowserWindow.fromWebContents(event.sender) !== null &&
      frame.processId === top.processId &&
      frame.routingId === top.routingId,
  };
}

function broadcast(event: EventMessage): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(CH.event, event);
}

/** Electron's safeStorage; Linux's plain-text fallback does not count as encryption. */
const safeStorageAdapter: SafeStorageLike = {
  isEncryptionAvailable: () =>
    safeStorage.isEncryptionAvailable() &&
    !(process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text"),
  encryptString: (plainText) => safeStorage.encryptString(plainText),
  decryptString: (encrypted) => safeStorage.decryptString(encrypted),
};

/** A mock OpenRouter for end-to-end tests: read only in an E2E build, and honoured only by an E2E engine (invariant 13). */
function openRouterBaseUrlForTests(): string | undefined {
  if (!STUDIO_E2E) return undefined;
  const url = app.commandLine.getSwitchValue("studio-openrouter-base-url");
  return url === "" ? undefined : url;
}

async function pickFolder(owner: BrowserWindow | null, defaultPath: string): Promise<string | null> {
  const options: OpenDialogOptions = { defaultPath, properties: ["openDirectory", "createDirectory"] };
  const result = owner === null ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(owner, options);
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

async function startStudio(): Promise<void> {
  const userData = app.getPath("userData");
  const { store: settings, notice } = await SettingsStore.open(userData);
  if (notice !== null) console.warn(`studio: ${notice}`);
  const keys = await KeyStore.open(safeStorageAdapter, join(userData, SECRETS_FILE));

  const engine = new EngineHost<MessagePortMain>({
    fork: () =>
      utilityProcess.fork(ENGINE_ENTRY, [], {
        env: engineEnv(process.env),
        serviceName: "studio-engine",
      }),
    channel: () => {
      const { port1, port2 } = new MessageChannelMain();
      return { local: port1, remote: port2 };
    },
    // Built on every (re)start, so a restarted engine gets the current settings.
    init: async () => ({
      kind: "control",
      type: "init",
      ledgerPath: join(userData, "ledger.jsonl"),
      settings: settings.current,
      encryptionAvailable: keys.status().encryptionAvailable,
      openRouterBaseUrl: openRouterBaseUrlForTests(),
    }),
    apiKey: () => keys.read(),
    onEvent: broadcast,
    // A final exit is not announced: every request then answers "the engine is not running".
    onExit: (error, restarting) => {
      if (restarting) notices.restarted(error);
    },
  });
  // Main's notices travel as engine events (see HostNotices), never as events of main's own.
  const notices = new HostNotices((control) => engine.send(control));
  if (notice !== null) notices.hold({ code: "INTERNAL", detail: notice });
  app.on("will-quit", () => engine.stop());

  protocol.handle(MEDIA_SCHEME, (request) => handleMediaRequest(request, { libraryRoot: () => settings.current.libraryPath }));

  ipcMain.handle(CH.request, async (event, raw: unknown) => {
    const response = await handleRendererRequest(raw, senderFrameOf(event), TRUSTED, {
      mainOnly: (command) => handleKeyCommand(command, { keys, engine }),
      settings: (command) =>
        handleSettingsCommand(command, {
          settings,
          engine,
          pickFolder: (defaultPath) => pickFolder(BrowserWindow.fromWebContents(event.sender), defaultPath),
          keyStatus: () => keys.status(),
          newId: randomUUID,
        }),
      engine: (command) => engine.request(command),
    });
    notices.seen(response);
    return response;
  });
  // Compiled in rather than app.getVersion(): in dev there is no package.json of
  // Studio's own, and the root package.json version belongs to the uniquifier.
  ipcMain.handle(CH.version, (event) => {
    if (!isTrustedSender(senderFrameOf(event), TRUSTED)) throw new Error("studio:version from an untrusted frame");
    return __APP_VERSION__;
  });

  await engine.start();
  createWindow();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win === undefined) {
      createWindow();
      return;
    }
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app
    .whenReady()
    .then(startStudio)
    .then(() => {
      // macOS: closing the last window keeps the app and the engine running; the
      // dock icon reopens a window, which restores itself from engine.snapshot.
      app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
      });
    })
    .catch((error: unknown) => {
      console.error(`studio: failed to start (${error instanceof Error ? error.message : String(error)})`);
      app.quit();
    });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
