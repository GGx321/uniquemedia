import { readFile } from "node:fs/promises";
import { parentPort, workerData } from "node:worker_threads";
import { createRealDecodeBackend } from "../../decode/realBackend";
import { createWasmImageDecoder } from "../../decode/wasmDecode";
import { createFaceGate, NoFaceInReferenceError, type FaceGate } from "../gate";
import { FACE_MODELS, verifyModelBytes } from "../modelSource";
import { FaceWorkerInitSchema, FaceWorkerRequestSchema, type FaceWorkerResponse } from "./protocol";

// T7c: the face worker thread — the engine's heavy face work (image decode,
// YuNet detection, SFace embedding) moved off its event loop. It is a
// separate BUILT ENTRY (electron.studio.vite.config.ts: engine/faceWorker),
// loaded from inside app.asar, and — like everything under studio/engine —
// Electron-free (runtime.test.ts walks this entry too).
//
// It owns the onnxruntime-web sessions and the WASM codecs (their heap lives
// here, not in the engine's), handles ONE request at a time, and is killed
// from outside (`worker.terminate()`, workerGate.ts) when a computation must
// be interrupted — synchronous WASM work cannot be interrupted from inside.

if (parentPort === null) throw new Error("faceWorker.ts must run as a worker_thread");
const port = parentPort;

function send(message: FaceWorkerResponse): void {
  port.postMessage(message);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface Loaded {
  gate: FaceGate;
  decode: ReturnType<typeof createWasmImageDecoder>;
}

async function load(): Promise<Loaded> {
  const init = FaceWorkerInitSchema.parse(workerData);
  const [yunet, sface, backend] = await Promise.all([
    readFile(init.models.yunetPath),
    readFile(init.models.sfacePath),
    createRealDecodeBackend(init.nodeModulesDir),
  ]);
  verifyModelBytes(yunet, FACE_MODELS.yunet.sha256, FACE_MODELS.yunet.file);
  verifyModelBytes(sface, FACE_MODELS.sface.sha256, FACE_MODELS.sface.file);
  const gate = await createFaceGate({ yunet, sface }, init.config, init.wasmPaths);
  return { gate, decode: createWasmImageDecoder(backend) };
}

/** Nothing here ever aborts: interruption is `terminate()` from the engine, never a cooperative signal. */
const NEVER_ABORTED = new AbortController().signal;

async function main(): Promise<void> {
  let loaded: Loaded;
  try {
    loaded = await load();
  } catch (error) {
    send({ type: "load-failed", message: messageOf(error) });
    return;
  }
  const { gate, decode } = loaded;

  port.on("message", (raw: unknown) => {
    const parsed = FaceWorkerRequestSchema.safeParse(raw);
    if (!parsed.success) {
      // The engine only sends what it validated itself: anything else is a bug worth dying loudly for.
      throw new Error(`face worker: an invalid request (${parsed.error.message})`);
    }
    const request = parsed.data;
    void (async () => {
      try {
        const image = await decode(new Uint8Array(request.bytes), NEVER_ABORTED);
        if (request.type === "check") {
          const verdict = await gate.check({ pose: request.pose, image, masterEmbedding: request.masterEmbedding });
          send({ type: "checked", id: request.id, verdict });
        } else {
          const embedding = await gate.embed(image);
          send({ type: "embedded", id: request.id, embedding });
        }
      } catch (error) {
        send({ type: "failed", id: request.id, code: error instanceof NoFaceInReferenceError ? "no-face-in-reference" : "error", message: messageOf(error) });
      }
    })();
  });
  send({ type: "ready" });
}

void main();
