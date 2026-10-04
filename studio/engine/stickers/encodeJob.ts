import { ApngTooLargeError, createApngEncoder } from "../../shared/stickers/apngWriter";

// The own-sticker encode job (3f.5), free of threads and files: it asks `readFrame` for each raw frame that lasts at least one 30 fps slot, one
// at a time, into ONE reused buffer, and writes them with Studio's own RGBA APNG writer (shared/stickers/apngWriter.ts), each with its slots as
// its delay. It runs inside the encode worker (stickerEncodeWorker.ts), because compressing 300 frames of up to 720 x 720 with a hand-written
// deflate takes tens of seconds and must never run on the engine's event loop.

/** The finished file would pass the byte limit. */
export class EncodeTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`the encoded sticker passes ${maxBytes} bytes`);
    this.name = "EncodeTooLargeError";
  }
}

export interface EncodeFrames {
  readonly width: number;
  readonly height: number;
  /** The slots each raw frame lasts; a frame with 0 is neither read nor written. */
  readonly slots: readonly number[];
  readonly maxBytes: number;
}

/** Fills `into` (`width * height * 4` bytes) with raw frame `index`, or throws. */
export type ReadFrame = (index: number, into: Uint8Array) => void;

export function encodeStickerFrames(job: EncodeFrames, readFrame: ReadFrame): Uint8Array {
  const kept = job.slots.filter((slots) => slots > 0).length;
  if (kept === 0) throw new Error("the loop has no frame");
  const encoder = createApngEncoder({ width: job.width, height: job.height, frameCount: kept, maxBytes: job.maxBytes });
  const frame = new Uint8Array(job.width * job.height * 4);
  try {
    job.slots.forEach((slots, index) => {
      if (slots === 0) return;
      readFrame(index, frame);
      encoder.add(frame, slots);
    });
    return encoder.finish();
  } catch (error) {
    if (error instanceof ApngTooLargeError) throw new EncodeTooLargeError(error.maxBytes);
    throw error;
  }
}
