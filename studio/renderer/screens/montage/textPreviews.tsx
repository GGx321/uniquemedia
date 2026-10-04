import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { TextLayer } from "../../../shared/engine";
import type { EngineClient } from "../../engine/client";
import { requestTextPreview } from "../../engine/textPreview";
import { type LayerPreview, previewLook, TextPreviewQueue } from "../../engine/textPreviewQueue";

// 3d.4: the editor's one per-layer queue of `montages.textPreview` asks (engine/textPreviewQueue.ts), handed to everything that
// shows a caption: the preview (every text layer's picture) and the properties panel (the caption's verdict). One per open draft.

const TextPreviewsContext = createContext<TextPreviewQueue | null>(null);

/** Gives the editor below one queue of text previews for `avatarId`'s draft. */
export function TextPreviewsProvider({ client, avatarId, children }: { client: EngineClient; avatarId: string; children: ReactNode }) {
  const [queue] = useState(() => new TextPreviewQueue((layer) => requestTextPreview(client, avatarId, layer)));
  return <TextPreviewsContext.Provider value={queue}>{children}</TextPreviewsContext.Provider>;
}

export function useTextPreviews(): TextPreviewQueue {
  const queue = useContext(TextPreviewsContext);
  if (queue === null) throw new Error("useTextPreviews needs a TextPreviewsProvider above it");
  return queue;
}

/**
 * `layer`'s picture and verdict, asked for whenever its look (text, font, style, colour, size) changes. Every consumer of the same
 * layer shares the queue's one ask (the preview and the panel never supersede each other).
 */
export function useLayerPreview(layer: TextLayer): LayerPreview {
  const queue = useTextPreviews();
  const latest = useRef(layer);
  latest.current = layer;
  const look = previewLook(layer);
  useEffect(() => queue.request(latest.current), [queue, layer.layerId, look]);
  const subscribe = useCallback((listener: () => void) => queue.subscribe(layer.layerId, listener), [queue, layer.layerId]);
  return useSyncExternalStore(subscribe, () => queue.get(layer.layerId));
}

/** Asks for every text layer of the draft (each look once), so a caption's picture is ready before the playhead reaches it. */
export function usePrefetchTextPreviews(layers: readonly TextLayer[]): void {
  const queue = useTextPreviews();
  const latest = useRef(layers);
  latest.current = layers;
  const looks = JSON.stringify(layers.map((l) => [l.layerId, previewLook(l)]));
  useEffect(() => {
    for (const layer of latest.current) queue.request(layer);
  }, [queue, looks]);
}
