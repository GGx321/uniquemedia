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
import { EngineInit, MainReply } from "./control";
import { deliver, Engine, exitIfStartFails } from "./engine";
import { createFaceGate, defaultFaceGateConfig, type FaceGate, type FaceGateImage } from "./face";
import { createAgeGate } from "./runs/ageGate";
import { createFaceQaGate } from "./runs/faceGate";
import { createPdqGate } from "./runs/pdqGate";
import type { QaGate } from "./runs/qa";

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
// own comment on the integrity fuse).
const ENGINE_DIR = dirname(fileURLToPath(import.meta.url));
/** out-studio/engine/models/*.onnx — studio/scripts/prepareFaceAssets.ts's own copy target, right next to this file. */
const MODEL_DIR = join(ENGINE_DIR, "models");
const ORT_DIST = join(ENGINE_DIR, "..", "..", "node_modules", "onnxruntime-web", "dist");
const WASM_PATHS = { wasm: join(ORT_DIST, "ort-wasm-simd-threaded.wasm"), mjs: join(ORT_DIST, "ort-wasm-simd-threaded.mjs") };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Reads the two model files and builds the real face gate. Never throws: a
 * dev build that skipped `faceModelCache.ts`/`prepareFaceAssets.ts`, or a
 * genuinely broken package, logs clearly and starts the engine WITHOUT a
 * face gate — `Engine`'s own `#assertFaceGate` then refuses any run rather
 * than silently storing photos no identity check has ever seen (T7b wiring
 * decisions, docs/studio/2026-09-24-stage-2-plan.md).
 */
async function loadFaceGate(): Promise<FaceGate | null> {
  try {
    const [yunet, sface] = await Promise.all([
      readFile(join(MODEL_DIR, "face_detection_yunet_2023mar.onnx")),
      readFile(join(MODEL_DIR, "face_recognition_sface_2021dec.onnx")),
    ]);
    return await createFaceGate({ yunet, sface }, defaultFaceGateConfig(), WASM_PATHS);
  } catch (error) {
    console.error(`studio engine: the face gate could not be loaded (${messageOf(error)}); photo runs will refuse to start until this is fixed`);
    return null;
  }
}

/** The engine's end of the port, for `createDecodeImage`'s own postMessage — the same one `deliver()` reads commands from. */
interface EnginePort {
  postMessage(message: unknown): void;
}

/**
 * T7b's own decode decision (qa.ts's own comment on `QaInput.decodeImage`
 * has the full reasoning): the engine's utilityProcess has no Electron
 * `nativeImage` of its own, so decoding travels to the REAL main process and
 * back over this same port, correlated by `callId`
 * (control.ts's `EngineCall`/`MainReply`). Returns two things: the
 * `decodeImage` function itself (`EngineDeps.decodeImage`), and
 * `handleIncoming`, which the port's own message listener must call BEFORE
 * `deliver()` — a `MainReply` is never a command or a control message
 * `Engine.receive` understands, and letting it fall through would only be
 * silently dropped there instead of settling the call it belongs to.
 */
function createDecodeImage(port: EnginePort): { decodeImage: (bytes: Uint8Array, signal: AbortSignal) => Promise<FaceGateImage>; handleIncoming: (data: unknown) => boolean } {
  const pending = new Map<string, { resolve: (image: FaceGateImage) => void; reject: (error: unknown) => void }>();

  function handleIncoming(data: unknown): boolean {
    const reply = MainReply.safeParse(data);
    if (!reply.success) return false;
    const entry = pending.get(reply.data.callId);
    if (entry !== undefined) {
      pending.delete(reply.data.callId);
      if (reply.data.error !== undefined) entry.reject(new Error(reply.data.error.detail ?? reply.data.error.code));
      else if (reply.data.image !== undefined) entry.resolve(reply.data.image);
      else entry.reject(new Error("studio engine: main answered image.decode with neither an image nor an error"));
    }
    return true; // consumed either way: a MainReply is never meant for deliver(), even one no call is waiting for.
  }

  function decodeImage(bytes: Uint8Array, signal: AbortSignal): Promise<FaceGateImage> {
    if (signal.aborted) return Promise.reject(signal.reason);
    const callId = randomUUID();
    return new Promise<FaceGateImage>((resolve, reject) => {
      const onAbort = (): void => {
        pending.delete(callId);
        reject(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      pending.set(callId, {
        resolve: (image) => {
          signal.removeEventListener("abort", onAbort);
          resolve(image);
        },
        reject: (error) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      });
      port.postMessage({ kind: "control", type: "image.decode", callId, bytes });
    });
  }

  return { decodeImage, handleIncoming };
}

// Main sends one init message with the MessagePort that carries everything else.
parentPort.once("message", (event) => {
  const [port] = event.ports;
  const init = EngineInit.safeParse(event.data);
  if (port === undefined || !init.success) {
    console.error("studio engine: invalid init message");
    process.exit(1);
  }

  const { decodeImage, handleIncoming } = createDecodeImage(port);

  void (async () => {
    // T7a: the production QA gates, in order — pdq first (free), then T7b's
    // face gate (free too — decoding through main costs no money, and
    // neither does the ONNX inference), age last (paid, so money is spent
    // only on images that already passed every free gate). None hold a
    // client, a key or the library of its own (T7a whole-slice review, the
    // architectural finding, widened by T7b to include `decodeImage` and
    // `master`): the run job hands each gate the run's own resources
    // through `QaInput` itself — see runs/qa.ts's own header.
    const pdqGate = createPdqGate();
    const ageGate = createAgeGate();
    const faceGate = await loadFaceGate();
    const qaGates: QaGate[] = faceGate === null ? [pdqGate, ageGate] : [pdqGate, createFaceQaGate({ faceGate }), ageGate];

    const ready = Engine.start(init.data, {
      bootId: randomUUID(),
      clock: Date.now,
      monotonic: () => performance.now(),
      newId: randomUUID,
      post: (message) => port.postMessage(message),
      // The runtime's own fetch (Electron's Node); only the OpenRouter client uses it.
      fetch: (url, init) => fetch(url, init),
      qaGates,
      decodeImage,
    });

    // A failed start ends the process, so main restarts it and tells the windows.
    exitIfStartFails(ready, (code) => process.exit(code));

    // Registered in arrival order, so control messages and commands are applied
    // in the order main sent them once the engine is ready. A MainReply to
    // this engine's own image.decode call is settled here, never forwarded.
    port.on("message", ({ data }) => {
      if (handleIncoming(data)) return;
      void deliver(ready, data);
    });
    port.start();
  })();
});
