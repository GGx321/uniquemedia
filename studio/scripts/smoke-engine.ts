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
 * - main refuses a command that breaks the contract;
 * - the `videos.*` commands are wired in the engine: refusals only (an empty list, NOT_FOUND, the N9 "not yet
 *   supported" answer), nothing rendered or written (a real render, kill and restart is the packaged E2E, 3a.9);
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
 * - packaged: the engine entry lives inside app.asar, not unpacked; the fuses are set.
 *
 * Every debug door (remote debugging, DevTools, the test switches) is a
 * build-time constant: a `build:studio` output has none, however it is
 * launched — also unpackaged. So the full run needs an E2E build
 * (STUDIO_E2E=1: DevTools and the test switches kept, never shipped).
 * --production checks a production build instead: its bundles (main, preload
 * and renderer, every debug door compiled out, see bundleChecks.ts), and with
 * --app the real package: its fuses, that it launches its engine with remote
 * debugging refused, and that the refusal is a clean one-line message, not a
 * stack trace.
 *
 * Usage (macOS; on Windows point --app at release-studio/win-unpacked or its
 * Studio.exe, and release-studio/e2e/win-unpacked for an E2E package):
 *   bun run build:studio:e2e && bun studio/scripts/smoke-engine.ts
 *   bun run dist:studio:mac:e2e && bun studio/scripts/smoke-engine.ts --app release-studio/e2e/mac-arm64/Studio.app
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
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, normalize, resolve } from "node:path";
import { FACE_MODELS } from "../engine/face/modelSource";
import { openLibrary } from "../engine/library";
import { Ledger } from "../engine/money/ledger";
import { RunEventSchema, type RunEvent } from "../engine/runs/journal";
import { defaultSettings, saveSettings } from "../main/settingsStore";
import { PROTOCOL_VERSION } from "../shared/engine";
import { ffmpegPath } from "../node/ffmpegBinary";
import { faceWorkerProblems, productionBundleProblems, productionEngineProblems, productionMainProblems, productionRendererCssProblems, textWorkerProblems } from "./bundleChecks";
import { authorizationLabel, DEFAULT_IMPORT_DESCRIBE_ANSWER, markerMatch, requestCarries, startMockOpenRouter, type MockRequest } from "./mockOpenRouter";
import { electronBinary } from "./electronBinary";
import { failureDetail } from "./failureDetail";
import { textAssetPackageProblems, textRasteriserOutputProblems } from "./textSmoke";
import { looksLikeAStackTrace } from "./stackTrace";

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
    const exe = app.toLowerCase().endsWith(".exe") ? app : join(app, "Studio.exe");
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

/** Connects to the app's renderer page and installs the request and event helpers. */
async function connectPage(port: number): Promise<Cdp> {
  const wsUrl = await waitFor("the renderer page on the DevTools port", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    const targets: unknown = await response.json();
    if (!Array.isArray(targets)) return null;
    for (const t of targets) {
      if (typeof t === "object" && t !== null && "type" in t && t.type === "page" && "url" in t && typeof t.url === "string" &&
        t.url.endsWith("/renderer/index.html") && "webSocketDebuggerUrl" in t && typeof t.webSocketDebuggerUrl === "string") {
        return t.webSocketDebuggerUrl;
      }
    }
    return null;
  });
  const cdp = await Cdp.connect(wsUrl);
  await waitFor("window.studio.request", async () =>
    (await cdp.evaluate(`document.readyState === "complete" && typeof window.studio?.request === "function"`)) === true ? true : null,
  );
  await cdp.evaluate(`
    window.__smoke = { events: [] };
    window.studio.subscribe((e) => window.__smoke.events.push(e));
    window.__req = (type, payload = {}) => window.studio.request({ v: ${PROTOCOL_VERSION}, id: crypto.randomUUID(), kind: "command", type, payload });
    true`);
  return cdp;
}

async function pageCount(port: number): Promise<number> {
  const targets: unknown = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
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
async function launchWithRetry(target: Target, userData: string, attempts = 3): Promise<Running> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await launch(target, userData);
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
};

