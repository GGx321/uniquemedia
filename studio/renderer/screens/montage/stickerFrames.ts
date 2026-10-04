import { Id } from "../../../shared/engine";
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

/** Opens a sticker's frames by its KEY (a built-in id, or an own sticker's `ownStickerKey`); null when this window cannot decode it (no `ImageDecoder`, no PNG decoding, no bytes for it). */
export type OpenStickerFrames = (key: string) => Promise<StickerFrames | null>;

const OWN_KEY_PREFIX = "own:";

/** The key a cache and an opener know an OWN sticker by (3f.5). A built-in id is a contract `Id`, which has no colon, so the two never collide. */
export const ownStickerKey = (mediaId: string): string => `${OWN_KEY_PREFIX}${mediaId}`;

/** The media id of an own sticker's key, or null for a built-in id or anything that is not a key made by `ownStickerKey` from a contract id. */
export function mediaIdOfOwnKey(key: string): string | null {
  if (!key.startsWith(OWN_KEY_PREFIX)) return null;
  const id = key.slice(OWN_KEY_PREFIX.length);
  return Id.safeParse(id).success ? id : null;
}

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

/**
 * The editor's opener: a sticker's verified bytes from main, decoded by the window's `ImageDecoder`. A built-in sticker's come from
 * `stickers.bytes` (the shipped catalogue); an OWN sticker's from `media.stickerBytes` (3f.5: main resolves the media id through its record). The
 * two doors are separate commands and the key says which is asked: an own key never reaches the built-in command, and a key that is neither a
 * built-in id nor an own key is not asked for at all.
 */
export function stickerFramesFrom(client: Pick<EngineClient, "request">): OpenStickerFrames {
  return async (key) => {
    const mediaId = mediaIdOfOwnKey(key);
    if (mediaId !== null) {
      const reply = await client.request("media.stickerBytes", { mediaId });
      return reply.ok ? openWithImageDecoder(bytesOfBase64(reply.result.apngBase64)) : null;
    }
    // A built-in id: anything else is refused by the contract before it leaves (and not asked for here).
    if (!Id.safeParse(key).success) return null;
    const reply = await client.request("stickers.bytes", { stickerId: key });
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

/**
 * One decoder per sticker, shared by every layer showing it; closed when the last one releases it. Each canvas releases what it
 * acquired when it goes, so leaving the editor closes every decoder (EditorPreview.test.tsx pins it).
 */
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

  #close(held: Held): void {
    held.released = true;
    held.opened?.close();
  }
}
