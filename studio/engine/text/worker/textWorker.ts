import { performance } from "node:perf_hooks";
import { parentPort, workerData } from "node:worker_threads";
import { createTextRasteriser, RasterError, type TextRasteriser } from "../rasteriser";
import { boundedMessage, TextWorkerInitSchema, TextWorkerRequestSchema, type TextWorkerResponse } from "./protocol";

// The text worker thread: resvg-wasm, the five fonts and (from 3b.4b) the caption layout live here, off the
// engine's event loop. It is a separate BUILT ENTRY (electron.studio.vite.config.ts: engine/textWorker), loaded by
// file URL from inside app.asar, and, like everything under studio/engine, Electron-free (runtime.test.ts walks
// this entry too). It handles ONE request at a time and is killed from outside (`worker.terminate()`,
// textGate.ts) when a call overruns its deadline or a wasm trap leaves it unusable: synchronous wasm work
// cannot be interrupted from inside.

if (parentPort === null) throw new Error("textWorker.ts must run as a worker_thread");
const port = parentPort;

function send(message: TextWorkerResponse, transfer: ArrayBuffer[] = []): void {
  port.postMessage(message, transfer);
}

function messageOf(error: unknown): string {
  return boundedMessage(error instanceof Error ? error.message : String(error));
}

async function main(): Promise<void> {
  let rasteriser: TextRasteriser;
  try {
    const init = TextWorkerInitSchema.parse(workerData);
    rasteriser = createTextRasteriser({ wasmPath: init.wasmPath, fontDir: init.fontDir });
    await rasteriser.init();
  } catch (error) {
    send({ type: "load-failed", message: messageOf(error) });
    return;
  }

  port.on("message", (raw: unknown) => {
    const parsed = TextWorkerRequestSchema.safeParse(raw);
    if (!parsed.success) {
      // The engine only sends what it validated itself: anything else is a bug worth dying loudly for.
      throw new Error(`text worker: an invalid request (${parsed.error.message})`);
    }
    const request = parsed.data;
    void (async () => {
      const started = performance.now();
      try {
        if (request.type === "render") {
          const image = await rasteriser.render({ svg: request.svg, font: request.font });
          const png = image.png.slice().buffer;
          send({ type: "rendered", id: request.id, width: image.width, height: image.height, png, workerMs: performance.now() - started }, [png]);
        } else {
          const box = rasteriser.measure({ svg: request.svg, font: request.font });
          send({ type: "measured", id: request.id, box, workerMs: performance.now() - started });
        }
      } catch (error) {
        const code = error instanceof RasterError ? error.code : "RENDER_FAILED";
        send({ type: "failed", id: request.id, code, message: messageOf(error), fatal: rasteriser.isBroken() || !(error instanceof RasterError) });
      }
    })();
  });
  send({ type: "ready" });
}

void main();
