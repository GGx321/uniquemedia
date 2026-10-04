import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Focus, MontageDraft } from "../../../shared/engine";
import type { EngineClient } from "../../engine/client";
import { evenOut, totalMs } from "./clipOps";
import { type FrameClock, windowFrameClock } from "./playback";
import { PlayheadStore } from "./playhead";
import { addStickerLayer, addTextLayer } from "./layerOps";
import { duplicateSelected, lowerSelected, raiseSelected, removeSelected, type Selection, splitSelected } from "./selection";
import type { DraftSession } from "./session";
import type { TextPreset } from "./textOps";
import { clampZoom, clockMs, MIN_ZOOM } from "./timelineScale";

// 3d.3a: the timeline's renderer state, none of it saved: the one selected item, the playhead (the preview's clock), the zoom,
// and whether «Воспроизвести» is running. 3d.4: the playhead is a store of its own (playhead.ts), so a playback re-renders only
// what subscribes to it (usePlayhead.ts), never the whole editor; this state object stays the same while the montage plays.

export interface TimelineState {
  readonly selection: Selection | null;
  select(selection: Selection | null): void;
  /** The playhead and «Воспроизвести»: read it through `usePlayhead.ts`, or `.get()` in a handler. */
  readonly playhead: PlayheadStore;
  /** Moves the playhead (snapped to 100 ms, within the montage) and stops a playback. */
  seek(ms: number): void;
  readonly zoom: number;
  setZoom(zoom: number): void;
  /** «Воспроизвести» / «Пауза». */
  togglePlay(): void;
}

export function useTimeline(spec: MontageDraft, clock: FrameClock = windowFrameClock): TimelineState {
  const total = totalMs(spec);
  const [selection, select] = useState<Selection | null>(null);
  const [zoom, setZoomState] = useState(MIN_ZOOM);
  const [playhead] = useState(() => new PlayheadStore(clock));

  // The store knows the montage's length before the screen is painted: a change stops a playback and pulls the playhead back
  // inside a shorter montage (playhead.ts).
  useLayoutEffect(() => playhead.setTotal(total), [playhead, total]);
  useEffect(() => () => playhead.dispose(), [playhead]);

  const seek = useCallback((ms: number) => playhead.seek(ms), [playhead]);
  const togglePlay = useCallback(() => playhead.toggle(), [playhead]);
  const setZoom = useCallback((next: number) => setZoomState(clampZoom(next)), []);

  return useMemo(() => ({ selection, select, playhead, seek, zoom, setZoom, togglePlay }), [selection, playhead, seek, zoom, setZoom, togglePlay]);
}

/** The step the playhead's clock shows now (while playing, the step it is in): what an action at the playhead acts at. */
export function playheadStep(timeline: Pick<TimelineState, "playhead">): number {
  return clockMs(timeline.playhead.get().ms);
}

/**
 * The toolbar's and the properties' actions on the selection, each one undo step through the session. They read
 * the session's CURRENT draft (not a render's copy), so a click right after another edit acts on it, and the playhead
 * as it is at the click (a playback may be moving it).
 */
export function useSelectionCommands(session: DraftSession, timeline: TimelineState) {
  const { select, selection, playhead } = timeline;
  return {
    remove: useCallback((): boolean => {
      const result = removeSelected(session.state.spec, selection);
      if (result === null || !session.edit(result.spec)) return false;
      select(result.selection);
      return true;
    }, [session, selection, select]),
    duplicate: useCallback((): boolean => {
      const result = duplicateSelected(session.state.spec, selection);
      if (typeof result === "string" || !session.edit(result.spec)) return false;
      select(result.selection);
      return true;
    }, [session, selection, select]),
    split: useCallback((): boolean => {
      const result = splitSelected(session.state.spec, selection, clockMs(playhead.get().ms));
      if (typeof result === "string" || !session.edit(result.spec)) return false;
      select(result.selection);
      return true;
    }, [session, selection, select, playhead]),
    /** «Поровну»: the same total over every clip. */
    evenOut: useCallback((): boolean => {
      const spec = session.state.spec;
      const next = evenOut(spec);
      return next !== spec && session.edit(next);
    }, [session]),
    /** «Слой выше» (3d.3b): the selected layer above the next layer on screen at the same time; it stays selected. */
    raise: useCallback((): boolean => {
      const result = raiseSelected(session.state.spec, selection);
      return typeof result !== "string" && session.edit(result.spec);
    }, [session, selection]),
    /** «Слой ниже». */
    lower: useCallback((): boolean => {
      const result = lowerSelected(session.state.spec, selection);
      return typeof result !== "string" && session.edit(result.spec);
    }, [session, selection]),
    /** «Добавить текст» (3d.3b; 3d.5: the «Текст» tab's button and its presets): a text at the playhead, selected; its id, or null. */
    addText: useCallback(
      (preset?: TextPreset): string | null => {
        const edit = addTextLayer(session.state.spec, clockMs(playhead.get().ms), preset);
        if (!edit.ok || edit.id === undefined || !session.edit(edit.spec)) return null;
        select({ kind: "layer", layerId: edit.id });
        return edit.id;
      },
      [session, playhead, select],
    ),
    /** A built-in sticker at the playhead, selected; its id, or null. */
    addSticker: useCallback(
      (stickerId: string): string | null => {
        const edit = addStickerLayer(session.state.spec, clockMs(playhead.get().ms), stickerId);
        if (!edit.ok || edit.id === undefined || !session.edit(edit.spec)) return null;
        select({ kind: "layer", layerId: edit.id });
        return edit.id;
      },
      [session, playhead, select],
    ),
  };
}

/**
 * K6: the face focus of a photo the owner just placed. The photo goes into the draft at once with `focus: null`;
 * `montages.focus` answers later, and a found focus is written into the history (`DraftSession.fillFocus`), never
 * as an undo step. An unresolved answer (null, a refusal) leaves null, which the preview draws at
 * `FOCUS_FALLBACK`. `pending` names the photos still being judged («ищем лицо…»).
 */
export function useFocusResolver(client: EngineClient, session: DraftSession, avatarId: string): { pending: ReadonlySet<string>; resolve(photoId: string): void } {
  /** Questions still out, per photo: the same photo may be asked again (placed, undone, placed) before an answer. */
  const [open, setOpen] = useState<ReadonlyMap<string, number>>(() => new Map());
  const pending = useMemo<ReadonlySet<string>>(() => new Set(open.keys()), [open]);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const resolve = useCallback(
    (photoId: string) => {
      setOpen((now) => new Map(now).set(photoId, (now.get(photoId) ?? 0) + 1));
      void client.request("montages.focus", { avatarId, photo: { source: "scene", photoId } }).then((reply) => {
        if (!alive.current) return;
        const focus: Focus | null = reply.ok ? reply.result.focus : null;
        if (focus !== null) session.fillFocus(photoId, focus);
        // This answer closes one question; «ищем лицо…» stays while a later one for the photo is still out.
        setOpen((now) => {
          const next = new Map(now);
          const left = (now.get(photoId) ?? 1) - 1;
          if (left > 0) next.set(photoId, left);
          else next.delete(photoId);
          return next;
        });
      });
    },
    [client, session, avatarId],
  );

  return { pending, resolve };
}
