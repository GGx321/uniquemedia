#!/usr/bin/env bun
/**
 * Packaged-engine smoke test for Studio (task T1).
 *
 * Full run (an E2E build, unpackaged or packaged): launches the app with a
 * temp userData and the DevTools protocol, and checks from inside the page:
 *
 * - the engine utilityProcess starts and answers engine.snapshot and money.status
 *   (money over a prepared userData/ledger.jsonl);
 * - studio-media:// answers 404 for a malformed and an unknown id and 200 (image
 *   MIME, nosniff) for a real photo in a temp library;
 * - the widened routes (3b.1): a committed video (moov at the end) loads and seeks through Range (a 206 with a
 *   Content-Range), a video with no record is a 404, and the poster and a built-in sticker (from the asar when
 *   packaged) load;
 * - main refuses a command that breaks the contract;
 * - the page's own origin (the 3f.6 security review, `checkRendererOrigin`): the window's page is studio-app://renderer/index.html,
 *   its own scripts, styles and fonts and the bridge work, and from inside it a system file (/etc/hosts, C:\Windows\win.ini) and a
 *   photo outside the library are refused by their `file:` URLs (fetch, XHR, `<img>`), a traversal through the app's scheme is a 404,
 *   and an injected `<iframe>` of a local HTML file or of the app's own page never runs, so its request never reaches main;
 * - the `videos.*` commands are wired in the engine: refusals only (an empty list, NOT_FOUND, the N9 "not yet
 *   supported" answer), nothing rendered or written (the real renders are the render scenario below);
 * - settings.setApiKey stores only ciphertext and hands the key to the engine;
 * - settings.setBudget is persisted by main and reaches the engine;
 * - the live library's folder picked again with another letter case (main's
 *   dialog answers from --studio-pick-folder) is the folder in use: no second
 *   survey — the one check of Electron's native realpath;
 * - the engine's environment has no OPENROUTER_* although the app's has one;
 * - a killed engine is restarted once, comes back with a new bootId and gets
 *   the key and the settings again;
 * - the crash is reported as an engine.notice of the restarted engine (its own
 *   bootId, no flood of events: the snapshot-loop regression), not as an error;
 * - a second instance exits and focuses the first; with the window closed the
 *   engine keeps running, and a reopened window restores from its snapshot,
 *   which still carries the crash notice;
 * - a corrupt settings.json is moved aside and reported as a pending notice in
 *   the snapshot; after an app restart the key is decrypted and sent again;
 *   clearApiKey removes it;
 * - packaged: the engine entry lives inside app.asar, not unpacked; the fuses are set;
 * - the render scenario (plan 3a.9 and 3e.1, `runPackagedRenderScenario`): seven real renders by `videos.render {spec}` with no
 *   window work (five pairwise 4 s specs, a mixed 15 s timeline and a layered 15 s one with a real caption and a built-in sticker, renderSmokeSpecs.ts) into a test export root, each file
 *   checked by the engine's verifier again, by ffprobe and by a box reader (invariants 14 and 20); the engine killed ALONE (Windows
 *   without /T) in the middle of a render (nothing is left: no file, record or used mark) and, through the E2E-only commit hold
 *   (studio/engine/videos/e2eCommitHold.ts), between the rename and the record (the restart adopts the video with its record and
 *   used mark); a render with the export root removed refused as EXPORT_UNAVAILABLE before a job starts; a committed video played
 *   and seeked through studio-media://video with Range, and a missing or elsewhere record answering 404. It prints `FACT` lines
 *   (the box tree, metadata, time and memory per render) that the plan's 3a.9 notes are written from. `--only render` runs it alone.
 * - the own-media scenario (plan 3f.1b, `runPackagedMediaScenario`): `media.pickImport` through main's E2E dialog stand-in
 *   (`--studio-pick-media`, one path whose file is rewritten between picks) with one tiny file per kind picked as `any` (the kind
 *   comes from the bytes): a PNG is imported by a JOB (the copy, the E2E build's stand-in importer, the record) and stored with its
 *   record, listed, kept across an app restart, and deleted; a track is refused `not-yet-supported` (no importer
 *   yet), a bare video header is accepted into a job that fails `format` (3f.3a), a text file is refused `format`, a HEIC picture
 *   `heic`; what a crash left in `media/` and its `.staging` is removed at the library's opening; the window cannot name a path.
 *   Last, a real HEVC HLG, variable-rate, turned clip (3f.3a) is imported through the packaged ffmpeg of the operating system and
 *   must come out as a 96 x 192 constant-rate SDR H.264 record. `--only media` runs it alone.
 * - the own-sticker scenario (plan 3f.5, `runPackagedStickerScenario`): a GIF of three frames is imported by a job in the packaged engine
 *   (the bounded GIF reader, the packaged ffmpeg's decodes, the encode worker thread inside app.asar) and stored as an APNG with its
 *   record (canvas, a 9 frame loop, 3 slots a frame); `media.stickerBytes` answers the stored file itself through the real main, refuses a
 *   file changed since the import, and the built-in `stickers.bytes` never serves it; a one-frame GIF fails `not-animated`, a truncated
 *   one `format`; deleting the media ends the door. `--only sticker` runs it alone.
 * - the custom-category scenario (CS.2, `runCategoryScenario`): `categories.create` makes the owner's own category with one paid pool call against the
 *   mock, a run of 5 photos names it (every photo carries the category and the owner's name, the writer is told the English label, the plan keeps a
 *   snapshot), and neither the avatar's marker vibe nor the category's name reaches the pool call. `--only category` runs it alone.
 *
 * Every debug door (remote debugging, DevTools, the test switches) is a
 * build-time constant: a `build:studio` output has none, however it is
 * launched — also unpackaged. So the full run needs an E2E build
 * (STUDIO_E2E=1: DevTools and the test switches kept, never shipped).
 * --production checks a production build instead: its bundles (main, preload
 * and renderer, every debug door compiled out, see bundleChecks.ts), and with
 * --app the real package: its fuses (`file:` pages get no extra privileges among them), its page's CSP and main loading that page
 * from studio-app://, never file:, that it launches its engine with remote
 * debugging refused, and that the refusal is a clean one-line message, not a
 * stack trace.
 *
 * Usage (macOS; on Windows point --app at release-studio/win-unpacked or its
 * Studio.exe, and release-studio/e2e/win-unpacked (its Studio E2E.exe) for an E2E package):
 *   bun run build:studio:e2e && bun studio/scripts/smoke-engine.ts
 *   bun run dist:studio:mac:e2e && bun studio/scripts/smoke-engine.ts --app "release-studio/e2e/mac-arm64/Studio E2E.app"
 *   bun run build:studio && bun studio/scripts/smoke-engine.ts --production
 *   bun run dist:studio:mac && bun studio/scripts/smoke-engine.ts --production --app release-studio/mac-arm64/Studio.app
 *
 * The app window shows for a few seconds. On macOS --use-mock-keychain keeps
 * safeStorage off the real Keychain (checked on Electron 43: no Keychain item
 * is created); Windows' DPAPI needs no such flag. The environment check reads
 * process environments with `ps -E` and runs on macOS only.
 * No request leaves the machine: the smoke never asks for a reconcile or any
 * other OpenRouter call, and the only key used is a fake one.
 */
import { extractFile, listPackage } from "@electron/asar";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, normalize, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { FACE_MODELS } from "../engine/face/modelSource";
import { openLibrary } from "../engine/library";
import { SAMPLE_AVATAR, SAMPLE_SOURCE, samplePhotoMeta } from "../engine/library/testing/sampleData";
import { sceneSpec, videoRecordJson } from "../engine/library/testing/videoRecords";
import { probeVideo } from "../engine/render/ffmpeg.testkit";
import { FIXTURES } from "../engine/media/video/testing/fixtures/index";
import { jpegMetadataMarkers, MEDIA_SMOKE_CLIP, MEDIA_SMOKE_FILES, MEDIA_SMOKE_STORED, MEDIA_SMOKE_TRACK, mediaRecordFileProblems, STICKER_SMOKE_FILES, STICKER_SMOKE_STORED } from "./mediaSmoke";
import { inspectApng } from "../shared/stickers/apng";
import { PEAK_RSS_BYTES } from "../engine/renderQueue/pool";
import { verifyRenderedMp4 } from "../engine/verify";
import { commitHoldPaths } from "../engine/videos/e2eCommitHold";
import { EXPORT_MARKER_FILE } from "../engine/exportRoot";
import { videoPaths } from "../engine/videos/record";
import { Ledger } from "../engine/money/ledger";
import { timeoutSignal } from "../engine/money/timeoutSignal";
import { RunEventSchema, type RunEvent } from "../engine/runs/journal";
import { defaultSettings, saveSettings } from "../main/settingsStore";
import { APP_PAGE_URL, APP_SCHEME, isAppPage } from "../main/appProtocol";
import { PROTOCOL_VERSION } from "../shared/engine";
import { ffmpegPath } from "../node/ffmpegBinary";
import { musicLists } from "../engine/music/fixtures";
import { parseFlashapiList } from "../engine/music/listSchema";
import { EXCERPTS, excerptOf } from "../engine/music/testing/storeKit";
import { startMockCdn, withExcerptDurations, withFutureExpiry } from "./mockCdn";
import { startMockFlashapi } from "./mockFlashapi";
import { faceWorkerProblems, photoDecodeWorkerProblems, productionBundleProblems, productionEngineBundleProblems, productionMainProblems, productionMoneyTimingProblems, productionRendererCssProblems, productionRendererPageProblems, stickerEncodeWorkerProblems, textWorkerProblems } from "./bundleChecks";
import { authorizationLabel, DEFAULT_IMPORT_DESCRIBE_ANSWER, markerMatch, requestCarries, startMockOpenRouter, type MockRequest } from "./mockOpenRouter";
import { electronBinary } from "./electronBinary";
import { failureDetail } from "./failureDetail";
import { textAssetPackageProblems, textRasteriserOutputProblems } from "./textSmoke";
import { looksLikeAStackTrace } from "./stackTrace";
import { boxTree, formatBoxTree, mp4Facts } from "./mp4Facts";
import { requireSamples, startFfmpegSampler } from "./processSampler";
import { renderedFileProblems } from "./renderSmokeChecks";
import { LAYERED_SPEC, MIXED_SPEC, PAIRWISE_SPECS, SMOKE_PHOTOS_NEEDED, smokeSpec, type SmokeSpecPlan } from "./renderSmokeSpecs";

const ROOT = resolve(import.meta.dirname, "../..");
const SMOKE_KEY = "sk-or-v1-smoke-test-not-real-7q3z";
const ENV_CANARY = "sk-or-v1-env-canary-must-not-reach-the-engine";
const PNG = Uint8Array.from(
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"),
);

// ---------- args ----------

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

const appArg = argValue("--app");
const keep = process.argv.includes("--keep");
const production = process.argv.includes("--production");

interface Target {
  label: string;
  executable: string;
  args: string[];
  /** What `@electron/fuses read --app` takes: the .app bundle on macOS, Studio.exe on Windows. */
  app: string | null;
  asar: string | null;
}

async function resolveTarget(): Promise<Target> {
  if (appArg === undefined) {
    const main = join(ROOT, "out-studio/main/main.js");
    const build = production ? "build:studio" : "build:studio:e2e";
    if (!existsSync(main)) throw new Error(`out-studio/main/main.js is missing: run \`bun run ${build}\` first`);
    // The E2E build is the one whose main reads the test switches; a production one has no debug door to drive.
    if (!production && !(await readFile(main, "utf8")).includes("studio-pick-folder")) {
      throw new Error("out-studio holds a production build, which the smoke cannot drive: run `bun run build:studio:e2e` first");
    }
    return { label: production ? "production build (out-studio)" : "E2E build (out-studio)", executable: await electronBinary(), args: [main], app: null, asar: null };
  }
  const app = resolve(appArg);
  if (process.platform === "win32") {
    // The E2E package has its own name (`Studio E2E.exe`, see dist:studio:win:e2e), the production one `Studio.exe`.
    const exe = app.toLowerCase().endsWith(".exe") ? app : existsSync(join(app, "Studio E2E.exe")) ? join(app, "Studio E2E.exe") : join(app, "Studio.exe");
    return { label: `packaged ${exe}`, executable: exe, args: [], app: exe, asar: join(dirname(exe), "resources", "app.asar") };
  }
  if (app.endsWith(".app")) {
    const name = basename(app, ".app");
    return {
      label: `packaged ${app}`,
      executable: join(app, "Contents/MacOS", name),
      args: [],
      app,
      asar: join(app, "Contents/Resources/app.asar"),
    };
  }
  return { label: `packaged ${app}`, executable: app, args: [], app: null, asar: null };
}

// ---------- checks ----------

const results: { name: string; ok: boolean; detail?: string }[] = [];

function check(name: string, ok: boolean, detail?: unknown): void {
  // Evidence is printed through failureDetail: a recorded request's headers (Authorization) and bodies never reach the log.
  const shown = ok || detail === undefined ? undefined : failureDetail(detail);
  results.push({ name, ok, detail: shown });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${shown === undefined ? "" : `\n      ${shown}`}`);
}

// ---------- CDP ----------

class Cdp {
  readonly #ws: WebSocket;
  #next = 0;
  readonly #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  readonly #listeners: ((method: string, params: unknown) => void)[] = [];

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.addEventListener("message", (event) => {
      const msg: unknown = JSON.parse(String(event.data));
      if (typeof msg !== "object" || msg === null) return;
      if ("id" in msg && typeof msg.id === "number") {
        const waiter = this.#pending.get(msg.id);
        this.#pending.delete(msg.id);
        if ("error" in msg) waiter?.reject(new Error(JSON.stringify(msg.error)));
        else waiter?.resolve("result" in msg ? msg.result : undefined);
      } else if ("method" in msg && typeof msg.method === "string") {
        const params = "params" in msg ? msg.params : undefined;
        for (const listener of this.#listeners) listener(msg.method, params);
      }
    });
  }

  static connect(url: string): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener("open", () => resolve(new Cdp(ws)));
      ws.addEventListener("error", () => reject(new Error(`cannot connect to ${url}`)));
    });
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = ++this.#next;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(listener: (method: string, params: unknown) => void): void {
    this.#listeners.push(listener);
  }

  async evaluate(expression: string): Promise<unknown> {
    const result = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (typeof result !== "object" || result === null) throw new Error("no evaluate result");
    if ("exceptionDetails" in result) throw new Error(`page threw: ${JSON.stringify(result.exceptionDetails).slice(0, 400)}`);
    const inner = "result" in result ? result.result : undefined;
    return typeof inner === "object" && inner !== null && "value" in inner ? inner.value : undefined;
  }

  close(): void {
    this.#ws.close();
  }
}

// ---------- process helpers ----------

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address !== null ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}

/** `intervalMs`: the default 200 ms suits a state that can change in well under a second; a wait with a known multi-second floor (e.g. money.reconcile's quiet window) should poll far less often. */
async function waitFor<T>(what: string, probe: () => Promise<T | null>, timeoutMs = 30_000, intervalMs = 200): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value !== null) return value;
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${what}${lastError ? `: ${String(lastError)}` : ""}`);
}

/** Chromium switches every launch gets: macOS keeps safeStorage off the real Keychain. */
const PLATFORM_FLAGS = process.platform === "darwin" ? ["--use-mock-keychain"] : [];

/** The engine: a child of the app's main process running Electron's Node utility service. */
function enginePid(mainPid: number): number | null {
  if (process.platform === "win32") {
    const script = `Get-CimInstance Win32_Process -Filter "ParentProcessId=${mainPid}" | Where-Object { $_.CommandLine -like '*node.mojom.NodeService*' } | Select-Object -First 1 -ExpandProperty ProcessId`;
    const out = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" }).stdout.trim();
    return /^\d+$/.test(out) ? Number(out) : null;
  }
  const ps = spawnSync("ps", ["-Ao", "pid=,ppid=,command="], { encoding: "utf8" });
  for (const line of ps.stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const [, pid = "", ppid = "", command = ""] = match;
    if (Number(ppid) === mainPid && command.includes("node.mojom.NodeService")) return Number(pid);
  }
  return null;
}

/** Ends a process; on Windows with its whole tree, which a plain kill leaves behind. */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"]);
  else child.kill("SIGKILL");
}

/** Whether a process with this pid still exists, cross-platform (signal 0 sends nothing). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * `kill -9` an arbitrary pid that is not a child of this process (so
 * `killTree`'s `ChildProcess`-based helper does not apply — T6's kill-and-resume
 * scenario SIGKILLs the engine `utilityProcess`, a grandchild reached only by
 * pid): a hard, unconditional termination, `taskkill /F` on Windows like
 * `killTree`'s own branch.
 */
function hardKill(pid: number): void {
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"]);
  else process.kill(pid, "SIGKILL");
}

/** The app's environment: the caller's, without anything OPENROUTER_* (bun loads .env) or ELECTRON_*. */
function appEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    const upper = name.toUpperCase();
    if (value === undefined || upper.startsWith("OPENROUTER_") || upper.startsWith("ELECTRON_")) continue;
    env[name] = value;
  }
  return env;
}

/** A process's command line with its environment appended (macOS `ps -E`). */
function commandWithEnv(pid: number): string {
  return spawnSync("ps", ["-E", "-ww", "-o", "command=", "-p", String(pid)], { encoding: "utf8" }).stdout;
}

interface Running {
  child: ChildProcess;
  cdp: Cdp;
  port: number;
  env: Record<string, string>;
  output: () => string;
}

/** How long one DevTools HTTP question may take: the app answers it in milliseconds, so this only ever ends a request that will not settle. */
const DEVTOOLS_FETCH_TIMEOUT_MS = 5_000;

/**
 * One bounded question to the app's DevTools HTTP port, answered with its parsed JSON (the body is read inside the bound).
 * An unbounded `fetch` here could hang for good when the window closed mid-request (the app quitting with its last window),
 * and every `waitFor` deadline around it would wait on a promise that never settles, past the step's own timeout.
 */
async function devtoolsJson(port: number, path: string): Promise<unknown> {
  const bound = timeoutSignal(DEVTOOLS_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { signal: bound.signal });
    return await response.json();
  } finally {
    bound.clear();
  }
}

/**
 * Whether anything answers on the app's DevTools port: ANY HTTP answer counts (its body is not read, so a malformed one still counts), and so does
 * a request that times out, because something that holds the port without answering is still listening. Only a refused connection is "not
 * listening". Fail-closed: this is the production build's proof that `--remote-debugging-port` is refused.
 */
async function devtoolsListening(port: number): Promise<boolean> {
  const bound = timeoutSignal(DEVTOOLS_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: bound.signal });
    await response.body?.cancel();
    return true;
  } catch {
    return bound.signal.aborted;
  } finally {
    bound.clear();
  }
}

/** Connects to the app's renderer page and installs the request and event helpers. */
async function connectPage(port: number): Promise<Cdp> {
  const wsUrl = await waitFor("the renderer page on the DevTools port", async () => {
    const targets = await devtoolsJson(port, "/json/list");
    if (!Array.isArray(targets)) return null;
    for (const t of targets) {
      if (typeof t === "object" && t !== null && "type" in t && t.type === "page" && "url" in t && typeof t.url === "string" &&
        isAppPage(t.url) && "webSocketDebuggerUrl" in t && typeof t.webSocketDebuggerUrl === "string") {
        return t.webSocketDebuggerUrl;
      }
    }
    return null;
  });
  const cdp = await Cdp.connect(wsUrl);
  await waitFor("window.studio.request", async () =>
    (await cdp.evaluate(`document.readyState === "complete" && typeof window.studio?.request === "function"`)) === true ? true : null,
  );
  await installPageHelpers(cdp);
  return cdp;
}

/** The request and event helpers the smoke drives the page with (`window.__req`, `window.__smoke.events`). */
async function installPageHelpers(cdp: Cdp): Promise<void> {
  await cdp.evaluate(`
    window.__smoke = { events: [] };
    window.studio.subscribe((e) => window.__smoke.events.push(e));
    window.__req = (type, payload = {}) => window.studio.request({ v: ${PROTOCOL_VERSION}, id: crypto.randomUUID(), kind: "command", type, payload });
    true`);
}

async function pageCount(port: number): Promise<number> {
  const targets = await devtoolsJson(port, "/json/list");
  return Array.isArray(targets) ? targets.filter((t) => typeof t === "object" && t !== null && "type" in t && t.type === "page").length : -1;
}

async function launch(target: Target, userData: string, extraArgs: string[] = []): Promise<Running> {
  const port = await freePort();
  // A real key must never reach the app under test; the canary must never reach its engine.
  const env = { ...appEnv(), OPENROUTER_API_KEY: ENV_CANARY };
  const child = spawn(
    target.executable,
    [...target.args, `--user-data-dir=${userData}`, `--remote-debugging-port=${port}`, ...PLATFORM_FLAGS, ...extraArgs],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout?.on("data", (d) => (output += String(d)));
  child.stderr?.on("data", (d) => (output += String(d)));
  try {
    return { child, cdp: await connectPage(port), port, env, output: () => output };
  } catch (error) {
    killTree(child); // this attempt is not going to become a Running: leave nothing behind for the next one
    throw error;
  }
}

/**
 * `launch`, retried with backoff: a cold relaunch right after the previous
 * instance's own `app.quit()` (the Windows/Linux "closing the last window"
 * branch below) can race Electron's SingletonLock file, which is not always
 * released the instant the process reports exited. Each failed attempt is
 * cleaned up by `launch` itself before the next one; a failure after every
 * attempt says so clearly instead of surfacing only the last try's bare
 * timeout.
 */
async function launchWithRetry(target: Target, userData: string, attempts = 3, extraArgs: string[] = []): Promise<Running> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await launch(target, userData, extraArgs);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await Bun.sleep(1_000 * attempt);
    }
  }
  throw new Error(
    `could not relaunch on ${userData} after ${attempts} attempts (a stale Electron SingletonLock right after the previous instance's app.quit()?): ${String(lastError)}`,
  );
}

/** Starts a second instance on the same userData; it must hand over to the first and exit. */
async function secondInstanceExits(target: Target, userData: string, env: Record<string, string>): Promise<boolean> {
  const second = spawn(target.executable, [...target.args, `--user-data-dir=${userData}`, ...PLATFORM_FLAGS], { env, stdio: "ignore" });
  const exited = new Promise<boolean>((resolve) => second.once("exit", () => resolve(true)));
  const result = await Promise.race([exited, Bun.sleep(15_000).then(() => false)]);
  if (!result) killTree(second);
  return result;
}

async function quit(running: Running): Promise<void> {
  running.cdp.close();
  const exited = new Promise<void>((resolve) => running.child.once("exit", () => resolve()));
  if (process.platform === "win32") killTree(running.child);
  else running.child.kill("SIGTERM");
  await Promise.race([exited, Bun.sleep(10_000)]);
  killTree(running.child);
}

/** The folder of the app under test (its executable's), set once the target is known: what a process must run from to count as the app's. */
let appExecutableDir = "";

/**
 * Windows only: the processes that hold `dir` for the app under test: whose command line names the folder at a path boundary
 * (`<dir>\`, so a sibling folder with the same prefix is not matched) and which run from the app's own folder or are the bundled
 * ffmpeg (every Chromium child carries --user-data-dir, and ffmpeg is handed the folder's paths). Not the query's own PowerShell
 * (`$PID`), whose command line names the folder too: counting it made every cleanup wait out its 15 s.
 */
function processesUsing(dir: string): number[] {
  const quote = (text: string): string => `'${text.replaceAll("'", "''")}'`;
  const script = [
    `$dir = ${quote(`${dir}\\`)}; $app = ${quote(`${appExecutableDir}\\`)}`,
    "Get-CimInstance Win32_Process | Where-Object {",
    "  $_.ProcessId -ne $PID -and $_.CommandLine -ne $null -and $_.ExecutablePath -ne $null -and $_.CommandLine.Contains($dir) -and",
    "  ($_.ExecutablePath.StartsWith($app, [StringComparison]::OrdinalIgnoreCase) -or $_.ExecutablePath -like '*ffmpeg-static*')",
    "} | ForEach-Object { $_.ProcessId }",
  ].join("\n");
  const out = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" }).stdout;
  return out.split(/\r?\n/).filter((line) => /^\d+$/.test(line.trim())).map(Number);
}

/**
 * Removes a scenario's temp folder. `taskkill /T` returns before every process of the app is gone, and one that is still on its way
 * out holds files of userData or the library (a Windows EBUSY on the folder was seen here, right after the app was killed). So the
 * cleanup first waits until no process of the app holds the folder any more, ends (each by its own pid, never its tree) and reports
 * any that will not go, and only then removes it; if the folder still will not go, it says which processes were holding it.
 */
async function removeTemp(dir: string): Promise<void> {
  if (process.platform === "win32") {
    const started = Date.now();
    let users = processesUsing(dir);
    while (users.length > 0 && Date.now() - started < 15_000) {
      await Bun.sleep(300);
      users = processesUsing(dir);
    }
    if (users.length > 0) {
      console.log(`CLEANUP  ${users.length} process(es) still name ${basename(dir)} after 15 s and are ended: ${users.join(", ")}`);
      for (const pid of users) spawnSync("taskkill", ["/PID", String(pid), "/F"]);
      await Bun.sleep(1_000);
    } else if (Date.now() - started > 600) {
      console.log(`CLEANUP  the app's processes took ${Date.now() - started} ms to be gone after the kill`);
    }
  }
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  } catch (error) {
    if (process.platform === "win32") console.log(`CLEANUP  ${basename(dir)} could not be removed; processes naming it: ${processesUsing(dir).join(", ") || "none"}`);
    throw error;
  }
}

/** A system file every machine of the OS has: what a page that could read `file:` URLs would read first. */
const SYSTEM_FILE_URL = process.platform === "win32" ? "file:///C:/Windows/win.ini" : "file:///etc/hosts";
/** A budget no other step sets: the injected `file:` frame below asks main for it, and it must never land. */
const FRAME_BUDGET_MICROS = 13_131_313;

/**
 * The page's own origin (the 3f.6 security review), from inside the real page with its real CSP and webPreferences, as any script
 * injected into it would run: the page is `studio-app://renderer/index.html`, its own scripts, styles and fonts and the bridge work,
 * and it reads no `file:` URL at all: not a system file, not a photo outside the library (fetch, XHR, `<img>`), not through the app's
 * scheme by a traversal (each such URL is answered 404 by main), and an injected `<iframe>` of a local HTML file or of the app's own
 * page never loads, so its script never reaches the bridge as the top frame.
 */
