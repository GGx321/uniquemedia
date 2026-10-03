import { useCallback, useEffect, useRef, useState } from "react";
import type { Focus, MontageDraft } from "../../../shared/engine";
import type { EngineClient } from "../../engine/client";
import { evenOut, totalMs } from "./clipOps";
import { type FrameClock, PlaybackClock, playStartMs, windowFrameClock } from "./playback";
import { duplicateSelected, removeSelected, type Selection, splitSelected } from "./selection";
import type { DraftSession } from "./session";
import { clampZoom, clockMs, MIN_ZOOM, snapPlayhead } from "./timelineScale";

// 3d.3a: the timeline's renderer state, none of it saved: the one selected item, the playhead (the preview's clock,
// 3d.4 reads it), the zoom, and whether «Воспроизвести» is running.

export interface TimelineState {
  readonly selection: Selection | null;
  select(selection: Selection | null): void;
  /** Where the playhead is; between 100 ms steps only while playing. */
  readonly playheadMs: number;
  /** Moves the playhead (snapped to 100 ms, within the montage) and stops a playback. */
  seek(ms: number): void;
  readonly zoom: number;
  setZoom(zoom: number): void;
  readonly playing: boolean;
  togglePlay(): void;
}

export function useTimeline(spec: MontageDraft, clock: FrameClock = windowFrameClock): TimelineState {
  const total = totalMs(spec);
  const [selection, select] = useState<Selection | null>(null);
  const [playheadMs, setPlayheadMs] = useState(0);
  const [zoom, setZoomState] = useState(MIN_ZOOM);
  const [playing, setPlaying] = useState(false);
  const playback = useRef<PlaybackClock | null>(null);
  if (playback.current === null) {
    playback.current = new PlaybackClock(clock, (ms, still) => {
      setPlayheadMs(ms);
      setPlaying(still);
    });
  }
  const totalRef = useRef(total);
  totalRef.current = total;
  const playheadRef = useRef(playheadMs);
  playheadRef.current = playheadMs;

  useEffect(() => () => playback.current?.pause(), []);

  // An edit that changes the montage's length stops a playback (it was timed against the old end).
  useEffect(() => {
    if (!playback.current?.playing) return;
    playback.current.pause();
    setPlaying(false);
    setPlayheadMs((ms) => clockMs(ms));
  }, [total]);

  // A shorter montage (a clip deleted or trimmed) never leaves the playhead past its end.
  useEffect(() => {
    if (playheadMs > total) setPlayheadMs(total);
  }, [playheadMs, total]);

  const seek = useCallback((ms: number) => {
    playback.current?.pause();
    setPlaying(false);
    setPlayheadMs(snapPlayhead(ms, totalRef.current));
  }, []);

  const togglePlay = useCallback(() => {
    const clockNow = playback.current;
    if (clockNow === null) return;
    if (clockNow.playing) {
      clockNow.pause();
      setPlaying(false);
      // A pause lands on the step the clock shows.
      setPlayheadMs((ms) => clockMs(ms));
      return;
    }
    const from = playStartMs(playheadRef.current, totalRef.current);
    setPlayheadMs(from);
    clockNow.play(from, totalRef.current);
    setPlaying(clockNow.playing);
  }, []);

  const setZoom = useCallback((next: number) => setZoomState(clampZoom(next)), []);

  return { selection, select, playheadMs, seek, zoom, setZoom, playing, togglePlay };
}

/**
 * The toolbar's and the properties' actions on the selection, each one undo step through the session. They read
 * the session's CURRENT draft (not a render's copy), so a click right after another edit acts on it.
 */
export function useSelectionCommands(session: DraftSession, timeline: TimelineState) {
  const { select, selection, playheadMs } = timeline;
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
      const result = splitSelected(session.state.spec, selection, playheadMs);
      if (typeof result === "string" || !session.edit(result.spec)) return false;
      select(result.selection);
      return true;
    }, [session, selection, select, playheadMs]),
    /** «Поровну»: the same total over every clip. */
    evenOut: useCallback((): boolean => {
      const spec = session.state.spec;
      const next = evenOut(spec);
      return next !== spec && session.edit(next);
    }, [session]),
  };
}

/**
 * K6: the face focus of a photo the owner just placed. The photo goes into the draft at once with `focus: null`;
 * `montages.focus` answers later, and a found focus is written into the history (`DraftSession.fillFocus`), never
 * as an undo step. An unresolved answer (null, a refusal) leaves null, which the preview draws at
 * `FOCUS_FALLBACK`. `pending` names the photos still being judged («ищем лицо…»).
 */
export function useFocusResolver(client: EngineClient, session: DraftSession, avatarId: string): { pending: ReadonlySet<string>; resolve(photoId: string): void } {
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const resolve = useCallback(
    (photoId: string) => {
      setPending((now) => new Set(now).add(photoId));
      void client.request("montages.focus", { avatarId, photo: { source: "scene", photoId } }).then((reply) => {
        if (!alive.current) return;
        const focus: Focus | null = reply.ok ? reply.result.focus : null;
        if (focus !== null) session.fillFocus(photoId, focus);
        setPending((now) => {
          const next = new Set(now);
          next.delete(photoId);
          return next;
        });
      });
    },
    [client, session, avatarId],
  );

  return { pending, resolve };
}
