#!/usr/bin/env bun
/**
 * Packaged-engine smoke test for Studio (task T1).
 *
 * Full run (dev build or an E2E package): launches the app with a temp
 * userData and the DevTools protocol, and checks from inside the page:
 *
 * - the engine utilityProcess starts and answers engine.snapshot and money.status
 *   (money over a prepared userData/ledger.jsonl);
 * - studio-media:// answers 404 for a malformed and an unknown id and 200 (image
 *   MIME, nosniff) for a real photo in a temp library;
 * - main refuses a command that breaks the contract;
 * - settings.setApiKey stores only ciphertext and hands the key to the engine;
 * - settings.setBudget is persisted by main and reaches the engine;
 * - the engine's environment has no OPENROUTER_* although the app's has one;
 * - a killed engine is restarted once, surfaces engine.error, comes back with a
 *   new bootId and gets the key and the settings again;
 * - the crash is reported as an engine.error of the restarted engine (its own
 *   bootId, no flood of events: the snapshot-loop regression);
 * - a second instance exits and focuses the first; with the window closed the
 *   engine keeps running, and a reopened window restores from its snapshot
 *   (it is not told about a crash reported before it opened: that needs a T0
 *   Snapshot field for notices, left to T6a);
 * - a corrupt settings.json is moved aside and reported the same way; after an
 *   app restart the key is decrypted and sent again; clearApiKey removes it;
 * - packaged: the engine entry lives inside app.asar, not unpacked; the fuses are set.
 *
 * A packaged production build has no remote debugging, so the full run needs
 * an E2E package (STUDIO_E2E=1: DevTools kept, never shipped). --production
 * checks the real package instead: its fuses, the E2E override compiled out
 * of the engine, and that it launches its engine with remote debugging refused.
 *
 * Usage (macOS; on Windows point --app at release-studio/win-unpacked or its
 * Studio.exe, and release-studio/e2e/win-unpacked for an E2E package):
 *   bun run build:studio && bun studio/scripts/smoke-engine.ts
 *   bun run dist:studio:mac:e2e && bun studio/scripts/smoke-engine.ts --app release-studio/e2e/mac-arm64/Studio.app
 *   bun run dist:studio:mac && bun studio/scripts/smoke-engine.ts --production --app release-studio/mac-arm64/Studio.app
 *
 * The app window shows for a few seconds. On macOS --use-mock-keychain keeps
 * safeStorage off the real Keychain (checked on Electron 43: no Keychain item
 * is created); Windows' DPAPI needs no such flag. The environment check reads
 * process environments with `ps -E` and runs on macOS only.
 * No request leaves the machine: there is no OpenRouter client yet, and the
 * only key used is a fake one.
 */
import { extractFile, listPackage } from "@electron/asar";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { openLibrary } from "../engine/library";
import { Ledger } from "../engine/money/ledger";
import { defaultSettings, saveSettings } from "../main/settingsStore";

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
    if (!existsSync(main)) throw new Error("out-studio/main/main.js is missing: run `bun run build:studio` first");
    return { label: "dev build (out-studio)", executable: await electronBinary(), args: [main], app: null, asar: null };
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

