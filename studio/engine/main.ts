// Entry of Studio's engine utilityProcess (built to out-studio/engine/main.js).
// Like everything reachable from here it uses only node:* APIs and reads no
// environment variables (invariant 1, pinned by runtime.test.ts). Its
// environment is the minimal one main passes to utilityProcess.fork, without
// any OPENROUTER_* (invariant 10).
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { EngineInit } from "./control";
import { ortWasmPathsFrom } from "./decode/wasmPaths";
import { deliver, Engine, exitIfStartFails } from "./engine";
import { defaultFaceGateConfig } from "./face/config";
import { createFaceWorkerSpawner } from "./face/worker/spawn";
import { createWorkerFaceGate, type WorkerFaceGate } from "./face/worker/workerGate";
import { timeoutSignal, untilAborted } from "./money/timeoutSignal";
import { createAgeGate } from "./runs/ageGate";
import { createFaceQaGate } from "./runs/faceGate";
import { createPdqGate } from "./runs/pdqGate";
import { productionGateOrder } from "./runs/productionGates";
import { TEXT_ASSET_DIRS } from "./text/assetLayout";
import { loadTextRasteriser } from "./text/load";
import { RASTER_WASM } from "./text/rasterTypes";
import { createTextWorkerSpawner } from "./text/worker/spawn";
import { createTextGate, TEXT_WORKER_IDLE_RECYCLE_MS } from "./text/worker/textGate";

const parentPort = process.parentPort;
if (!parentPort) throw new Error("the studio engine must run as an Electron utilityProcess");

// T7b: the face gate's models and onnxruntime-web's WASM runtime, resolved
// relative to THIS bundled file's own runtime location — never via
// process.resourcesPath or similar (the runtime rule forbids it here; see
// face/gate.ts's own header on createFaceGate's wasmPaths parameter).
// electron-vite preserves import.meta.url across bundling, so this resolves
// correctly both in dev and once packaged into app.asar, where `out-studio/`
// and `node_modules/` sit as siblings at the asar root (electron-builder.
// studio.yml's own `files` list; nothing here is unpacked — see that file's
// own comment on the integrity fuse). The same NODE_MODULES_DIR resolves the
// engine's own WASM JPEG/PNG decoder (decode/realBackend.ts) — a sibling of
// onnxruntime-web's own dist/, at both the repo root and the packaged asar
// root.
const ENGINE_DIR = dirname(fileURLToPath(import.meta.url));
/** out-studio/engine/models/*.onnx — studio/scripts/prepareFaceAssets.ts's own copy target, right next to this file. */
const MODEL_DIR = join(ENGINE_DIR, "models");
const NODE_MODULES_DIR = join(ENGINE_DIR, "..", "..", "node_modules");
const ORT_DIST = join(NODE_MODULES_DIR, "onnxruntime-web", "dist");
// Security review H4: onnxruntime-web 1.30 passes `wasmPaths.mjs` to a bare
// `import()`, which rejects a plain Windows OS path — file:// URLs (decode/
// wasmPaths.ts) survive on every platform.
const WASM_PATHS = ortWasmPathsFrom(ORT_DIST);
// 3b.2, the text rasteriser: resvg's .wasm and the bundled fonts, copied next to this file at build time
// (scripts/prepareTextAssets.ts), so they sit inside app.asar under the integrity fuse and resolve the same
// way the face models do. resvg itself runs in a worker thread, textWorker.js (electron.studio.vite.config.ts),
// a sibling of this file loaded by file URL like the face worker; it is handed the two paths and resolves none.
const TEXT_FONT_DIR = join(ENGINE_DIR, TEXT_ASSET_DIRS.fonts);
const TEXT_WASM_PATH = join(ENGINE_DIR, TEXT_ASSET_DIRS.wasm, RASTER_WASM.file);
const TEXT_WORKER_URL = new URL("./textWorker.js", import.meta.url);

/** How long the start-up waits for the text worker's verdict before starting without it (it takes well under a second). */
const TEXT_LOAD_START_WAIT_MS = 2_000;

/**
 * `work`'s result, or null when it is not done within `ms`: the caller starts without it and the work carries on
 * (and logs its own outcome). Anything `work` itself throws is passed on.
 */
