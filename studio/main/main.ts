import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  MessageChannelMain,
  protocol,
  safeStorage,
  shell,
  utilityProcess,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type MessagePortMain,
  type OpenDialogOptions,
} from "electron";
import { randomUUID } from "node:crypto";
import { lstat, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { EventMessage, MediaPickKind } from "../shared/engine";
import { DEBUGGABLE, STUDIO_DEV, STUDIO_E2E } from "../engine/buildFlags";
import { CH } from "../preload/api";
import { installProcessGuards } from "../engine/processGuards";
import { e2eIdentityProblem } from "./e2eIdentity";
import { engineEnv } from "./engineEnv";
import { handleExportFolderCommand } from "./exportFolderFlow";
import { handleRevealCommand, handleRevealFolderCommand } from "./revealFlow";
import { forwardEngineOutput } from "./engineOutput";
import { EngineHost } from "./engineHost";
import { handleImportPhotoCommand } from "./importFlow";
import { MEDIA_DIALOG_FILTERS } from "./mediaFilters";
import { handleMediaPickCommand } from "./mediaImportFlow";
import { handleKeyCommand, KeyStore, SECRETS_FILE, type SafeStorageLike } from "./keyFlow";
import { handleMusicKeyCommand, musicKeyStatusOf, openMusicKeyStore } from "./musicKeyFlow";
import { createStickerLookup } from "./media/stickers";
import { handleMediaRequest, MEDIA_SCHEME, MEDIA_SCHEME_PRIVILEGES } from "./mediaProtocol";
import { HostNotices } from "./notices";
import { appMenuTemplate } from "./appMenu";
import { createQuitFlow, WINDOW_FLUSH_WAIT_MS } from "./quitFlow";
import { createWindowFlush } from "./windowFlush";
import { handleRendererRequest, isTrustedSender, type SenderFrame, type TrustedRenderer } from "./requests";
import { handleSettingsCommand, reconcileLibraryPath } from "./settingsFlow";
import { defaultLibraryPath, defaultSettings, SettingsStore } from "./settingsStore";

// An error nobody caught is logged by kind and main goes on: no dialog, and a render or the engine are not taken down with it.
installProcessGuards({ on: (event, listener) => { process.on(event, (error) => listener(error)); }, role: "main", log: console.error });

// A production build keeps no debugging door open, however it is launched:
// DevTools are off (see createWindow), --inspect is disabled by a fuse, and
// the remote debugging switches are dropped here, before Chromium reads them.
// DEBUGGABLE is a build-time constant (dev and E2E builds only, never
// shipped), so these doors do not depend on `app.isPackaged`. A launch that
// asked for one of these switches gets one clean line back, not silence and
// not a stack trace (see smoke-engine.ts's production check).
if (!DEBUGGABLE) {
  for (const name of ["remote-debugging-port", "remote-debugging-pipe", "remote-debugging-address"]) app.commandLine.removeSwitch(name);
  if (process.argv.some((arg) => arg.startsWith("--remote-debugging-"))) {
    console.warn("studio: ignoring --remote-debugging-port/--remote-debugging-pipe/--remote-debugging-address (production build)");
  }
}

// The dev server is trusted only under `electron-vite dev`: every built app
// loads its own files and never a URL taken from the environment.
const devServerUrl = STUDIO_DEV ? process.env.ELECTRON_RENDERER_URL : undefined;

// --user-data-dir wins, so the smoke test runs against a temp folder.
// Otherwise, in dev Electron runs the bare out-studio/main/main.js with no
// package name of Studio's own, so userData would default to the shared
// "Electron" folder.
const userDataSwitch = app.commandLine.getSwitchValue("user-data-dir");
if (userDataSwitch !== "") app.setPath("userData", resolve(userDataSwitch));
else if (!app.isPackaged) app.setPath("userData", join(app.getPath("appData"), STUDIO_E2E ? "uniquemedia-studio-e2e-dev" : "uniquemedia-studio-dev"));

// An E2E build packaged under Studio's own identity would share Studio's userData (settings, library, ledger): it does not start.
// Inside `if (STUDIO_E2E)` so a production bundle drops it whole: `isPackaged` decides nothing there but where unpackaged data lives.
if (STUDIO_E2E) {
  const identityProblem = e2eIdentityProblem({ e2e: true, packaged: app.isPackaged, appName: app.name });
  if (identityProblem !== null) {
    console.error(`studio: ${identityProblem}`);
    app.exit(1);
    // `app.exit` does not stop this module: without this, the code below (the single-instance lock, the window) could still run on Studio's own userData.
    process.exit(1);
  }
}

// Must run before `ready`. The CSP is never bypassed: the renderer CSP allows the scheme in img-src and media-src.
protocol.registerSchemesAsPrivileged([{ scheme: MEDIA_SCHEME, privileges: MEDIA_SCHEME_PRIVILEGES }]);

const RENDERER_FILE = join(import.meta.dirname, "../renderer/index.html");
// Inside app.asar when packaged; utilityProcess loads it from there.
const ENGINE_ENTRY = join(import.meta.dirname, "../engine/main.js");
/** In userData, next to the ledger: bodies of paid answers that could not be used, kept (redacted) as evidence. */
const RAW_DIR = "raw";
const RENDER_TMP_DIR = "render-tmp";
/** In userData: `tracks/` and `covers/` of the music store (3c). */
const MUSIC_DIR = "music";
/** In `render-tmp`: the engine's text previews (3b.4b), served by `studio-media://text/<previewId>`. */
const TEXT_PREVIEW_DIR = "text";
/** The built-in stickers: inside app.asar when packaged, next to `out-studio/` in the repo. */
const STICKER_DIR = join(import.meta.dirname, "../../studio/assets/stickers");
const TRUSTED: TrustedRenderer = { devServerUrl, fileUrl: pathToFileURL(RENDERER_FILE).href };

function isDevServer(url: string): boolean {
  return devServerUrl !== undefined && new URL(url).origin === new URL(devServerUrl).origin;
}

/** Whether the quit is agreed (quitFlow.ts's `isQuitting`); set once the quit flow exists. */
let quitAgreed: () => boolean = () => false;

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
  // A page holds a close with beforeunload while it saves (the montage editor); during an agreed quit it may not.
  win.webContents.on("will-prevent-unload", (event) => {
    if (quitAgreed()) event.preventDefault();
  });
  win.webContents.on("will-navigate", (event) => {
    if (!isDevServer(event.url)) event.preventDefault();
  });
  if (devServerUrl) win.loadURL(devServerUrl);
  else win.loadFile(RENDERER_FILE);
}

