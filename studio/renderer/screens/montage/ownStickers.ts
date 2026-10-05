import type { MediaSummary } from "../../../shared/engine";
import type { EngineClient } from "../../engine/client";
import { useMediaRecords } from "./ownMedia";

// The editor's picture of the owner's own stickers (Stage 3, 3f.5): what the preview needs of each to draw it: its canvas (the box is sized from it),
// its loop and its per-frame delays (the frame on screen is picked by the 30 fps tick through them, as the render's loop does). Kept from `media.list` (asked BY ID for the stickers the draft names, so an old one is found
// whatever the library holds) and kept current by `media.changed` (ownMedia.ts, shared with the own videos of 3f.3b). The bytes are a separate door
// (`media.stickerBytes`, stickerFrames.ts): this only knows the record.

/** An own sticker as the preview uses it. */
export interface OwnSticker {
  readonly mediaId: string;
  readonly width: number;
  readonly height: number;
  /** The loop in 30 fps frames, as stored. */
  readonly loopFrames: number;
  /** Each frame's delay in 30 fps frames; they add up to `loopFrames`. */
  readonly delayFrames: readonly number[];
}

/** The preview's view of a media record: null for anything that is not a sticker with a canvas, a loop and delays. */
export function ownStickerOf(summary: MediaSummary): OwnSticker | null {
  if (summary.kind !== "sticker" || summary.width === null || summary.height === null || summary.loopFrames === null || summary.delayFrames === null) return null;
  return { mediaId: summary.mediaId, width: summary.width, height: summary.height, loopFrames: summary.loopFrames, delayFrames: summary.delayFrames };
}

/**
 * The own stickers the draft names (`mediaIds`), by media id: asked by id (`media.list {kind: "sticker", mediaIds}`), so one that is older than the
 * 500 newest the plain listing holds is still found, and followed by `media.changed`. Empty until the answer arrives, and when it cannot be had: an
 * own sticker the layer names then has no record to draw from, and its place is shown with nothing in it (as a sticker gone from the set is). Nothing
 * is asked while the draft names none; the ids are asked in sorted order, each once, so the same set in another order is not another question.
 */
export function useOwnStickers(client: Pick<EngineClient, "request" | "subscribe">, mediaIds: readonly string[]): ReadonlyMap<string, OwnSticker> {
  return useMediaRecords(client, "sticker", mediaIds, ownStickerOf).held;
}
