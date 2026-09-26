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
import { openLibrary } from "../engine/library";
import { Ledger } from "../engine/money/ledger";
import { defaultSettings, saveSettings } from "../main/settingsStore";
import { productionBundleProblems, productionEngineProblems, productionMainProblems } from "./bundleChecks";
import { startMockOpenRouter, type MockRequest } from "./mockOpenRouter";
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

async function electronBinary(): Promise<string> {
  const mod: unknown = await import("electron");
  const path = typeof mod === "string" ? mod : typeof mod === "object" && mod !== null && "default" in mod ? mod.default : null;
  if (typeof path !== "string") throw new Error("could not locate the Electron binary");
  return path;
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
  results.push({ name, ok, detail: ok || detail === undefined ? undefined : JSON.stringify(detail).slice(0, 600) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : `\n      ${JSON.stringify(detail).slice(0, 600)}`}`);
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

async function waitFor<T>(what: string, probe: () => Promise<T | null>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value !== null) return value;
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(200);
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
    window.__req = (type, payload = {}) => window.studio.request({ v: 1, id: crypto.randomUUID(), kind: "command", type, payload });
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
  return { child, cdp: await connectPage(port), port, env, output: () => output };
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

/** Every debug door compiled out of a production build's bundles (bundleChecks.ts), wherever they were read from. */
function checkProductionBundles(where: string, main: string, engine: string, preload: string, renderer: string): void {
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
}

async function productionCheck(target: Target): Promise<void> {
  if (target.asar === null) {
    // `build:studio` output: the bundles only; a package is what launches.
    checkProductionBundles(
      "the production build",
      await readFile(join(ROOT, "out-studio", "main", "main.js"), "utf8"),
      await readFile(join(ROOT, "out-studio", "engine", "main.js"), "utf8"),
      await readFile(join(ROOT, "out-studio", "preload", "preload.cjs"), "utf8"),
      await rendererBundleText(target),
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

/** Whether any marker word is anywhere in a mock request's body, in any letter case (engine.canary.test.ts's own `carriesMarker`). */
function carriesMarker(request: MockRequest): boolean {
  const text = JSON.stringify(request.body).toLowerCase();
  return AVATAR_MARKER_WORDS.some((word) => text.includes(word));
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
async function runAvatarScenario(target: Target): Promise<void> {
  const mock = await startMockOpenRouter({ descriptorText: AVATAR_DESCRIPTOR, rejectAgeCheckNumber: 1 });
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
      "avatar scenario: 3 candidates passed the age check and the age-gated one was rejected",
      Array.isArray(candidates) &&
        candidates.length === 3 &&
        field(end, "payload", "result", "rejectedByAgeCheck") === 1 &&
        Array.isArray(failedSlots) &&
        failedSlots.length === 1 &&
        field(failedSlots[0], "reason") === "age-rejected",
      end,
    );

    // 4. The 3 passed candidates' files exist in the library; the rejected one was never written anywhere (checked before the pick below deletes the unpicked ones — invariant 9).
    const beforePick = await filesUnder(libraryRoot);
    const photoDir = `avatars/${String(avatarId)}/photos/`;
    check(
      "avatar scenario: exactly the 3 passed candidates' image and sidecar files exist in the library",
      Array.isArray(candidates) &&
        candidates.every((c: unknown) => {
          const photoId = String(field(c, "photoId"));
          return beforePick.some((f) => f.startsWith(photoDir) && f.includes(photoId) && f.endsWith(".json")) &&
            beforePick.some((f) => f.startsWith(photoDir) && f.includes(photoId) && !f.endsWith(".json"));
        }) &&
        beforePick.filter((f) => f.startsWith(photoDir) && f.endsWith(".json")).length === 3,
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
    // 2 minutes) to pass, never a fixed sleep past what the engine itself reports.
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
      "avatar scenario: money.reconcile against the mock's /credits reports no mismatch",
      field(reconciled, "result", "status") === "done" &&
        field(reconciled, "result", "mismatch") !== true &&
        field(reconciled, "result", "ledgerDeltaMicros") === expectedMicros,
      reconciled,
    );

    // 10. Every request the engine made went to the mock, exactly the expected sequence, and no unknown route was hit.
    check("avatar scenario: no request to the mock was on an unexpected route", mock.unexpected.length === 0, mock.unexpected);
    check(
      "avatar scenario: the mock saw exactly 1 descriptor call, 4 image calls and 4 age checks",
      mock.descriptorRequests().length === 1 && mock.imageRequests().length === 4 && mock.ageCheckRequests().length === 4,
      mock.requests,
    );

    // 11. The marker vibe reaches the mock only in the descriptor request (T6a-2b's network canary).
    const carrying = mock.requests.filter(carriesMarker);
    check(
      "avatar scenario: the marker vibe appears in the mock's requests only in the descriptor call",
      carrying.length === 1 && carrying[0]?.schemaName === "avatar_descriptor",
      carrying,
    );
  } finally {
    await quit(running);
    await mock.stop();
    await rm(tmp, { recursive: true, force: true });
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
    const bad = await cdp.evaluate(`window.studio.request({ v: 1, id: "smoke-bad-0001", kind: "command", type: "no.such.command", payload: {} })`);
    check("main refuses a command that breaks the contract", field(bad, "ok") === false && field(bad, "error", "code") === "VALIDATION", bad);

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

    // 7. Single instance, and a closed window leaves the engine running.
    const enginePidBefore = enginePid(mainPid);
    await cdp.evaluate("window.close(), true").catch(() => undefined);
    cdp.close();
    await waitFor("the window to close", async () => ((await pageCount(running.port)) === 0 ? true : null), 10_000);
    check("closing the last window keeps the app and the same engine running (macOS)",
      running.child.exitCode === null && enginePidBefore !== null && enginePid(mainPid) === enginePidBefore, { enginePidBefore });
    check("a second instance on the same userData exits", await secondInstanceExits(target, userData, running.env));
    running.cdp = await connectPage(running.port);
    check("the first instance opened a window for it, and only one", (await pageCount(running.port)) === 1);
    const reopened = await req(running.cdp, "engine.snapshot");
    check("the reopened window restores from engine.snapshot of the engine that kept running",
      field(reopened, "ok") === true && field(reopened, "result", "bootId") === newBootId, { reopened, newBootId });
    check("a window opened after the crash is still told about it (the snapshot's pending notices)",
      JSON.stringify(field(reopened, "result", "notices")).includes("engine-restarted"), reopened);

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
    if (keep) console.log(`\nkept ${tmp}`);
    else await rm(tmp, { recursive: true, force: true });
  }

  await runAvatarScenario(target);
  finish();
}

await main();
