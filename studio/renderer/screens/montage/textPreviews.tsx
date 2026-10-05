import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { MontageDraft, TextLayer } from "../../../shared/engine";
import type { EngineClient } from "../../engine/client";
import { requestTextPreview } from "../../engine/textPreview";
import { type LayerPreview, previewLook, TextPreviewQueue } from "../../engine/textPreviewQueue";
import { refusedCaptionLayers } from "./captionCheck";

// 3d.4: the editor's one per-layer queue of `montages.textPreview` asks (engine/textPreviewQueue.ts), handed to everything that
// shows a caption: the preview (every text layer's picture), the properties panel (the caption's verdict) and, in DraftEditor, the
// «Рендер» blocker and the layer blocks' marks (a refusal only the real emoji font can give). One per open draft.

const TextPreviewsContext = createContext<TextPreviewQueue | null>(null);

/** The one queue of text previews of `avatarId`'s open draft: the screen makes it once and hands it to `TextPreviewsProvider`. */
export function useTextPreviewQueue(client: EngineClient, avatarId: string): TextPreviewQueue {
  const [queue] = useState(() => new TextPreviewQueue((layer) => requestTextPreview(client, avatarId, layer)));
  return queue;
}

/** Gives the editor below `queue`, the draft's one queue of text previews. */
export function TextPreviewsProvider({ queue, children }: { queue: TextPreviewQueue; children: ReactNode }) {
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

/**
 * The text layers whose caption the engine's preview refuses as it stands now (`refusedCaptionLayers`), read from `queue` for «Рендер».
 * `queue` is given, not read from the context: the screen that blocks the button sits above the provider that hands the queue down.
 * The snapshot is a string, so the component renders again only when the set changes.
 */
export function useRefusedCaptions(queue: TextPreviewQueue, layers: readonly MontageDraft["layers"][number][]): ReadonlySet<string> {
  const latest = useRef(layers);
  latest.current = layers;
  // A layer id never holds a line break, so one is the separator.
  const ids = layers.flatMap((l) => (l.kind === "text" ? [l.layerId] : [])).join("\n");
  const subscribe = useCallback(
    (listener: () => void) => {
      const stops = ids
        .split("\n")
        .filter((id) => id !== "")
        .map((id) => queue.subscribe(id, listener));
      return () => {
        for (const stop of stops) stop();
      };
    },
    [queue, ids],
  );
  const key = useSyncExternalStore(subscribe, () => [...refusedCaptionLayers(latest.current, (id) => queue.get(id))].join("\n"));
  return useMemo(() => new Set(key.split("\n").filter((id) => id !== "")), [key]);
}
