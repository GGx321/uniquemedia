import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { parentPort } from "node:worker_threads";
import { EncodeTooLargeError, encodeStickerFrames } from "./encodeJob";
import { EncodeRequestSchema, MAX_ENCODE_MESSAGE_LENGTH, type EncodeResponse } from "./encodeProtocol";

// The own-sticker encode worker thread (3f.5): reads the raw rgba frames the importer's ffmpeg decode wrote, one at a time, and writes the APNG
// (encodeJob.ts). A separate BUILT ENTRY (electron.studio.vite.config.ts: engine/stickerEncodeWorker) loaded from inside app.asar, Electron-free
// like everything under studio/engine. It only ever answers with bytes: the engine ends this thread on a cancel or a time limit (encodeGate.ts)
// and writes the file itself, so a thread that was ended leaves nothing behind. One job per thread.

if (parentPort === null) throw new Error("stickerEncodeWorker.ts must run as a worker_thread");
const port = parentPort;

function send(message: EncodeResponse, transfer: ArrayBuffer[] = []): void {
  port.postMessage(message, transfer);
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, MAX_ENCODE_MESSAGE_LENGTH);

port.on("message", (raw: unknown) => {
  const parsed = EncodeRequestSchema.safeParse(raw);
  if (!parsed.success) {
    // The engine sends only what it validated itself: anything else is a bug worth dying loudly for.
    throw new Error(`sticker encode worker: an invalid request (${parsed.error.message})`);
  }
  const job = parsed.data;
  let fd: number | undefined;
  try {
    const frameBytes = job.width * job.height * 4;
    fd = openSync(job.rawPath, "r");
    const size = fstatSync(fd).size;
    // The raw file is exactly the frames the importer counted: a file of another size is not what was judged.
    if (size !== frameBytes * job.slots.length) throw new Error("the raw file is not the size of its frames");
    const handle = fd;
    const apng = encodeStickerFrames({ width: job.width, height: job.height, slots: job.slots, maxBytes: job.maxBytes }, (index, into) => {
      let filled = 0;
      while (filled < frameBytes) {
        const got = readSync(handle, into, filled, frameBytes - filled, index * frameBytes + filled);
        if (got === 0) throw new Error("a raw frame ended early");
        filled += got;
      }
    });
    // The bytes are a view into a larger buffer only when the writer made them so; a copy keeps the transfer to this file's own.
    const data = apng.byteOffset === 0 && apng.byteLength === apng.buffer.byteLength && apng.buffer instanceof ArrayBuffer ? apng.buffer : apng.slice().buffer;
    send({ type: "encoded", id: job.id, apng: data as ArrayBuffer }, [data as ArrayBuffer]);
  } catch (error) {
    send({ type: "failed", id: job.id, reason: error instanceof EncodeTooLargeError ? "too-large" : "failed", message: messageOf(error) });
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
});
