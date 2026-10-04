import { useCallback, useSyncExternalStore } from "react";
import { msToFrameFloor } from "../../../shared/montage";
import type { PlayheadSnapshot, PlayheadStore } from "./playhead";
import { clockMs } from "./timelineScale";

// 3d.4: how a component reads the playhead store (playhead.ts). The store tells its listeners on every frame of a playback;
// `useSyncExternalStore` re-renders a component only when what it READS changes (a number or a boolean, compared by value), so
// each hook below costs a re-render only at its own rate:
// - `usePlayheadRest`: on a seek, a pause, the end (never while playing): the toolbar, the panels, the «+» buttons;
// - `usePlayheadStep`: every 100 ms: the clock and the playhead line;
// - `usePlayheadFrame`: every 30 fps frame: the preview;
// - `usePlaying`: when playback starts or stops.

function usePlayheadValue<T extends number | boolean>(store: PlayheadStore, read: (snapshot: PlayheadSnapshot) => T): T {
  const subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store]);
  return useSyncExternalStore(subscribe, () => read(store.get()));
}

const restOf = (s: PlayheadSnapshot): number => s.restMs;
const stepOf = (s: PlayheadSnapshot): number => clockMs(s.ms);
const frameOf = (s: PlayheadSnapshot): number => msToFrameFloor(Math.max(0, s.ms));
const playingOf = (s: PlayheadSnapshot): boolean => s.playing;

export const usePlayheadRest = (store: PlayheadStore): number => usePlayheadValue(store, restOf);
export const usePlayheadStep = (store: PlayheadStore): number => usePlayheadValue(store, stepOf);
export const usePlayheadFrame = (store: PlayheadStore): number => usePlayheadValue(store, frameOf);
export const usePlaying = (store: PlayheadStore): boolean => usePlayheadValue(store, playingOf);
