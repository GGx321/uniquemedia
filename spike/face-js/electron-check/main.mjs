/**
 * Electron check for the face-js spike: runs the port in the two places Studio could host it.
 *
 * 1. utilityProcess: forks spike/face-js/run.ts (Node 24 strips the types) with ffmpeg decoding
 *    -> spike/face-js/out/face-js.utility.json (+ parity.utility.json).
 * 2. renderer: a hidden BrowserWindow served over a privileged app:// scheme runs the bundled
 *    renderer.ts with Chromium decoding, once single-threaded and once cross-origin isolated
 *    (COOP/COEP) with 4 wasm threads -> spike/face-js/out/face-js.renderer-t{1,4}.json.
 *
 * Run from the repo root:
 *   bun run spike/face-js/electron-check/build.mjs
 *   node_modules/.bin/electron spike/face-js/electron-check/main.mjs
 *   bun run spike/face-js/parity.ts spike/face-js/out/face-js.renderer-t1.json   # and -t4
 */
import { app, BrowserWindow, protocol, utilityProcess } from "electron";
import { existsSync, writeSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";

const ROOT = process.cwd();
const OUT = join(ROOT, "spike/face-js/out");
const STUDIO_OUT = join(ROOT, "spike/studio-api/out");
const BUNDLE = join(OUT, "electron-check/renderer.js");
const SERVED = [
  "spike/face-js/electron-check/",
  "spike/face-js/out/electron-check/",
  "spike/studio-api/out/avatar/",
  "spike/studio-api/out/render/",
  "spike/studio-api/out/models/",
  "node_modules/onnxruntime-web/dist/",
];
const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".wasm": "application/wasm",
  ".onnx": "application/octet-stream",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const RENDERER_TIMEOUT_MS = 300_000;

/** Synchronous, so nothing is lost when app.exit() tears the process down with stdout piped. */
function log(line) {
  writeSync(1, `${line}\n`);
}

protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

async function listImages(dir) {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && !e.name.startsWith(".") && IMAGE_EXTS.has(extname(e.name).toLowerCase()))
    .map((e) => relative(STUDIO_OUT, join(e.parentPath, e.name)).split("\\").join("/"))
    .sort();
}

function serve() {
  protocol.handle("app", async (req) => {
    const url = new URL(req.url);
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    if (rel.includes("..") || !SERVED.some((p) => rel.startsWith(p))) return new Response("forbidden", { status: 403 });
    const path = join(ROOT, rel);
    if (!existsSync(path)) return new Response("not found", { status: 404 });
    // CORP keeps every subresource loadable under COEP require-corp; COOP/COEP on the document
    // make it crossOriginIsolated (SharedArrayBuffer -> wasm threads).
    const headers = {
      "content-type": MIME[extname(rel).toLowerCase()] ?? "application/octet-stream",
      "cross-origin-resource-policy": "same-origin",
    };
    // A dedicated worker of an isolated document needs COEP on its own script response too;
    // on other subresources the two headers are inert, so only the HTML is conditional.
    if (url.searchParams.get("isolate") === "1" || !rel.endsWith(".html")) {
      headers["cross-origin-opener-policy"] = "same-origin";
      headers["cross-origin-embedder-policy"] = "require-corp";
    }
    return new Response(await readFile(path), { headers });
  });
}

function runUtility() {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = utilityProcess.fork(join(ROOT, "spike/face-js/run.ts"), ["--threads", "4", "--output", join(OUT, "face-js.utility.json")], {
      cwd: ROOT,
      stdio: "pipe",
      serviceName: "face-js",
    });
    let stderr = "";
    child.stdout?.on("data", () => {});
    child.stderr?.on("data", (c) => {
      stderr += c.toString();
    });
    child.on("exit", (code) => {
      resolve({ code, seconds: (Date.now() - started) / 1000, stderr: stderr.split("\n").filter(Boolean).slice(-8) });
    });
  });
}

/**
 * One hidden window for all runs: a fresh BrowserWindow right after destroying the previous one
 * intermittently failed its first load with ERR_FAILED, while navigating the same window
 * (including the switch to a cross-origin-isolated page) is reliable.
 */
function createWindow() {
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  const logs = [];
  win.webContents.on("console-message", (e) => {
    if (!String(e.message).includes("Electron Security Warning")) logs.push(e.message);
  });
  win.webContents.on("render-process-gone", (_e, details) => logs.push(`render process gone: ${details.reason}`));
  return { win, logs };
}

async function runRenderer({ win, logs }, keys, threads, isolate) {
  logs.length = 0;
  try {
    await win.loadURL(`app://face-js/spike/face-js/electron-check/index.html?isolate=${isolate ? 1 : 0}`);
    const run = win.webContents.executeJavaScript(`window.runFaceJs(${JSON.stringify({ keys, threads })})`);
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("renderer timed out")), RENDERER_TIMEOUT_MS);
    });
    const result = await Promise.race([run, timeout]).finally(() => clearTimeout(timer));
    return { ok: true, result, logs: [...logs] };
  } catch (err) {
    return { ok: false, error: String(err), logs: [...logs] };
  }
}

app.dock?.hide();
app.whenReady().then(async () => {
  let exitCode = 0;
  try {
    if (!existsSync(BUNDLE)) throw new Error(`missing ${relative(ROOT, BUNDLE)}; build it first (see the header of this file)`);
    await mkdir(OUT, { recursive: true });
    serve();

    const utility = await runUtility();
    log(`utilityProcess: ${JSON.stringify(utility)}`);
    if (utility.code !== 0) exitCode = 1;

    const keys = [...(await listImages(join(STUDIO_OUT, "render"))), ...(await listImages(join(STUDIO_OUT, "avatar")))];
    const window = createWindow();
    for (const [threads, isolate] of [[1, false], [4, true]]) {
      const r = await runRenderer(window, keys, threads, isolate);
      if (!r.ok) {
        exitCode = 1;
        log(`renderer t${threads}: FAILED ${r.error}; console: ${JSON.stringify(r.logs.slice(-8))}`);
        continue;
      }
      const path = join(OUT, `face-js.renderer-t${threads}.json`);
      await writeFile(path, `${JSON.stringify(r.result, null, 2)}\n`);
      log(`renderer t${threads}: ${JSON.stringify(r.result.meta)}; wrote ${relative(ROOT, path)}`);
      if (r.logs.length) log(`renderer t${threads} console: ${JSON.stringify(r.logs.slice(-8))}`);
    }
  } catch (err) {
    exitCode = 1;
    log(String(err instanceof Error ? err.stack : err));
  }
  app.exit(exitCode);
});
