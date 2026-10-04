import { parentPort, workerData } from "node:worker_threads";
import { DecodeRequestSchema, DecodeWorkerInitSchema, MAX_DECODE_MESSAGE_LENGTH, type DecodeResponse } from "./decodeProtocol";
import { createRealDecodeBackend } from "./realBackend";
import { createWasmImageDecoder } from "./wasmDecode";

// The own-photo decode worker thread (Stage 3, 3f.2 fix round 1, H1): the engine's WASM JPEG/PNG decode of a picture the owner picked, moved
// off the engine's event loop. A separate BUILT ENTRY (electron.studio.vite.config.ts: engine/photoDecodeWorker) loaded from inside app.asar,
// Electron-free like everything under studio/engine. It owns the codecs' WASM memory, which only ever grows: the engine ENDS this thread
// (`terminate()`, decodeGate.ts) when a decode is cancelled or runs out of time, and when it has been idle, and that is what gives the
// memory back. It handles one request at a time and never aborts by itself: synchronous WASM cannot be interrupted from inside.

if (parentPort === null) throw new Error("photoDecodeWorker.ts must run as a worker_thread");
const port = parentPort;

const init = DecodeWorkerInitSchema.parse(workerData);
/** The codecs are loaded (and smoke-decoded) at the first picture, once. A load that failed is not remembered. */
let decoder: Promise<ReturnType<typeof createWasmImageDecoder>> | undefined;
const NEVER_ABORTED = new AbortController().signal;

function send(message: DecodeResponse, transfer: ArrayBuffer[] = []): void {
  port.postMessage(message, transfer);
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, MAX_DECODE_MESSAGE_LENGTH);

port.on("message", (raw: unknown) => {
  const parsed = DecodeRequestSchema.safeParse(raw);
  if (!parsed.success) {
    // The engine sends only what it validated itself: anything else is a bug worth dying loudly for.
    throw new Error(`photo decode worker: an invalid request (${parsed.error.message})`);
  }
  const { id, bytes } = parsed.data;
  void (async () => {
    try {
      if (decoder === undefined) {
        const loading = createRealDecodeBackend(init.nodeModulesDir).then((backend) => createWasmImageDecoder(backend, { maxPixels: init.maxPixels }));
        decoder = loading;
        loading.catch(() => {
          if (decoder === loading) decoder = undefined;
        });
      }
      const image = await (await decoder)(new Uint8Array(bytes), NEVER_ABORTED);
      const whole = image.data.byteOffset === 0 && image.data.byteLength === image.data.buffer.byteLength && image.data.buffer instanceof ArrayBuffer;
      const data: ArrayBuffer = whole ? (image.data.buffer as ArrayBuffer) : image.data.slice().buffer;
      send({ type: "decoded", id, width: image.width, height: image.height, data }, [data]);
    } catch (error) {
      send({ type: "failed", id, message: messageOf(error) });
    }
  })();
});