async function withinStartWait<T>(work: Promise<T>, ms: number): Promise<T | null> {
  const wait = timeoutSignal(ms);
  try {
    return await untilAborted(work, wait.signal);
  } catch (error) {
    if (wait.signal.aborted) return null;
    throw error;
  } finally {
    wait.clear();
  }
}
// T7c: the face worker thread's built entry (electron.studio.vite.config.ts:
// engine/faceWorker), a sibling of this file — resolved the same way, so it
// loads from inside app.asar on macOS and Windows alike (a file URL, never a
// hand-joined path, and nothing unpacked). Everything the worker loads (the
// models, the WASM codecs, onnxruntime-web's own files) is handed to it as
// `workerData`: it resolves no path itself.
const FACE_WORKER_URL = new URL("./faceWorker.js", import.meta.url);

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Money review M3: a hung ORT init (or a hung WASM codec load) must never
 * leave the engine unresponsive — before this, `loadFaceGate()` had no
 * bound of its own, so the `await` at the top of the port's init handler
 * could hang forever, and the engine would never even become responsive to
 * a plain, free command. `untilAborted` bounds the work even when it
 * ignores the signal itself (a hung native call), exactly the same shape
 * `runJob.ts`'s own `loadMaster()`/`prepareGates()` use.
 *
 * Re-review N14: the engine's own `port.on("message", ...)` listener is not
 * registered until AFTER this resolves (`Engine.start()` runs right after
 * it) — while `loadFaceGate()` is still in flight, the engine answers
 * NOTHING, not even a free command. main's own default command deadline is
 * `engineHost.ts`'s `REQUEST_TIMEOUT_MS`, 30 s. A bound at or above that
 * would let a slow-but-eventually-successful load still be running when
 * main's own first command already gave up as a bare `INTERNAL` timeout,
 * with no information about why. 25 s stays comfortably below 30 s
 * (normal load is roughly 1 s either way) so the engine has always either
 * succeeded or already given up and started without a face gate — a real,
 * informative `FACE_GATE_UNAVAILABLE` — before main's own deadline could
 * fire on it.
 */
const FACE_GATE_LOAD_TIMEOUT_MS = 25_000;

/**
 * T7c: how long the face worker may sit idle before it is terminated to give
 * its memory back (measured on Electron's Node: ~610 MB resident after 2K
 * checks and a 12 MP master, ~44 MB for the engine alone). A photo run's
 * checks arrive seconds apart, far inside this window; the next check after
 * a real pause pays a ~0.2 s respawn.
 */
const FACE_WORKER_IDLE_RECYCLE_MS = 60_000;

type FaceGateLoad = { faceGate: WorkerFaceGate } | { error: string };

/**
 * Starts the face worker thread (T7c) and waits for it to load — the two
 * models (sha256-checked inside the worker), onnxruntime-web's WASM and the
 * engine's own WASM JPEG/PNG decoder (decode/realBackend.ts), all together:
 * the face gate cannot run without a working decoder either way, so they
 * load and fail together. Never throws: a dev build that skipped
 * `faceModelCache.ts`/`prepareFaceAssets.ts`, a genuinely broken package
 * (models, the WASM codecs OR the worker entry itself), or a load that
 * outlives `FACE_GATE_LOAD_TIMEOUT_MS` (the worker is terminated then), logs
 * clearly and starts the engine WITHOUT a face gate — `Engine`'s own
 * `#assertFaceGate` then refuses any run rather than silently storing photos
 * no identity check has ever seen (T7b wiring decisions,
 * docs/studio/2026-09-24-stage-2-plan.md), and `EngineDeps.faceGateLoadError`
 * (M3) carries why, into the refusal's own detail.
 *
 * The worker is only the STARTUP proof: it stays alive afterwards and is
 * respawned lazily by the gate itself if a cancel, a timeout or a crash ever
 * kills it (face/worker/workerGate.ts).
 */