function checkPackage(target: Target): void {
  if (target.asar === null || target.app === null) return;
  const entries = listPackage(target.asar, { isPack: false }).map((p) => p.replaceAll("\\", "/"));
  check("app.asar contains out-studio/engine/main.js", entries.includes("/out-studio/engine/main.js"));
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
  check("app.asar contains the face worker entry, and it is not unpacked", entries.includes("/out-studio/engine/faceWorker.js") && !existsSync(join(`${target.asar}.unpacked`, "out-studio", "engine", "faceWorker.js")));
  // 3b.2, the text rasteriser: resvg's .wasm, the six fonts and their OFL texts stay inside the asar too (never
  // unpacked, for the same integrity reason). That they load from there under the fuses, in the real
  // utilityProcess, is checked by `checkTextRasteriser` on what the engine prints at start-up.
  const textAssetProblems = [...textAssetPackageProblems(entries), ...(entries.includes("/out-studio/engine/textWorker.js") ? [] : ["/out-studio/engine/textWorker.js is not in the package"])];
  if (existsSync(join(`${target.asar}.unpacked`, "out-studio", "engine", "textWorker.js"))) textAssetProblems.push("textWorker.js is unpacked from the asar");
  check("app.asar contains resvg's wasm, the bundled fonts and their licences", textAssetProblems.length === 0, textAssetProblems);
  const fuses = spawnSync("bunx", ["@electron/fuses", "read", "--app", target.app], { encoding: "utf8" }).stdout;
  const wrong = Object.entries(EXPECTED_FUSES).filter(([fuse, state]) => !new RegExp(`${fuse} is ${state}`).test(fuses));
  check("the Electron fuses are set (runAsNode, NODE_OPTIONS, --inspect off; asar-only with integrity; cookie encryption)", wrong.length === 0, { wrong, fuses });
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

/** Every debug door compiled out of a production build's bundles (bundleChecks.ts), wherever they were read from. */
function checkProductionBundles(where: string, main: string, engine: string, preload: string, renderer: string, rendererCss: string): void {
  const mainProblems = productionMainProblems(main);
  check(`${where}: main has every debug door compiled out (no test switch, no env renderer URL, DevTools off, remote debugging refused)`, mainProblems.length === 0, mainProblems);
  const engineProblems = productionEngineProblems(engine);
  check(`${where}: the engine was built without the E2E flag (no base-URL override)`, engineProblems.length === 0, engineProblems);
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
  );
  const packagedEntries = new Set(listPackage(target.asar, { isPack: false }).map((p) => p.replaceAll("\\", "/")));
  checkTextWorker(
    "the package",
    asarText(target, join("out-studio", "engine", "main.js")),
    packagedEntries.has("/out-studio/engine/textWorker.js") ? asarText(target, join("out-studio", "engine", "textWorker.js")) : null,
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
      listening = await fetch(`http://127.0.0.1:${port}/json/version`).then(() => true, () => false);
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
    await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
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
    // 120 s wait. Without this marker, the reconcile after the scenario
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
    // reconcile wait (studio/engine/money/reconcile.ts's RECONCILE_QUIET_MS,
    // 2 minutes) to pass, never a fixed sleep past what the engine itself
    // reports. Thanks to the baseline reconcile above, this is a real
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
      170_000,
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
    await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
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
    // The one-time image age check is mandatory for an import, whatever
    // settings.imageAgeCheck says; nothing here should reject it.
    rejectAgeCheckNumber: 0,
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
      "import scenario: avatars.estimateImport prices the mandatory age check plus up to two describe attempts",
      field(estimate, "ok") === true && typeof field(estimate, "result", "worstMicros") === "number",
      estimate,
    );

    // 2. Confirm the import: the one-time age check, then the vision describe call.
    const imported = await req(cdp, "avatars.importAvatar", {
      stagingId,
      name: IMPORT_MARKER_NAME,
      confirmedAiPersona: true,
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
    // 9 widened: "generated, or the owner's import"), with the one-time
    // age verdict recorded in qa.age.
    const { library } = await openLibrary(libraryRoot);
    const manifest = library.getAvatar(String(avatarId));
    const photo = manifest?.masterPhotoId ? library.getPhoto(manifest.masterPhotoId) : undefined;
    check(
      "import scenario: the master photo's sidecar records the import, not a generated frame, with a passing one-time age verdict",
      photo?.source.kind === "imported" && photo.qa.age?.adult === true,
      photo,
    );

    // 4. studio-media:// serves the imported master, exactly like a generated one.
    const loaded = await cdp.evaluate(
      `new Promise((r) => { const i = new Image(); i.onload = () => r(true); i.onerror = () => r(false); i.src = "studio-media://photo/${String(avatarId)}/${String(masterPhotoId)}"; })`,
    );
    check("import scenario: studio-media:// serves the imported master photo (invariant 9 widened)", loaded === true);

    // 5. Exactly one mandatory age check and one describe attempt reached the mock; the import never generates an image.
    check(
      "import scenario: the mock saw exactly one age check and one describe attempt, no image generation",
      mock.ageCheckRequests().length === 1 && mock.importDescribeRequests().length === 1 && mock.imageRequests().length === 0,
      mock.requests,
    );
    check("import scenario: no request to the mock was on an unexpected route", mock.unexpected.length === 0, mock.unexpected);

    // 6. The owner's entered name never reaches the mock: T6c has no vibe at
    // all (traits come from the vision call), so the name is the only user
    // text at risk of leaking into a request (mirrors engine.canary.test.ts's own check).
    const nameLeaks = mock.requests.filter((r) => JSON.stringify(r.body).toLowerCase().includes(IMPORT_MARKER_NAME.toLowerCase()));
    check("import scenario: the owner's entered name never reaches the mock", nameLeaks.length === 0, nameLeaks);

    // 7. Money: one age check + one describe attempt, exactly the mock's charged costs, nothing left open.
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
        const events = await cdp.evaluate(`window.__smoke.events.filter((e) => e.type === "engine.notice")`);
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
    // the ledger — the same wait a real kill -9 would force on the owner):
    // a known >= 300 s floor, so a 3 s poll interval finds it just as
    // promptly as the default 200 ms would, for a fraction of the calls.
    const reconciledAfterKill = await waitFor(
      "money.reconcile past its quiet window (invariant 4: nothing more is spent until reconciled)",
      async () => {
        const r = await req(cdp, "money.reconcile");
        if (field(r, "ok") !== true || field(r, "result", "status") === "too-early") return null;
        return r;
      },
      340_000,
      3_000,
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
    await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
}

// ---------- main ----------

function finish(): void {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) process.exit(1);
}

async function main(): Promise<void> {
  const target = await resolveTarget();
  console.log(`Studio engine smoke test — ${production ? "production check, " : ""}${target.label}\n`);
  if (production) {
    await productionCheck(target);
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
  await saveSettings(userData, { ...defaultSettings(userData), libraryPath: libraryRoot });

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
    const videosDelete = await req(cdp, "videos.delete", { videoId: "smoke-no-such-video-01" });
    check("videos.delete of an unknown video is NOT_FOUND", field(videosDelete, "ok") === false && field(videosDelete, "error", "code") === "NOT_FOUND", videosDelete);
    const videosDraft = await req(cdp, "videos.render", { montageId: "smoke-no-such-montage-01" });
    check("videos.render of a montage draft is NOT_FOUND until drafts exist", field(videosDraft, "ok") === false && field(videosDraft, "error", "code") === "NOT_FOUND", videosDraft);
    const layered = {
      schemaVersion: 1,
      avatarId: avatar.id,
      seed: 1,
      music: null,
      clips: [{ clipId: "smoke-clip-0001", kind: "photo", cell: { photo: { source: "scene", photoId: photo.id }, focus: null }, motion: "static", durationMs: 4000, transitionIn: "cut" }],
      layers: [{ layerId: "smoke-layer-0001", kind: "text", startMs: 0, endMs: 1000, value: "hello", font: "manrope", style: "none", color: "#ffffff", x: 0.5, y: 0.5, scale: 1 }],
    };
    const videosLayered = await req(cdp, "videos.render", { spec: layered });
    check(
      "videos.render refuses a spec with a text layer as not-yet-supported (N9), before touching anything",
      field(videosLayered, "ok") === false && field(videosLayered, "error", "code") === "MONTAGE_INVALID" && JSON.stringify(field(videosLayered, "error", "issues")).includes("not-yet-supported"),
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
      const events = await cdp.evaluate(`window.__smoke.events.filter((e) => e.type === "engine.notice")`);
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
    await waitFor("the window to close", async () => ((await pageCount(running.port)) === 0 ? true : null), 10_000);

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
    else await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }

  await runAvatarScenario(target);
  await runImportScenario(target);
  await runPhotoRunKillResumeScenario(target);
  finish();
}

await main();
