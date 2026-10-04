import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { StickerFrameCache, StickerFrames } from "./stickerFrames";

// 3d.4: a sticker in the preview is drawn on a canvas, one decoded frame at a time: the frame the playhead's 30 fps tick picks on the
// loop stored with the sticker (previewFrame.ts), so it stays in phase with the playhead and the render. The decoder is the
// editor's, shared per sticker and fed by main's `stickers.bytes` (an own sticker's: `media.stickerBytes`, 3f.5; stickerFrames.ts), and released when the canvas goes; each
// decoded frame is closed once drawn. Where the window cannot decode it (no `ImageDecoder`), the picture itself is shown, from
// `studio-media://sticker/<id>` as an element, playing on its own clock.

export interface StickerCanvasProps {
  readonly cache: StickerFrameCache;
  /** What the decoder is opened for: a built-in sticker's id, or an own sticker's `ownStickerKey`. */
  readonly stickerId: string;
  /** Its picture as an element shows it (the fallback where nothing decodes). */
  readonly url: string;
  /** The frame of the picture to show (stickerFrameIndex). */
  readonly frameIndex: number;
  /** The canvas's own pixels per side: the picture's size (the box scales it). The canvas's width, when `height` says it is not square. */
  readonly side: number;
  /** An own sticker's canvas need not be square (3f.5): its height, when it is not `side`. */
  readonly height?: number;
}

export function StickerCanvas({ cache, stickerId, url, frameIndex, side, height = side }: StickerCanvasProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [frames, setFrames] = useState<StickerFrames | null | "opening">("opening");
  /** The newest frame asked for: an older decode that lands late is not drawn over it. */
  const latest = useRef(0);

  useEffect(() => {
    let alive = true;
    setFrames("opening");
    void cache.acquire(stickerId).then((opened) => {
      if (alive) setFrames(opened);
    });
    return () => {
      alive = false;
      cache.release(stickerId);
    };
  }, [cache, stickerId]);

  useLayoutEffect(() => {
    if (frames === "opening" || frames === null) return;
    const token = ++latest.current;
    void frames.frame(frameIndex).then((decoded) => {
      if (decoded === null) return;
      try {
        const node = canvas.current;
        const context = node?.getContext("2d") ?? null;
        if (token !== latest.current || node === null || context === null) return;
        context.clearRect(0, 0, node.width, node.height);
        context.drawImage(decoded.image, 0, 0, node.width, node.height);
      } finally {
        decoded.close();
      }
    });
  }, [frames, frameIndex]);

  if (frames === null) return <img className="pv-sticker-pic" src={url} alt="" draggable={false} />;
  return <canvas ref={canvas} className="pv-sticker-pic" width={side} height={height} data-frame={frameIndex} />;
}