async function launch(target: Target, userData: string): Promise<Running> {
  const port = await freePort();
  // A real key must never reach the app under test; the canary must never reach its engine.
  const env = { ...appEnv(), OPENROUTER_API_KEY: ENV_CANARY };
  const child = spawn(
    target.executable,
    [...target.args, `--user-data-dir=${userData}`, `--remote-debugging-port=${port}`, ...PLATFORM_FLAGS],
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

/** In-memory reads from the asar (never extracted to disk). */
function asarText(target: Target, file: string): string {
  return target.asar === null ? "" : extractFile(target.asar, file).toString("utf8");
}

async function productionCheck(target: Target): Promise<void> {
  if (target.asar === null) throw new Error("--production needs --app <Studio.app>");
  checkPackage(target);
  check("the packaged engine was built without the E2E flag (no base-URL override)",
    /resolveOpenRouterBaseUrl\(init\.openRouterBaseUrl, false\)/.test(asarText(target, join("out-studio", "engine", "main.js"))));
  check("the packaged main never reads the E2E base-URL switch", !asarText(target, join("out-studio", "main", "main.js")).includes("studio-openrouter-base-url"));

  const tmp = await mkdtemp(join(tmpdir(), "studio-smoke-prod-"));
  const port = await freePort();
  const child = spawn(target.executable, [`--user-data-dir=${join(tmp, "userData")}`, `--remote-debugging-port=${port}`, ...PLATFORM_FLAGS], {
    env: appEnv(),
    stdio: "ignore",
  });
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
  } finally {
    if (process.platform !== "win32") child.kill("SIGTERM");
    await Bun.sleep(1000);
    killTree(child);
    await Bun.sleep(500);
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

  let running = await launch(target, userData);
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
    const crashEvent = await waitFor("an engine.error event", async () => {
      const events = await cdp.evaluate(`window.__smoke.events.filter((e) => e.type === "engine.error")`);
      return Array.isArray(events) && events.length > 0 ? events[0] : null;
    });
    check("a killed engine surfaces engine.error", /exited unexpectedly.*restarting it/.test(String(field(crashEvent, "payload", "error", "detail"))), crashEvent);
    const after = await waitFor("a snapshot from the restarted engine", async () => {
      const s = await req(cdp, "engine.snapshot");
      return field(s, "ok") === true ? s : null;
    });
    const newBootId = field(after, "result", "bootId");
    check("the restarted engine has a new bootId", typeof newBootId === "string" && newBootId !== bootId, { bootId, newBootId });
    check("the restarted engine got the key again", field(after, "result", "settings", "apiKey", "last4") === "7q3z", after);
    check("the restarted engine got the current settings again", field(after, "result", "settings", "monthlyBudgetMicros") === 25_000_000, after);
    // The regression: main's own events (a foreign bootId) made the renderer
    // resnapshot, and every snapshot replayed them. Notices now come from the
    // engine's own stream: every engine.error carries the new engine's bootId,
    // and a quiet second later there are still only a handful.
    await Bun.sleep(1500);
    const crashEvents = await cdp.evaluate(`window.__smoke.events.filter((e) => e.type === "engine.error")`);
    check("the crash is reported by the restarted engine itself, without an event flood",
      Array.isArray(crashEvents) && crashEvents.length >= 1 && crashEvents.length <= 3 &&
        crashEvents.every((e: unknown) => field(e, "bootId") === newBootId),
      { newBootId, crashEvents });
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

    // 8. App restart with a corrupt settings.json: it is moved aside and reported;
    // main decrypts the key and hands it over again; then clear it.
    await quit(running);
    await Bun.write(join(userData, "settings.json"), "{ corrupt");
    running = await launch(target, userData);
    const restarted = await req(running.cdp, "engine.snapshot");
    // The page's own store took the first snapshot, which released the notice
    // as an engine event; it may have landed before this page's subscription.
    const notice = await waitFor("the settings notice", async () => {
      const events = await running.cdp.evaluate(`window.__smoke.events.filter((e) => e.type === "engine.error")`);
      return Array.isArray(events) && events.length > 0 ? events : null;
    }, 3_000).catch(() => null);
    const caught = await req(running.cdp, "engine.events", { afterSeq: 0, bootId: field(restarted, "result", "bootId") });
    const aside = (await readdir(userData)).filter((name) => name.startsWith("settings.json.corrupt-"));
    const reported = [...(Array.isArray(notice) ? notice : []), ...(Array.isArray(field(caught, "result", "events")) ? [field(caught, "result", "events")] : [])];
    check("a corrupt settings.json is moved aside, the defaults are used, and the engine reports it in its own stream",
      aside.length === 1 && field(restarted, "result", "settings", "libraryPath") === join(userData, "library") &&
        /moved to settings\.json\.corrupt-/.test(JSON.stringify(reported)) &&
        JSON.stringify(reported).includes(String(field(restarted, "result", "bootId"))),
      { aside, restarted, notice, caught });
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
  finish();
}

await main();
