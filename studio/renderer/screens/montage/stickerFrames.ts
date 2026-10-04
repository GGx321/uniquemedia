import type { EngineClient } from "../../engine/client";

// 3d.4: a sticker's frames for the preview's canvas, decoded by WebCodecs `ImageDecoder` (the 3b.5 hand-off):
// - created with `colorSpaceConversion: "none"`: Chrome applies a PNG's gAMA / iCCP by default and ffmpeg ignores them; measured,
//   the pixels then match the render;
// - frames are picked by the 30 fps tick and the loop stored with the sticker (previewFrame.ts `stickerFrameIndex`), never by the
//   decoder's own frame durations (Chrome reports 1/30 s as 33 000 µs, which drifts);
// - the bytes come from MAIN over IPC (`stickers.bytes`, the verified built-in set; review round 1): the media scheme stays closed
//   to script reads, since a CORS-enabled scheme would let any page in the session read any route;
// - one decoder per sticker, shared by every layer that shows it, closed when the last one lets go (`StickerFrameCache`): a
//   decoder holds the file and its frame buffers, and a decoded frame is closed as soon as it is drawn.

/** A decoded frame, to be closed once drawn. */
export interface DecodedFrame {
  readonly image: CanvasImageSource;
  close(): void;
}

/** A sticker's frames, decoded on demand. */
export interface StickerFrames {
  readonly frameCount: number;
  /** Frame `index` (clamped to the frames there are); null when it could not be decoded (the decoder closed meanwhile). */
  frame(index: number): Promise<DecodedFrame | null>;
  close(): void;
}

/** Opens a sticker's frames; null when this window cannot decode it (no `ImageDecoder`, no PNG decoding, no bytes for it). */
export type OpenStickerFrames = (stickerId: string) => Promise<StickerFrames | null>;

/** The window's own decoder: `ImageDecoder` over an APNG's bytes, colours untouched. */
export async function openWithImageDecoder(bytes: Uint8Array): Promise<StickerFrames | null> {
  if (typeof ImageDecoder === "undefined") return null;
  // An APNG is a PNG to the decoder.
  if (!(await ImageDecoder.isTypeSupported("image/png"))) return null;
  const decoder = new ImageDecoder({ data: bytes, type: "image/png", colorSpaceConversion: "none" });
  try {
    await decoder.tracks.ready;
    await decoder.completed;
  } catch {
    decoder.close();
    return null;
  }
  const frameCount = Math.max(1, decoder.tracks.selectedTrack?.frameCount ?? 1);
  let closed = false;
  return {
    frameCount,
    async frame(index) {
      if (closed) return null;
      try {
        const { image } = await decoder.decode({ frameIndex: Math.min(Math.max(0, index), frameCount - 1) });
        return { image, close: () => image.close() };
      } catch {
        // Closed while decoding (the layer went away): nothing to draw.
        return null;
      }
    },
    close() {
      if (closed) return;
      closed = true;
      decoder.close();
    },
  };
}

/** Base64 (the contract's form of the bytes: every message survives JSON) back into bytes. */
function bytesOfBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** The editor's opener: a built-in sticker's verified bytes from main (`stickers.bytes`), decoded by the window's `ImageDecoder`. */
export function stickerFramesFrom(client: Pick<EngineClient, "request">): OpenStickerFrames {
  return async (stickerId) => {
    const reply = await client.request("stickers.bytes", { stickerId });
    if (!reply.ok) return null;
    return openWithImageDecoder(bytesOfBase64(reply.result.apngBase64));
  };
}

interface Held {
  count: number;
  readonly frames: Promise<StickerFrames | null>;
  /** The frames once opened (undefined while opening). */
  opened: StickerFrames | null | undefined;
  released: boolean;
}

/** One decoder per picture, shared by every layer showing it; closed when the last one releases it. */
export class StickerFrameCache {
  readonly #open: OpenStickerFrames;
  readonly #held = new Map<string, Held>();

  constructor(open: OpenStickerFrames) {
    this.#open = open;
  }

  /** The picture's frames, opened on the first acquire. Every acquire is paired with a `release`. */
  acquire(url: string): Promise<StickerFrames | null> {
    const held = this.#held.get(url);
    if (held !== undefined) {
      held.count += 1;
      return held.frames;
    }
    const frames = this.#open(url).catch(() => null);
    const entry: Held = { count: 1, frames, opened: undefined, released: false };
    this.#held.set(url, entry);
    void frames.then((opened) => {
      entry.opened = opened;
      // Released before it finished opening: closed as soon as it opens.
      if (entry.released) opened?.close();
    });
    return frames;
  }

  release(url: string): void {
    const held = this.#held.get(url);
    if (held === undefined) return;
    held.count -= 1;
    if (held.count > 0) return;
    this.#held.delete(url);
    this.#close(held);
  }

  /** Every picture still held is closed (the editor closing). */
  closeAll(): void {
    for (const [url, held] of [...this.#held]) {
      this.#held.delete(url);
      this.#close(held);
    }
  }

  #close(held: Held): void {
    held.released = true;
    held.opened?.close();
  }
}
