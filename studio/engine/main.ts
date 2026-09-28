// Entry of Studio's engine utilityProcess (built to out-studio/engine/main.js).
// Like everything reachable from here it uses only node:* APIs and reads no
// environment variables (invariant 1, pinned by runtime.test.ts). Its
// environment is the minimal one main passes to utilityProcess.fork, without
// any OPENROUTER_* (invariant 10).
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { EngineInit } from "./control";
import { createRealDecodeBackend } from "./decode/realBackend";
import { createWasmImageDecoder } from "./decode/wasmDecode";
import { ortWasmPathsFrom } from "./decode/wasmPaths";
import { deliver, Engine, exitIfStartFails } from "./engine";
import { createFaceGate, defaultFaceGateConfig, type FaceGate, type FaceGateImage } from "./face";
import { timeoutSignal, untilAborted } from "./money/timeoutSignal";
import { createAgeGate } from "./runs/ageGate";
import { createFaceQaGate } from "./runs/faceGate";
import { createPdqGate } from "./runs/pdqGate";
import { productionGateOrder } from "./runs/productionGates";

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
 */
const FACE_GATE_LOAD_TIMEOUT_MS = 60_000;

type FaceGateLoad = { faceGate: FaceGate; decodeImage: (bytes: Uint8Array, signal: AbortSignal) => Promise<FaceGateImage> } | { error: string };

/**
 * Reads the two model files, builds the real face gate, AND builds the
 * engine's own WASM image decoder (decode/realBackend.ts) — the face gate
 * cannot run without a working decoder either way (it is the only caller),
 * so the two are loaded together and fail together. Never throws: a dev
 * build that skipped `faceModelCache.ts`/`prepareFaceAssets.ts`, a
 * genuinely broken package (models OR the WASM codecs), or a load that
 * outlives `FACE_GATE_LOAD_TIMEOUT_MS`, logs clearly and starts the engine
 * WITHOUT a face gate — `Engine`'s own `#assertFaceGate` then refuses any
 * run rather than silently storing photos no identity check has ever seen
 * (T7b wiring decisions, docs/studio/2026-09-24-stage-2-plan.md), and
 * `EngineDeps.faceGateLoadError` (M3) carries why, into the refusal's own
 * detail.
 */
async function loadFaceGate(): Promise<FaceGateLoad> {
  const timeout = timeoutSignal(FACE_GATE_LOAD_TIMEOUT_MS);
  try {
    const work = (async (): Promise<FaceGateLoad> => {
      const [yunet, sface, decodeBackend] = await Promise.all([
        readFile(join(MODEL_DIR, "face_detection_yunet_2023mar.onnx")),
        readFile(join(MODEL_DIR, "face_recognition_sface_2021dec.onnx")),
        createRealDecodeBackend(NODE_MODULES_DIR),
      ]);
      const faceGate = await createFaceGate({ yunet, sface }, defaultFaceGateConfig(), WASM_PATHS);
      return { faceGate, decodeImage: createWasmImageDecoder(decodeBackend) };
    })();
    return await untilAborted(work, timeout.signal);
  } catch (error) {
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
    // architectural finding, widened by T7b to include `decodeImage` and
    // `master`): the run job hands each gate the run's own resources
    // through `QaInput` itself — see runs/qa.ts's own header.
    const pdqGate = createPdqGate();
    const ageGate = createAgeGate();
    const loaded = await loadFaceGate();
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
      ...("error" in loaded ? { faceGateLoadError: loaded.error } : { decodeImage: loaded.decodeImage }),
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