async function checkRendererOrigin(cdp: Cdp, scratch: string): Promise<void> {
  const outsidePhoto = join(scratch, "outside-the-library.png");
  await writeFile(outsidePhoto, PNG);
  const evilPage = join(scratch, "downloaded.html");
  await writeFile(
    evilPage,
    `<!doctype html><script>parent.postMessage("the file: frame ran", "*"); parent.studio.request({ v: ${PROTOCOL_VERSION}, id: "smoke-frame-0001", kind: "command", type: "settings.setBudget", payload: { monthlyBudgetMicros: ${FRAME_BUDGET_MICROS} } });</script>`,
  );
  const budgetBefore = field(await req(cdp, "settings.get"), "result", "monthlyBudgetMicros");
  const appResponses: { url: string; status: number }[] = [];
  cdp.on((method, params) => {
    if (method !== "Network.responseReceived") return;
    const url = field(params, "response", "url");
    if (typeof url === "string" && url.startsWith(`${APP_SCHEME}:`)) appResponses.push({ url, status: Number(field(params, "response", "status")) });
  });
  const traversals = [
    `${APP_SCHEME}://renderer/../../../../../../etc/hosts`,
    `${APP_SCHEME}://renderer/%2e%2e/%2e%2e/%2e%2e/etc/hosts`,
    `${APP_SCHEME}://renderer/..%2f..%2f..%2fetc%2fhosts`,
    `${APP_SCHEME}://renderer/..%5c..%5c..%5cWindows%5cwin.ini`,
    `${APP_SCHEME}://renderer/assets/..\\..\\..\\Windows\\win.ini`,
    `${APP_SCHEME}://renderer/C:/Windows/win.ini`,
  ];
  const page = await cdp.evaluate(`(async () => {
    const fetched = async (url) => { try { const r = await fetch(url); return "read " + r.status + " (" + (await r.arrayBuffer()).byteLength + " B)"; } catch (e) { return "refused"; } };
    const xhr = (url) => new Promise((done) => { try { const q = new XMLHttpRequest(); q.open("GET", url); q.onload = () => done("read " + q.responseText.length); q.onerror = () => done("refused"); q.send(); } catch (e) { done("refused"); } });
    const img = (url) => new Promise((done) => { const i = new Image(); i.onload = () => done("loaded"); i.onerror = () => done("refused"); i.src = url; });
    const violations = [];
    addEventListener("securitypolicyviolation", (e) => violations.push(e.violatedDirective));
    const framed = (url) => new Promise((done) => {
      const timer = setTimeout(() => done("never ran"), 3000);
      addEventListener("message", (e) => { clearTimeout(timer); done("ran: " + String(e.data)); }, { once: true });
      const f = document.createElement("iframe");
      f.src = url;
      document.body.appendChild(f);
    });
    await document.fonts.ready;
    const result = {
      href: location.href,
      origin: location.origin,
      rendered: document.getElementById("root")?.children.length ?? 0,
      script: document.querySelector("script[type=module]")?.src ?? null,
      styles: [...document.styleSheets].filter((s) => (s.href ?? "").startsWith("${APP_SCHEME}://renderer/assets/") && s.cssRules.length > 0).length,
      fonts: [...document.fonts].filter((f) => f.status === "loaded").length,
      bridge: typeof window.studio?.request,
      systemFetch: await fetched(${JSON.stringify(SYSTEM_FILE_URL)}),
      systemXhr: await xhr(${JSON.stringify(SYSTEM_FILE_URL)}),
      photoFetch: await fetched(${JSON.stringify(pathToFileURL(outsidePhoto).href)}),
      photoXhr: await xhr(${JSON.stringify(pathToFileURL(outsidePhoto).href)}),
      photoImg: await img(${JSON.stringify(pathToFileURL(outsidePhoto).href)}),
      ownSchemeFetch: await fetched("${APP_PAGE_URL}"),
      traversals: await Promise.all(${JSON.stringify(traversals)}.map(img)),
      fileFrame: await framed(${JSON.stringify(pathToFileURL(evilPage).href)}),
      appFrame: await framed("${APP_PAGE_URL}"),
    };
    for (const f of document.querySelectorAll("iframe")) f.remove();
    return { ...result, violations };
  })()`);
  check("origin: the window's page is studio-app://renderer/index.html, an origin of its own", field(page, "href") === APP_PAGE_URL && field(page, "origin") === `${APP_SCHEME}://renderer`, page);
  check(
    "origin: the app's own module script ran, its styles and fonts loaded from the scheme, and the preload bridge is there",
    Number(field(page, "rendered")) > 0 && String(field(page, "script")).startsWith(`${APP_SCHEME}://renderer/assets/`) && Number(field(page, "styles")) > 0 && Number(field(page, "fonts")) > 0 && field(page, "bridge") === "function",
    page,
  );
  check(`origin: the page cannot read ${SYSTEM_FILE_URL} (fetch and XHR refused)`, field(page, "systemFetch") === "refused" && field(page, "systemXhr") === "refused", page);
  check("origin: the page cannot read a photo outside the library by its file: URL (fetch, XHR and <img> refused)", field(page, "photoFetch") === "refused" && field(page, "photoXhr") === "refused" && field(page, "photoImg") === "refused", page);
  check("origin: the page cannot fetch its own scheme either (no supportFetchAPI)", field(page, "ownSchemeFetch") === "refused", page);
  await Bun.sleep(300);
  // Everything the app's scheme answered that is not the bundle itself: each traversal, however Chromium wrote it.
  const strays = appResponses.filter((r) => r.url !== APP_PAGE_URL && !r.url.startsWith(`${APP_SCHEME}://renderer/assets/`));
  check(
    "origin: no traversal through the app's scheme loads: main answers each one that reaches it with a 404",
    JSON.stringify(field(page, "traversals")) === JSON.stringify(traversals.map(() => "refused")) && strays.length > 0 && strays.every((r) => r.status === 404),
    { traversals: field(page, "traversals"), strays },
  );
  check("origin: an injected <iframe> of a local HTML file never runs", field(page, "fileFrame") === "never ran", page);
  const violations = field(page, "violations");
  check(
    "origin: an injected <iframe> of the app's own page is blocked by frame-src 'none'",
    field(page, "appFrame") === "never ran" && Array.isArray(violations) && violations.includes("frame-src"),
    page,
  );
  const budgetAfter = field(await req(cdp, "settings.get"), "result", "monthlyBudgetMicros");
  check(
    "origin: the file: frame's request never reached main (the budget it asked for was not set)",
    typeof budgetBefore === "number" && budgetAfter === budgetBefore && budgetAfter !== FRAME_BUDGET_MICROS,
    { budgetBefore, budgetAfter },
  );
}

/**
 * One Range request to a `studio-media://` URL, byte for byte. The window's own fetch is refused by its CSP and the scheme has no CORS
 * grant, and Electron opens no second tab, so the one window is sent to the URL itself (a page ON the video's origin, where a same-origin
 * fetch with the header is allowed), asked, and sent back to the app, whose helpers are installed again. Nothing else may be in flight.
 * Answers status, Content-Range and the body's length.
 */
async function rangeProbe(cdp: Cdp, url: string, range: string): Promise<unknown> {
  const home = await cdp.evaluate("location.href");
  if (typeof home !== "string") throw new Error("the window has no address");
  await cdp.send("Page.enable");
  await cdp.send("Page.navigate", { url });
  try {
    await waitFor("the window to be on the video's origin", async () => ((await cdp.evaluate("location.protocol").catch(() => null)) === "studio-media:" ? true : null), 10_000, 100);
    return await cdp.evaluate(`(async () => { const r = await fetch(location.href, { headers: { Range: ${JSON.stringify(range)} } }); const b = await r.arrayBuffer(); return { status: r.status, range: r.headers.get("content-range"), length: b.byteLength }; })()`);
  } finally {
    await cdp.send("Page.navigate", { url: home });
    await waitFor("the app's window to be back", async () => ((await cdp.evaluate(`document.readyState === "complete" && typeof window.studio?.request === "function"`).catch(() => null)) === true ? true : null), 15_000, 100);
    await installPageHelpers(cdp);
  }
}

function req(cdp: Cdp, type: string, payload: unknown = {}): Promise<unknown> {
  return cdp.evaluate(`window.__req(${JSON.stringify(type)}, ${JSON.stringify(payload)})`);
}

function field(value: unknown, ...path: string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null || !(key in current)) return undefined;
    current = Reflect.get(current, key);
  }
  return current;
}

// ---------- packaged checks ----------

const EXPECTED_FUSES: Record<string, "Enabled" | "Disabled"> = {
  RunAsNode: "Disabled",
  EnableNodeOptionsEnvironmentVariable: "Disabled",
  EnableNodeCliInspectArguments: "Disabled",
  OnlyLoadAppFromAsar: "Enabled",
  EnableEmbeddedAsarIntegrityValidation: "Enabled",
  EnableCookieEncryption: "Enabled",
  // The page is served from `studio-app://renderer` (studio/main/appProtocol.ts): no `file:` page gets more than a browser's.
  GrantFileProtocolExtraPrivileges: "Disabled",
};

function checkPackage(target: Target): void {
  if (target.asar === null || target.app === null) return;
  const entries = listPackage(target.asar, { isPack: false }).map((p) => p.replaceAll("\\", "/"));
  check("app.asar contains out-studio/engine/main.js", entries.includes("/out-studio/engine/main.js"));
  // Electron names the userData folder (and the safeStorage key) after package.json's productName or name. The E2E package,
  // built with the shortened money timings, must never share them with an installed Studio: it has its own name, and the
  // production package keeps Studio's.
  const packaged: unknown = JSON.parse(asarText(target, "package.json"));
  const packagedName = production ? "uniquemedia-studio" : "uniquemedia-studio-e2e";
  check(
    `the ${production ? "production" : "E2E"} package's app name is ${packagedName}${production ? "" : ", not Studio's: its userData is its own"}`,
    field(packaged, "name") === packagedName && (production ? field(packaged, "productName") === undefined : field(packaged, "productName") === "Studio E2E"),
    { name: field(packaged, "name"), productName: field(packaged, "productName") },
  );
  check("the engine is not unpacked from the asar", !existsSync(join(`${target.asar}.unpacked`, "out-studio")));
  // T7b, the face gate: neither the models nor onnxruntime-web's WASM
  // runtime are asarUnpack'd (electron-builder.studio.yml) — both must stay
  // inside the integrity-checked asar. This only checks packaging; that they
  // are actually LOADED from there and produce a real verdict is proven by
  // runPhotoRunKillResumeScenario's own qa.faceCos check below.
  const modelFiles = Object.values(FACE_MODELS).map((m) => `/out-studio/engine/models/${m.file}`);
  const ortFiles = [
    "/node_modules/onnxruntime-web/dist/ort.node.min.mjs",
    "/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm",
    "/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs",
  ];
  const missingFaceAssets = [...modelFiles, ...ortFiles].filter((f) => !entries.includes(f));
  check("app.asar contains the face gate's models and onnxruntime-web's WASM runtime", missingFaceAssets.length === 0, { missingFaceAssets });
  // T7c: the face worker thread is its own built entry, loaded by file URL
  // from inside the asar (never unpacked, for the same integrity reason).
  // 3f.2: the own-photo decode worker, the same way: inside the asar, never unpacked.
  check("app.asar contains the own-photo decode worker entry, and it is not unpacked", entries.includes("/out-studio/engine/photoDecodeWorker.js") && !existsSync(join(`${target.asar}.unpacked`, "out-studio", "engine", "photoDecodeWorker.js")));
  // 3f.5: the own-sticker encode worker, the same way: inside the asar, never unpacked.
  check("app.asar contains the own-sticker encode worker entry, and it is not unpacked", entries.includes("/out-studio/engine/stickerEncodeWorker.js") && !existsSync(join(`${target.asar}.unpacked`, "out-studio", "engine", "stickerEncodeWorker.js")));
  check("app.asar contains the face worker entry, and it is not unpacked", entries.includes("/out-studio/engine/faceWorker.js") && !existsSync(join(`${target.asar}.unpacked`, "out-studio", "engine", "faceWorker.js")));
  // 3b.2, the text rasteriser: resvg's .wasm, the six fonts and their OFL texts stay inside the asar too (never
  // unpacked, for the same integrity reason). That they load from there under the fuses, in the real
  // utilityProcess, is checked by `checkTextRasteriser` on what the engine prints at start-up.
  const textAssetProblems = [...textAssetPackageProblems(entries), ...(entries.includes("/out-studio/engine/textWorker.js") ? [] : ["/out-studio/engine/textWorker.js is not in the package"])];
  if (existsSync(join(`${target.asar}.unpacked`, "out-studio", "engine", "textWorker.js"))) textAssetProblems.push("textWorker.js is unpacked from the asar");
  check("app.asar contains resvg's wasm, the bundled fonts and their licences", textAssetProblems.length === 0, textAssetProblems);
  const fuses = spawnSync("bunx", ["@electron/fuses", "read", "--app", target.app], { encoding: "utf8" }).stdout;
  const wrong = Object.entries(EXPECTED_FUSES).filter(([fuse, state]) => !new RegExp(`${fuse} is ${state}`).test(fuses));
  check("the Electron fuses are set (runAsNode, NODE_OPTIONS, --inspect off; asar-only with integrity; cookie encryption; no extra file: privileges)", wrong.length === 0, { wrong, fuses });
}

/**
 * In-memory reads from the asar (never extracted to disk). @electron/asar
 * splits a path on the platform's separator, so a `/` path is normalised:
 * on Windows it would otherwise never be found.
 */
function asarText(target: Target, file: string): string {
  return target.asar === null ? "" : extractFile(target.asar, normalize(file)).toString("utf8");
}

