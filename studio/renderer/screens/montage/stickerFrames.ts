import { dataUrlBytes } from "../../lib/dataUrl";

// 3d.4: a sticker's frames for the preview's canvas, decoded by WebCodecs `ImageDecoder` (the 3b.5 hand-off):
// - created with `colorSpaceConversion: "none"`: Chrome applies a PNG's gAMA / iCCP by default and ffmpeg ignores them; measured,
//   the pixels then match the render;
// - frames are picked by the 30 fps tick and the loop stored with the sticker (previewFrame.ts `stickerFrameIndex`), never by the
//   decoder's own frame durations (Chrome reports 1/30 s as 33 000 µs, which drifts);
// - the bytes come from main's `studio-media://sticker/<id>` (a secure, CORS-enabled scheme; the CSP lets script read that route
//   only) or, in the dev mock, from the stand-in's data URL;
// - one decoder per picture, shared by every layer that shows it, closed when the last one lets go (`StickerFrameCache`): a
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

/** Opens a picture's frames; null when this window cannot decode it (no `ImageDecoder`, a type it does not take, no bytes). */
export type OpenStickerFrames = (url: string) => Promise<StickerFrames | null>;

async function bytesOf(url: string): Promise<{ type: string; bytes: Uint8Array } | null> {
  const inline = dataUrlBytes(url);
  if (inline !== null) return inline;
  const response = await fetch(url);
  if (!response.ok) return null;
  return { type: response.headers.get("Content-Type") ?? "image/png", bytes: new Uint8Array(await response.arrayBuffer()) };
}

/** The window's own decoder: `ImageDecoder` over the picture's bytes, colours untouched. */
export async function openWithImageDecoder(url: string): Promise<StickerFrames | null> {
  if (typeof ImageDecoder === "undefined") return null;
  const source = await bytesOf(url).catch(() => null);
  if (source === null) return null;
  // An APNG is a PNG to the decoder.
  const type = source.type === "image/apng" ? "image/png" : source.type;
  if (!(await ImageDecoder.isTypeSupported(type))) return null;
  const decoder = new ImageDecoder({ data: source.bytes, type, colorSpaceConversion: "none" });
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