function senderFrameOf(event: IpcMainInvokeEvent | IpcMainEvent): SenderFrame {
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

/** A mock flashapi for end-to-end tests: read only in an E2E build, and honoured only by an E2E engine (a loopback base only). */
function flashapiBaseUrlForTests(): string | undefined {
  if (!STUDIO_E2E) return undefined;
  const url = app.commandLine.getSwitchValue("studio-flashapi-base-url");
  return url === "" ? undefined : url;
}

/** A mock CDN for end-to-end tests (3c.4): read only in an E2E build, and honoured only by an E2E engine (a loopback plain-http base only). */
function musicCdnBaseUrlForTests(): string | undefined {
  if (!STUDIO_E2E) return undefined;
  const url = app.commandLine.getSwitchValue("studio-music-cdn-base-url");
  return url === "" ? undefined : url;
}

/**
 * The folder main's dialog answers with, for the smoke test, which cannot
 * click a native dialog. Read only by an E2E build: every other build has it
 * compiled out and always shows the dialog.
 */
function pickedFolderForTests(): string | undefined {
  if (!STUDIO_E2E) return undefined;
  const path = app.commandLine.getSwitchValue("studio-pick-folder");
  return path === "" ? undefined : path;
}

async function pickFolder(owner: BrowserWindow | null, defaultPath: string): Promise<string | null> {
  const forTests = pickedFolderForTests();
  if (forTests !== undefined) return forTests;
  const options: OpenDialogOptions = { defaultPath, properties: ["openDirectory", "createDirectory"] };
  const result = owner === null ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(owner, options);
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

/**
 * The file main's import dialog answers with, for the smoke test, which
 * cannot click a native dialog. Read only by an E2E build: every other build
 * has it compiled out and always shows the dialog (T6c).
 */
function pickedImportFileForTests(): string | undefined {
  if (!STUDIO_E2E) return undefined;
  const path = app.commandLine.getSwitchValue("studio-pick-import-file");
  return path === "" ? undefined : path;
}

/** T6c: the owner's own open-file dialog for importing an existing avatar's photo; never handed a path by the renderer. */
async function pickImportFile(owner: BrowserWindow | null): Promise<string | null> {
  const forTests = pickedImportFileForTests();
  if (forTests !== undefined) return forTests;
  const options: OpenDialogOptions = { properties: ["openFile"], filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }] };
  const result = owner === null ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(owner, options);
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

/**
 * The file main's own-media dialog answers with, for the smoke test, which cannot click a native dialog (3f.1). Read only by an E2E
 * build: every other build has it compiled out and always shows the dialog.
 */
function pickedMediaForTests(): string[] | undefined {
  if (!STUDIO_E2E) return undefined;
  const path = app.commandLine.getSwitchValue("studio-pick-media");
  return path === "" ? undefined : [path];
}

/** 3f.1: the owner's own open-file dialog for own media, with the kind's filters; several files. Never handed a path by the renderer. */
async function pickMediaFiles(owner: BrowserWindow | null, kind: MediaPickKind): Promise<string[] | null> {
  const forTests = pickedMediaForTests();
  if (forTests !== undefined) return forTests;
  const options: OpenDialogOptions = { properties: ["openFile", "multiSelections"], filters: MEDIA_DIALOG_FILTERS[kind].map((f) => ({ name: f.name, extensions: [...f.extensions] })) };
  const result = owner === null ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(owner, options);
  return result.canceled ? null : result.filePaths;
}

async function startStudio(): Promise<void> {
  const userData = app.getPath("userData");
  const { store: settings, notice } = await SettingsStore.open(userData);
  if (notice !== null) console.warn(`studio: ${notice}`);
  const keys = await KeyStore.open(safeStorageAdapter, join(userData, SECRETS_FILE));
  // The RapidAPI key: the same store class over its own file (S20). It reaches the engine only over its MessagePort.
  const musicKeys = await openMusicKeyStore(safeStorageAdapter, userData);

  // Main's notices travel in every engine init (see HostNotices), never as events of main's own.
  const notices = new HostNotices({ newId: randomUUID, clock: Date.now });
  if (notice !== null) notices.add("settings-reset", notice);

  const engine = new EngineHost<MessagePortMain>({
    fork: () => {
      // Piped, not inherited, and relayed to main's own output: an inherited stream does not reach the launcher on
      // Windows (engineOutput.ts), and the packaged smoke reads what the engine prints from main's output.
      const child = utilityProcess.fork(ENGINE_ENTRY, [], {
        env: engineEnv(process.env),
        serviceName: "studio-engine",
        stdio: "pipe",
      });
      forwardEngineOutput(child, process.stdout, process.stderr);
      return child;
    },
    channel: () => {
      const { port1, port2 } = new MessageChannelMain();
      return { local: port1, remote: port2 };
    },
    // Built on every (re)start, so a restarted engine gets the current settings.
    init: async () => ({
      kind: "control",
      type: "init",
      ledgerPath: join(userData, "ledger.jsonl"),
      defaultLibraryPath: defaultLibraryPath(userData),
      defaultExportPath: defaultSettings(userData).exportPath,
      rawDir: join(userData, RAW_DIR),
      renderTmpDir: join(userData, RENDER_TMP_DIR),
      // The built-in stickers (inside app.asar when packaged): a render reads each from here, checked against the catalogue (3b.6).
      stickerDir: STICKER_DIR,
      // The same allowlist the engine process itself was forked with (S4): the engine never reads its environment.
      ffmpegEnv: engineEnv(process.env),
      settings: settings.current,
      encryptionAvailable: keys.status().encryptionAvailable,
      openRouterBaseUrl: openRouterBaseUrlForTests(),
      // The flashapi quota log (3c.3) and the track store's lists, tracks, covers and waveforms (3c.4) live here.
      musicDir: join(userData, "music"),
      musicBaseUrl: flashapiBaseUrlForTests(),
      musicCdnBaseUrl: musicCdnBaseUrlForTests(),
      notices: [...notices.all],
    }),
    apiKey: () => keys.read(),
    musicKey: () => musicKeys.read(),
    onEvent: (event) => {
      broadcast(event);
      // The engine is the source of truth about the live library: a confirm
      // main gave up on (engineHost.ts's 30 s deadline) can still land after
      // that, and settings.json must not keep naming the old folder then.
      if (event.type === "settings.changed") void reconcileLibraryPath(event.payload.settings, { settings, engine, newId: randomUUID });
    },
    // The restarted engine gets the notice in its init. A final exit has no
    // next engine to carry one, so EngineHost announces it itself instead
    // (M5): every open window is pushed an `onEvent(goneEvent(...))`, and
    // every request from then on answers ENGINE_GONE_DETAIL, not a bare
    // "the engine is not running".
    onExit: (error, restarting) => {
      if (restarting) notices.add("engine-restarted", error.detail);
    },
  });
  // Quitting: the engine is first asked to cancel its renders and to let a commit that is past its claim finish (bounded
  // by `SHUTDOWN_WAIT_MS`), so no orphaned ffmpeg keeps writing into the export folder and no half-saved video is left for
  // the next start to settle (quitFlow.ts): `before-quit` is held for the whole wait, however often it is pressed, and the
  // engine's process is stopped only in `will-quit`, when the quit really goes on.
  // Before that, each window saves what its owner is editing (the montage editor's autosave waits for a quiet spell):
  // main asks, the preload answers `{id, ok}` once the window's save landed, and the wait is bounded. A window that
  // could not save cancels the quit before the engine is touched; its «Выйти без сохранения» quits skipping the ask.
  const windowFlush = createWindowFlush({
    targets: () =>
      BrowserWindow.getAllWindows().map((win) => ({
        send: (id: string) => win.webContents.send(CH.flushRequest, id),
        isGone: () => win.isDestroyed() || win.webContents.isDestroyed() || win.webContents.isCrashed(),
      })),
    newId: randomUUID,
    timeoutMs: WINDOW_FLUSH_WAIT_MS,
  });
  ipcMain.on(CH.flushDone, (event, answer: unknown) => {
    if (isTrustedSender(senderFrameOf(event), TRUSTED)) windowFlush.acknowledge(answer);
  });
  const quitFlow = createQuitFlow({
    flushWindows: () => windowFlush.request(),
    shutdown: () => engine.shutdown(),
    quit: () => app.quit(),
    stop: () => engine.stop(),
  });
  ipcMain.on(CH.quitWithoutSaving, (event) => {
    if (isTrustedSender(senderFrameOf(event), TRUSTED)) quitFlow.quitWithoutSaving();
  });
  // Once the quit is agreed and the engine shut down, a page's beforeunload (an edit made meanwhile) may not cancel it.
  quitAgreed = () => quitFlow.isQuitting();
  app.on("before-quit", (event) => quitFlow.beforeQuit(event));
  app.on("will-quit", () => quitFlow.willQuit());

  // Invariant 28: every route is built from ids under a root of its own. The built-in stickers sit in the asar (or the
  // repo) at the same place relative to this bundle: out-studio/main/main.js -> ../../studio/assets/stickers.
  const mediaDeps = {
    libraryRoot: () => settings.current.libraryPath,
    exportRoot: () => settings.current.exportPath,
    musicRoot: () => join(userData, MUSIC_DIR),
    textPreviewRoot: () => join(userData, RENDER_TMP_DIR, TEXT_PREVIEW_DIR),
    sticker: createStickerLookup(STICKER_DIR),
  };
  protocol.handle(MEDIA_SCHEME, (request) => handleMediaRequest(request, mediaDeps));

  ipcMain.handle(CH.request, (event, raw: unknown) =>
    handleRendererRequest(raw, senderFrameOf(event), TRUSTED, {
      mainOnly: (command) => handleKeyCommand(command, { keys, engine }),
      musicKey: (command) => handleMusicKeyCommand(command, { keys: musicKeys, engine }),
      settings: (command) =>
        handleSettingsCommand(command, {
          settings,
          engine,
          pickFolder: (defaultPath) => pickFolder(BrowserWindow.fromWebContents(event.sender), defaultPath),
          keyStatus: () => keys.status(),
          musicKeyStatus: () => musicKeyStatusOf(musicKeys.status()),
          newId: randomUUID,
        }),
      importPhoto: (command) =>
        handleImportPhotoCommand(command, {
          pickImportFile: () => pickImportFile(BrowserWindow.fromWebContents(event.sender)),
          engine: { stageImportPhoto: (bytes) => engine.stageImportPhoto(bytes) },
        }),
      mediaImport: (command) => {
        // The window that asked closing stops the copy in flight and the rest of its pick.
        const closed = new AbortController();
        const onClosed = (): void => closed.abort();
        event.sender.once("destroyed", onClosed);
        return handleMediaPickCommand(command, {
          pickFiles: (kind) => pickMediaFiles(BrowserWindow.fromWebContents(event.sender), kind),
          engine: { importMedia: (file, signal) => engine.importMedia(file, signal) },
          platform: process.platform,
          signal: closed.signal,
        }).finally(() => event.sender.removeListener("destroyed", onClosed));
      },
      exportFolder: (command) =>
        handleExportFolderCommand(command, {
          settings,
          engine,
          pickFolder: (defaultPath) => pickFolder(BrowserWindow.fromWebContents(event.sender), defaultPath),
          keyStatus: () => keys.status(),
          musicKeyStatus: () => musicKeyStatusOf(musicKeys.status()),
          newId: randomUUID,
          home: () => app.getPath("home"),
          platform: process.platform,
        }),
      reveal: (command) =>
        handleRevealCommand(command, {
          engine,
          exportPath: () => settings.current.exportPath,
          show: (path) => shell.showItemInFolder(path),
          newId: randomUUID,
          platform: process.platform,
        }),
      revealFolder: (command) =>
        handleRevealFolderCommand(command, {
          engine,
          exportPath: () => settings.current.exportPath,
          openFolder: (path) => shell.openPath(path),
          // A link is not followed: only a real folder inside the export folder is opened. The export folder itself may be a
          // link to a folder (the engine's export check follows it): it is looked at through the link.
          isFolder: (path, how) => (how?.followLink === true ? stat(path) : lstat(path)).then(
            (info) => info.isDirectory(),
            () => false,
          ),
          newId: randomUUID,
          platform: process.platform,
        }),
      engine: (command) => engine.request(command),
    }),
  );
  // Compiled in rather than app.getVersion(): in dev there is no package.json of
  // Studio's own, and the root package.json version belongs to the uniquifier.
  ipcMain.handle(CH.version, (event) => {
    if (!isTrustedSender(senderFrameOf(event), TRUSTED)) throw new Error("studio:version from an untrusted frame");
    return __APP_VERSION__;
  });

  await engine.start();
  // The built app has no Reload (appMenu.ts): a page holding a close while it saves cannot tell a reload from it.
  if (!STUDIO_DEV) {
    const template = appMenuTemplate(process.platform);
    Menu.setApplicationMenu(template === null ? null : Menu.buildFromTemplate(template));
  }
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