async function loadFaceGate(): Promise<FaceGateLoad> {
  const faceGate = createWorkerFaceGate({
    spawnWorker: createFaceWorkerSpawner(FACE_WORKER_URL, {
      models: {
        yunetPath: join(MODEL_DIR, "face_detection_yunet_2023mar.onnx"),
        sfacePath: join(MODEL_DIR, "face_recognition_sface_2021dec.onnx"),
      },
      nodeModulesDir: NODE_MODULES_DIR,
      wasmPaths: WASM_PATHS,
      config: defaultFaceGateConfig(),
    }),
    loadTimeoutMs: FACE_GATE_LOAD_TIMEOUT_MS,
    idleRecycleMs: FACE_WORKER_IDLE_RECYCLE_MS,
  });
  const timeout = timeoutSignal(FACE_GATE_LOAD_TIMEOUT_MS);
  try {
    await untilAborted(faceGate.start(timeout.signal), timeout.signal);
    return { faceGate };
  } catch (error) {
    await faceGate.dispose();
    const why = timeout.signal.aborted ? `it took longer than ${FACE_GATE_LOAD_TIMEOUT_MS} ms` : messageOf(error);
    console.error(`studio engine: the face gate could not be loaded (${why}); photo runs will refuse to start until this is fixed`);
    return { error: why };
  } finally {
    timeout.clear();
  }
}

// Main sends one init message with the MessagePort that carries everything else.
parentPort.once("message", (event) => {
  const [port] = event.ports;
  const init = EngineInit.safeParse(event.data);
  if (port === undefined || !init.success) {
    console.error("studio engine: invalid init message");
    process.exit(1);
  }

  void (async () => {
    // T7a: the production QA gates, in order — pdq first (free), then T7b's
    // face gate (free too — the engine's own WASM decode costs no money, and
    // neither does the ONNX inference), age last (paid, so money is spent
    // only on images that already passed every free gate). None hold a
    // client, a key or the library of its own (T7a whole-slice review, the
    // architectural finding, widened by T7b to include
    // `master`): the run job hands each gate the run's own resources
    // through `QaInput` itself — see runs/qa.ts's own header.
    const pdqGate = createPdqGate();
    const ageGate = createAgeGate();
    // 3b.2: the text worker loads alongside the face gate, so it adds nothing to the start-up time, and the start
    // waits for it at most TEXT_LOAD_START_WAIT_MS (never on the critical path if it hangs). It logs its own ready
    // line (with the self-test fingerprint the packaged smoke checks) or its own error and never throws. The gate it
    // returns lives on after a failed load, so a later call retries.
    // 3b.4b: the gate is created HERE, synchronously, and handed to the Engine (which owns it from then on) and to the
    // loader, so the Engine has its gate even when the start did not wait for the load. What the Engine reads of the
    // load is its CURRENT outcome, not what the start-up wait happened to see.
    const textGate = createTextGate({
      spawnWorker: createTextWorkerSpawner(TEXT_WORKER_URL, { wasmPath: TEXT_WASM_PATH, fontDir: TEXT_FONT_DIR }),
      idleRecycleMs: TEXT_WORKER_IDLE_RECYCLE_MS,
    });
    let textLoadError: string | undefined;
    const textLoad = loadTextRasteriser({ gate: textGate }).then((outcome) => {
      textLoadError = "error" in outcome ? outcome.error : undefined;
      return outcome;
    });
    const loaded = await loadFaceGate();
    await withinStartWait(textLoad, TEXT_LOAD_START_WAIT_MS);
    const qaGates = productionGateOrder({ pdq: pdqGate, face: "error" in loaded ? null : createFaceQaGate({ faceGate: loaded.faceGate }), age: ageGate });

    const ready = Engine.start(init.data, {
      bootId: randomUUID(),
      clock: Date.now,
      monotonic: () => performance.now(),
      newId: randomUUID,
      post: (message) => port.postMessage(message),
      // The runtime's own fetch (Electron's Node); only the OpenRouter client uses it.
      fetch: (url, init) => fetch(url, init),
      qaGates,
      // The same worker gate serves the render's focus points (`videos.render`, S8); without it every photo takes the stand-in point.
      ...("error" in loaded ? { faceGateLoadError: loaded.error } : { faceGate: loaded.faceGate }),
      text: { gate: textGate, loadError: () => textLoadError },
    });

    // A failed start ends the process, so main restarts it and tells the windows.
    exitIfStartFails(ready, (code) => process.exit(code));

    // Registered in arrival order, so control messages and commands are applied
    // in the order main sent them once the engine is ready.
    port.on("message", ({ data }) => {
      void deliver(ready, data);
    });
    port.start();
  })();
});
