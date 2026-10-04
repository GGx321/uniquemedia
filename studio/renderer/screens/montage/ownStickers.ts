import { useEffect, useState } from "react";
import type { MediaSummary } from "../../../shared/engine";
import type { EngineClient } from "../../engine/client";

// The editor's picture of the owner's own stickers (Stage 3, 3f.5): what the preview needs of each to draw it: its canvas (the box is sized from it),
// its loop and its per-frame delays (the frame on screen is picked by the 30 fps tick through them, as the render's loop does). Kept from `media.list`
// and kept current by `media.changed`. The bytes are a separate door (`media.stickerBytes`, stickerFrames.ts): this only knows the record.

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

/** What `media.changed` says: a record stored or replaced, or one gone. */
export type MediaChange = { readonly change: "upserted"; readonly media: MediaSummary } | { readonly change: "removed"; readonly mediaId: string };

/** The map after one change; the same map when the change is not about an own sticker or one it never held. Never edits the map it is given. */
export function applyMediaChange(held: ReadonlyMap<string, OwnSticker>, change: MediaChange): ReadonlyMap<string, OwnSticker> {
  if (change.change === "removed") {
    if (!held.has(change.mediaId)) return held;
    const next = new Map(held);
    next.delete(change.mediaId);
    return next;
  }
  const sticker = ownStickerOf(change.media);
  if (sticker === null) return held;
  return new Map(held).set(sticker.mediaId, sticker);
}

const NONE: ReadonlyMap<string, OwnSticker> = new Map();

/**
 * The owner's own stickers by media id, read once (`media.list`) and followed by `media.changed`. Empty until the list arrives, and when it cannot be
 * read: an own sticker the layer names then has no record to draw from, and its place is shown with nothing in it (as a sticker gone from the set is).
 */
export function useOwnStickers(client: Pick<EngineClient, "request" | "subscribe">): ReadonlyMap<string, OwnSticker> {
  const [held, setHeld] = useState<ReadonlyMap<string, OwnSticker>>(NONE);
  useEffect(() => {
    let alive = true;
    // Events that arrive before the list does are kept and applied after it, so none is lost to the race.
    const early: MediaChange[] = [];
    let listed = false;
    const unsubscribe = client.subscribe((event) => {
      if (event.type !== "media.changed") return;
      if (!listed) early.push(event.payload);
      else if (alive) setHeld((current) => applyMediaChange(current, event.payload));
    });
    void client.request("media.list", { kind: "sticker" }).then((reply) => {
      if (!alive) return;
      listed = true;
      let next: ReadonlyMap<string, OwnSticker> = new Map();
      if (reply.ok) {
        for (const media of reply.result.media) {
          const sticker = ownStickerOf(media);
          if (sticker !== null) next = new Map(next).set(sticker.mediaId, sticker);
        }
      }
      for (const change of early.splice(0)) next = applyMediaChange(next, change);
      setHeld(next);
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [client]);
  return held;
}