/** The renderer's built JS (there may be more than one chunk), read from disk or, packaged, from the asar without extracting it. */
async function rendererBundleText(target: Target): Promise<string> {
  if (target.asar === null) {
    const dir = join(ROOT, "out-studio", "renderer", "assets");
    const files = (await readdir(dir)).filter((f) => f.endsWith(".js"));
    return (await Promise.all(files.map((f) => readFile(join(dir, f), "utf8")))).join("\n");
  }
  const entries = listPackage(target.asar, { isPack: false }).map((p) => p.replaceAll("\\", "/"));
  const files = entries.filter((p) => p.startsWith("/out-studio/renderer/assets/") && p.endsWith(".js"));
  return files.map((p) => asarText(target, p.replace(/^\//, ""))).join("\n");
}

/** The shared chunks beside the entries (`out-studio/*.js`, where zod, the contract and the money core land), from disk or, packaged, the asar. */
async function sharedChunkText(target: Target): Promise<string> {
  if (target.asar === null) {
    const dir = join(ROOT, "out-studio");
    const files = (await readdir(dir)).filter((f) => f.endsWith(".js"));
    return (await Promise.all(files.map((f) => readFile(join(dir, f), "utf8")))).join("\n");
  }
  const entries = listPackage(target.asar, { isPack: false }).map((p) => p.replaceAll("\\", "/"));
  const files = entries.filter((p) => /^\/out-studio\/[^/]+\.js$/.test(p));
  return files.map((p) => asarText(target, p.replace(/^\//, ""))).join("\n");
}

/** The renderer's built CSS (fonts.css once Vite resolves it), read the same way as rendererBundleText's JS. */
async function rendererCssText(target: Target): Promise<string> {
  if (target.asar === null) {
    const dir = join(ROOT, "out-studio", "renderer", "assets");
    const files = (await readdir(dir)).filter((f) => f.endsWith(".css"));
    return (await Promise.all(files.map((f) => readFile(join(dir, f), "utf8")))).join("\n");
  }
  const entries = listPackage(target.asar, { isPack: false }).map((p) => p.replaceAll("\\", "/"));
  const files = entries.filter((p) => p.startsWith("/out-studio/renderer/assets/") && p.endsWith(".css"));
  return files.map((p) => asarText(target, p.replace(/^\//, ""))).join("\n");
}

/** The renderer's built page (its CSP), read from disk or, packaged, from the asar. */
async function rendererPageText(target: Target): Promise<string> {
  return target.asar === null ? readFile(join(ROOT, "out-studio", "renderer", "index.html"), "utf8") : asarText(target, join("out-studio", "renderer", "index.html"));
}

/** Every debug door compiled out of a production build's bundles (bundleChecks.ts), wherever they were read from. */
function checkProductionBundles(where: string, main: string, engine: string, preload: string, renderer: string, rendererCss: string, sharedChunks: string, rendererPage: string): void {
  const mainProblems = productionMainProblems(main);
  check(`${where}: main has every debug door compiled out (no test switch, no env renderer URL, DevTools off, remote debugging refused) and loads the page from studio-app://, never file:`, mainProblems.length === 0, mainProblems);
  const pageProblems = productionRendererPageProblems(rendererPage);
  check(`${where}: the page's CSP keeps it to its own origin (frames, children, plugins, <base> and forms shut; no file:)`, pageProblems.length === 0, pageProblems);
  const engineProblems = productionEngineBundleProblems(engine, sharedChunks);
  check(`${where}: the engine and its shared chunks were built without the E2E flag (no base-URL override, no test-only commit hold)`, engineProblems.length === 0, engineProblems);
  const timingProblems = productionMoneyTimingProblems(sharedChunks);
  check(`${where}: the money timings are the production ones (the E2E build's shortened reconcile wait and request timeout are compiled out)`, timingProblems.length === 0, timingProblems);
  check(`${where}: a preload bundle was read`, preload.length > 0);
  const preloadProblems = productionBundleProblems(preload);
  check(`${where}: preload has every debug door compiled out`, preloadProblems.length === 0, preloadProblems);
  check(`${where}: a renderer bundle was read`, renderer.length > 0);
  const rendererProblems = productionBundleProblems(renderer);
  check(`${where}: renderer has every debug door compiled out`, rendererProblems.length === 0, rendererProblems);
  check(`${where}: a renderer CSS bundle was read`, rendererCss.length > 0);
  const rendererCssProblems = productionRendererCssProblems(rendererCss);
  check(`${where}: renderer CSS has no unresolved @fontsource url() and still carries a woff2 reference`, rendererCssProblems.length === 0, rendererCssProblems);
}

/**
 * T7c: the face worker design rests on one runtime property — a worker thread
 * stuck in a synchronous loop (what a pathological WASM computation is) is
 * ended by `worker.terminate()` promptly. Node/V8 guarantee it (Bun, which the
 * unit tests run under, does NOT: its `terminate()` never settles on such a
 * worker, which is why those tests hang the worker asynchronously instead), so
 * this proves it on the Electron runtime the engine actually ships in. Runs
 * the dev Electron binary (the same Electron version as the packaged app's) as
 * plain Node (`ELECTRON_RUN_AS_NODE`) for EVERY target, packaged ones too — a
 * packaged app's own fuses forbid runAsNode, so it cannot be that binary, and
 * CI always passes `--app`.
 */
async function checkRuntimeInterruptsBusyWorker(): Promise<void> {
  const busyWorkerSource = 'require("node:worker_threads").parentPort.postMessage(1); for (;;) Math.sqrt(Math.random());';
  const script = [
    'const { Worker } = require("node:worker_threads");',
    `const worker = new Worker(${JSON.stringify(busyWorkerSource)}, { eval: true });`,
    'worker.once("message", () => setTimeout(async () => {',
    "  const started = performance.now();",
    '  const outcome = await Promise.race([worker.terminate().then(() => "terminated"), new Promise((r) => setTimeout(() => r("still running"), 5000))]);',
    '  console.log(JSON.stringify({ outcome, ms: Math.round(performance.now() - started) }));',
    "  process.exit(0);",
    "}, 100));",
  ].join("\n");
  const result = spawnSync(await electronBinary(), ["-e", script], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8", timeout: 30_000 });
  const line = result.stdout.trim().split("\n").at(-1) ?? "";
  const parsed: unknown = (() => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  })();
  const ok = typeof parsed === "object" && parsed !== null && "outcome" in parsed && parsed.outcome === "terminated" && "ms" in parsed && typeof parsed.ms === "number" && parsed.ms < 2000;
  check("Electron's runtime ends a worker thread stuck in a synchronous loop within 2 s of terminate() (the face worker's cancel guarantee)", ok, { stdout: result.stdout, stderr: result.stderr.slice(0, 500) });
}

/** T7c: the face worker entry, wherever it was read from (bundleChecks.ts's `faceWorkerProblems`). */
function checkFaceWorker(where: string, engine: string, worker: string | null, fileExists: (outStudioPath: string) => boolean): void {
  const problems = faceWorkerProblems(engine, worker, fileExists);
  check(`${where}: the face worker entry is built, loaded by file URL, a worker thread, Electron-free, and every chunk it imports is present`, problems.length === 0, problems);
}

/** 3f.2: the own-photo decode worker entry, wherever it was read from (bundleChecks.ts's `photoDecodeWorkerProblems`). */
function checkPhotoDecodeWorker(where: string, engine: string, worker: string | null, fileExists: (outStudioPath: string) => boolean): void {
  const problems = photoDecodeWorkerProblems(engine, worker, fileExists);
  check(`${where}: the own-photo decode worker entry is built, loaded by file URL, a worker thread, Electron-free, with every chunk it imports present and the WASM decode only inside it`, problems.length === 0, problems);
}

/** 3f.5: the own-sticker encode worker entry, wherever it was read from (bundleChecks.ts's `stickerEncodeWorkerProblems`). */
function checkStickerEncodeWorker(where: string, engine: string, worker: string | null, fileExists: (outStudioPath: string) => boolean): void {
  const problems = stickerEncodeWorkerProblems(engine, worker, fileExists);
  check(`${where}: the own-sticker encode worker entry is built, loaded by file URL, a worker thread, Electron-free, with every chunk it imports present and the APNG writer only inside it`, problems.length === 0, problems);
}

/** 3b.2: the text worker entry, wherever it was read from (bundleChecks.ts's `textWorkerProblems`). */
function checkTextWorker(where: string, engine: string, worker: string | null, fileExists: (outStudioPath: string) => boolean): void {
  const problems = textWorkerProblems(engine, worker, fileExists);
  check(`${where}: the text worker entry is built, loaded by file URL, a worker thread, Electron-free, with every chunk it imports present and resvg only inside it`, problems.length === 0, problems);
}

/**
 * 3b.2: the engine starts the text worker at start-up; the worker draws a Cyrillic string in each of the five
 * fonts and the engine logs the fingerprint of the result (engine/text/load.ts). Waits for that line in the app's
 * captured output and checks it against the pinned fingerprint, the same constant on macOS and Windows. In a package
 * this proves that a worker_thread inside the real utilityProcess, with the fuses on, loads the wasm and the fonts
 * from inside app.asar and draws the pinned bytes.
 */
async function checkTextRasteriser(where: string, output: () => string): Promise<void> {
  const ready = await waitFor("the text rasteriser's ready line", async () => (textRasteriserOutputProblems(output()).length === 0 ? true : null), 30_000).catch(() => false);
  const problems = textRasteriserOutputProblems(output());
  check(`${where}: the engine loads resvg-wasm and the fonts and its Cyrillic self-test draws the pinned fingerprint`, ready === true && problems.length === 0, { problems, outputTail: output().slice(-1500) });
}

async function productionCheck(target: Target): Promise<void> {
  await checkRuntimeInterruptsBusyWorker();
  if (target.asar === null) {
    // `build:studio` output: the bundles only; a package is what launches.
    checkProductionBundles(
      "the production build",
      await readFile(join(ROOT, "out-studio", "main", "main.js"), "utf8"),
      await readFile(join(ROOT, "out-studio", "engine", "main.js"), "utf8"),
      await readFile(join(ROOT, "out-studio", "preload", "preload.cjs"), "utf8"),
      await rendererBundleText(target),
      await rendererCssText(target),
      await sharedChunkText(target),
      await rendererPageText(target),
    );
    const builtTextAssets = [
      ...(await readdir(join(ROOT, "out-studio", "engine", "fonts")).catch(() => [])).map((f) => `/out-studio/engine/fonts/${f}`),
      ...(await readdir(join(ROOT, "out-studio", "engine", "wasm")).catch(() => [])).map((f) => `/out-studio/engine/wasm/${f}`),
    ];
    const builtTextProblems = textAssetPackageProblems(builtTextAssets);
    check("the production build holds resvg's wasm, the bundled fonts and their licences", builtTextProblems.length === 0, builtTextProblems);
    const textWorkerPath = join(ROOT, "out-studio", "engine", "textWorker.js");
    checkTextWorker(
      "the production build",
      await readFile(join(ROOT, "out-studio", "engine", "main.js"), "utf8"),
      existsSync(textWorkerPath) ? await readFile(textWorkerPath, "utf8") : null,
      (outStudioPath) => existsSync(join(ROOT, "out-studio", outStudioPath)),
    );
    const photoWorkerPath = join(ROOT, "out-studio", "engine", "photoDecodeWorker.js");
    checkPhotoDecodeWorker(
      "the production build",
      await readFile(join(ROOT, "out-studio", "engine", "main.js"), "utf8"),
      existsSync(photoWorkerPath) ? await readFile(photoWorkerPath, "utf8") : null,
      (outStudioPath) => existsSync(join(ROOT, "out-studio", outStudioPath)),
    );
    const stickerEncodeWorkerPath = join(ROOT, "out-studio", "engine", "stickerEncodeWorker.js");
    checkStickerEncodeWorker(
      "the production build",
      await readFile(join(ROOT, "out-studio", "engine", "main.js"), "utf8"),
      existsSync(stickerEncodeWorkerPath) ? await readFile(stickerEncodeWorkerPath, "utf8") : null,
      (outStudioPath) => existsSync(join(ROOT, "out-studio", outStudioPath)),
    );
    const workerPath = join(ROOT, "out-studio", "engine", "faceWorker.js");
    checkFaceWorker(
      "the production build",
      await readFile(join(ROOT, "out-studio", "engine", "main.js"), "utf8"),
      existsSync(workerPath) ? await readFile(workerPath, "utf8") : null,
      (outStudioPath) => existsSync(join(ROOT, "out-studio", outStudioPath)),
    );
    return;
  }
  checkPackage(target);
  checkProductionBundles(
    "the package",
    asarText(target, join("out-studio", "main", "main.js")),
    asarText(target, join("out-studio", "engine", "main.js")),
    asarText(target, join("out-studio", "preload", "preload.cjs")),
    await rendererBundleText(target),
    await rendererCssText(target),
    await sharedChunkText(target),
    await rendererPageText(target),
  );
  const packagedEntries = new Set(listPackage(target.asar, { isPack: false }).map((p) => p.replaceAll("\\", "/")));
  checkTextWorker(
    "the package",
    asarText(target, join("out-studio", "engine", "main.js")),
    packagedEntries.has("/out-studio/engine/textWorker.js") ? asarText(target, join("out-studio", "engine", "textWorker.js")) : null,
    (outStudioPath) => packagedEntries.has(`/out-studio/${outStudioPath}`),
  );
  checkPhotoDecodeWorker(
    "the package",
    asarText(target, join("out-studio", "engine", "main.js")),
    packagedEntries.has("/out-studio/engine/photoDecodeWorker.js") ? asarText(target, join("out-studio", "engine", "photoDecodeWorker.js")) : null,
    (outStudioPath) => packagedEntries.has(`/out-studio/${outStudioPath}`),
  );
  checkStickerEncodeWorker(
    "the package",
    asarText(target, join("out-studio", "engine", "main.js")),
    packagedEntries.has("/out-studio/engine/stickerEncodeWorker.js") ? asarText(target, join("out-studio", "engine", "stickerEncodeWorker.js")) : null,
    (outStudioPath) => packagedEntries.has(`/out-studio/${outStudioPath}`),
  );
  checkFaceWorker(
    "the package",
    asarText(target, join("out-studio", "engine", "main.js")),
    packagedEntries.has("/out-studio/engine/faceWorker.js") ? asarText(target, join("out-studio", "engine", "faceWorker.js")) : null,
    (outStudioPath) => packagedEntries.has(`/out-studio/${outStudioPath}`),
  );

  const tmp = await mkdtemp(join(tmpdir(), "studio-smoke-prod-"));
  const port = await freePort();
  const child = spawn(target.executable, [`--user-data-dir=${join(tmp, "userData")}`, `--remote-debugging-port=${port}`, ...PLATFORM_FLAGS], {
    env: appEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (d) => (output += String(d)));
  child.stderr?.on("data", (d) => (output += String(d)));
  try {
    const mainPid = child.pid ?? -1;
    const engine = await waitFor("the engine process", async () => enginePid(mainPid), 20_000).catch(() => null);
    check("the production app launches and starts its engine utilityProcess", engine !== null && child.exitCode === null);
    await checkTextRasteriser("the production app", () => output);
    let listening = false;
    for (let i = 0; i < 10 && !listening; i++) {
      listening = await devtoolsListening(port);
      await Bun.sleep(300);
    }
    check("the production app ignores --remote-debugging-port", !listening);
    // The refusal (studio/main/main.ts) is one clean line, not a stack trace:
    // exactly one line mentions it, in the project's `studio: ...` log style,
    // and nothing in the output looks like an unhandled exception.
    const refusalLines = output.split("\n").map((line) => line.trim()).filter((line) => line.includes("remote-debugging-port"));
    check(
      "the production app prints its remote-debugging refusal as a clean one-line message, not a stack trace",
      refusalLines.length === 1 && refusalLines[0]?.startsWith("studio: ") === true && !looksLikeAStackTrace(output),
      { output: output.slice(0, 2000) },
    );
  } finally {
    if (process.platform !== "win32") child.kill("SIGTERM");
    await Bun.sleep(1000);
    killTree(child);
    await Bun.sleep(500);
    await removeTemp(tmp);
  }
}

// ---------- avatar end-to-end scenario (against the mock OpenRouter) ----------

/** Distinctive words that must reach the mock only inside the descriptor request (T6a-2b's marker-vibe canary, engine.canary.test.ts's own convention). */
const AVATAR_MARKER_WORDS = ["zebra", "lantern", "marmalade"];

/** studio/engine/testing/engineHarness.ts's TRAITS, with the vibe replaced by the marker words. */
const AVATAR_TRAITS = {
  age: 25,
  ethnicity: "european",
  skinTone: "light-olive",
  hairColor: "chestnut",
  hairLength: "shoulder",
  hairTexture: "wavy",
  eyeColor: "hazel",
  build: "athletic",
  marks: ["freckles"],
  vibe: AVATAR_MARKER_WORDS.join(" "),
};

/** A descriptor that fits the traits above (engineHarness.ts's GOOD): passes the age anchor and every adult-text rule on the first attempt. */
const AVATAR_DESCRIPTOR =
  "25-year-old European woman, light olive skin, hazel eyes, shoulder-length wavy chestnut hair, athletic build, light freckles across the nose.";

/** Every file under `dir`, relative to it, with `/` separators regardless of platform. */
async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name).slice(dir.length + 1).replaceAll("\\", "/"));
}

/** Whether any marker word is anywhere in a mock request: URL, headers or body, in any letter case (engine.canary.test.ts's own `carriesMarker` scan). */
function carriesMarker(request: MockRequest): boolean {
  return requestCarries(request, AVATAR_MARKER_WORDS);
}

/**
 * Slice 2a's "Done when": a packaged (or unpackaged E2E) build creates an
 * avatar end-to-end against a mock OpenRouter. Its own app instance, its own
 * temp userData and library, its own mock server — kept apart from the
 * checks above so neither's ledger or events are read by the other.
 *
 * No request leaves the machine: the base-URL override (invariant 13) points
 * only at this mock's loopback port, and the only key ever sent is a fake
 * one. Every check below is against what the mock actually saw, not an
 * assumption about the engine's internals.
 */
// Owner's decision (2026-09-27): the paid image age check is off by default,
// so this scenario runs the app's real, unconfigured default — no age-check
// requests at all, all 4 candidates pass. The age-gate behaviour itself (the
// rejection, the age-checked candidate count, the age-check request count)
// stays covered by the engine test suite (candidateJob.test.ts,
// engine.avatars.test.ts, engine.candidates.test.ts, engine.canary.test.ts,
// engine.imageAgeCheck.test.ts) — cheaper to run and already thorough; this
// packaged E2E only adds a cheap plumbing check that the setting can be
// turned on through the real app (main → engine), without a second full
// avatar/candidate cycle.
async function runAvatarScenario(target: Target): Promise<void> {
  const mock = await startMockOpenRouter({ descriptorText: AVATAR_DESCRIPTOR });
  const tmp = await mkdtemp(join(tmpdir(), "studio-smoke-avatar-"));
  const userData = join(tmp, "userData");
  const libraryRoot = join(tmp, "avatar-library");
  await mkdir(userData, { recursive: true });
  await mkdir(libraryRoot, { recursive: true });

  const running = await launch(target, userData, [
    `--studio-openrouter-base-url=${mock.url}`,
    `--studio-pick-folder=${libraryRoot}`,
  ]);
  try {
    const { cdp } = running;
    const statuses = new Map<string, { status: number; mimeType: string }>();
    cdp.on((method, params) => {
      if (method !== "Network.responseReceived") return;
      const url = field(params, "response", "url");
      if (typeof url !== "string" || !url.startsWith("studio-media:")) return;
      statuses.set(url, { status: Number(field(params, "response", "status")), mimeType: String(field(params, "response", "mimeType")) });
    });
    await cdp.send("Network.enable");

    const keySet = await req(cdp, "settings.setApiKey", { key: SMOKE_KEY });
    check("avatar scenario: settings.setApiKey stores the fake key", field(keySet, "ok") === true, keySet);

    // The renderer never sends a path for real: main's folder dialog answers
    // from --studio-pick-folder (an E2E-only switch), which is why the
    // library actually adopted is `libraryRoot`, not the (irrelevant) path below.
    const libSet = await req(cdp, "settings.setLibraryPath", { path: libraryRoot });
    check(
      "avatar scenario: settings.setLibraryPath adopts the temp library (via --studio-pick-folder)",
      field(libSet, "ok") === true && field(libSet, "result", "libraryPath") === libraryRoot,
      libSet,
    );

    // 0. A baseline reconcile before any paid call (M2 of the whole-slice
    // review): the ledger is empty, so Budget.quiet() is already infinite
    // (no activity to wait out) and this returns at once — no need for the
    // reconcile wait (2 minutes in production, 5 s in this E2E build). Without this marker, the reconcile after the scenario
    // below would always land in reconcileLedger's "no baseline" branch
    // (studio/engine/money/reconcile.ts), where `mismatch` is always null:
    // /credits would never actually be compared against the ledger.
    const baseline = await req(cdp, "money.reconcile");
    check(
      "avatar scenario: the baseline reconcile (before any paid call) succeeds at once, with no delta yet to compare",
      field(baseline, "ok") === true &&
        field(baseline, "result", "status") === "done" &&
        field(baseline, "result", "deltaUnavailable") === "no-baseline" &&
        field(baseline, "result", "creditsDeltaMicros") === null &&
        field(baseline, "result", "mismatch") === null,
      baseline,
    );

    // 1. Estimate, then create the draft: one descriptor call.
    const estimate = await req(cdp, "avatars.estimate", { traits: AVATAR_TRAITS });
    check("avatar scenario: avatars.estimate prices a new avatar", field(estimate, "ok") === true, estimate);
    const draft = await req(cdp, "avatars.createDraft", { traits: AVATAR_TRAITS, acceptedWorstMicros: field(estimate, "result", "worstMicros") });
    check("avatar scenario: avatars.createDraft writes the descriptor and a draft", field(draft, "ok") === true, draft);
    const avatarId = field(draft, "result", "draft", "avatarId");
    check(
      "avatar scenario: the draft's descriptor is exactly the mock's answer",
      field(draft, "result", "draft", "descriptor", "text") === AVATAR_DESCRIPTOR,
      draft,
    );

    // 2. Estimate, then generate the first batch of candidates.
    const batchEstimate = await req(cdp, "avatars.estimateCandidates", { avatarId });
    check("avatar scenario: avatars.estimateCandidates prices the batch", field(batchEstimate, "ok") === true, batchEstimate);
    const generated = await req(cdp, "avatars.generateCandidates", { avatarId, acceptedWorstMicros: field(batchEstimate, "result", "worstMicros") });
    check("avatar scenario: avatars.generateCandidates starts a job", field(generated, "ok") === true, generated);
    const jobId = field(generated, "result", "jobId");

    // 3. Wait for the job's end: a bounded poll of the events the page already collects, no fixed sleep.
    const end = await waitFor(
      "the candidate job to end",
      async () => {
        const found = await cdp.evaluate(
          `window.__smoke.events.find((e) => (e.type === "job.done" || e.type === "job.failed" || e.type === "job.cancelled") && e.payload.jobId === ${JSON.stringify(jobId)})`,
        );
        return found === undefined ? null : found;
      },
      30_000,
    );
    check("avatar scenario: the candidate batch finished as job.done", field(end, "type") === "job.done", end);
    const candidates = field(end, "payload", "result", "candidates");
    const failedSlots = field(end, "payload", "result", "failedSlots");
    check(
      "avatar scenario: with the image age check off (the app's default), all 4 candidates pass — no age check, so nothing to reject",
      Array.isArray(candidates) &&
        candidates.length === 4 &&
        field(end, "payload", "result", "rejectedByAgeCheck") === 0 &&
        Array.isArray(failedSlots) &&
        failedSlots.length === 0,
      end,
    );

    // 4. All 4 candidates' files exist in the library (checked before the pick below deletes the unpicked ones — invariant 9).
    const beforePick = await filesUnder(libraryRoot);
    const photoDir = `avatars/${String(avatarId)}/photos/`;
    check(
      "avatar scenario: exactly the 4 candidates' image and sidecar files exist in the library",
      Array.isArray(candidates) &&
        candidates.every((c: unknown) => {
          const photoId = String(field(c, "photoId"));
          return beforePick.some((f) => f.startsWith(photoDir) && f.includes(photoId) && f.endsWith(".json")) &&
            beforePick.some((f) => f.startsWith(photoDir) && f.includes(photoId) && !f.endsWith(".json"));
        }) &&
        beforePick.filter((f) => f.startsWith(photoDir) && f.endsWith(".json")).length === 4,
      { candidates, beforePick },
    );

    // 5. Pick one candidate: the draft becomes an active avatar with the chosen master.
    const picked = Array.isArray(candidates) ? candidates[0] : undefined;
    const photoId = field(picked, "photoId");
    const pick = await req(cdp, "avatars.pick", { avatarId, photoId, name: "Zoe" });
    check(
      "avatar scenario: avatars.pick makes the draft an active avatar with the chosen master photo",
      field(pick, "ok") === true && field(pick, "result", "avatar", "status") === "active" && field(pick, "result", "avatar", "masterPhotoId") === photoId,
      pick,
    );

    // 6. studio-media:// serves the new master photo.
    await cdp.evaluate(
      `new Promise((r) => { const i = new Image(); i.onload = () => r(true); i.onerror = () => r(false); i.src = "studio-media://photo/${String(avatarId)}/${String(photoId)}"; })`,
    );
    await Bun.sleep(300);
    const media = statuses.get(`studio-media://photo/${String(avatarId)}/${String(photoId)}`);
    check(
      "avatar scenario: studio-media:// serves the new master photo (200, an image MIME type)",
      media?.status === 200 && Boolean(media.mimeType.startsWith("image/")),
      [...statuses],
    );

    // 7. The Avatars grid (Studio's default screen) shows the new avatar's tile, by its name.
    const tileShown = await waitFor(
      "the new avatar's tile in the Avatars grid",
      async () => {
        const found = await cdp.evaluate(
          `[...document.querySelectorAll("article.avatar-card h2.avatar-name")].some((h) => h.textContent.trim() === "Zoe")`,
        );
        return found === true ? true : null;
      },
      10_000,
    );
    check("avatar scenario: the Avatars grid shows the new avatar's tile", tileShown === true);

    // 8. Money: the ledger total is exactly the sum of the mock's charged costs, and nothing is left open.
    const expectedMicros = Math.round(mock.totalUsageUsd() * 1_000_000);
    const money = await req(cdp, "money.status");
    check(
      "avatar scenario: money.status' ledger total equals the mock's charged costs, no open reserves",
      field(money, "ok") === true &&
        field(money, "result", "ledger") === "open" &&
        field(money, "result", "spentMicros") === expectedMicros &&
        field(money, "result", "unsettledMicros") === 0 &&
        field(money, "result", "unsettledCount") === 0 &&
        field(money, "result", "reconcileNeeded") === false,
      { money, expectedMicros },
    );

    // 9. money.reconcile against the mock's /credits: a bounded poll for the
    // reconcile wait (studio/engine/money/reconcile.ts's RECONCILE_QUIET_MS:
    // 2 minutes in production, 5 s in this E2E build) to pass, never a fixed
    // sleep past what the engine itself reports. Thanks to the baseline reconcile above, this is a real
    // comparison (M2 of the whole-slice review), not the "no baseline"
    // branch: creditsDeltaMicros is /credits' usage since that baseline —
    // exactly the mock's charged total — checked against the ledger total
    // for the same window, and they must match with no mismatch.
    const reconciled = await waitFor(
      "money.reconcile past its quiet window",
      async () => {
        const r = await req(cdp, "money.reconcile");
        if (field(r, "ok") !== true || field(r, "result", "status") === "too-early") return null;
        return r;
      },
      60_000,
    );
    check(
      "avatar scenario: money.reconcile against the mock's /credits is a real comparison — the delta equals the mock's charged total and the ledger total, and mismatch is false",
      field(reconciled, "result", "status") === "done" &&
        field(reconciled, "result", "deltaUnavailable") === null &&
        field(reconciled, "result", "creditsDeltaMicros") === expectedMicros &&
        field(reconciled, "result", "ledgerDeltaMicros") === expectedMicros &&
        field(reconciled, "result", "mismatch") === false,
      { reconciled, expectedMicros },
    );

    // 10. Every request the engine made went to the mock, exactly the expected sequence, and no unknown route was hit.
    check("avatar scenario: no request to the mock was on an unexpected route", mock.unexpected.length === 0, mock.unexpected);
    check(
      "avatar scenario: the mock saw exactly 1 descriptor call, 4 image calls and no age checks (the toggle is off)",
      mock.descriptorRequests().length === 1 && mock.imageRequests().length === 4 && mock.ageCheckRequests().length === 0,
      mock.requests,
    );

    // 11. The marker vibe reaches the mock only in the descriptor request (T6a-2b's network canary).
    const carrying = mock.requests.filter(carriesMarker);
    check(
      "avatar scenario: the marker vibe appears in the mock's requests only in the descriptor call",
      carrying.length === 1 && carrying[0]?.schemaName === "avatar_descriptor",
      carrying.map((r) => ({ method: r.method, path: r.path, schemaName: r.schemaName, matched: markerMatch(r, AVATAR_MARKER_WORDS) })),
    );

    // 12. Every authenticated request the mock saw carried exactly Bearer
    // <the fake key> (M4): the price-fetch GETs are OpenRouter's public
    // pricing endpoints and send no Authorization at all
    // (studio/engine/openrouter/priceFetch.ts), so this checks every other
    // route — the descriptor, the 4 image calls (no age checks: the toggle is
    // off) and both reconciles' /credits.
    const authenticated = mock.requests.filter((r) => !r.path.endsWith("/endpoints") && r.path !== "/api/v1/models");
    check(
      "avatar scenario: every authenticated request to the mock carried exactly Bearer <the fake key>",
      authenticated.length === 1 + 4 + 0 + 2 && authenticated.every((r) => r.authorization === `Bearer ${SMOKE_KEY}`),
      authenticated.map((r) => ({ path: r.path, auth: authorizationLabel(r, SMOKE_KEY) })),
    );

    // 13. A cheap plumbing check that the toggle itself works end to end
    // through the real app (renderer → main → engine), without a second full
    // avatar/candidate cycle: settings.setImageAgeCheck reaches the engine
    // and its answer reports the new value. The age-check behaviour itself
    // (on) is already covered by the engine test suite — see the comment on
    // runAvatarScenario above.
    const toggledOn = await req(cdp, "settings.setImageAgeCheck", { imageAgeCheck: "on" });
    check(
      "avatar scenario: settings.setImageAgeCheck reaches the engine and reports the new value",
      field(toggledOn, "ok") === true && field(toggledOn, "result", "imageAgeCheck") === "on",
      toggledOn,
    );
    const toggledOff = await req(cdp, "settings.setImageAgeCheck", { imageAgeCheck: "off" });
    check(
      "avatar scenario: settings.setImageAgeCheck can turn it back off",
      field(toggledOff, "ok") === true && field(toggledOff, "result", "imageAgeCheck") === "off",
      toggledOff,
    );

    // 14. The fake key appears nowhere in the temp userData or the library —
    // and nowhere in the app's captured output either — except as
    // ciphertext inside secrets.bin (M4).
    const secretsBlob = await readFile(join(userData, "secrets.bin")).catch(() => null);
    check(
      "avatar scenario: secrets.bin holds ciphertext, not the fake key",
      secretsBlob !== null && secretsBlob.length > 0 && !secretsBlob.toString("latin1").includes(SMOKE_KEY),
    );
    // A scan of nothing would pass vacuously: both trees must actually hold
    // files (the scenario's own writes above) before "0 leaks" means anything.
    const userDataFiles = await filesUnder(userData);
    const libraryFiles = await filesUnder(libraryRoot);
    check(
      "avatar scenario: the key-leak scan has files to scan (userData and the library are non-empty)",
      userDataFiles.length > 0 && libraryFiles.length > 0,
      { userDataFileCount: userDataFiles.length, libraryFileCount: libraryFiles.length },
    );
    const userDataLeaks: string[] = [];
    for (const name of userDataFiles) {
      if (name === "secrets.bin") continue;
      try {
        if ((await readFile(join(userData, name))).toString("latin1").includes(SMOKE_KEY)) userDataLeaks.push(name);
      } catch {
        // a file that vanished between the listing and the read
      }
    }
    check("avatar scenario: the fake key appears nowhere else in userData", userDataLeaks.length === 0, userDataLeaks);
    const libraryLeaks: string[] = [];
    for (const name of libraryFiles) {
      try {
        if ((await readFile(join(libraryRoot, name))).toString("latin1").includes(SMOKE_KEY)) libraryLeaks.push(name);
      } catch {
        // a file that vanished between the listing and the read
      }
    }
    check("avatar scenario: the fake key appears nowhere in the library", libraryLeaks.length === 0, libraryLeaks);
    check("avatar scenario: the fake key never appeared in the app's captured stdout/stderr", !running.output().includes(SMOKE_KEY));
  } finally {
    await quit(running);
    await mock.stop();
    await removeTemp(tmp);
  }
}

// ---------- studio-media:// routes (3b.1) ----------

/** A real 2 s H.264/AAC MP4 from the bundled ffmpeg, with its index (moov) at the END, so a player must seek with Range to play it. Never a committed blob. */
function renderSmokeVideo(path: string): void {
  const r = spawnSync(ffmpegPath(), [
    "-y", "-f", "lavfi", "-i", "testsrc=size=128x128:rate=30:duration=2", "-f", "lavfi", "-i", "sine=duration=2",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path,
  ]);
  if (r.status !== 0) throw new Error(`smoke test could not render a video: ${r.stderr.toString()}`);
}

const MEDIA_ROOT_ID = "smoke-export-root-0001";
const MEDIA_VIDEO_ID = "smoke-video-0000001";
const MEDIA_REL = "Smoke/2026-09-30_photo_001.mp4";

/** The export folder with its marker, the video file and a poster, before launch; the record is written later (`writeMediaRecord`) so `videos.list` is empty when the earlier checks look. */
async function prepareMediaFixtures(exportRoot: string, avatarId: string, libraryRoot: string, poster: Uint8Array): Promise<void> {
  await mkdir(join(exportRoot, "Smoke"), { recursive: true });
  await writeFile(join(exportRoot, EXPORT_MARKER_FILE), JSON.stringify({ schemaVersion: 1, rootId: MEDIA_ROOT_ID, createdAt: new Date().toISOString() }));
  renderSmokeVideo(join(exportRoot, MEDIA_REL));
  const videosDir = videoPaths(libraryRoot, avatarId).videosDir;
  await mkdir(videosDir, { recursive: true });
  await writeFile(join(videosDir, `${MEDIA_VIDEO_ID}.poster.png`), poster);
}

async function writeMediaRecord(exportRoot: string, libraryRoot: string, avatarId: string, photoId: string): Promise<string> {
  const file = join(exportRoot, MEDIA_REL);
  const bytes = await readFile(file);
  const record = {
    ...videoRecordJson(MEDIA_VIDEO_ID, sceneSpec(avatarId, [photoId])),
    jobId: "smoke-job-media-0001",
    montageId: null,
    music: null,
    file: { rootId: MEDIA_ROOT_ID, relPath: MEDIA_REL, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), mtimeMs: Math.floor((await stat(file)).mtimeMs) },
  };
  const path = videoPaths(libraryRoot, avatarId).record(MEDIA_VIDEO_ID);
  await writeFile(path, JSON.stringify(record));
  return path;
}

// ---------- import an existing avatar end-to-end scenario (T6c) ----------

/** T6c has no owner-authored vibe at all (traits come from the vision call); the entered name is the only user text that could leak. */
const IMPORT_MARKER_NAME = "zebra-lantern-nina";

/** A real, valid, non-animated PNG (roughly 3:4), rendered once by the bundled ffmpeg — never a committed binary blob, and never touched by the app's own dialog (main reads it from disk, at the path --studio-pick-import-file names). */
function renderImportPhoto(): Uint8Array {
  const r = spawnSync(ffmpegPath(), [
    "-f", "lavfi", "-i", "mandelbrot=size=300x400",
    "-frames:v", "1", "-f", "image2pipe", "-c:v", "png", "pipe:1",
  ]);
  if (r.status !== 0) throw new Error(`smoke test could not render an import photo: ${r.stderr.toString()}`);
  return new Uint8Array(r.stdout);
}

/**
 * T6c: importing an existing avatar from one photo the owner already has,
 * end to end against the mock OpenRouter — its own app instance, its own
 * temp userData and library, its own mock server, kept apart from the avatar
 * scenario above. The renderer never sends a path or raw bytes (design
 * constraint 1): main's own dialog answers with --studio-pick-import-file
 * (an E2E-only switch, compiled out of production exactly like
 * --studio-pick-folder), reads that file itself, and only then does the
 * command chain (pick → estimate → accept) begin.
 */
async function runImportScenario(target: Target): Promise<void> {
  const mock = await startMockOpenRouter({
    descriptorText: AVATAR_DESCRIPTOR,
  });
  const tmp = await mkdtemp(join(tmpdir(), "studio-smoke-import-"));
  const userData = join(tmp, "userData");
  const libraryRoot = join(tmp, "import-library");
  const photoPath = join(tmp, "master.png");
  await mkdir(userData, { recursive: true });
  await mkdir(libraryRoot, { recursive: true });
  await Bun.write(photoPath, renderImportPhoto());

  const running = await launch(target, userData, [
    `--studio-openrouter-base-url=${mock.url}`,
    `--studio-pick-folder=${libraryRoot}`,
    `--studio-pick-import-file=${photoPath}`,
  ]);
  try {
    const { cdp } = running;

    const keySet = await req(cdp, "settings.setApiKey", { key: SMOKE_KEY });
    check("import scenario: settings.setApiKey stores the fake key", field(keySet, "ok") === true, keySet);

    const libSet = await req(cdp, "settings.setLibraryPath", { path: libraryRoot });
    check(
      "import scenario: settings.setLibraryPath adopts the temp library (via --studio-pick-folder)",
      field(libSet, "ok") === true && field(libSet, "result", "libraryPath") === libraryRoot,
      libSet,
    );

    // 0. A baseline reconcile before any paid call, for the same reason as the avatar scenario's own.
    const baseline = await req(cdp, "money.reconcile");
    check(
      "import scenario: the baseline reconcile (before any paid call) succeeds at once, with no delta yet to compare",
      field(baseline, "ok") === true && field(baseline, "result", "status") === "done" && field(baseline, "result", "deltaUnavailable") === "no-baseline",
      baseline,
    );

    // 1. Design constraint 1: pick (main's own dialog, answered here by
    // --studio-pick-import-file — the renderer never sends a path or raw
    // bytes), then estimate for that exact staged photo.
    const picked = await req(cdp, "avatars.pickImportPhoto", {});
    check(
      "import scenario: avatars.pickImportPhoto stages the photo main's dialog answered with (via --studio-pick-import-file)",
      field(picked, "ok") === true && field(picked, "result", "picked") === true && typeof field(picked, "result", "stagingId") === "string",
      picked,
    );
    const stagingId = field(picked, "result", "stagingId");

    const estimate = await req(cdp, "avatars.estimateImport", { stagingId });
    check(
      "import scenario: avatars.estimateImport prices up to two describe attempts and no age check",
      field(estimate, "ok") === true && typeof field(estimate, "result", "worstMicros") === "number",
      estimate,
    );

    // 2. Confirm the import: the vision describe call (no age check, no AI-persona confirmation).
    const imported = await req(cdp, "avatars.importAvatar", {
      stagingId,
      name: IMPORT_MARKER_NAME,
      acceptedWorstMicros: field(estimate, "result", "worstMicros"),
    });
    check("import scenario: avatars.importAvatar writes a new active avatar", field(imported, "ok") === true, imported);
    const avatarId = field(imported, "result", "avatar", "avatarId");
    const masterPhotoId = field(imported, "result", "avatar", "masterPhotoId");
    check(
      "import scenario: the new avatar is active, with the vision job's own descriptor",
      field(imported, "result", "avatar", "status") === "active" &&
        field(imported, "result", "avatar", "descriptor", "text") === DEFAULT_IMPORT_DESCRIBE_ANSWER.descriptor,
      imported,
    );

    // 3. The library: the master photo's sidecar marks it imported (invariant
    // 9 widened: "generated, or the owner's import"), with no age verdict
    // and no AI-persona confirmation written (owner decision 2026-10-05).
    const { library } = await openLibrary(libraryRoot);
    const manifest = library.getAvatar(String(avatarId));
    const photo = manifest?.masterPhotoId ? library.getPhoto(manifest.masterPhotoId) : undefined;
    check(
      "import scenario: the master photo's sidecar records the import, not a generated frame, with no age verdict and no confirmation",
      photo?.source.kind === "imported" && photo.qa.age === undefined && !("confirmedAiPersona" in photo.source),
      photo,
    );

    // 4. studio-media:// serves the imported master, exactly like a generated one.
    const loaded = await cdp.evaluate(
      `new Promise((r) => { const i = new Image(); i.onload = () => r(true); i.onerror = () => r(false); i.src = "studio-media://photo/${String(avatarId)}/${String(masterPhotoId)}"; })`,
    );
    check("import scenario: studio-media:// serves the imported master photo (invariant 9 widened)", loaded === true);

    // 5. Exactly one describe attempt reached the mock, no age check; the import never generates an image.
    check(
      "import scenario: the mock saw exactly one describe attempt, no age check, no image generation",
      mock.ageCheckRequests().length === 0 && mock.importDescribeRequests().length === 1 && mock.imageRequests().length === 0,
      mock.requests,
    );
    check("import scenario: no request to the mock was on an unexpected route", mock.unexpected.length === 0, mock.unexpected);

    // 6. The owner's entered name never reaches the mock: T6c has no vibe at
    // all (traits come from the vision call), so the name is the only user
    // text at risk of leaking into a request (mirrors engine.canary.test.ts's own check).
    const nameLeaks = mock.requests.filter((r) => JSON.stringify(r.body).toLowerCase().includes(IMPORT_MARKER_NAME.toLowerCase()));
    check("import scenario: the owner's entered name never reaches the mock", nameLeaks.length === 0, nameLeaks);

    // 7. Money: one describe attempt, exactly the mock's charged costs, nothing left open.
    const expectedMicros = Math.round(mock.totalUsageUsd() * 1_000_000);
    const money = await req(cdp, "money.status");
    check(
      "import scenario: money.status' ledger total equals the mock's charged costs, no open reserves",
      field(money, "ok") === true &&
        field(money, "result", "ledger") === "open" &&
        field(money, "result", "spentMicros") === expectedMicros &&
        field(money, "result", "unsettledMicros") === 0 &&
        field(money, "result", "unsettledCount") === 0,
      { money, expectedMicros },
    );
  } finally {
    await quit(running);
    await mock.stop();
    await removeTemp(tmp);
  }
}

// ---------- own media: the import job, the records, the dialog stand-in (3f.1b) ----------

/**
 * The own-media import in the real build, on both operating systems: main's dialog stand-in (`--studio-pick-media`) names ONE path; the
 * file there is rewritten between picks. A PNG goes through the whole job in the packaged engine (copy into `media/.staging`, the E2E
 * build's real photo importer (3f.2: WASM decode, upright, re-encoded as a JPEG without metadata), the stored file and its record, written with the Windows retries and the fsyncs of the library's own
 * helpers), then the record is listed, survives an app restart and is deleted with its file. A 1x1 picture and an animated WebP fail inside their jobs (too-small, animated-webp), and so does an M4A head
 * with no stream in it (format, 3f.4). A video and a sticker are refused where the engine says: no importer yet. At the end (3f.4) a real WAV is imported as an own TRACK by the packaged music importer
 * (the packaged ffmpeg: probe, pinned encode, check of the output), its waveform is answered by `music.peaks`, and it is deleted. Nothing is sent to the network.
 */
async function runPackagedMediaScenario(target: Target): Promise<void> {
  const tmp = await mkdtemp(join(tmpdir(), "studio-smoke-media-"));
  const userData = join(tmp, "userData");
  const libraryRoot = join(tmp, "media-library");
  const pickedDir = join(tmp, "picked");
  // The name says photo whatever the bytes are: the kind is read from the bytes, never from the name.
  const pickedPath = join(pickedDir, MEDIA_SMOKE_STORED.name);
  await mkdir(userData, { recursive: true });
  await mkdir(pickedDir, { recursive: true });
  await mkdir(libraryRoot, { recursive: true });
  // The library file, so that the folder is a library the engine adopts (and not a folder it refuses for holding other things).
  await openLibrary(libraryRoot);
  const mediaDir = join(libraryRoot, "media");
  const stagingDir = join(mediaDir, ".staging");
  // What a crash of an earlier life left: a copy, a part file, a record's temp file, a stored file with no record.
  await mkdir(stagingDir, { recursive: true });
  await Bun.write(join(stagingDir, ".old-00000001.part"), "half a copy");
  await Bun.write(join(stagingDir, "old-00000001.media"), "a whole copy");
  await Bun.write(join(mediaDir, ".media-00000009.json.0123456789ab.tmp"), "half a record");
  await Bun.write(join(mediaDir, "orphan-00000001.png"), "a stored file with no record");

  const args = [`--studio-pick-folder=${libraryRoot}`, `--studio-pick-media=${pickedPath}`];
  let running = await launch(target, userData, args);
  const pick = (kind: string): Promise<unknown> => req(running.cdp, "media.pickImport", { kind });
  const names = async (dir: string): Promise<string[]> => (await readdir(dir).catch(() => [] as string[])).sort();
  const snapshotJobs = async (): Promise<unknown[]> => {
    const snapshot = await req(running.cdp, "engine.snapshot");
    const jobs = field(snapshot, "result", "jobs");
    return Array.isArray(jobs) ? jobs : [];
  };
  try {
    const libSet = await req(running.cdp, "settings.setLibraryPath", { path: libraryRoot });
    check(
      "media scenario: settings.setLibraryPath adopts the temp library (via --studio-pick-folder)",
      field(libSet, "ok") === true && field(libSet, "result", "libraryPath") === libraryRoot,
      libSet,
    );

    // 1. The library opened: media.list waits for its recovery, and what the crash left is gone (nothing but the empty staging folder).
    const empty = await req(running.cdp, "media.list", {});
    check("media scenario: media.list of a new library is empty", field(empty, "ok") === true && field(empty, "result", "total") === 0 && JSON.stringify(field(empty, "result", "media")) === "[]", empty);
    check("media scenario: what a crash left in media/ is removed when the library opens (the orphan stored file and the record's temp file)", (await names(mediaDir)).filter((n) => n !== ".staging").length === 0, await names(mediaDir));
    check("media scenario: what a crash left in the staging folder is removed too", (await names(stagingDir)).length === 0, await names(stagingDir));

    // 2. The photo: a PNG, picked as `any`, becomes a JOB; the job ends with its record.
    const photo = MEDIA_SMOKE_FILES.find((file) => file.label === "photo");
    if (photo === undefined) throw new Error("the smoke's table has no photo");
    await Bun.write(pickedPath, photo.bytes);
    const started = await pick("any");
    const jobIds = field(started, "result", "jobIds");
    check(
      "media scenario: picking a PNG starts one import job, and refuses nothing",
      field(started, "ok") === true && field(started, "result", "picked") === true && Array.isArray(jobIds) && jobIds.length === 1 && JSON.stringify(field(started, "result", "refused")) === "[]",
      started,
    );
    check("media scenario: the answer names a file by its base name and carries no path", !JSON.stringify(started).includes(tmp), started);
    const jobId = Array.isArray(jobIds) ? String(jobIds[0]) : "";
    const ended = await waitFor("the import job to end", async () => (await snapshotJobs()).find((job) => field(job, "jobId") === jobId && field(job, "status") !== "running") ?? null, 30_000, 100);
    check("media scenario: the import job is done, with its record, and it is an import of a photo", field(ended, "status") === "done" && field(ended, "kind") === "import" && field(ended, "mediaKind") === "photo" && field(ended, "done") === field(ended, "total"), ended);
    const mediaId = String(field(ended, "mediaId"));
    const listed = await req(running.cdp, "media.list", {});
    const first = field(listed, "result", "media", "0");
    check(
      "media scenario: media.list has the record: the photo's name, its size from the PNG, and the size of the stored file",
      field(listed, "result", "total") === 1 && field(first, "mediaId") === mediaId && field(first, "kind") === MEDIA_SMOKE_STORED.kind && field(first, "name") === MEDIA_SMOKE_STORED.name && field(first, "width") === MEDIA_SMOKE_STORED.width && field(first, "height") === MEDIA_SMOKE_STORED.height && typeof field(first, "bytes") === "number" && Number(field(first, "bytes")) > 0,
      listed,
    );
    check("media scenario: the record's JSON carries no path", !JSON.stringify(listed).includes(tmp), listed);
    const problems = mediaRecordFileProblems((await names(mediaDir)).filter((n) => n !== ".staging"), mediaId, MEDIA_SMOKE_STORED.extension);
    check("media scenario: media/ holds the stored file and its record and nothing else", problems.length === 0, problems);
    // 3f.2: the stored file is the importer's own JPEG (the PNG decoded by the engine's WASM codec, re-encoded by ffmpeg), never the picked bytes.
    const storedBytes = new Uint8Array(await readFile(join(mediaDir, `${mediaId}.${MEDIA_SMOKE_STORED.extension}`)));
    check("media scenario: the stored file is a JPEG the importer made, not the picked PNG", storedBytes[0] === 0xff && storedBytes[1] === 0xd8 && storedBytes[2] === 0xff && createHash("sha256").update(storedBytes).digest("hex") !== createHash("sha256").update(photo.bytes).digest("hex"));
    check("media scenario: the stored JPEG holds no metadata segment (no JFIF, EXIF, comment or encoder string)", jpegMetadataMarkers(storedBytes).length === 0 && !Buffer.from(storedBytes).includes(Buffer.from("Lavc")), jpegMetadataMarkers(storedBytes));
    const recordText = await readFile(join(mediaDir, `${mediaId}.json`), "utf8");
    check("media scenario: the record on disk names the file by its own name and the picked path nowhere", recordText.includes(`"file": "${mediaId}.${MEDIA_SMOKE_STORED.extension}"`) && !recordText.includes(pickedDir), recordText);
    check("media scenario: the staging folder is empty after the import", (await names(stagingDir)).length === 0, await names(stagingDir));

    // 3. Every other case, through the same dialog stand-in: the bytes decide, whatever the name.
    for (const file of MEDIA_SMOKE_FILES.filter((f) => f.label !== "photo")) {
      await Bun.write(pickedPath, file.bytes);
      const answer = await pick("any");
      if ("failed" in file.expect) {
        // The boundary takes the file (its bytes are a photo's); the photo importer turns it away INSIDE the job, with its reason.
        const wantedReason = file.expect.failed;
        const taken = field(answer, "result", "jobIds");
        const failedId = Array.isArray(taken) && taken.length === 1 ? String(taken[0]) : "";
        const failed = await waitFor(`the ${file.label} import job to end`, async () => (await snapshotJobs()).find((job) => field(job, "jobId") === failedId && field(job, "status") !== "running" && field(job, "status") !== "queued") ?? null, 30_000, 100);
        check(
          `media scenario: the ${file.label} file starts a job that fails as ${wantedReason}, and names no path`,
          failedId !== "" && field(failed, "status") === "failed" && field(failed, "error", "code") === "MEDIA_UNSUPPORTED" && field(failed, "error", "mediaReason") === wantedReason && !JSON.stringify(failed).includes(tmp),
          failed,
        );
        continue;
      }
      const refused = field(answer, "result", "refused", "0");
      const wanted = "refused" in file.expect ? file.expect.refused : "";
      check(
        `media scenario: the ${file.label} file picked as any is refused as ${wanted}, starts no job and names no path`,
        field(answer, "ok") === true && field(answer, "result", "picked") === true && JSON.stringify(field(answer, "result", "jobIds")) === "[]" && field(refused, "reason") === wanted && field(refused, "name") === MEDIA_SMOKE_STORED.name && !JSON.stringify(answer).includes(tmp),
        answer,
      );
    }
    check("media scenario: no refused file left anything in media/ or its staging folder", mediaRecordFileProblems((await names(mediaDir)).filter((n) => n !== ".staging"), mediaId, MEDIA_SMOKE_STORED.extension).length === 0 && (await names(stagingDir)).length === 0, { media: await names(mediaDir), staging: await names(stagingDir) });

    // 4. The window cannot name a file, and the commands of a job that is over or never was.
    const withPath = await req(running.cdp, "media.pickImport", { kind: "photo", path: pickedPath });
    check("media scenario: a pick that names a path is refused by the contract, and nothing is imported", field(withPath, "ok") === false && (await snapshotJobs()).filter((job) => field(job, "kind") === "import").length === MEDIA_SMOKE_FILES.filter((f) => "job" in f.expect || "failed" in f.expect).length, withPath);
    const cancelOver = await req(running.cdp, "media.cancelImport", { jobId });
    check("media scenario: media.cancelImport of a job that is over answers it as it ended, and changes nothing", field(cancelOver, "ok") === true && field(cancelOver, "result", "jobId") === jobId && (await req(running.cdp, "media.list", {}).then((r) => field(r, "result", "total"))) === 1, cancelOver);
    const cancelUnknown = await req(running.cdp, "media.cancelImport", { jobId: "job-00000404" });
    check("media scenario: media.cancelImport of a job that never was is NOT_FOUND", field(cancelUnknown, "ok") === false && field(cancelUnknown, "error", "code") === "NOT_FOUND", cancelUnknown);

    // 5. The app restarts: the record is on disk, and the library's opening lists it again.
    await quit(running);
    running = await launch(target, userData, args);
    const after = await req(running.cdp, "media.list", {});
    check("media scenario: after an app restart the record is listed again, untouched", field(after, "ok") === true && field(after, "result", "total") === 1 && field(after, "result", "media", "0", "mediaId") === mediaId, after);
    check("media scenario: the restart's jobs start clean (the engine's jobs live in memory only)", (await snapshotJobs()).filter((job) => field(job, "kind") === "import").length === 0);

    // 6. Delete: the record and the stored file go; the same id again is NOT_FOUND.
    const removed = await req(running.cdp, "media.delete", { mediaId });
    check("media scenario: media.delete answers the id", field(removed, "ok") === true && field(removed, "result", "mediaId") === mediaId, removed);
    check("media scenario: the record and the stored file are gone from media/", (await names(mediaDir)).filter((n) => n !== ".staging").length === 0, await names(mediaDir));
    const gone = await req(running.cdp, "media.list", {});
    check("media scenario: media.list is empty again", field(gone, "result", "total") === 0, gone);
    const twice = await req(running.cdp, "media.delete", { mediaId });
    check("media scenario: deleting the same id again is NOT_FOUND", field(twice, "ok") === false && field(twice, "error", "code") === "NOT_FOUND", twice);
    check("media scenario: the picked file itself was never touched by any of it", existsSync(pickedPath));

    // 7. Own video (3f.3a): a real HEVC HLG, variable-rate, turned clip goes through the packaged ffmpeg of this operating system.
    await Bun.write(pickedPath, new Uint8Array(await readFile(FIXTURES[MEDIA_SMOKE_CLIP.fixture].file)));
    const clipStarted = await pick("any");
    const clipIds = field(clipStarted, "result", "jobIds");
    const clipJobId = Array.isArray(clipIds) ? String(clipIds[0]) : "";
    check("media scenario: picking the clip starts one import job and refuses nothing", field(clipStarted, "ok") === true && Array.isArray(clipIds) && clipIds.length === 1 && JSON.stringify(field(clipStarted, "result", "refused")) === "[]", clipStarted);
    const clipJob = await waitFor("the clip's import job to end", async () => (await snapshotJobs()).find((job) => field(job, "jobId") === clipJobId && field(job, "status") !== "running" && field(job, "status") !== "queued") ?? null, 180_000, 200);
    check("media scenario: the clip's job is done, and is an import of a video", field(clipJob, "status") === "done" && field(clipJob, "mediaKind") === "video", clipJob);
    const clipId = String(field(clipJob, "mediaId"));
    const clipListed = await req(running.cdp, "media.list", { kind: "video" });
    const clip = field(clipListed, "result", "media", "0");
    const clipDuration = Number(field(clip, "durationMs"));
    check(
      "media scenario: the clip's record says what the mezzanine is: upright (96 x 192), tone-mapped, about 22 frames long at 30 fps, and the source's own variable rate",
      field(clip, "mediaId") === clipId && field(clip, "width") === MEDIA_SMOKE_CLIP.width && field(clip, "height") === MEDIA_SMOKE_CLIP.height && field(clip, "hdrToSdr") === MEDIA_SMOKE_CLIP.hdrToSdr && clipDuration >= MEDIA_SMOKE_CLIP.minDurationMs && clipDuration <= MEDIA_SMOKE_CLIP.maxDurationMs && Math.abs(Number(field(clip, "sourceFps")) - 19.091) < 0.01,
      clip,
    );
    const stored = await probeVideo(join(mediaDir, `${clipId}.mp4`)).catch(() => null);
    const storedVideo = stored?.streams.find((s) => s.codec_type === "video");
    check("media scenario: the stored file is an H.264 mezzanine of 96 x 192 (ffprobe's own reading)", storedVideo?.codec_name === "h264" && storedVideo.width === MEDIA_SMOKE_CLIP.width && storedVideo.height === MEDIA_SMOKE_CLIP.height && stored?.streams.length === 1, stored);
    check("media scenario: the clip left only its stored file and its record in media/ and nothing in its staging folder", mediaRecordFileProblems((await names(mediaDir)).filter((n) => n !== ".staging"), clipId, "mp4").length === 0 && (await names(stagingDir)).length === 0, { media: await names(mediaDir), staging: await names(stagingDir) });
    check("media scenario: the clip's record carries no path", !JSON.stringify(clipListed).includes(tmp), clipListed);
    const clipRemoved = await req(running.cdp, "media.delete", { mediaId: clipId });
    check("media scenario: media.delete removes the clip and its file", field(clipRemoved, "ok") === true && (await names(mediaDir)).filter((n) => n !== ".staging").length === 0, clipRemoved);

    // 8. An own TRACK (3f.4): a real WAV through the packaged music importer (probe, pinned encode and check of the output by the packaged ffmpeg), then its
    // waveform through `music.peaks` and its delete. Nothing else is in the library by now, so every count here is the track's own.
    await Bun.write(pickedPath, MEDIA_SMOKE_TRACK.bytes);
    const trackStarted = await pick("any");
    const trackJobIds = field(trackStarted, "result", "jobIds");
    check(
      "media scenario: picking a WAV starts one import job, and refuses nothing",
      field(trackStarted, "ok") === true && Array.isArray(trackJobIds) && trackJobIds.length === 1 && JSON.stringify(field(trackStarted, "result", "refused")) === "[]",
      trackStarted,
    );
    const trackJobId = Array.isArray(trackJobIds) ? String(trackJobIds[0]) : "";
    const trackEnded = await waitFor("the track's import job to end", async () => (await snapshotJobs()).find((job) => field(job, "jobId") === trackJobId && field(job, "status") !== "running" && field(job, "status") !== "queued") ?? null, 60_000, 100);
    check("media scenario: the track's import job is done, and it is an import of audio", field(trackEnded, "status") === "done" && field(trackEnded, "mediaKind") === MEDIA_SMOKE_TRACK.kind, trackEnded);
    const trackId = String(field(trackEnded, "mediaId"));
    const trackListed = await req(running.cdp, "media.list", { kind: "audio" });
    const trackRecord = field(trackListed, "result", "media", "0");
    const trackMs = Number(field(trackRecord, "durationMs"));
    check(
      "media scenario: media.list has the track: its name, its decoded length, no picture size, and no waveform and no path in the answer",
      field(trackListed, "result", "total") === 1 && field(trackRecord, "mediaId") === trackId && field(trackRecord, "kind") === MEDIA_SMOKE_TRACK.kind && field(trackRecord, "name") === MEDIA_SMOKE_STORED.name && field(trackRecord, "width") === null && trackMs >= MEDIA_SMOKE_TRACK.minMs && trackMs <= MEDIA_SMOKE_TRACK.maxMs && !JSON.stringify(trackListed).includes("waveform") && !JSON.stringify(trackListed).includes(tmp),
      trackListed,
    );
    const trackProblems = mediaRecordFileProblems((await names(mediaDir)).filter((n) => n !== ".staging"), trackId, MEDIA_SMOKE_TRACK.extension);
    check("media scenario: media/ holds the stored M4A and its record and nothing else, and the staging folder is empty", trackProblems.length === 0 && (await names(stagingDir)).length === 0, { trackProblems, staging: await names(stagingDir) });
    const trackBytes = new Uint8Array(await readFile(join(mediaDir, `${trackId}.${MEDIA_SMOKE_TRACK.extension}`)));
    check("media scenario: the stored track is an M4A the importer made (brand M4A), with no encoder string and none of the picked file's bytes", Buffer.from(trackBytes.subarray(4, 12)).toString("latin1") === "ftypM4A " && !Buffer.from(trackBytes).includes(Buffer.from("Lavf")) && !Buffer.from(trackBytes).includes(Buffer.from("Lavc")) && createHash("sha256").update(trackBytes).digest("hex") !== createHash("sha256").update(MEDIA_SMOKE_TRACK.bytes).digest("hex"));
    const trackRecordText = await readFile(join(mediaDir, `${trackId}.json`), "utf8");
    check("media scenario: the track's record on disk keeps its waveform, names its file by its own name and the picked path nowhere", trackRecordText.includes('"waveform"') && trackRecordText.includes(`"file": "${trackId}.${MEDIA_SMOKE_TRACK.extension}"`) && !trackRecordText.includes(pickedDir), trackRecordText.slice(0, 400));
    const peaks = await req(running.cdp, "music.peaks", { track: { source: "own", mediaId: trackId }, startMs: 0, durationMs: trackMs, bars: 16 });
    const peaksList = field(peaks, "result", "peaks");
    check("media scenario: music.peaks of the own track answers a waveform of 16 integers from 0 to 1000 with sound in it", field(peaks, "ok") === true && Array.isArray(peaksList) && peaksList.length === 16 && peaksList.every((p) => Number.isInteger(p) && p >= 0 && p <= 1000) && peaksList.some((p) => Number(p) > 0), peaks);
    const trackGone = await req(running.cdp, "media.delete", { mediaId: trackId });
    check("media scenario: the track is deleted with its file, its record and its waveform", field(trackGone, "ok") === true && (await names(mediaDir)).filter((n) => n !== ".staging").length === 0, await names(mediaDir));
    const peaksAfter = await req(running.cdp, "music.peaks", { track: { source: "own", mediaId: trackId }, startMs: 0, durationMs: trackMs, bars: 16 });
    check("media scenario: music.peaks of a deleted track is NOT_FOUND", field(peaksAfter, "ok") === false && field(peaksAfter, "error", "code") === "NOT_FOUND", peaksAfter);
  } finally {
    await quit(running);
    await removeTemp(tmp);
  }
}

// ---------- own stickers: the import job and the preview's bytes (3f.5) ----------

/**
 * The own-sticker import in the real build, on both operating systems: main's dialog stand-in (`--studio-pick-media`) names ONE path whose file is
 * rewritten between picks. A GIF of three frames of 10 cs goes through the whole job in the PACKAGED engine: the bounded GIF reader, the packaged
 * ffmpeg's two decodes (the count at 30 fps, then the raw frames, with the decoder pinned), the encode in its own worker thread loaded from inside
 * app.asar, and the stored APNG with its record (the canvas, a loop of 9 and delays of 3 slots on the 30 fps grid). Then the preview's door: main answers
 * `media.stickerBytes` with the stored file itself (its hash is the stored file's), refuses a file changed on disk since the import, and the built-in
 * `stickers.bytes` never serves a user file. A GIF of one frame fails as `not-animated`, a truncated one as `format`; deleting the media ends the door.
 */
async function runPackagedStickerScenario(target: Target): Promise<void> {
  const tmp = await mkdtemp(join(tmpdir(), "studio-smoke-sticker-"));
  const userData = join(tmp, "userData");
  const libraryRoot = join(tmp, "sticker-library");
  const pickedDir = join(tmp, "picked");
  const pickedPath = join(pickedDir, STICKER_SMOKE_STORED.name);
  await mkdir(userData, { recursive: true });
  await mkdir(pickedDir, { recursive: true });
  await mkdir(libraryRoot, { recursive: true });
  await openLibrary(libraryRoot);
  const mediaDir = join(libraryRoot, "media");
  const stagingDir = join(mediaDir, ".staging");
  const args = [`--studio-pick-folder=${libraryRoot}`, `--studio-pick-media=${pickedPath}`];
  const running = await launch(target, userData, args);
  const names = async (dir: string): Promise<string[]> => (await readdir(dir).catch(() => [] as string[])).sort();
  const snapshotJobs = async (): Promise<unknown[]> => {
    const jobs = field(await req(running.cdp, "engine.snapshot"), "result", "jobs");
    return Array.isArray(jobs) ? jobs : [];
  };
  const endOf = (jobId: string, what: string) => waitFor(what, async () => (await snapshotJobs()).find((job) => field(job, "jobId") === jobId && field(job, "status") !== "running" && field(job, "status") !== "queued") ?? null, 60_000, 100);
  const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
  try {
    const libSet = await req(running.cdp, "settings.setLibraryPath", { path: libraryRoot });
    check("sticker scenario: settings.setLibraryPath adopts the temp library (via --studio-pick-folder)", field(libSet, "ok") === true && field(libSet, "result", "libraryPath") === libraryRoot, libSet);

    // 1. The animated GIF becomes a job that ends in a record.
    const animated = STICKER_SMOKE_FILES.find((file) => file.label === "animated-gif");
    if (animated === undefined) throw new Error("the smoke's sticker table has no animated GIF");
    await Bun.write(pickedPath, animated.bytes);
    const started = await req(running.cdp, "media.pickImport", { kind: "any" });
    const jobIds = field(started, "result", "jobIds");
    check("sticker scenario: picking a GIF starts one import job, and refuses nothing", field(started, "ok") === true && Array.isArray(jobIds) && jobIds.length === 1 && JSON.stringify(field(started, "result", "refused")) === "[]", started);
    const jobId = Array.isArray(jobIds) ? String(jobIds[0]) : "";
    const ended = await endOf(jobId, "the sticker import job to end");
    check("sticker scenario: the import job is done, with its record, and it is an import of a sticker", field(ended, "status") === "done" && field(ended, "kind") === "import" && field(ended, "mediaKind") === "sticker", ended);
    const mediaId = String(field(ended, "mediaId"));
    const listed = await req(running.cdp, "media.list", { kind: "sticker" });
    const record = field(listed, "result", "media", "0");
    check(
      "sticker scenario: media.list has the record: the GIF's name and canvas, a loop of 9 frames at 30 fps and 3 slots a frame (10 cs is 3 slots)",
      field(listed, "result", "total") === 1 &&
        field(record, "mediaId") === mediaId &&
        field(record, "kind") === STICKER_SMOKE_STORED.kind &&
        field(record, "name") === STICKER_SMOKE_STORED.name &&
        field(record, "width") === STICKER_SMOKE_STORED.width &&
        field(record, "height") === STICKER_SMOKE_STORED.height &&
        field(record, "loopFrames") === STICKER_SMOKE_STORED.loopFrames &&
        JSON.stringify(field(record, "delayFrames")) === JSON.stringify(STICKER_SMOKE_STORED.delayFrames),
      listed,
    );
    check("sticker scenario: the record carries no path", !JSON.stringify(listed).includes(tmp), listed);
    const storedPath = join(mediaDir, `${mediaId}.${STICKER_SMOKE_STORED.extension}`);
    const stored = new Uint8Array(await readFile(storedPath));
    const inspected = inspectApng(stored);
    check(
      "sticker scenario: the stored file is an APNG the importer made (not the picked GIF) that the strict reader takes, on the record's canvas and loop",
      inspected.ok && inspected.info.width === STICKER_SMOKE_STORED.width && inspected.info.height === STICKER_SMOKE_STORED.height && inspected.info.loopFrames === STICKER_SMOKE_STORED.loopFrames && JSON.stringify(inspected.info.frames.map((f) => f.delayFrames)) === JSON.stringify(STICKER_SMOKE_STORED.delayFrames) && sha256(stored) !== sha256(animated.bytes),
      inspected,
    );
    const recordText = await readFile(join(mediaDir, `${mediaId}.json`), "utf8");
    check("sticker scenario: the record on disk names the file by its own name and the picked path nowhere", recordText.includes(`"file": "${mediaId}.${STICKER_SMOKE_STORED.extension}"`) && !recordText.includes(pickedDir), recordText);
    check("sticker scenario: media/ holds the stored file and its record and nothing else, and the staging folder is empty", mediaRecordFileProblems((await names(mediaDir)).filter((n) => n !== ".staging"), mediaId, STICKER_SMOKE_STORED.extension).length === 0 && (await names(stagingDir)).length === 0, { media: await names(mediaDir), staging: await names(stagingDir) });

    // 2. The preview's door, in the real main.
    const bytesAnswer = await req(running.cdp, "media.stickerBytes", { mediaId });
    const sent = typeof field(bytesAnswer, "result", "apngBase64") === "string" ? new Uint8Array(Buffer.from(String(field(bytesAnswer, "result", "apngBase64")), "base64")) : new Uint8Array(0);
    check("sticker scenario: media.stickerBytes answers the stored file itself, byte for byte, and no path", field(bytesAnswer, "ok") === true && field(bytesAnswer, "result", "mediaId") === mediaId && sha256(sent) === sha256(stored) && !JSON.stringify({ ...(bytesAnswer as object), result: undefined }).includes(tmp), { ok: field(bytesAnswer, "ok"), sent: sent.length, stored: stored.length });
    const builtIn = await req(running.cdp, "stickers.bytes", { stickerId: mediaId });
    check("sticker scenario: the built-in stickers.bytes never serves a user file: a media id is NOT_FOUND there", field(builtIn, "ok") === false && field(builtIn, "error", "code") === "NOT_FOUND", builtIn);
    const unknown = await req(running.cdp, "media.stickerBytes", { mediaId: "media-00000404" });
    check("sticker scenario: media.stickerBytes of a media nobody holds is NOT_FOUND, with the fixed text", field(unknown, "ok") === false && field(unknown, "error", "code") === "NOT_FOUND" && field(unknown, "error", "detail") === "no such own sticker", unknown);
    // A file changed on disk since the import (same size): main refuses it and sends none of it.
    const changed = Uint8Array.from(stored);
    changed[changed.length - 20] = (changed[changed.length - 20] ?? 0) ^ 0xff;
    await writeFile(storedPath, changed);
    const tampered = await req(running.cdp, "media.stickerBytes", { mediaId });
    check("sticker scenario: a file changed since the import is refused with the fixed text, and none of it is sent", field(tampered, "ok") === false && field(tampered, "error", "code") === "INTERNAL" && field(tampered, "error", "detail") === "the own sticker failed its check" && !JSON.stringify(tampered).includes(tmp), tampered);
    await writeFile(storedPath, stored);
    const restored = await req(running.cdp, "media.stickerBytes", { mediaId });
    check("sticker scenario: with the file put back the same door answers again", field(restored, "ok") === true, restored);

    // 3. A still GIF and a truncated one fail inside their jobs.
    for (const file of STICKER_SMOKE_FILES.filter((f) => f.label !== "animated-gif")) {
      await Bun.write(pickedPath, file.bytes);
      const answer = await req(running.cdp, "media.pickImport", { kind: "any" });
      const wantedReason = "failed" in file.expect ? file.expect.failed : "";
      const taken = field(answer, "result", "jobIds");
      const failedId = Array.isArray(taken) && taken.length === 1 ? String(taken[0]) : "";
      const failed = await endOf(failedId, `the ${file.label} import job to end`);
      check(`sticker scenario: the ${file.label} file starts a job that fails as ${wantedReason}, and names no path`, failedId !== "" && field(failed, "status") === "failed" && field(failed, "error", "code") === "MEDIA_UNSUPPORTED" && field(failed, "error", "mediaReason") === wantedReason && !JSON.stringify(failed).includes(tmp), failed);
    }
    check("sticker scenario: the refused files left nothing in media/ or its staging folder", mediaRecordFileProblems((await names(mediaDir)).filter((n) => n !== ".staging"), mediaId, STICKER_SMOKE_STORED.extension).length === 0 && (await names(stagingDir)).length === 0, { media: await names(mediaDir), staging: await names(stagingDir) });

    // 4. Delete: the door ends with the record.
    const removed = await req(running.cdp, "media.delete", { mediaId });
    check("sticker scenario: media.delete answers the id", field(removed, "ok") === true && field(removed, "result", "mediaId") === mediaId, removed);
    const afterDelete = await req(running.cdp, "media.stickerBytes", { mediaId });
    check("sticker scenario: a deleted sticker's bytes are NOT_FOUND, and its files are gone", field(afterDelete, "ok") === false && field(afterDelete, "error", "code") === "NOT_FOUND" && (await names(mediaDir)).filter((n) => n !== ".staging").length === 0, { answer: afterDelete, media: await names(mediaDir) });
  } finally {
    await quit(running);
    await removeTemp(tmp);
  }
}

// ---------- music: list -> downloads -> music.list -> playback, end to end (3c.4) ----------

const SMOKE_MUSIC_KEY = "smoke-music-key-not-real-7q3z";

/**
 * The track store in the real Electron build, against the mock flashapi and the mock CDN. The tests of 3c.3 and 3c.4 use
 * Bun's `fetch` and `http`; production uses Electron's Node, so this is the run that proves the HTTP path there (the
 * engine's loopback transport is `node:http`; the pinned-address `node:https` one can only meet the real CDN, which this
 * smoke never contacts). One list of 30 goes through the whole pipeline; two tracks are spoiled on purpose (a redirect
 * to another allowed host and an HTML page served as audio), so the run also shows that a refused track does not poison
 * the list. Nothing here spends flashapi quota: the key is fake and the server is on loopback.
 */
async function runMusicScenario(target: Target): Promise<void> {
  const listFile = JSON.parse(await readFile(musicLists.kyiv.file, "utf8")) as { response: unknown };
  const parsed = parseFlashapiList(listFile.response);
  if (!parsed.ok) throw new Error("the Kyiv fixture does not parse");
  const SPOILED = [3, 4];
  // The fixtures' URLs expire after 2026-10-01: the list the mock serves gets URLs that live for the whole run.
  const flashapi = startMockFlashapi({ key: SMOKE_MUSIC_KEY, transformResponse: (response) => withFutureExpiry(withExcerptDurations(response), Date.now() + 100 * 3600 * 1000) });
  const cdn = startMockCdn({});
  cdn.override(cdn.downloadPath(3), { status: 302, headers: { location: "https://scontent-fra3-2.cdninstagram.com/elsewhere.m4a" } });
  cdn.override(cdn.downloadPath(4), { body: "<html>not audio</html>", headers: { "content-type": "audio/mp4" } });
  const tmp = await mkdtemp(join(tmpdir(), "studio-smoke-music-"));
  const userData = join(tmp, "userData");
  await mkdir(userData, { recursive: true });
  const args = [`--studio-flashapi-base-url=${flashapi.url}`, `--studio-music-cdn-base-url=${cdn.url}`];
  const kept = parsed.tracks.filter((_track, index) => !SPOILED.includes(index));
  let running = await launch(target, userData, args);
  try {
    const statuses: { url: string; status: number; mimeType: string; contentRange: string | null }[] = [];
    running.cdp.on((method, params) => {
      if (method !== "Network.responseReceived") return;
      const url = field(params, "response", "url");
      if (typeof url !== "string" || !url.startsWith("studio-media://track/")) return;
      const headers = field(params, "response", "headers");
      const range = typeof headers === "object" && headers !== null ? Object.entries(headers).find(([k]) => k.toLowerCase() === "content-range")?.[1] : undefined;
      statuses.push({ url, status: Number(field(params, "response", "status")), mimeType: String(field(params, "response", "mimeType")), contentRange: typeof range === "string" ? range : null });
    });
    await running.cdp.send("Network.enable");

    const keySet = await req(running.cdp, "settings.setMusicKey", { key: SMOKE_MUSIC_KEY });
    check("music scenario: settings.setMusicKey stores the fake key", field(keySet, "ok") === true, keySet);
    const empty = await req(running.cdp, "music.list");
    check("music scenario: music.list is empty before any refresh", field(empty, "ok") === true && JSON.stringify(field(empty, "result", "tracks")) === "[]", empty);

    // 1. The refresh: answers at once, runs in the background, ends idle.
    const started = await req(running.cdp, "music.refresh", { confirm: true });
    check("music scenario: music.refresh answers at once with the refresh running", field(started, "ok") === true && field(started, "result", "status", "refresh", "state") === "running", started);
    const ended = await waitFor(
      "the music refresh to end",
      async () => {
        const status = await req(running.cdp, "music.status");
        const state = field(status, "result", "refresh", "state");
        return state === "idle" || state === "failed" ? status : null;
      },
      120_000,
      500,
    );
    check("music scenario: the refresh ends idle", field(ended, "result", "refresh", "state") === "idle", ended);
    check("music scenario: the status counts the tracks that were stored, and the bytes", field(ended, "result", "trackCount") === kept.length && Number(field(ended, "result", "bytesOnDisk")) > 0 && typeof field(ended, "result", "listFetchedAt") === "string", ended);
    check("music scenario: one request was counted", field(ended, "result", "sentLast31d") === 1, ended);

    // 2. music.list: the tracks that passed, none of the two spoiled ones.
    const listed = await req(running.cdp, "music.list");
    const tracks = Array.isArray(field(listed, "result", "tracks")) ? (field(listed, "result", "tracks") as unknown[]) : [];
    check("music scenario: music.list holds every track that was stored and none of the refused two", tracks.length === kept.length && SPOILED.every((i) => !tracks.some((t) => field(t, "trackId") === parsed.tracks[i]?.trackId)), tracks.length);
    check("music scenario: music.list keeps explicit per track", tracks.filter((t) => field(t, "explicit") === true).length === kept.filter((t) => t.explicit).length, tracks.length);
    const ascending = tracks.every((t) => {
      const highlights = field(t, "highlights");
      if (!Array.isArray(highlights)) return false;
      const rest = highlights.filter((h) => field(h, "likelyDefault") === false).map((h) => Number(field(h, "ms")));
      const flagged = highlights.filter((h) => field(h, "likelyDefault") === true);
      return rest.every((ms, i) => i === 0 || ms > (rest[i - 1] ?? 0)) && (flagged.length === 0 || (flagged.length === 1 && field(highlights.at(-1), "ms") === 1500));
    });
    check("music scenario: highlights are ascending, a 1500 flagged and last", ascending, tracks.slice(0, 3));
    check("music scenario: music.list answers no URL, path or hash", !/https?:|oh=|oe=|\.m4a|[0-9a-f]{64}|userData/.test(JSON.stringify(tracks)), tracks.slice(0, 1));

    // 3. What is on disk: the stored files are the excerpts byte for byte, and nothing partial or signed is left.
    const musicDir = join(userData, "music");
    const trackFiles = (await readdir(join(musicDir, "tracks"))).sort();
    check("music scenario: a verified .m4a on disk for each stored track, no temp file", trackFiles.length === kept.length && trackFiles.every((name) => /^[a-z0-9-]+\.m4a$/.test(name)), trackFiles.slice(0, 3));
    const firstKept = kept[0];
    const firstIndex = parsed.tracks.findIndex((t) => t.trackId === firstKept?.trackId);
    const onDisk = await readFile(join(musicDir, "tracks", `${firstKept?.trackId}.m4a`));
    check("music scenario: a stored track is the served excerpt, byte for byte", Buffer.from(excerptOf(firstIndex)).equals(onDisk));
    check("music scenario: a cover on disk for each stored track, none for the refused two", (await readdir(join(musicDir, "covers"))).length === kept.length);
    check("music scenario: a waveform on disk for each stored track", (await readdir(join(musicDir, "peaks"))).length === kept.length);
    const record = await readFile(join(musicDir, "lists", "current.json"), "utf8");
    check("music scenario: the list record keeps no signed URL, no dash manifest and no host name once the downloads are done", !/https?:|oh=|oe=|_nc_|dash|manifest|cdninstagram|fbcdn/i.test(record), record.slice(0, 300));
    check("music scenario: the record is complete and says which two were refused", JSON.parse(record).complete === true && JSON.stringify(JSON.parse(record).tracks.filter((t: { audio: { state: string } }) => t.audio.state === "failed").map((t: { audio: { reason: string } }) => t.audio.reason).sort()) === JSON.stringify(["probe:bad-box", "redirect"].sort()), record.slice(0, 200));

    // 4. Playback: the renderer's audio element loads a stored track through studio-media://track with Range.
    const playId = String(firstKept?.trackId);
    const played = await running.cdp.evaluate(`(async () => {
      const once = (el, ok, bad) => new Promise((r) => { el.addEventListener(ok, () => r(true), { once: true }); el.addEventListener(bad, () => r(false), { once: true }); setTimeout(() => r(false), 15000); });
      const a = document.createElement("audio");
      a.muted = true; a.preload = "auto"; a.src = "studio-media://track/${playId}";
      const meta = await once(a, "loadedmetadata", "error");
      const duration = a.duration;
      const missing = document.createElement("audio");
      missing.src = "studio-media://track/9999999999999999";
      const missingFailed = !(await once(missing, "loadedmetadata", "error"));
      const load = (src) => new Promise((r) => { const i = new Image(); i.onload = () => r({ loaded: true, width: i.naturalWidth }); i.onerror = () => r({ loaded: false }); i.src = src; });
      return { meta, duration, missingFailed, cover: await load("studio-media://cover/${playId}"), noCover: await load("studio-media://cover/9999999999999999") };
    })()`);
    check("music scenario: a stored track loads its metadata through studio-media://track, at the excerpt's length", field(played, "meta") === true && Math.abs(Number(field(played, "duration")) - (EXCERPTS[firstIndex % EXCERPTS.length]?.durationMs ?? 0) / 1000) < 0.3, played);
    await Bun.sleep(300);
    check(
      "music scenario: the track is served as audio/mp4, and Range gets a 206 with a Content-Range",
      statuses.some((s) => s.url.endsWith(playId) && (s.status === 200 || s.status === 206) && s.mimeType === "audio/mp4") &&
        statuses.some((s) => s.status === 206 && s.contentRange !== null && /^bytes \d+-\d+\/\d+$/.test(s.contentRange)),
      statuses,
    );
    check("music scenario: a track that is not stored does not load (404)", field(played, "missingFailed") === true && statuses.some((s) => s.url.endsWith("9999999999999999") && s.status === 404), [played, statuses]);
    check("music scenario: the cover loads through studio-media://cover, and an unknown one does not", field(played, "cover", "loaded") === true && field(played, "noCover", "loaded") === false, played);

    // 5. The waveform.
    const peaks = await req(running.cdp, "music.peaks", { track: { source: "trending", trackId: playId }, startMs: 0, durationMs: 8000, bars: 72 });
    const bars = field(peaks, "result", "peaks");
    check("music scenario: music.peaks answers 72 integers from 0 to 1000", Array.isArray(bars) && bars.length === 72 && bars.every((v) => Number.isInteger(v) && v >= 0 && v <= 1000) && Math.max(...(bars as number[])) > 0, peaks);
    const noPeaks = await req(running.cdp, "music.peaks", { track: { source: "trending", trackId: "9999999999999999" }, startMs: 0, durationMs: 1000, bars: 16 });
    check("music scenario: music.peaks of a track that is not stored is NOT_FOUND", field(noPeaks, "ok") === false && field(noPeaks, "error", "code") === "NOT_FOUND", noPeaks);

    // 6. What the servers saw: one list request with the key in its header only, and no key or credential at the CDN.
    check("music scenario: exactly one list request left, and it carried the fake key in its header", flashapi.requests.length === 1 && flashapi.requests[0]?.headers["x-rapidapi-key"] === SMOKE_MUSIC_KEY && !flashapi.requests[0]?.url.includes(SMOKE_MUSIC_KEY), flashapi.requests.length);
    check("music scenario: the CDN was asked for 30 tracks and the 28 covers of the ones that passed, and nothing else", cdn.requests.length === 30 + kept.length && cdn.unexpected.length === 0 && flashapi.unexpected.length === 0, { asked: cdn.requests.length, unexpected: cdn.unexpected });
    check(
      "music scenario: no request to the CDN carried the key, a cookie or an authorization",
      cdn.requests.every((r) => !("x-rapidapi-key" in r.headers) && !("cookie" in r.headers) && !("authorization" in r.headers) && !JSON.stringify(r).includes(SMOKE_MUSIC_KEY)),
    );
    check("music scenario: the redirect was not followed: its track was asked for once, and nothing was asked for at the redirect's target", cdn.requests.filter((r) => r.path === cdn.downloadPath(3)).length === 1 && cdn.requests.every((r) => !r.path.includes("elsewhere")));
    check("music scenario: a refused track's cover was never requested", SPOILED.every((i) => !cdn.requests.some((r) => r.path === cdn.coverPath(i))));

    // 7. The key and the signed URLs stay out of everything the app wrote or printed.
    const leaks: string[] = [];
    for (const name of await readdir(userData, { recursive: true })) {
      const path = join(userData, name);
      if (name === "secrets.bin" || !existsSync(path)) continue;
      try {
        const text = (await readFile(path)).toString("latin1");
        if (text.includes(SMOKE_MUSIC_KEY) || /\boh=[0-9A-Za-z_]{8,}/.test(text)) leaks.push(name);
      } catch {
        // A directory.
      }
    }
    check("music scenario: nothing under userData holds the music key or a signed URL (secrets.bin aside)", leaks.length === 0, leaks);
    check("music scenario: nothing the app printed holds the music key or a signed URL", !running.output().includes(SMOKE_MUSIC_KEY) && !/\boh=[0-9A-Za-z_]{8,}/.test(running.output()), running.output().slice(-400));

    // 8. A restart: the list, the tracks and the count are back with no request.
    await quit(running);
    running = await launchWithRetry(target, userData, 3, args);
    const again = await req(running.cdp, "music.list");
    check("music scenario: after a restart music.list holds the same tracks", Array.isArray(field(again, "result", "tracks")) && (field(again, "result", "tracks") as unknown[]).length === kept.length, again);
    const againStatus = await req(running.cdp, "music.status");
    check("music scenario: after a restart the status has the count and the list time, idle, with no new request", field(againStatus, "result", "trackCount") === kept.length && field(againStatus, "result", "refresh", "state") === "idle" && flashapi.requests.length === 1 && cdn.requests.length === 30 + kept.length, againStatus);
  } finally {
    await quit(running);
    await flashapi.stop();
    await cdn.stop();
    await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
}

// ---------- photo run: kill -9 + resume end-to-end scenario (slice 2b, T6) ----------

/** A run's slot the plan committed to, once launched: enough for `req(cdp, "runs.*", ...)` payloads below. */
const RUN_CATEGORIES = ["home"];
const RUN_POSES = { profile: false, back: false };

/**
 * Every request the mock holds this long before answering, after recording
 * it: long enough that a 20-photo run (network pool of 6) is still genuinely
 * mid-flight when this scenario polls for it, short enough that the whole
 * scenario stays fast.
 */
const RUN_REQUEST_DELAY_MS = 700;

/** `listResult` (a `runs.list` response) → the one `RunSummary` for `runId`, or undefined. */
function findRunSummary(listResult: unknown, runId: unknown): unknown {
  const runs = field(listResult, "result", "runs");
  return Array.isArray(runs) ? runs.find((r: unknown) => field(r, "runId") === runId) : undefined;
}

/** Whichever of job.done/job.failed/job.cancelled came in for `jobId`, or null until one has. */
async function endEventOf(cdp: Cdp, jobId: unknown): Promise<unknown> {
  const found = await cdp.evaluate(
    `window.__smoke.events.find((e) => (e.type === "job.done" || e.type === "job.failed" || e.type === "job.cancelled") && e.payload.jobId === ${JSON.stringify(jobId)}) ?? null`,
  );
  return found === null ? null : found;
}

/**
 * The distinct attempt ids `userData/ledger.jsonl` has a `reserve` line for,
 * among those starting with `prefix` — read as plain bytes, never through
 * the `Ledger` class (which the live engine's own `Budget` already owns;
 * this only reads, like every other direct userData/library read in this
 * file). A reserve is written before its request leaves (invariant 2), and
 * `Budget.tryReserve` checks the persisted ledger itself, not only this
 * process's memory, so a reused attempt id throws `ATTEMPT_ID_REUSED`
 * whichever process — this engine boot or an earlier, crashed one — reserved
 * it first (money/budget.ts): every id here was reserved at most once, ever.
 *
 * Tolerates only a torn *last* line (a crash mid-append), exactly like
 * `Ledger`'s own reader (money/ledger.ts's `load()`, ~lines 283-305): a line
 * counts as "last" when nothing meaningful follows it, whether or not it
 * ends in a newline. An unparseable line anywhere else is real corruption,
 * not a crash artefact, and throws — this reader has no business silently
 * hiding that from a check whose whole point is proving nothing was missed.
 */
async function reservedAttemptIds(userData: string, prefix: string): Promise<string[]> {
  const path = join(userData, "ledger.jsonl");
  const bytes = await readFile(path).catch(() => null);
  if (bytes === null) return [];
  const ids = new Set<string>();
  let start = 0;
  let lineNo = 0;
  while (start < bytes.length) {
    lineNo++;
    const newline = bytes.indexOf(0x0a, start);
    const terminated = newline !== -1;
    const end = terminated ? newline : bytes.length;
    const isLast = !terminated || end + 1 >= bytes.length;
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.subarray(start, end).toString("utf8"));
    } catch (error) {
      if (isLast) break; // a torn last line: tolerated, like Ledger's own reader
      throw new Error(`${path}:${lineNo} is not valid JSON — a corrupt middle line, not a torn tail: ${String(error)}`);
    }
    if (field(parsed, "type") === "reserve") {
      const attemptId = field(parsed, "attemptId");
      if (typeof attemptId === "string" && attemptId.startsWith(prefix)) ids.add(attemptId);
    }
    start = end + 1;
  }
  return [...ids];
}

/**
 * Creates one active avatar the same way the avatar scenario does (its own
 * draft → candidates → pick), so this scenario's photo run has a master
 * photo to reference. Kept apart from `runAvatarScenario`'s own avatar: this
 * scenario needs its own money and mock traffic, undisturbed by another
 * scenario's checks.
 */
async function createActiveAvatarForRun(cdp: Cdp, name: string): Promise<unknown> {
  const estimate = await req(cdp, "avatars.estimate", { traits: AVATAR_TRAITS });
  const draft = await req(cdp, "avatars.createDraft", { traits: AVATAR_TRAITS, acceptedWorstMicros: field(estimate, "result", "worstMicros") });
  check("run scenario: avatars.createDraft writes the descriptor and a draft", field(draft, "ok") === true, draft);
  const avatarId = field(draft, "result", "draft", "avatarId");
  const batchEstimate = await req(cdp, "avatars.estimateCandidates", { avatarId });
  const generated = await req(cdp, "avatars.generateCandidates", { avatarId, acceptedWorstMicros: field(batchEstimate, "result", "worstMicros") });
  const jobId = field(generated, "result", "jobId");
  const done = await waitFor("the run scenario's own candidate job to end", () => endEventOf(cdp, jobId), 30_000);
  check("run scenario: the candidate batch finished as job.done", field(done, "type") === "job.done", done);
  const candidates = field(done, "payload", "result", "candidates");
  const firstCandidate = Array.isArray(candidates) ? candidates[0] : undefined;
  const pick = await req(cdp, "avatars.pick", { avatarId, photoId: field(firstCandidate, "photoId"), name });
  check(
    "run scenario: avatars.pick makes the draft an active avatar with a master photo",
    field(pick, "ok") === true && field(pick, "result", "avatar", "status") === "active",
    pick,
  );
  return avatarId;
}

/**
 * Slice 2b's own "Done when" (stage-2-plan.md): after `kill -9` in the middle
 * of a 20-photo run and a resume, no attempt id was ever sent twice, the
 * `/credits` delta stays within the ledger's own total, and the run's cap is
 * never exceeded; a second, small run's cancel stops it cleanly too. The
 * T6-decisions follow-up this scenario closes: "the crash tests stop a job
 * in-process; a real kill -9 of the packaged engine mid-run belongs to the
 * E2E smoke."
 *
 * T7b: also this scenario's own asar proof for the face gate (task item 4),
 * since it already runs real photo runs end-to-end in the packaged app —
 * the face gate is wired unconditionally (unlike the age gate, never a
 * Settings toggle), so it runs here whether this scenario asks for it or
 * not; `faceFixture: true` makes the mock serve a real, matching face, real
 * JPEG bytes (studio/engine/face/fixtures, composited onto every run
 * image's own PDQ-distinct background by facePool.ts) instead of a faceless
 * mandelbrot portrait and pattern, so every front/three-quarter slot
 * (RUN_POSES keeps profile/back off) can actually pass instead of retrying
 * forever. L9: `faceMismatchAt` additionally makes exactly one served
 * image — the run's own first slot attempt, past the 4 candidate portraits
 * generated before it — a genuine "no face detected" instead: this
 * scenario's own step 8c proves that slot's first attempt retries and a
 * later attempt passes, not only that the always-matches path works.
 *
 * Its own app instance, its own temp userData and library, its own mock
 * server — kept apart from every other scenario's money and events. The
 * image-age-check toggle stays off (the app's own default): no age-check
 * requests, and no `qa.age` verdict on any photo.
 */
async function runPhotoRunKillResumeScenario(target: Target): Promise<void> {
  // L9: `createActiveAvatarForRun` below always generates exactly 4
  // candidates (avatars.generateCandidates' own fixed batch size) before the
  // run's own first image request — the mismatch index must land AFTER all
  // of them, or it corrupts the master itself instead of a run slot
  // (mockOpenRouter.ts's `buildFacePool` own comment has the full story of
  // the bug this fixed: a mismatch at index 0 made `avatars.pick`'s own
  // `candidates[0]` — always the FIRST generated candidate — a faceless
  // master, failing the whole run as MASTER_FACE_UNUSABLE before any slot
  // ever ran).
  const CANDIDATES_BEFORE_RUN = 4;
  const mock = await startMockOpenRouter({
    descriptorText: AVATAR_DESCRIPTOR,
    imageDelayMs: RUN_REQUEST_DELAY_MS,
    writerDelayMs: RUN_REQUEST_DELAY_MS,
    distinctImages: true,
    faceFixture: true,
    // Exactly one served image — the run's own first slot attempt — is a
    // genuine "no face detected" instead of the matching fixture face, so
    // this scenario also proves a real face-gate retry, not just the
    // always-matches path.
    faceMismatchAt: CANDIDATES_BEFORE_RUN,
  });
  const tmp = await mkdtemp(join(tmpdir(), "studio-smoke-run-"));
  const userData = join(tmp, "userData");
  const libraryRoot = join(tmp, "run-library");
  await mkdir(userData, { recursive: true });
  await mkdir(libraryRoot, { recursive: true });

  const running = await launch(target, userData, [`--studio-openrouter-base-url=${mock.url}`, `--studio-pick-folder=${libraryRoot}`]);
  try {
    const { cdp } = running;
    const mainPid = running.child.pid ?? -1;

    const keySet = await req(cdp, "settings.setApiKey", { key: SMOKE_KEY });
    check("run scenario: settings.setApiKey stores the fake key", field(keySet, "ok") === true, keySet);
    const libSet = await req(cdp, "settings.setLibraryPath", { path: libraryRoot });
    check(
      "run scenario: settings.setLibraryPath adopts the temp library (via --studio-pick-folder)",
      field(libSet, "ok") === true && field(libSet, "result", "libraryPath") === libraryRoot,
      libSet,
    );

    const avatarId = await createActiveAvatarForRun(cdp, "Nova");

    // 1. Price and start a 20-photo run.
    const PHOTO_COUNT = 20;
    const runRequest = { avatarId, count: PHOTO_COUNT, categories: RUN_CATEGORIES, poses: RUN_POSES };
    const runEstimate = await req(cdp, "runs.estimate", runRequest);
    check("run scenario: runs.estimate prices a 20-photo run", field(runEstimate, "ok") === true, runEstimate);
    const startAcceptedWorstMicros = Number(field(runEstimate, "result", "estimate", "worstMicros"));
    const usageBeforeRun = mock.totalUsageUsd();
    const imagesBeforeRun = mock.imageRequests().length;
    const writersBeforeRun = mock.sceneWriterRequests().length;
    const started = await req(cdp, "runs.start", { ...runRequest, acceptedWorstMicros: startAcceptedWorstMicros });
    check("run scenario: runs.start plans and launches the run", field(started, "ok") === true, started);
    const runId = String(field(started, "result", "runId"));
    const firstJobId = field(started, "result", "jobId");

    // 2. Kill on an observed state — some slots done, some still in flight — never a fixed sleep.
    const midFlight = await waitFor(
      "some run slots done and some still in flight (job.progress)",
      async () => {
        const progress = await cdp.evaluate(
          `window.__smoke.events.filter((e) => e.type === "job.progress" && e.payload.jobId === ${JSON.stringify(firstJobId)}).at(-1) ?? null`,
        );
        if (progress === null) return null;
        const done = Number(field(progress, "payload", "done"));
        const total = Number(field(progress, "payload", "total"));
        return done >= 2 && done < total ? progress : null;
      },
      60_000,
    );
    check(
      "run scenario: the run is genuinely mid-flight before the kill (some slots done, total still 20)",
      Number(field(midFlight, "payload", "done")) >= 2 && Number(field(midFlight, "payload", "total")) === PHOTO_COUNT,
      midFlight,
    );

    // 3. kill -9 the engine utilityProcess (Windows: taskkill /F), then wait
    // for its restart — first the crash's own notice (only the *new* engine
    // emits it), then a snapshot that answers again, then its new bootId
    // (main.ts's flow, exactly like the earlier restart-policy check above).
    const enginePidBeforeKill = await waitFor("the engine process", async () => enginePid(mainPid), 5_000);
    hardKill(enginePidBeforeKill);
    const crashEvent = await waitFor(
      "an engine.notice event for this scenario's own engine",
      async () => {
        // By code: any other engine.notice (there is one for a swallowed rejection now) must not be taken for the restart's.
        const events = await cdp.evaluate(`window.__smoke.events.filter((e) => e.type === "engine.notice" && e.payload.notice.code === "engine-restarted")`);
        return Array.isArray(events) && events.length > 0 ? events[0] : null;
      },
      30_000,
    );
    check("run scenario: a killed engine is reported as an engine-restarted notice", field(crashEvent, "payload", "notice", "code") === "engine-restarted", crashEvent);
    const afterKill = await waitFor(
      "a snapshot from the restarted engine",
      async () => {
        const s = await req(cdp, "engine.snapshot");
        return field(s, "ok") === true ? s : null;
      },
      30_000,
    );
    check("run scenario: the restarted engine has a fresh bootId", typeof field(afterKill, "result", "bootId") === "string", afterKill);

    // 4. runs.list shows the run resumable with open slots.
    const listedAfterKill = await req(cdp, "runs.list");
    const summaryAfterKill = findRunSummary(listedAfterKill, runId);
    check(
      "run scenario: runs.list shows the run resumable with open slots after the kill",
      field(summaryAfterKill, "running") === false && field(summaryAfterKill, "resumable") === true && Number(field(summaryAfterKill, "open")) > 0,
      summaryAfterKill,
    );

    // 5. Invariant 4: "after a restart nothing is spent without a user click."
    // The kill left the in-flight attempt's reserve open, owned by an engine
    // process that no longer exists — the resumed engine's own Budget starts
    // with an empty "this process's own reserves" set, so that reserve reads
    // as foreign and every paid command (runs.resume included) is refused
    // RECONCILE_REQUIRED until the owner reconciles. A bounded poll of
    // money.reconcile past its own quiet window (money/reconcile.ts's
    // RECONCILE_QUIET_MS after REQUEST_TIMEOUT_MS since this engine opened
    // the ledger — the same wait a real kill -9 would force on the owner;
    // 300 s in production, 20 s in this E2E build): a 1 s poll interval
    // finds it promptly for a modest number of calls.
    const reconciledAfterKill = await waitFor(
      "money.reconcile past its quiet window (invariant 4: nothing more is spent until reconciled)",
      async () => {
        const r = await req(cdp, "money.reconcile");
        if (field(r, "ok") !== true || field(r, "result", "status") === "too-early") return null;
        return r;
      },
      90_000,
      1_000,
    );
    check("run scenario: money.reconcile closes the reserve the kill left open, before any more paid calls", field(reconciledAfterKill, "result", "status") === "done", reconciledAfterKill);

    // 6. runs.estimateResume gives a remaining worst case; runs.resume with it.
    const resumeEstimate = await req(cdp, "runs.estimateResume", { runId });
    check(
      "run scenario: runs.estimateResume gives a remaining worst case",
      field(resumeEstimate, "ok") === true && typeof field(resumeEstimate, "result", "estimate", "worstMicros") === "number",
      resumeEstimate,
    );
    const resumeAcceptedWorstMicros = Number(field(resumeEstimate, "result", "estimate", "worstMicros"));
    const resumed = await req(cdp, "runs.resume", { runId, acceptedWorstMicros: resumeAcceptedWorstMicros });
    check("run scenario: runs.resume continues the run from its persisted state", field(resumed, "ok") === true, resumed);
    const secondJobId = field(resumed, "result", "jobId");

    // 7. Wait for the resumed run to finish, then check its final state.
    const end = await waitFor("the resumed run job to end", () => endEventOf(cdp, secondJobId), 90_000);
    check("run scenario: the resumed run finished as job.done", field(end, "type") === "job.done", end);
    const photoIds = field(end, "payload", "result", "photoIds");
    const failedSlots = Number(field(end, "payload", "result", "failedSlots"));
    const photoIdCount = Array.isArray(photoIds) ? photoIds.length : -1;
    check(
      "run scenario: the final state is fully accounted for (20 done, or done + failed = 20)",
      photoIdCount >= 0 && photoIdCount + failedSlots === PHOTO_COUNT,
      { photoIds, failedSlots },
    );
    const listedFinal = await req(cdp, "runs.list");
    const summaryFinal = findRunSummary(listedFinal, runId);
    check("run scenario: no open slots remain once the resumed run is done", Number(field(summaryFinal, "open")) === 0, summaryFinal);

    // 8. No attempt id was ever sent twice: the journal's own record of every
    // attempt this run's two jobs made (attemptId is never put on the wire —
    // OpenRouter's own request bodies carry no id at all — so the durable,
    // fsynced record the money model itself relies on, runs/journal.ts's
    // "attempt" events, is the black-box evidence: a duplicate here is
    // exactly what invariant 5 forbids, and `Budget.tryReserve` itself would
    // have thrown ATTEMPT_ID_REUSED had the engine tried it).
    const { library } = await openLibrary(libraryRoot);
    const { events: journalEvents } = await library.readJournal(runId, RunEventSchema);
    const isAttemptEvent = (e: RunEvent): e is Extract<RunEvent, { type: "attempt" }> => e.type === "attempt";
    const attemptIds = journalEvents.filter(isAttemptEvent).map((e) => e.attemptId);
    check(
      "run scenario: no attempt id was ever sent twice (the run's own journal, across both jobs)",
      attemptIds.length > 0 && new Set(attemptIds).size === attemptIds.length,
      attemptIds,
    );

    // 8b. T7b's own asar proof: the face gate is wired into every photo run
    // unconditionally (never a Settings toggle, unlike the age gate), so
    // with a real fixture face served for both the master and every run
    // image (this scenario's own `faceFixture: true` mock option), the gate
    // must have actually run — for real, models, onnxruntime-web's WASM and
    // the engine's own WASM JPEG decoder all loaded from inside app.asar
    // (electron-builder.studio.yml) — and passed: every generated photo's
    // sidecar carries a `qa.faceCos` at or above the gate's own 0.55 hybrid
    // threshold (RUN_POSES keeps profile/back off, so every slot is
    // front/three-quarter — identity is checked on all of them, invariant:
    // a pass never stores below the threshold). L9: also the exact stored
    // count, not just "some photos exist". Read the same way step 3's
    // import scenario already reads a photo's own qa verdict.
    const avatarIdStr = String(avatarId);
    const generatedPhotos = library.photosByAvatar(avatarIdStr).filter((p) => p.id !== library.getAvatar(avatarIdStr)?.masterPhotoId);
    check(
      "run scenario: exactly PHOTO_COUNT photos are stored, matching the run's own reported photoIds",
      generatedPhotos.length === PHOTO_COUNT && generatedPhotos.length === photoIdCount,
      { stored: generatedPhotos.length, reported: photoIdCount, PHOTO_COUNT },
    );
    check(
      "run scenario: every generated photo carries qa.faceCos >= 0.55 — the face gate ran for real, models and ORT loaded from inside app.asar",
      generatedPhotos.length > 0 && generatedPhotos.every((p) => typeof p.qa.faceCos === "number" && p.qa.faceCos >= 0.55),
      generatedPhotos.map((p) => ({ id: p.id, faceCos: p.qa.faceCos })),
    );

    // 8c. L9: this scenario's own induced face mismatch (mockOpenRouter's
    // `faceMismatchAt`: exactly one served run image is a genuine "no
    // face detected") must have made at least one slot actually retry — a
    // qa-retry attempt outcome in the journal — and every slot still ended
    // with a stored photo (step 8b's own exact-count check already proves
    // the run fully recovered): the gate does not just always pass, it
    // genuinely rejects a bad image and the retry mechanism genuinely works
    // end to end in the packaged app.
    const isQaRetry = (e: RunEvent): boolean => e.type === "attempt" && e.outcome === "qa-retry";
    const qaRetries = journalEvents.filter(isQaRetry);
    check(
      "run scenario: the induced face mismatch made at least one slot retry (qa-retry in the journal), and the run still finished with every photo stored",
      qaRetries.length >= 1,
      { qaRetries: qaRetries.length },
    );

    // 9. The wire, not only the journal: a crash can end the engine between
    // an attempt's send and its journal write, so the journal alone (step 8)
    // cannot prove a kill never doubles a *send*, only that it never doubles
    // a *journaled outcome*. `userData/ledger.jsonl`'s own `reserve` lines
    // are written before the request leaves (invariant 2) and are checked
    // against the persisted ledger itself, cross-process (the comment on
    // reservedAttemptIds above): so the mock's own request count for this
    // run — every image and every scene-writer call it actually received,
    // across both engine lifetimes — can never exceed the run's distinct
    // reserved attempt ids, image and writer counted separately.
    const imagesForRun = mock.imageRequests().length - imagesBeforeRun;
    const reservedImageIds = await reservedAttemptIds(userData, `${runId}:slot-`);
    check(
      "run scenario: the mock's image requests for this run never exceed the run's own reserved attempt ids",
      imagesForRun <= reservedImageIds.length,
      { imagesForRun, reservedImageAttemptIds: reservedImageIds.length },
    );
    // Known gap, documented rather than covered: a 20-photo run fits in one
    // writer chunk (WRITER_CALL.slotsPerCall=25), and the writer's single
    // call finishes near-instantly next to the run's 20 image slots — so the
    // mid-flight kill above (step 2) always lands during the image phase,
    // never mid-writer-attempt. This check still proves the writer's own
    // reserve accounting is sound for the (here, trivial) writer work this
    // scenario does; a kill genuinely interrupting an in-flight writer
    // attempt, and its resume, is not exercised by this scenario.
    const writersForRun = mock.sceneWriterRequests().length - writersBeforeRun;
    const reservedWriterIds = await reservedAttemptIds(userData, `${runId}:writer-`);
    check(
      "run scenario: the mock's scene-writer requests for this run never exceed the run's own reserved attempt ids",
      writersForRun <= reservedWriterIds.length,
      { writersForRun, reservedWriterAttemptIds: reservedWriterIds.length },
    );

    // 10. Credits and the cap: the mock's real usage for this run alone (its
    // usage before the run minus its usage now) must never exceed the run's
    // own committed total (settled cost plus any reserve still open at its
    // worst case — RunSummary.committedMicros, "the run's summary" the plan
    // points at); that committed total must in turn never exceed the run's
    // own persisted cap (`capMicros`), and the cap itself must never exceed
    // the worst case the owner accepted at the start: it is set once, at plan
    // time, and a resume never raises it (T6 decisions).
    const usageDeltaMicros = Math.round((mock.totalUsageUsd() - usageBeforeRun) * 1_000_000);
    const committedMicros = Number(field(summaryFinal, "committedMicros"));
    check(
      "run scenario: the fake /credits usage delta for this run is within the ledger's own total for it",
      usageDeltaMicros <= committedMicros,
      { usageDeltaMicros, committedMicros },
    );
    // The cap is set once, at plan time, and never raised (T6 decisions) —
    // `summaryFinal.capMicros` is that one persisted number. Comparing
    // against `startAcceptedWorstMicros + resumeAcceptedWorstMicros` instead
    // allowed spend up to roughly 2x the actual cap: the resume's own
    // accepted worst case is the REMAINING room at resume time (already
    // priced against the same cap), not a second cap added on top of the
    // start's.
    const capMicros = Number(field(summaryFinal, "capMicros"));
    check(
      "run scenario: the run's cap was never exceeded (committed spend <= the run's own persisted cap)",
      committedMicros <= capMicros,
      { committedMicros, capMicros, startAcceptedWorstMicros, resumeAcceptedWorstMicros },
    );
    // A cap raised on resume (to the resume's own accepted worst case, or by
    // any other path) would still satisfy the check above, so pin the cap
    // itself against the price the owner accepted when the run started.
    check(
      "run scenario: the run's cap was not raised by the resume (cap <= the worst case accepted at the start)",
      capMicros <= startAcceptedWorstMicros,
      { capMicros, startAcceptedWorstMicros, resumeAcceptedWorstMicros },
    );

    // 11. Cancel: a second, small run, stopped mid-flight.
    const CANCEL_COUNT = 4;
    const cancelRequest = { avatarId, count: CANCEL_COUNT, categories: RUN_CATEGORIES, poses: RUN_POSES };
    const cancelEstimate = await req(cdp, "runs.estimate", cancelRequest);
    check("cancel scenario: runs.estimate prices the small run", field(cancelEstimate, "ok") === true, cancelEstimate);
    const imagesBeforeCancelRun = mock.imageRequests().length;
    const cancelStarted = await req(cdp, "runs.start", { ...cancelRequest, acceptedWorstMicros: field(cancelEstimate, "result", "estimate", "worstMicros") });
    check("cancel scenario: runs.start plans and launches the small run", field(cancelStarted, "ok") === true, cancelStarted);
    const cancelRunId = field(cancelStarted, "result", "runId");
    const cancelJobId = field(cancelStarted, "result", "jobId");

    // Genuinely mid-flight: wait for an image request to actually arrive at
    // the mock (it is held there by its own delay), never a fixed sleep.
    await waitFor("an image request for the small run to arrive at the mock", async () => (mock.imageRequests().length > imagesBeforeCancelRun ? true : null), 20_000);
    const cancelled = await req(cdp, "runs.cancel", { runId: cancelRunId });
    check("cancel scenario: runs.cancel answers ok", field(cancelled, "ok") === true, cancelled);

    const cancelEnd = await waitFor("the small run's job to end", () => endEventOf(cdp, cancelJobId), 20_000);
    check("cancel scenario: the run stops via cancel", field(cancelEnd, "type") === "job.cancelled", cancelEnd);

    // No request reaches the mock after the cancel settled (every request
    // asks `beforeSend` right before it leaves): a grace period past the
    // terminal event, watching for growth, not a timed action.
    const requestsAtCancelEnd = mock.requests.length;
    await Bun.sleep(1_500);
    check(
      "cancel scenario: no request reaches the mock after the cancel settled",
      mock.requests.length === requestsAtCancelEnd,
      { before: requestsAtCancelEnd, after: mock.requests.length },
    );

    const listedAfterCancel = await req(cdp, "runs.list");
    const cancelSummary = findRunSummary(listedAfterCancel, cancelRunId);
    check(
      "cancel scenario: the in-flight reserves end as the plan says (open, for a future resume — worst case until reconciled, or settled)",
      field(cancelSummary, "running") === false && field(cancelSummary, "resumable") === true && Number(field(cancelSummary, "open")) >= 1,
      cancelSummary,
    );

    // 12. T6a-2b's network canary (item 2), extended to the photo-run path
    // (2b whole-slice review blocker) and run over EVERY request this app
    // instance's mock ever received, after the cancel run above, so its
    // requests are covered too — not over a filtered subset of image,
    // scene-writer and age-check requests. `createActiveAvatarForRun` built
    // this avatar from `AVATAR_TRAITS`, whose vibe is the marker words: the
    // marker may reach the mock only inside the descriptor request that wrote
    // it. Any other request that carries it, of whatever kind, is a leak.
    const carryingMarker = mock.requests.filter(carriesMarker);
    check(
      "run scenario: every request that carries the avatar's marker vibe is an avatar_descriptor request, across all of the mock's requests",
      carryingMarker.length > 0 && carryingMarker.every((r) => r.schemaName === "avatar_descriptor"),
      { totalRequests: mock.requests.length, carrying: carryingMarker.map((r) => ({ method: r.method, path: r.path, schemaName: r.schemaName, matched: markerMatch(r, AVATAR_MARKER_WORDS) })) },
    );

    check("run scenario: no request to the mock was on an unexpected route", mock.unexpected.length === 0, mock.unexpected);
  } finally {
    await quit(running);
    await mock.stop();
    await removeTemp(tmp);
  }
}

// ---------- custom category end-to-end scenario (CS.2) ----------

const CATEGORY_NAME = "Кофейни Парижа";
const CATEGORY_DESCRIPTION = "кофейни и булочные Парижа, утро и вечер";
const CATEGORY_LABEL = "Paris cafes";
const CATEGORY_PHOTOS = 5;

/**
 * CS.2: the owner's own category, made and drawn in the packaged app against the mock. `categories.create` is one paid pool call (the mock answers
 * the "scene_pool" schema), the category is listed, and a run of 5 photos names it: every photo is the category's, carries the owner's name, and the
 * writer was told only the English label. The avatar's marker vibe must reach no request of the category call; the pool call was reserved once and
 * settled, and the run's plan keeps a snapshot of the category.
 */
async function runCategoryScenario(target: Target): Promise<void> {
  const mock = await startMockOpenRouter({ descriptorText: AVATAR_DESCRIPTOR, distinctImages: true, faceFixture: true, poolAnswer: { label: CATEGORY_LABEL } });
  const tmp = await mkdtemp(join(tmpdir(), "studio-smoke-category-"));
  const userData = join(tmp, "userData");
  const libraryRoot = join(tmp, "category-library");
  await mkdir(userData, { recursive: true });
  await mkdir(libraryRoot, { recursive: true });

  const running = await launch(target, userData, [`--studio-openrouter-base-url=${mock.url}`, `--studio-pick-folder=${libraryRoot}`]);
  try {
    const { cdp } = running;
    const keySet = await req(cdp, "settings.setApiKey", { key: SMOKE_KEY });
    check("category scenario: settings.setApiKey stores the fake key", field(keySet, "ok") === true, keySet);
    const libSet = await req(cdp, "settings.setLibraryPath", { path: libraryRoot });
    check("category scenario: settings.setLibraryPath adopts the temp library (via --studio-pick-folder)", field(libSet, "ok") === true && field(libSet, "result", "libraryPath") === libraryRoot, libSet);
    const avatarId = await createActiveAvatarForRun(cdp, "Cleo");

    // 1. The library starts with no category; the pool call is priced before it is accepted.
    const empty = await req(cdp, "categories.list");
    check("category scenario: categories.list of a new library is empty, with nothing unreadable, interrupted or busy", JSON.stringify(field(empty, "result")) === JSON.stringify({ categories: [], unreadable: 0, overLimit: 0, interrupted: [], busy: null }), empty);
    const estimate = await req(cdp, "categories.estimate");
    const worstMicros = Number(field(estimate, "result", "worstMicros"));
    check("category scenario: categories.estimate prices the pool call (a worst case above the expected one)", field(estimate, "ok") === true && worstMicros > Number(field(estimate, "result", "expectedMicros")) && worstMicros > 0, estimate);

    // 2. One paid call makes the category.
    const poolsBefore = mock.poolRequests().length;
    const created = await req(cdp, "categories.create", { name: CATEGORY_NAME, description: CATEGORY_DESCRIPTION, acceptedWorstMicros: worstMicros });
    check("category scenario: categories.create makes a category", field(created, "ok") === true, created);
    const categoryId = String(field(created, "result", "category", "categoryId"));
    check("category scenario: the category is the owner's name, the mock's label and a pool of five places", field(created, "result", "category", "name") === CATEGORY_NAME && field(created, "result", "category", "label") === CATEGORY_LABEL && Array.isArray(field(created, "result", "category", "pool", "locations")) && (field(created, "result", "category", "pool", "locations") as unknown[]).length === 5, created);
    check("category scenario: the call cost what the mock billed for it (settled at usage.cost), and the category's own total says so", field(created, "result", "spentMicros") === 5_100 && field(created, "result", "category", "spentMicros") === 5_100, created);
    check("category scenario: exactly one pool request reached the mock", mock.poolRequests().length === poolsBefore + 1, mock.poolRequests().length - poolsBefore);
    const listed = await req(cdp, "categories.list");
    const listedIds = field(listed, "result", "categories");
    check("category scenario: categories.list holds the category, and the record is on disk in the library", Array.isArray(listedIds) && listedIds.length === 1 && field(listedIds[0], "categoryId") === categoryId && (await filesUnder(join(libraryRoot, "categories"))).some((f) => f.endsWith(`${categoryId}.json`)), listed);
    const noPending = (await filesUnder(join(libraryRoot, "categories"))).filter((f) => f.includes("pending-"));
    check("category scenario: the record of the call is gone once it ended", noPending.length === 0, noPending);

    // 3. A run names it.
    const request = { avatarId, count: CATEGORY_PHOTOS, categories: [categoryId], poses: RUN_POSES };
    const runEstimate = await req(cdp, "runs.estimate", request);
    check("category scenario: runs.estimate accepts the custom category", field(runEstimate, "ok") === true, runEstimate);
    const started = await req(cdp, "runs.start", { ...request, acceptedWorstMicros: field(runEstimate, "result", "estimate", "worstMicros") });
    check("category scenario: runs.start plans and launches the run", field(started, "ok") === true, started);
    const runId = String(field(started, "result", "runId"));
    const end = await waitFor("the category run's job to end", () => endEventOf(cdp, field(started, "result", "jobId")), 90_000);
    check("category scenario: the run finished as job.done", field(end, "type") === "job.done", end);
    const photoIds = field(end, "payload", "result", "photoIds");
    check("category scenario: all 5 photos were drawn", Array.isArray(photoIds) && photoIds.length === CATEGORY_PHOTOS && Number(field(end, "payload", "result", "failedSlots")) === 0, end);

    // 4. What the owner sees, and what the engine kept.
    const photos = await req(cdp, "photos.list", { avatarId });
    const generated = (field(photos, "result", "photos") as unknown[]).filter((p) => field(p, "category") === categoryId);
    check("category scenario: photos.list lists the 5 photos under the category, each with the owner's name", generated.length === CATEGORY_PHOTOS && generated.every((p) => field(p, "categoryName") === CATEGORY_NAME), photos);
    const plan: unknown = JSON.parse(await readFile(join(libraryRoot, "runs", runId, "plan.json"), "utf8"));
    check(
      "category scenario: the run's plan keeps a snapshot of the category (id, the owner's name, the English label, the style)",
      JSON.stringify(field(plan, "categories")) === JSON.stringify([{ ref: categoryId, name: CATEGORY_NAME, label: CATEGORY_LABEL, style: "phone" }]),
      field(plan, "categories"),
    );
    const writerBodies = mock.sceneWriterRequests().map((r) => r.bodyText);
    check("category scenario: the writer was told the English label, never the category's id or the owner's name", writerBodies.length >= 1 && writerBodies.every((b) => b.includes(CATEGORY_LABEL) && !b.includes(categoryId) && !b.includes(CATEGORY_NAME)), writerBodies.length);

    // 5. What did not leave: the avatar's marker vibe, and the category's name, in any request of the pool call.
    const poolRequests = mock.poolRequests();
    check("category scenario: the pool call carried the owner's description and neither the category's name nor the avatar's marker vibe", poolRequests.length === 1 && poolRequests.every((r) => r.bodyText.includes("кофейни и булочные Парижа") && !r.bodyText.includes(CATEGORY_NAME) && !carriesMarker(r)), poolRequests.map((r) => markerMatch(r, AVATAR_MARKER_WORDS)));
    const carrying = mock.requests.filter(carriesMarker);
    check("category scenario: every request that carries the avatar's marker vibe is an avatar_descriptor request", carrying.length > 0 && carrying.every((r) => r.schemaName === "avatar_descriptor"), carrying.map((r) => ({ path: r.path, schemaName: r.schemaName })));

    // 6. The money: one reserve for the pool call, settled; nothing open; the mock's total is the ledger's.
    const poolReserves = (await reservedAttemptIds(userData, "")).filter((id) => /:pool#\d+$/.test(id));
    check("category scenario: the pool call was reserved exactly once, under its own attempt id", poolReserves.length === 1, poolReserves);
    const money = await req(cdp, "money.status");
    check("category scenario: money.status has no open reserve, and the ledger's total is what the mock billed", field(money, "result", "unsettledMicros") === 0 && Math.abs(Number(field(money, "result", "spentMicros")) - Math.round(mock.totalUsageUsd() * 1_000_000)) <= 1, money);
    check("category scenario: no request to the mock was on an unexpected route", mock.unexpected.length === 0, mock.unexpected);
  } finally {
    await quit(running);
    await mock.stop();
    await removeTemp(tmp);
  }
}

// ---------- main ----------

// ---------- packaged render end-to-end scenario (plan 3a.9: headless E2E; 3e.1: playback) ----------

const RENDER_ROOT_ID = "smoke-render-root-0001";
/** A different length, so the marker's cheap `lstat` check sees the change even within one timestamp tick. */
const OTHER_ROOT_ID = "smoke-other-root-00000002";
/** The contract's own scene categories: a photo outside them is not listed in the gallery. */
const SCENE_CATEGORIES = ["home", "travel", "shoot", "glam", "fit"] as const;
const MIB = 1024 * 1024;
/** The longest a clean render may take on any runner: generous, it only ends a hang. */
const RENDER_WAIT_MS = 180_000;
/** How long the memory sampler may take to produce its first sample before the run gives up on it as broken (a cold PowerShell on a loaded Windows runner is seconds). */
const SAMPLER_READY_MS = 60_000;

/** A line for the plan's notes, read from the CI log: what this OS measured. */
function fact(what: string, value: unknown): void {
  console.log(`FACT  ${what}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
}

/** The engine only (a utilityProcess, a child of the app): never its ffmpeg children with it, which is the point. Windows without `/T`. */
function killEngineOnly(pid: number): void {
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/F"]);
  else process.kill(pid, "SIGKILL");
}

/** A real 720x1280 JPEG, different for every `n` (colour and noise): a scene photo for the render to read. Noisy on purpose, since the noisiest outputs are the largest. */
async function renderScenePhoto(n: number, dir: string): Promise<Uint8Array> {
  // Photo 0 is the repo's own committed JPEG, the same bytes on every machine: the first render's output is then the one that can be
  // compared between a Mac and a Windows runner (a determinism probe, recorded as information and never a gate; N13).
  if (n === 0) return new Uint8Array(await readFile(join(ROOT, "studio/engine/face/fixtures/images/render-best-home-1.jpg")));
  const out = join(dir, `scene-${n}.jpg`);
  const proc = Bun.spawn(
    [ffmpegPath(), "-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `testsrc2=size=720x1280:rate=1,noise=alls=40:allf=t:all_seed=${n + 1},hue=h=${(n * 37) % 360}`, "-frames:v", "1", "-q:v", "3", out],
    { stdout: "ignore", stderr: "pipe" },
  );
  const [stderr, code] = await Promise.all([Bun.readableStreamToText(proc.stderr), proc.exited]);
  if (code !== 0) throw new Error(`smoke test could not draw a scene photo: ${stderr}`);
  return new Uint8Array(await readFile(out));
}

interface SceneWorld {
  readonly avatarId: string;
  readonly photoIds: readonly string[];
}

/** An active avatar with a master and `SMOKE_PHOTOS_NEEDED` scene photos (each its own picture, eligible for a video). */
async function seedSceneLibrary(libraryRoot: string, scratch: string): Promise<SceneWorld> {
  const { library } = await openLibrary(libraryRoot);
  const avatar = await library.createAvatar({ ...SAMPLE_AVATAR, name: "Mia" });
  const master = await library.addPhoto(avatar.id, PNG, samplePhotoMeta());
  await library.updateAvatar(avatar.id, { status: "active", masterPhotoId: master.id });
  const photoIds: string[] = [];
  for (let n = 0; n < SMOKE_PHOTOS_NEEDED; n += 4) {
    const batch = await Promise.all(Array.from({ length: Math.min(4, SMOKE_PHOTOS_NEEDED - n) }, (_, i) => renderScenePhoto(n + i, scratch)));
    for (const [i, bytes] of batch.entries()) {
      const category = SCENE_CATEGORIES[(n + i) % SCENE_CATEGORIES.length] ?? "home";
      const photo = await library.addPhoto(avatar.id, bytes, samplePhotoMeta({ mediaType: "image/jpeg", width: 720, height: 1280, source: { ...SAMPLE_SOURCE, category, attemptId: `smoke-render-attempt-${n + i}` } }));
      photoIds.push(photo.id);
    }
  }
  return { avatarId: avatar.id, photoIds };
}

interface SmokeRender {
  readonly plan: SmokeSpecPlan;
  readonly photoIds: readonly string[];
  readonly jobId: string;
  readonly videoId: string;
  /** From the command's answer to the job's end, as this script saw it. */
  readonly ms: number;
  readonly relPath: string;
  readonly bytes: number;
  readonly videoKind: string;
}

const specFrames = (plan: SmokeSpecPlan): number => plan.clips.reduce((sum, clip) => sum + (clip.durationMs * 3) / 100, 0);
const specMs = (plan: SmokeSpecPlan): number => plan.clips.reduce((sum, clip) => sum + clip.durationMs, 0);

/** The state of the renders and the photos after a restart, read through the engine's own commands. */
async function photoFacts(cdp: Cdp, avatarId: string, photoIds: readonly string[]): Promise<{ used: boolean[]; reserved: boolean[]; usedIn: string[][] }> {
  const listed = await req(cdp, "photos.list", { avatarId });
  const photos = field(listed, "result", "photos");
  const byId = new Map<string, unknown>();
  if (Array.isArray(photos)) for (const p of photos) byId.set(String(field(p, "photoId")), p);
  const each = (name: string): unknown[] => photoIds.map((id) => field(byId.get(id), name));
  return { used: each("used").map((v) => v === true), reserved: each("reserved").map((v) => v === true), usedIn: each("usedIn").map((v) => (Array.isArray(v) ? v.map(String) : [])) };
}

async function listVideos(cdp: Cdp, avatarId: string): Promise<{ videoId: string; relPath: string; fileState: string; bytes: number }[]> {
  const answer = await req(cdp, "videos.list", { avatarId });
  const videos = field(answer, "result", "videos");
  if (!Array.isArray(videos)) return [];
  return videos.map((v: unknown) => ({ videoId: String(field(v, "videoId")), relPath: String(field(v, "relPath")), fileState: String(field(v, "fileState")), bytes: Number(field(v, "bytes")) }));
}

async function namesIn(dir: string): Promise<string[]> {
  return readdir(dir).catch(() => []);
}

/** A disk call that Windows may refuse for a moment (the engine or Defender had the file open): retried a few times, never hidden after that. */
async function retrying<T>(call: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "";
      if (attempt >= 8 || !["EBUSY", "EPERM", "EACCES"].includes(code)) throw error;
      await Bun.sleep(150 * attempt);
    }
  }
}

/** The avatar's export folder's final-name videos (a file that is not a `.studio-part-` temp). */
const finalVideos = (names: readonly string[]): string[] => names.filter((name) => name.endsWith(".mp4") && !name.startsWith(".studio-part-"));

async function runPackagedRenderScenario(target: Target): Promise<void> {
  const tmp = await mkdtemp(join(tmpdir(), "studio-smoke-render-"));
  const userData = join(tmp, "userData");
  const libraryRoot = join(tmp, "library");
  const exportRoot = join(tmp, "export");
  const scratch = join(tmp, "scratch");
  for (const dir of [userData, libraryRoot, exportRoot, scratch]) await mkdir(dir, { recursive: true });
  await writeFile(join(exportRoot, EXPORT_MARKER_FILE), JSON.stringify({ schemaVersion: 1, rootId: RENDER_ROOT_ID, createdAt: new Date().toISOString() }));
  const world = await seedSceneLibrary(libraryRoot, scratch);
  const { avatarId } = world;
  // Two at once, so the clean renders after the first kill can share the pool; the measured ones are submitted one at a time.
  await saveSettings(userData, { ...defaultSettings(userData), libraryPath: libraryRoot, exportPath: exportRoot, renderConcurrency: 2 });

  // One scene photo per cell: spec 0..4 are the pairwise ones, then the mixed timeline.
  let next = 0;
  const take = (plan: SmokeSpecPlan): string[] => world.photoIds.slice(next, (next += plan.photoCount));
  const photosOf = new Map<SmokeSpecPlan, string[]>([...PAIRWISE_SPECS, MIXED_SPEC, LAYERED_SPEC].map((plan) => [plan, take(plan)]));
  const photosFor = (plan: SmokeSpecPlan): string[] => photosOf.get(plan) ?? [];
  const [kenBurns, pan, collage2, collage3, collage4] = PAIRWISE_SPECS;
  if (kenBurns === undefined || pan === undefined || collage2 === undefined || collage3 === undefined || collage4 === undefined) throw new Error("the pairwise specs changed shape");

  const sampler = startFfmpegSampler();
  const renders: SmokeRender[] = [];
  let running = await launch(target, userData);
  sampler.follow(running.child.pid ?? -1);
  try {
    let cdp = running.cdp;
    const responses: { url: string; status: number; contentRange: string | null }[] = [];
    const listen = (c: Cdp): void => {
      c.on((method, params) => {
        if (method !== "Network.responseReceived") return;
        const url = field(params, "response", "url");
        if (typeof url !== "string" || !url.startsWith("studio-media://video/")) return;
        const headers = field(params, "response", "headers");
        const range = typeof headers === "object" && headers !== null ? Object.entries(headers).find(([k]) => k.toLowerCase() === "content-range")?.[1] : undefined;
        responses.push({ url, status: Number(field(params, "response", "status")), contentRange: typeof range === "string" ? range : null });
      });
    };
    listen(cdp);
    await cdp.send("Network.enable");

    // The sampler's first sample (a cold PowerShell and a first CIM query over every process on Windows) can take longer than a whole render;
    // a render measured before it has one is measured by nothing. Not a finding about the app: a sampler that never samples throws a harness error.
    await sampler.ready(SAMPLER_READY_MS);

    const snapshot = await req(cdp, "engine.snapshot");
    check("render scenario: the engine starts over the scene library and the test export root", field(snapshot, "ok") === true && field(snapshot, "result", "settings", "exportPath") === exportRoot, snapshot);
    fact("platform", `${process.platform} ${process.arch}, Bun ${Bun.version}`);

    const submit = async (plan: SmokeSpecPlan): Promise<{ jobId: string; videoId: string; answerMs: number; startedAt: number }> => {
      const startedAt = Date.now();
      const answer = await req(cdp, "videos.render", { spec: smokeSpec(plan, avatarId, photosFor(plan)) });
      const answerMs = Date.now() - startedAt;
      const jobId = field(answer, "result", "jobId");
      const videoId = field(answer, "result", "videoId");
      if (field(answer, "ok") !== true || typeof jobId !== "string" || typeof videoId !== "string") throw new Error(`videos.render refused ${plan.name}: ${failureDetail(answer)}`);
      return { jobId, videoId, answerMs, startedAt };
    };
    const finished = async (plan: SmokeSpecPlan, started: { jobId: string; videoId: string; startedAt: number }): Promise<SmokeRender> => {
      const end = await waitFor(`the render of ${plan.name} to end`, () => endEventOf(cdp, started.jobId), RENDER_WAIT_MS, 100);
      const endedAt = Date.now();
      const result = field(end, "payload", "result");
      check(`render scenario: ${plan.name} ends as job.done with a committed video`, field(end, "type") === "job.done" && field(result, "kind") === "render" && field(result, "videoId") === started.videoId, end);
      return { plan, photoIds: photosFor(plan), jobId: started.jobId, videoId: started.videoId, ms: endedAt - started.startedAt, relPath: String(field(result, "relPath")), bytes: Number(field(result, "bytes")), videoKind: String(field(result, "videoKind")) };
    };
    let lastTree = "";
    const examine = async (render: SmokeRender): Promise<void> => {
      const path = join(exportRoot, render.relPath);
      const bytes = new Uint8Array(await readFile(path));
      const frames = specFrames(render.plan);
      const verified = await verifyRenderedMp4(path, { frames });
      check(`render scenario: the engine's own verifier accepts ${render.plan.name} when run again on the committed file (the Windows 6.1.1 gate)`, verified.ok, verified);
      const probe = await probeVideo(path);
      const facts = mp4Facts(bytes);
      const problems = renderedFileProblems({ frames, durationMs: specMs(render.plan) }, { probe, facts });
      check(`render scenario: ffprobe and the box reader find exactly what the engine writes in ${render.plan.name} (invariants 14 and 20)`, problems.length === 0, problems);
      const used = await photoFacts(cdp, avatarId, render.photoIds);
      check(`render scenario: every photo of ${render.plan.name} carries the used mark of its video and is no longer reserved`, used.usedIn.every((ids) => ids.length === 1 && ids[0] === render.videoId) && !used.reserved.some(Boolean), used);
      check(`render scenario: ${render.plan.name} is named <date>_${render.videoKind}_<NNN>.mp4 in the avatar's own folder`, new RegExp(`^Mia/\\d{4}-\\d{2}-\\d{2}_${render.videoKind}_\\d{3}\\.mp4$`).test(render.relPath), render.relPath);
      if (render.plan === PAIRWISE_SPECS[0]) fact(`sha256 of ${render.plan.name} (rendered from the committed fixture photo, for the macOS-against-Windows determinism comparison)`, createHash("sha256").update(bytes).digest("hex"));
      const tree = formatBoxTree(boxTree(bytes));
      fact(`box tree of ${render.plan.name}`, tree === lastTree ? "identical to the previous file's" : tree);
      lastTree = tree;
      fact(`metadata of ${render.plan.name}`, { size: bytes.length, brands: facts.brands, times: facts.times, tool: facts.tool, compressor: facts.compressor, formatTags: probe.format.tags, streamTags: probe.streams.map((s) => s.tags), audioMinusVideoMs: Math.round((Number(probe.streams.find((s) => s.codec_type === "audio")?.duration) - Number(probe.streams.find((s) => s.codec_type === "video")?.duration)) * 1000) });
    };
    const measured = async (plan: SmokeSpecPlan): Promise<void> => {
      const started = await submit(plan);
      const render = await finished(plan, started);
      renders.push(render);
      const peak = sampler.tracker.between(started.startedAt, started.startedAt + render.ms);
      requireSamples(peak, `the render of ${plan.name}`);
      fact(`render of ${plan.name} (${render.videoKind})`, { seconds: Math.round(render.ms / 100) / 10, answerMs: started.answerMs, peakSingleFfmpegMiB: Math.round(peak.peakSingleBytes / MIB), peakAllFfmpegMiB: Math.round(peak.peakConcurrentBytes / MIB), samples: peak.samples, bytes: render.bytes });
      check(`render scenario: ${plan.name} stays under the pool's peakRSS (${PEAK_RSS_BYTES / MIB} MiB)`, Math.max(peak.peakSingleBytes, peak.peakConcurrentBytes) <= PEAK_RSS_BYTES, peak);
      await examine(render);
    };

    // 1. An export root that is gone: refused before any job starts, nothing reserved.
    await retrying(() => rename(exportRoot, `${exportRoot}-away`));
    const refused = await req(cdp, "videos.render", { spec: smokeSpec(kenBurns, avatarId, photosFor(kenBurns)) });
    await retrying(() => rename(`${exportRoot}-away`, exportRoot));
    check("render scenario: a render with the export root removed is EXPORT_UNAVAILABLE (missing)", field(refused, "ok") === false && field(refused, "error", "code") === "EXPORT_UNAVAILABLE" && field(refused, "error", "exportReason") === "missing", refused);
    const afterRefusal = await req(cdp, "engine.snapshot");
    const afterRefusalPhotos = await photoFacts(cdp, avatarId, photosFor(kenBurns));
    check("render scenario: the refusal started no job and reserved no photo", Array.isArray(field(afterRefusal, "result", "jobs")) && !JSON.stringify(field(afterRefusal, "result", "jobs")).includes('"render"') && !afterRefusalPhotos.reserved.some(Boolean), { afterRefusal, afterRefusalPhotos });

    // 2. Clean renders, one at a time so each one's memory and time are its own: a photo, a collage, and the 15 s mixed timeline.
    await measured(kenBurns);
    await measured(collage2);
    await measured(MIXED_SPEC);
    // One real caption and one built-in sticker, 15 s: commits, passes the verifier, and its peak ffmpeg RSS is gated (the layer pass's calls and pass 2 each).
    await measured(LAYERED_SPEC);

    // 3. Kill ONLY the engine in the middle of a render (Windows without /T). After the restart nothing of it is left: no file under a final
    // name, no record, no used mark, and no ffmpeg of its own.
    // Everything the kill needs is found BEFORE the victim is sent, so nothing slow (a CIM query on Windows) sits between "its ffmpeg is
    // running" and the kill: the kill lands mid-render, not in verify after ffmpeg has exited.
    const bootBefore = field(await req(cdp, "engine.snapshot"), "result", "bootId");
    const engineToKill = enginePid(running.child.pid ?? -1);
    check("render scenario: the engine process is found to kill", engineToKill !== null, { mainPid: running.child.pid });
    const victim = await submit(collage4);
    await waitFor(
      "the victim render to be mid-flight with an ffmpeg running",
      async () => {
        const events = await cdp.evaluate(`window.__smoke.events.filter((e) => e.type === "job.progress" && e.payload.jobId === ${JSON.stringify(victim.jobId)} && e.payload.done > 0).length`);
        return Number(events) > 0 && sampler.latestPids().length > 0 ? true : null;
      },
      60_000,
      50,
    );
    const ffmpegsAtKill = sampler.latestPids();
    const phase = await cdp.evaluate(`(() => {
      const mine = window.__smoke.events.filter((e) => e.payload && e.payload.jobId === ${JSON.stringify(victim.jobId)});
      return { ended: mine.some((e) => e.type === "job.done" || e.type === "job.failed" || e.type === "job.cancelled"), saving: mine.some((e) => e.type === "job.progress" && e.payload.saving === true) };
    })()`);
    check(
      "render scenario: the engine is killed mid-render: the victim's ffmpeg is running, the job has no end event and is not in its saving phase",
      ffmpegsAtKill.length > 0 && sampler.runningAmong(ffmpegsAtKill).length > 0 && field(phase, "ended") === false && field(phase, "saving") === false,
      { ffmpegsAtKill, phase },
    );
    if (engineToKill !== null) killEngineOnly(engineToKill);
    const killedAt = Date.now();
    // 1 s after the kill, before the restarted engine is even up: is the engine's ffmpeg still there?
    await Bun.sleep(1_000);
    fact("the killed engine's ffmpeg 1 s after the kill", sampler.runningAmong(ffmpegsAtKill).length > 0 ? "still running (it outlives the engine)" : "already gone");
    await waitFor("a snapshot from the restarted engine", async () => {
      const s = await req(cdp, "engine.snapshot");
      return field(s, "ok") === true && field(s, "result", "bootId") !== bootBefore ? s : null;
    });
    const survivorsGone = await waitFor("the killed engine's ffmpeg to be gone", async () => (sampler.runningAmong(ffmpegsAtKill).length > 0 ? null : true), 15_000, 100).then(
      () => true,
      () => false,
    );
    fact("the killed engine's ffmpeg after the kill", survivorsGone ? `gone within ${Date.now() - killedAt} ms` : `STILL RUNNING after ${Date.now() - killedAt} ms: ${sampler.runningAmong(ffmpegsAtKill).join(", ")}`);
    check(
      "render scenario: the killed engine's ffmpeg is gone within 15 s (a 4 s render's pass; on macOS it outlives the engine until that pass ends, which grows with the timeline)",
      survivorsGone,
      sampler.runningAmong(ffmpegsAtKill),
    );
    for (const pid of sampler.runningAmong(ffmpegsAtKill)) killEngineOnly(pid); // defensive: a survivor must not write into the next steps (by its pid alone, never its tree)

    const mia = join(exportRoot, "Mia");
    // A temp file the killed ffmpeg still had open is one the restarted engine's sweep may have to skip (Windows: EBUSY, retried, then left
    // for the next start), so what is left NOW is recorded, and the next start is what must have cleared it (checked after the relaunch below).
    await waitFor("the restarted engine's sweep to clear the killed render's temp files", async () => ((await namesIn(mia)).some((n) => n.startsWith(".studio-part-")) ? null : true), 8_000, 200).catch(() => undefined);
    const afterKill = await namesIn(mia);
    fact("temp files left in the export folder after the restart that followed the mid-render kill", afterKill.filter((n) => n.startsWith(".studio-part-")));
    check("render scenario: after the mid-render kill there is no file under a final name for the killed render", finalVideos(afterKill).every((n) => renders.some((r) => r.relPath === `Mia/${n}`)), afterKill);
    const listedAfterKill = await listVideos(cdp, avatarId);
    check("render scenario: after the mid-render kill there is no record of it", listedAfterKill.length === renders.length && !listedAfterKill.some((v) => v.videoId === victim.videoId), listedAfterKill);
    const victimPhotos = await photoFacts(cdp, avatarId, photosFor(collage4));
    check("render scenario: after the mid-render kill its photos are not used and not reserved", !victimPhotos.used.some(Boolean) && !victimPhotos.reserved.some(Boolean), victimPhotos);
    check("render scenario: after the mid-render kill there is no commit intent left", (await namesIn(videoPaths(libraryRoot, avatarId).pendingDir)).length === 0, await namesIn(videoPaths(libraryRoot, avatarId).pendingDir));
    fact("render-tmp folders left after the restart that followed the mid-render kill", await namesIn(join(userData, "render-tmp")));

    // 4. The photos are free again, so the same spec renders now, next to another one (the pool takes two).
    const again = await submit(collage4);
    const second = await submit(pan);
    const [collage4Render, panRender] = [await finished(collage4, again), await finished(pan, second)];
    renders.push(collage4Render, panRender);
    const together = sampler.tracker.between(Math.min(again.startedAt, second.startedAt), Date.now());
    fact("two renders at once (collage4-pan and photo-pan)", { peakSingleFfmpegMiB: Math.round(together.peakSingleBytes / MIB), peakAllFfmpegMiB: Math.round(together.peakConcurrentBytes / MIB), samples: together.samples });
    await examine(collage4Render);
    await examine(panRender);

    // 5. Playback and record resolution (3e.1, invariant 28): a committed video plays and seeks through studio-media://video with Range, from the
    // export root through its record; a `missing` or an `elsewhere` record answers 404 and never plays.
    const listed = await listVideos(cdp, avatarId);
    check("render scenario: videos.list shows every committed video as present, each at the path the job reported", listed.length === renders.length && renders.every((r) => listed.some((v) => v.videoId === r.videoId && v.relPath === r.relPath && v.fileState === "present" && v.bytes === r.bytes)), listed);
    const mixed = renders.find((r) => r.plan === MIXED_SPEC);
    const first = renders.find((r) => r.plan === kenBurns);
    const third = renders.find((r) => r.plan === pan);
    if (mixed === undefined || first === undefined || third === undefined) throw new Error("the clean renders are missing");
    const urlOf = (r: SmokeRender): string => `studio-media://video/${avatarId}/${r.videoId}`;
    const play = (r: SmokeRender, seekTo: number): Promise<unknown> =>
      cdp.evaluate(`(async () => {
        const once = (el, ok, bad) => new Promise((res) => { el.addEventListener(ok, () => res(true), { once: true }); el.addEventListener(bad, () => res(false), { once: true }); setTimeout(() => res(false), 20000); });
        const v = document.createElement("video");
        v.muted = true; v.preload = "auto"; v.src = "${urlOf(r)}";
        const meta = await once(v, "loadedmetadata", "error");
        const duration = v.duration;
        let seeked = false, at = 0;
        if (meta) { v.currentTime = ${seekTo}; seeked = await once(v, "seeked", "error"); at = v.currentTime; }
        return { meta, duration, seeked, at, size: [v.videoWidth, v.videoHeight] };
      })()`);
    const mixedBytes = (await stat(join(exportRoot, mixed.relPath))).size;
    const played = await play(mixed, 12);
    check("render scenario: the committed 15 s video plays through studio-media://video in the packaged app (Electron's H.264/AAC)", field(played, "meta") === true && Math.abs(Number(field(played, "duration")) - 15) < 0.3 && JSON.stringify(field(played, "size")) === "[1080,1920]", played);
    check("render scenario: the committed video seeks to 12 s", field(played, "seeked") === true && Math.abs(Number(field(played, "at")) - 12) < 0.3, played);
    check("render scenario: the player was served by Range: a 206 whose Content-Range total is the file's size", responses.some((r) => r.url === urlOf(mixed) && r.status === 206 && r.contentRange?.endsWith(`/${mixedBytes}`) === true), responses.filter((r) => r.url === urlOf(mixed)));

    // An explicit Range request, byte for byte (from the window sent to the video's own origin and back: see rangeProbe).
    const rangeAnswer = await rangeProbe(cdp, urlOf(mixed), "bytes=1000-1999");
    check("render scenario: an explicit Range: bytes=1000-1999 on studio-media://video is a 206 with that Content-Range and exactly those 1000 bytes", field(rangeAnswer, "status") === 206 && field(rangeAnswer, "range") === `bytes 1000-1999/${mixedBytes}` && field(rangeAnswer, "length") === 1000, rangeAnswer);

    // A `missing` record: its file is gone from a root that is still the record's.
    const firstPath = join(exportRoot, first.relPath);
    await retrying(() => rename(firstPath, `${firstPath}.away`));
    const missingList = await listVideos(cdp, avatarId);
    const missingPlayed = await play(first, 1);
    await retrying(() => rename(`${firstPath}.away`, firstPath));
    check("render scenario: videos.list reads the record of a removed file as missing", missingList.find((v) => v.videoId === first.videoId)?.fileState === "missing" && missingList.filter((v) => v.fileState === "present").length === renders.length - 1, missingList);
    check("render scenario: a missing record answers 404 and never plays", field(missingPlayed, "meta") === false && responses.some((r) => r.url === urlOf(first) && r.status === 404) && !responses.some((r) => r.url === urlOf(first) && r.status < 400), { missingPlayed, responses: responses.filter((r) => r.url === urlOf(first)) });

    // An `elsewhere` record: the export folder now holds another root (the marker names another id).
    const markerPath = join(exportRoot, EXPORT_MARKER_FILE);
    const markerText = await readFile(markerPath, "utf8");
    await retrying(() => writeFile(markerPath, markerText.replace(RENDER_ROOT_ID, OTHER_ROOT_ID)));
    const elsewhereList = await listVideos(cdp, avatarId);
    const elsewherePlayed = await play(third, 1);
    await retrying(() => writeFile(markerPath, markerText));
    check("render scenario: videos.list reads every record as elsewhere once the export folder is another root", elsewhereList.length === renders.length && elsewhereList.every((v) => v.fileState === "elsewhere"), elsewhereList);
    check("render scenario: an elsewhere record answers 404 and never plays", field(elsewherePlayed, "meta") === false && responses.some((r) => r.url === urlOf(third) && r.status === 404) && !responses.some((r) => r.url === urlOf(third) && r.status < 400), { elsewherePlayed, responses: responses.filter((r) => r.url === urlOf(third)) });
    const restored = await listVideos(cdp, avatarId);
    check("render scenario: with the file and the marker back every record is present again", restored.length === renders.length && restored.every((v) => v.fileState === "present"), restored);
    // The positive control: the same two videos that answered 404 play now, so the 404s above were the states and not a player that never works for them.
    // A fresh document: a failed load of the same URL may be remembered by the old one's memory cache.
    await cdp.send("Network.clearBrowserCache");
    await cdp.send("Page.reload", { ignoreCache: true });
    await waitFor("the window to reload", async () => ((await cdp.evaluate(`document.readyState === "complete" && typeof window.studio?.request === "function"`).catch(() => null)) === true ? true : null), 15_000, 100);
    await installPageHelpers(cdp);
    const firstAgain = await play(first, 1);
    const thirdAgain = await play(third, 1);
    check("render scenario: with the file and the marker back the two videos that answered 404 play again", field(firstAgain, "meta") === true && field(thirdAgain, "meta") === true, { firstAgain, thirdAgain });

    // 6. A fresh app (the engine host restarts a crashed engine once per run): kill ONLY the engine between the rename and the record, where the
    // restart must ADOPT the video with its record and its used mark. The hold is a test hook of the E2E build, armed by a file in userData.
    await quit(running);
    running = await launch(target, userData);
    sampler.follow(running.child.pid ?? -1);
    cdp = running.cdp;
    listen(cdp);
    await cdp.send("Network.enable");
    await waitFor("the next start to sweep what the killed render left", async () => ((await namesIn(mia)).some((n) => n.startsWith(".studio-part-")) || (await namesIn(join(userData, "render-tmp"))).includes(victim.jobId) ? null : true), 20_000, 200).catch(() => undefined);
    check("render scenario: the next start has swept the killed render's temp file and render-tmp folder", !(await namesIn(mia)).some((n) => n.startsWith(".studio-part-")) && !(await namesIn(join(userData, "render-tmp"))).includes(victim.jobId), { mia: await namesIn(mia), renderTmp: await namesIn(join(userData, "render-tmp")) });
    await writeFile(commitHoldPaths(userData).armed, "");
    const adoptedSubmit = await submit(collage3);
    await waitFor("the commit to be held after the rename", async () => (existsSync(commitHoldPaths(userData).held) ? true : null), RENDER_WAIT_MS, 50);
    const heldNames = finalVideos(await namesIn(mia));
    const claimed = heldNames.find((n) => !renders.some((r) => r.relPath === `Mia/${n}`));
    check("render scenario: held after the rename: the video is under its final name", claimed !== undefined && /_collage3_\d{3}\.mp4$/.test(claimed), heldNames);
    const paths = videoPaths(libraryRoot, avatarId);
    check("render scenario: held after the rename: its record does not exist yet and its intent does", !existsSync(paths.record(adoptedSubmit.videoId)) && existsSync(paths.intent(adoptedSubmit.videoId)), await namesIn(paths.videosDir));
    const heldBoot = field(await req(cdp, "engine.snapshot"), "result", "bootId");
    const heldEngine = enginePid(running.child.pid ?? -1);
    check("render scenario: the engine process is found to kill (held)", heldEngine !== null);
    if (heldEngine !== null) killEngineOnly(heldEngine);
    await waitFor("a snapshot from the restarted engine (held commit)", async () => {
      const s = await req(cdp, "engine.snapshot");
      return field(s, "ok") === true && field(s, "result", "bootId") !== heldBoot ? s : null;
    });
    const adopted = await waitFor("the restarted engine to adopt the held video", async () => (await listVideos(cdp, avatarId)).find((v) => v.videoId === adoptedSubmit.videoId) ?? null, 60_000, 200).catch(() => null);
    check("render scenario: after the kill between the rename and the record the video is ADOPTED with its record, present, at the name it was renamed to", adopted !== null && adopted.fileState === "present" && adopted.relPath === `Mia/${claimed ?? ""}`, adopted);
    const adoptedPhotos = await photoFacts(cdp, avatarId, photosFor(collage3));
    check("render scenario: the adopted video's photos carry its used mark", adoptedPhotos.usedIn.every((ids) => ids.length === 1 && ids[0] === adoptedSubmit.videoId) && adoptedPhotos.used.every(Boolean), adoptedPhotos);
    check("render scenario: after the adoption no intent is left and the hold was used up", (await namesIn(paths.pendingDir)).length === 0 && !existsSync(commitHoldPaths(userData).armed) && existsSync(commitHoldPaths(userData).held), await namesIn(paths.pendingDir));
    if (adopted !== null) {
      const render: SmokeRender = { plan: collage3, photoIds: photosFor(collage3), jobId: adoptedSubmit.jobId, videoId: adoptedSubmit.videoId, ms: 0, relPath: adopted.relPath, bytes: adopted.bytes, videoKind: "collage3" };
      renders.push(render);
      await examine(render);
    }

    // 7. Everything that was rendered is still there, and nothing else is.
    const finalList = await listVideos(cdp, avatarId);
    check("render scenario: at the end every committed video is present, seven of them", finalList.length === 7 && finalList.every((v) => v.fileState === "present"), finalList);
    const endNames = await namesIn(mia);
    check("render scenario: the avatar's export folder holds exactly those videos and no temp file", endNames.length === 7 && finalVideos(endNames).length === 7, endNames);
    fact("renders", renders.map((r) => ({ name: r.plan.name, seconds: Math.round(r.ms / 100) / 10, bytes: r.bytes })));
    fact("largest output", Math.max(...renders.map((r) => r.bytes)));
  } finally {
    sampler.stop();
    await quit(running);
    if (keep) console.log(`\nkept ${tmp}`);
    else await removeTemp(tmp);
  }
}

function finish(): void {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) process.exit(1);
}

async function main(): Promise<void> {
  const target = await resolveTarget();
  appExecutableDir = dirname(target.executable);
  console.log(`Studio engine smoke test — ${production ? "production check, " : ""}${target.label}\n`);
  if (production) {
    await productionCheck(target);
    finish();
    return;
  }

  // `--only render` runs the packaged render scenario alone (a shorter loop while working on it); CI runs everything.
  if (argValue("--only") === "render") {
    await runPackagedRenderScenario(target);
    finish();
    return;
  }

  // `--only media` runs the own-media scenario alone, for working on it; the full run is the one that counts.
  if (argValue("--only") === "media") {
    await runPackagedMediaScenario(target);
    finish();
    return;
  }

  // `--only sticker` runs the own-sticker scenario alone (3f.5), for working on it.
  if (argValue("--only") === "sticker") {
    await runPackagedStickerScenario(target);
    finish();
    return;
  }

  // `--only category` runs the custom-category scenario alone (CS.2), for working on it.
  if (argValue("--only") === "category") {
    await runCategoryScenario(target);
    finish();
    return;
  }

  // `--only music` runs the track store's scenario alone, for working on it; the full run is the one that counts.
  if (argValue("--only") === "music") {
    await runMusicScenario(target);
    finish();
    return;
  }

  const tmp = await mkdtemp(join(tmpdir(), "studio-smoke-"));
  const userData = join(tmp, "userData");
  const libraryRoot = join(tmp, "library");
  await mkdir(userData, { recursive: true });
  await mkdir(libraryRoot, { recursive: true });

  // A library with one real photo.
  const { library } = await openLibrary(libraryRoot);
  const avatar = await library.createAvatar({
    name: "Smoke",
    age: 25,
    traits: { hair: "chestnut" },
    descriptor: "a 25-year-old woman with chestnut hair",
  });
  const photo = await library.addPhoto(avatar.id, PNG, {
    mediaType: "image/png",
    width: 1,
    height: 1,
    source: {
      kind: "generated",
      model: "x-ai/grok-imagine-image-2.0",
      provider: "xai",
      jobId: "smoke-job-0001",
      attemptId: "smoke-attempt-0001",
      promptSha: "a".repeat(64),
      prompt: "smoke test portrait",
      costMicros: 50_000,
    },
  });
  const exportRoot = join(tmp, "export");
  await prepareMediaFixtures(exportRoot, avatar.id, libraryRoot, PNG);
  await saveSettings(userData, { ...defaultSettings(userData), libraryPath: libraryRoot, exportPath: exportRoot });

  // A ledger with one settled attempt this month and one left open by "a crash".
  const ledger = await Ledger.open(join(userData, "ledger.jsonl"));
  const at = new Date().toISOString();
  const reserve = { type: "reserve" as const, jobId: "smoke-job-0001", scope: { avatarJobId: "smoke-job-0001" }, model: "x-ai/grok-imagine-image-2.0", at };
  await ledger.append({ ...reserve, attemptId: "smoke-att-0001", worstMicros: 55_000 });
  await ledger.append({ type: "settle", attemptId: "smoke-att-0001", costMicros: 50_000, estimated: false, at });
  await ledger.append({ ...reserve, attemptId: "smoke-att-0002", worstMicros: 55_000 });

  checkPackage(target);
  await checkRuntimeInterruptsBusyWorker();

  // The live library's folder spelled with another letter case, for main's
  // folder dialog to answer with (it cannot be clicked). Only a disk that
  // ignores case (APFS, NTFS by default) has it as the same folder.
  const otherCase = join(dirname(libraryRoot), basename(libraryRoot).toUpperCase());
  const caseInsensitive = otherCase !== libraryRoot && existsSync(otherCase);
  let running = await launch(target, userData, caseInsensitive ? [`--studio-pick-folder=${otherCase}`] : []);
  try {
    const { cdp } = running;
    const statuses = new Map<string, { status: number; mimeType: string; nosniff: boolean }>();
    cdp.on((method, params) => {
      if (method !== "Network.responseReceived") return;
      const url = field(params, "response", "url");
      if (typeof url !== "string" || !url.startsWith("studio-media:")) return;
      const headers = field(params, "response", "headers");
      const nosniff = typeof headers === "object" && headers !== null &&
        Object.entries(headers).some(([k, v]) => k.toLowerCase() === "x-content-type-options" && v === "nosniff");
      statuses.set(url, { status: Number(field(params, "response", "status")), mimeType: String(field(params, "response", "mimeType")), nosniff });
    });
    await cdp.send("Network.enable");

    // 1. Engine started and answers.
    const snapshot = await req(cdp, "engine.snapshot");
    const bootId = field(snapshot, "result", "bootId");
    check("engine.snapshot answers from the engine", field(snapshot, "ok") === true && typeof bootId === "string", snapshot);
    await checkTextRasteriser(target.asar === null ? "the E2E build" : "the E2E package", running.output);
    check("the snapshot carries the settings from settings.json", field(snapshot, "result", "settings", "libraryPath") === libraryRoot, snapshot);

    const money = await req(cdp, "money.status");
    check(
      "money.status reads userData/ledger.jsonl through the Budget",
      field(money, "ok") === true &&
        field(money, "result", "spentMicros") === 50_000 &&
        field(money, "result", "unsettledMicros") === 55_000 &&
        field(money, "result", "unsettledCount") === 1 &&
        JSON.stringify(field(money, "result", "reconcileReasons")) === '["open-reserves"]',
      money,
    );

    // 2. Main validates.
    const bad = await cdp.evaluate(`window.studio.request({ v: ${PROTOCOL_VERSION}, id: "smoke-bad-0001", kind: "command", type: "no.such.command", payload: {} })`);
    check("main refuses a command that breaks the contract", field(bad, "ok") === false && field(bad, "error", "code") === "VALIDATION", bad);

    // 2b. The video commands are wired in the packaged engine (3a.8b.2). Refusals only: nothing here renders, writes or
    // spends (a real render, kill and restart in the packaged app is 3a.9's smoke).
    const videosList = await req(cdp, "videos.list", { avatarId: avatar.id });
    check("videos.list answers an avatar with no videos with an empty list", field(videosList, "ok") === true && JSON.stringify(field(videosList, "result", "videos")) === "[]", videosList);
    const videosCancel = await req(cdp, "videos.cancel", { jobId: "smoke-no-such-job-0001" });
    check("videos.cancel of an unknown job is NOT_FOUND", field(videosCancel, "ok") === false && field(videosCancel, "error", "code") === "NOT_FOUND", videosCancel);
    const videosDelete = await req(cdp, "videos.delete", { videoId: "smoke-no-such-video-01", mode: "record" });
    check("videos.delete of an unknown video is NOT_FOUND", field(videosDelete, "ok") === false && field(videosDelete, "error", "code") === "NOT_FOUND", videosDelete);
    const videosDraft = await req(cdp, "videos.render", { montageId: "smoke-no-such-montage-01" });
    check("videos.render of a montage draft that does not exist is NOT_FOUND", field(videosDraft, "ok") === false && field(videosDraft, "error", "code") === "NOT_FOUND", videosDraft);
    // 2c. The montage draft commands are wired in the packaged engine (3d.1a). The smoke avatar is a draft avatar, so it has no
    // scene photos to put in a montage: refusals and empty answers only (the drafts themselves are the engine tests' work).
    const montagesList = await req(cdp, "montages.list", {});
    check("montages.list answers a library with no drafts with an empty list", field(montagesList, "ok") === true && JSON.stringify(field(montagesList, "result", "items")) === "[]" && field(montagesList, "result", "total") === 0, montagesList);
    const montagesListAvatar = await req(cdp, "montages.list", { avatarId: avatar.id });
    check("montages.list of an avatar with no drafts is an empty list too", field(montagesListAvatar, "ok") === true && field(montagesListAvatar, "result", "skippedTotal") === 0, montagesListAvatar);
    const montagesGet = await req(cdp, "montages.get", { montageId: "smoke-no-such-montage-01" });
    check("montages.get of an unknown draft is NOT_FOUND", field(montagesGet, "ok") === false && field(montagesGet, "error", "code") === "NOT_FOUND", montagesGet);
    const montagesDelete = await req(cdp, "montages.delete", { montageId: "smoke-no-such-montage-01" });
    check("montages.delete of an unknown draft is NOT_FOUND", field(montagesDelete, "ok") === false && field(montagesDelete, "error", "code") === "NOT_FOUND", montagesDelete);
    const montagesCreate = await req(cdp, "montages.create", { avatarId: avatar.id, photoIds: [] });
    check("montages.create for an avatar that is not active is NOT_FOUND", field(montagesCreate, "ok") === false && field(montagesCreate, "error", "code") === "NOT_FOUND", montagesCreate);
    const montagesFocus = await req(cdp, "montages.focus", { avatarId: avatar.id, photo: { source: "scene", photoId: photo.id } });
    check("montages.focus for an avatar that is not active is NOT_FOUND", field(montagesFocus, "ok") === false && field(montagesFocus, "error", "code") === "NOT_FOUND", montagesFocus);
    // 2d. The text preview (3b.4b) through the packaged text worker: the caption rules, the layout, the template and resvg-wasm inside
    // app.asar, the PNG written under userData/render-tmp/text and served by studio-media://text/<previewId>.
    const previewLayer = { layerId: "smoke-layer-0001", kind: "text", startMs: 0, endMs: 1000, value: "sunday reset ☀️", font: "manrope", style: "plaque", color: "#ffffff", x: 0.5, y: 0.195, scale: 1 };
    const textPreview = await req(cdp, "montages.textPreview", { avatarId: avatar.id, layer: previewLayer });
    const previewId = field(textPreview, "result", "previewId");
    const previewWidth = field(textPreview, "result", "width");
    check(
      "montages.textPreview draws a caption through the packaged text worker",
      field(textPreview, "ok") === true && typeof previewId === "string" && typeof previewWidth === "number" && previewWidth > 100 && previewWidth <= 1080,
      textPreview,
    );
    const previewLoaded = await cdp.evaluate(
      `(async () => new Promise((r) => { const i = new Image(); i.onload = () => r({ loaded: true, width: i.naturalWidth }); i.onerror = () => r({ loaded: false }); i.src = "studio-media://text/${String(previewId)}"; }))()`,
    );
    check("the text preview PNG is served at studio-media://text/<previewId> at the size the answer states", JSON.stringify(previewLoaded) === JSON.stringify({ loaded: true, width: previewWidth }), previewLoaded);
    const previewRefused = await req(cdp, "montages.textPreview", { avatarId: avatar.id, layer: { ...previewLayer, value: "café" } });
    check(
      "montages.textPreview refuses a caption outside the charset as TEXT_INVALID (charset)",
      field(previewRefused, "ok") === false && field(previewRefused, "error", "code") === "TEXT_INVALID" && field(previewRefused, "error", "captionIssue") === "charset",
      previewRefused,
    );
    const layered = {
      schemaVersion: 1,
      avatarId: avatar.id,
      seed: 1,
      music: null,
      clips: [{ clipId: "smoke-clip-0001", kind: "photo", cell: { photo: { source: "scene", photoId: photo.id }, focus: null }, motion: "static", durationMs: 4000, transitionIn: "cut" }],
      layers: [{ layerId: "smoke-layer-0001", kind: "sticker", startMs: 0, endMs: 1000, sticker: { source: "own", mediaId: "smoke-media-0001" }, x: 0.5, y: 0.5, size: 0.2 }],
    };
    const videosLayered = await req(cdp, "videos.render", { spec: layered });
    check(
      "videos.render refuses a spec whose own sticker is not in the library as media-unavailable, before touching anything",
      field(videosLayered, "ok") === false && field(videosLayered, "error", "code") === "MONTAGE_INVALID" && JSON.stringify(field(videosLayered, "error", "issues")).includes("media-unavailable"),
      videosLayered,
    );
    const engineJobs = await req(cdp, "engine.snapshot");
    check("none of those refusals left a render job behind", Array.isArray(field(engineJobs, "result", "jobs")) && !JSON.stringify(field(engineJobs, "result", "jobs")).includes('"render"'), engineJobs);

    // 3. studio-media://
    const media = await cdp.evaluate(`(async () => {
      const load = (src) => new Promise((r) => { const i = new Image(); i.onload = () => r({ loaded: true, width: i.naturalWidth }); i.onerror = () => r({ loaded: false }); i.src = src; });
      return {
        malformed: await load("studio-media://photo/NOPE/../x"),
        unknown: await load("studio-media://photo/${avatar.id}/unknown-photo-0000"),
        real: await load("studio-media://photo/${avatar.id}/${photo.id}"),
      };
    })()`);
    check("an image with a malformed studio-media:// id does not load", field(media, "malformed", "loaded") === false, media);
    check("an image with an unknown photo id does not load", field(media, "unknown", "loaded") === false, media);
    check("a real library photo loads through studio-media://", field(media, "real", "loaded") === true && field(media, "real", "width") === 1, media);
    await Bun.sleep(300);
    const real = statuses.get(`studio-media://photo/${avatar.id}/${photo.id}`);
    const unknown = statuses.get(`studio-media://photo/${avatar.id}/unknown-photo-0000`);
    check("the real photo is a 200 with image/png and nosniff", real?.status === 200 && real.mimeType === "image/png" && real.nosniff, [...statuses]);
    check("the unknown photo is a 404", unknown?.status === 404, [...statuses]);
    const malformed = [...statuses].find(([url]) => url.includes("NOPE") || url.includes("/x"));
    check("the malformed id is a 404", malformed?.[1].status === 404, [...statuses]);

    // 3b. The widened routes (3b.1, invariant 28), in the real app: a committed video plays and seeks through Range, the poster
    // and a built-in sticker (from inside app.asar when packaged) load, and a video with no record is a 404.
    const responses: { url: string; status: number; contentRange: string | null }[] = [];
    cdp.on((method, params) => {
      if (method !== "Network.responseReceived") return;
      const url = field(params, "response", "url");
      if (typeof url !== "string" || !url.startsWith("studio-media://video/")) return;
      const headers = field(params, "response", "headers");
      const range = typeof headers === "object" && headers !== null ? Object.entries(headers).find(([k]) => k.toLowerCase() === "content-range")?.[1] : undefined;
      responses.push({ url, status: Number(field(params, "response", "status")), contentRange: typeof range === "string" ? range : null });
    });
    const recordPath = await writeMediaRecord(exportRoot, libraryRoot, avatar.id, photo.id);
    const videoUrl = `studio-media://video/${avatar.id}/${MEDIA_VIDEO_ID}`;
    const played = await cdp.evaluate(`(async () => {
      const once = (el, ok, bad) => new Promise((r) => { el.addEventListener(ok, () => r(true), { once: true }); el.addEventListener(bad, () => r(false), { once: true }); setTimeout(() => r(false), 15000); });
      const v = document.createElement("video");
      v.muted = true; v.preload = "auto"; v.src = "${videoUrl}";
      const meta = await once(v, "loadedmetadata", "error");
      const duration = v.duration;
      v.currentTime = 1.5;
      const seeked = await once(v, "seeked", "error");
      const at = v.currentTime;
      const missing = document.createElement("video");
      missing.src = "studio-media://video/${avatar.id}/smoke-no-such-video-01";
      const missingFailed = !(await once(missing, "loadedmetadata", "error"));
      const load = (src) => new Promise((r) => { const i = new Image(); i.onload = () => r({ loaded: true, width: i.naturalWidth }); i.onerror = () => r({ loaded: false }); i.src = src; });
      return { meta, duration, seeked, at, missingFailed,
        poster: await load("studio-media://poster/${avatar.id}/${MEDIA_VIDEO_ID}"),
        sticker: await load("studio-media://sticker/heart-pulse"),
        unknownSticker: await load("studio-media://sticker/no-such-sticker") };
    })()`);
    check("a committed video loads its metadata through studio-media://video", field(played, "meta") === true && Math.abs(Number(field(played, "duration")) - 2) < 0.3, played);
    check("a committed video seeks (Range) to 1.5 s", field(played, "seeked") === true && Math.abs(Number(field(played, "at")) - 1.5) < 0.2, played);
    check("the player was served with Range: a 206 answer carried a Content-Range", responses.some((r) => r.status === 206 && r.contentRange !== null && /^bytes \d+-\d+\/\d+$/.test(r.contentRange)), responses);
    check("a video with no record does not load (404)", field(played, "missingFailed") === true && responses.some((r) => r.url.includes("smoke-no-such-video-01") && r.status === 404), [played, responses]);
    check("the poster route serves a poster", field(played, "poster", "loaded") === true, played);
    check("a built-in sticker loads through studio-media://sticker (from the asar when packaged)", field(played, "sticker", "loaded") === true && field(played, "sticker", "width") === 320, played);
    check("an unknown sticker does not load", field(played, "unknownSticker", "loaded") === false, played);
    // 3d.4 (review round 1): the preview's decoder gets a built-in sticker's bytes from main over IPC (`stickers.bytes`, from inside
    // app.asar when packaged); the media scheme stays closed to script reads (it is never CORS-enabled).
    const stickerBytes = await cdp.evaluate(`(async () => {
      const head = async (stickerId) => {
        const r = await window.__req("stickers.bytes", { stickerId });
        return r.ok ? { ok: true, head: r.result.apngBase64.slice(0, 11), length: r.result.apngBase64.length } : { ok: false, code: r.error.code };
      };
      const fetched = await fetch("studio-media://sticker/heart-pulse").then(() => "read", () => "refused");
      return { known: await head("heart-pulse"), unknown: await head("no-such-sticker"), fetched };
    })()`);
    check("stickers.bytes answers a built-in sticker's verified PNG bytes (from the asar when packaged)", field(stickerBytes, "known", "ok") === true && field(stickerBytes, "known", "head") === "iVBORw0KGgo" && Number(field(stickerBytes, "known", "length")) > 1000, stickerBytes);
    check("stickers.bytes of a sticker the set lacks is NOT_FOUND", field(stickerBytes, "unknown", "code") === "NOT_FOUND", stickerBytes);
    check("the window cannot read the media scheme by script (no corsEnabled)", field(stickerBytes, "fetched") === "refused", stickerBytes);
    // The record was only there for this section: later checks (and a restarted engine) must find the library as it was.
    await rm(recordPath);

    // 3c. The page's own origin (the 3f.6 security review): no `file:` read, no `file:` frame, the app itself unharmed.
    await checkRendererOrigin(cdp, tmp);

    // 4. Key flow.
    const set = await req(cdp, "settings.setApiKey", { key: SMOKE_KEY });
    check("settings.setApiKey stores the key and answers only its last four chars",
      field(set, "ok") === true && field(set, "result", "stored") === true && field(set, "result", "last4") === "7q3z" && !JSON.stringify(set).includes(SMOKE_KEY), set);
    const afterSet = await req(cdp, "settings.get");
    check("the engine got the key (settings.get from the engine shows it stored)",
      field(afterSet, "result", "apiKey", "stored") === true && field(afterSet, "result", "apiKey", "last4") === "7q3z", afterSet);
    const blob = await readFile(join(userData, "secrets.bin"));
    check("secrets.bin holds ciphertext, not the key", blob.length > 0 && !blob.toString("latin1").includes(SMOKE_KEY));
    const leaks: string[] = [];
    for (const name of await readdir(userData, { recursive: true })) {
      const path = join(userData, name);
      if (name === "secrets.bin" || !existsSync(path)) continue;
      try {
        if ((await readFile(path)).toString("latin1").includes(SMOKE_KEY)) leaks.push(name);
      } catch {
        // a directory or a file that vanished
      }
    }
    check("the key is in no other userData file", leaks.length === 0, leaks);

    // 4b. Settings belong to main.
    const budget = await req(cdp, "settings.setBudget", { monthlyBudgetMicros: 25_000_000 });
    const savedSettings: unknown = JSON.parse(await readFile(join(userData, "settings.json"), "utf8"));
    const moneyAfterBudget = await req(cdp, "money.status");
    check("settings.setBudget is persisted by main and reaches the engine",
      field(budget, "ok") === true && field(budget, "result", "monthlyBudgetMicros") === 25_000_000 &&
        field(savedSettings, "monthlyBudgetMicros") === 25_000_000 && field(moneyAfterBudget, "result", "monthlyBudgetMicros") === 25_000_000,
      { budget, savedSettings, moneyAfterBudget });

    // 4c. The live library's folder picked again with another letter case: the
    // engine must know it is the folder in use (Electron's native realpath
    // folds the case) and answer without a second survey, which would move
    // the live library's unfinished writes to quarantine.
    if (!caseInsensitive) {
      console.log("SKIP  picking the live library with another letter case (this disk is case-sensitive)");
    } else {
      const unfinished = join(libraryRoot, "avatars", avatar.id, "photos", "writing-0001.png");
      await Bun.write(unfinished, PNG);
      const picked = await req(cdp, "settings.setLibraryPath", { path: otherCase });
      check("the live library picked with another letter case is the folder in use: ok, and no second survey",
        field(picked, "ok") === true && field(picked, "result", "libraryPath") === otherCase &&
          existsSync(unfinished) && !existsSync(join(libraryRoot, "quarantine")),
        { picked, unfinished: existsSync(unfinished), quarantine: existsSync(join(libraryRoot, "quarantine")) });
      await rm(unfinished, { force: true });
    }

    // 5. Engine environment.
    const mainPid = running.child.pid ?? -1;
    const pid = await waitFor("the engine process", async () => enginePid(mainPid), 5_000);
    if (process.platform !== "darwin") {
      console.log("SKIP  the engine environment check (reads environments with macOS `ps -E`; engineEnv.test.ts covers the rule)");
    } else if (commandWithEnv(mainPid).includes(ENV_CANARY)) {
      check("the engine's environment has no OPENROUTER_* (the app's has one)", !commandWithEnv(pid).includes("OPENROUTER"));
    } else {
      check("ps -E shows process environments (needed for the env check)", false, "ps -E did not show the app's own environment");
    }

    // 6. Restart policy.
    process.kill(pid, "SIGKILL");
    const crashEvent = await waitFor("an engine.notice event", async () => {
      const events = await cdp.evaluate(`window.__smoke.events.filter((e) => e.type === "engine.notice" && e.payload.notice.code === "engine-restarted")`);
      return Array.isArray(events) && events.length > 0 ? events[0] : null;
    });
    check("a killed engine is reported as an engine-restarted notice",
      field(crashEvent, "payload", "notice", "code") === "engine-restarted" &&
        /exited unexpectedly.*restarting it/.test(String(field(crashEvent, "payload", "notice", "detail"))),
      crashEvent);
    const after = await waitFor("a snapshot from the restarted engine", async () => {
      const s = await req(cdp, "engine.snapshot");
      return field(s, "ok") === true ? s : null;
    });
    const newBootId = field(after, "result", "bootId");
    check("the restarted engine has a new bootId", typeof newBootId === "string" && newBootId !== bootId, { bootId, newBootId });
    check("the restarted engine got the key again", field(after, "result", "settings", "apiKey", "last4") === "7q3z", after);
    check("the restarted engine got the current settings again", field(after, "result", "settings", "monthlyBudgetMicros") === 25_000_000, after);
    // The regression: main's own events (a foreign bootId) made the renderer
    // resnapshot, and every snapshot replayed them. Notices come from the
    // engine's own stream: every engine.notice carries the new engine's
    // bootId, and a quiet second later there are still only a handful.
    await Bun.sleep(1500);
    const crashEvents = await cdp.evaluate(`window.__smoke.events.filter((e) => e.type === "engine.notice")`);
    const errorEvents = await cdp.evaluate(`window.__smoke.events.filter((e) => e.type === "engine.error")`);
    check("the crash is reported by the restarted engine itself, without an event flood and not as an error",
      Array.isArray(crashEvents) && crashEvents.length >= 1 && crashEvents.length <= 3 &&
        crashEvents.every((e: unknown) => field(e, "bootId") === newBootId) &&
        Array.isArray(errorEvents) && errorEvents.length === 0,
      { newBootId, crashEvents, errorEvents });
    check("the restarted engine's snapshot carries the crash notice",
      JSON.stringify(field(after, "result", "notices")).includes("engine-restarted"), after);
    const newPid = enginePid(mainPid);
    check("a new engine process runs", newPid !== null && newPid !== pid, { pid, newPid });
    check("the key never appeared in the app's output", !running.output().includes(SMOKE_KEY));

    // 7. Single instance, and what a closed last window does to the app.
    // macOS keeps the app and the engine running (main.ts's
    // window-all-closed no-ops there; the dock icon would reopen a window).
    // Windows and Linux instead quit the whole app on the last window close
    // (main.ts: `window-all-closed` calls `app.quit()` off darwin, which
    // triggers `will-quit` -> `engine.stop()`), so there is no "same engine
    // kept running" to check there — the app and its engine must both exit,
    // and the rest of the smoke continues on a fresh cold relaunch instead.
    const enginePidBeforeClose = enginePid(mainPid);
    await cdp.evaluate("window.close(), true").catch(() => undefined);
    cdp.close();
    await waitFor(
      "the window to close",
      async () => {
        try {
          return (await pageCount(running.port)) === 0 ? true : null;
        } catch (error) {
          // Off macOS the app quits with its last window, and it can be gone before the DevTools port is asked for the last time:
          // a refused connection then IS the window having closed (the quit itself is checked below). On macOS the app stays,
          // so a failed connection is retried until the deadline.
          if (process.platform !== "darwin") return true;
          throw error;
        }
      },
      10_000,
    );

    if (process.platform === "darwin") {
      check("closing the last window keeps the app and the same engine running (macOS)",
        running.child.exitCode === null && enginePidBeforeClose !== null && enginePid(mainPid) === enginePidBeforeClose, { enginePidBeforeClose });
      check("a second instance on the same userData exits", await secondInstanceExits(target, userData, running.env));
      running.cdp = await connectPage(running.port);
      check("the first instance opened a window for it, and only one", (await pageCount(running.port)) === 1);
      const reopened = await req(running.cdp, "engine.snapshot");
      check("the reopened window restores from engine.snapshot of the engine that kept running",
        field(reopened, "ok") === true && field(reopened, "result", "bootId") === newBootId, { reopened, newBootId });
      check("a window opened after the crash is still told about it (the snapshot's pending notices)",
        JSON.stringify(field(reopened, "result", "notices")).includes("engine-restarted"), reopened);
    } else {
      console.log(`SKIP  "keeps the same engine running" and "reopened window restores from it" (${process.platform}: window-all-closed quits the app instead — see main.ts)`);
      const closedChild = running.child;
      const quitCleanly = await waitFor(
        "the app to quit after its last window closed",
        async () => (closedChild.exitCode !== null || closedChild.signalCode !== null ? true : null),
        15_000,
      ).catch(() => false);
      check(`closing the last window quits the app on ${process.platform}`, quitCleanly === true, { exitCode: closedChild.exitCode, signalCode: closedChild.signalCode });
      const engineExited = await waitFor(
        "the engine process to exit along with the app",
        async () => (enginePidBeforeClose === null || !pidAlive(enginePidBeforeClose) ? true : null),
        10_000,
      ).catch(() => false);
      check("the engine process exits along with the app", engineExited === true, { enginePidBeforeClose });
      killTree(closedChild); // defensive: a no-op once it has already exited on its own

      // A cold relaunch on the same userData: the rest of the smoke (second
      // instance, then the corrupt-settings.json restart below) needs a
      // live instance, and this OS left none running to reuse. Retried with
      // backoff (see launchWithRetry) in case the SingletonLock this app
      // just released is not yet gone.
      running = await launchWithRetry(target, userData);
      check("a second instance on the same userData exits", await secondInstanceExits(target, userData, running.env));
      check("the relaunched instance kept its one window after the second instance exited", (await pageCount(running.port)) === 1);
    }

    // 8. App restart with a corrupt settings.json: it is moved aside and reported;
    // main decrypts the key and hands it over again; then clear it.
    await quit(running);
    await Bun.write(join(userData, "settings.json"), "{ corrupt");
    running = await launch(target, userData);
    const restarted = await req(running.cdp, "engine.snapshot");
    const aside = (await readdir(userData)).filter((name) => name.startsWith("settings.json.corrupt-"));
    const pending = field(restarted, "result", "notices");
    check("a corrupt settings.json is moved aside, the defaults are used, and the snapshot carries a settings-reset notice",
      aside.length === 1 && field(restarted, "result", "settings", "libraryPath") === join(userData, "library") &&
        Array.isArray(pending) &&
        pending.some((n: unknown) => field(n, "code") === "settings-reset" && /moved to settings\.json\.corrupt-/.test(String(field(n, "detail")))),
      { aside, restarted });
    const relaunched = await req(running.cdp, "settings.get");
    check("after an app restart the engine has the key again", field(relaunched, "result", "apiKey", "last4") === "7q3z", relaunched);
    const cleared = await req(running.cdp, "settings.clearApiKey");
    const afterClear = await req(running.cdp, "settings.get");
    check("settings.clearApiKey removes the key from disk and the engine",
      field(cleared, "result", "stored") === false && field(afterClear, "result", "apiKey", "stored") === false && !existsSync(join(userData, "secrets.bin")),
      { cleared, afterClear });
  } finally {
    await quit(running);
    // Windows can hold a brief file lock on a just-exited process's files
    // (userData, the library); bounded retries ride that out instead of
    // failing the cleanup outright.
    if (keep) console.log(`\nkept ${tmp}`);
    else await removeTemp(tmp);
  }

  await runAvatarScenario(target);
  await runImportScenario(target);
  await runPackagedMediaScenario(target);
  await runPackagedStickerScenario(target);
  await runMusicScenario(target);
  await runPhotoRunKillResumeScenario(target);
  await runCategoryScenario(target);
  await runPackagedRenderScenario(target);
  finish();
}

await main();
