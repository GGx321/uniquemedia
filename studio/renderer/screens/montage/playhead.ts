import { type FrameClock, PlaybackClock, playStartMs, windowFrameClock } from "./playback";
import { clockMs, snapPlayhead } from "./timelineScale";

// 3d.4: the playhead, the preview's clock, in a store of its own. Until 3d.4 it lived in the editor's React state, so every frame
// of a playback re-rendered the whole editor (the 3d.3a / 3d.3b note). Now nothing re-renders unless it subscribes, and a
// component subscribes to as much as it shows (`usePlayhead.ts`): the live time (the preview, a frame at a time), the 100 ms step
// (the clock and the playhead line), or where the playhead RESTS (the toolbar, the panels, the «+» buttons), which moves only on a
// seek, a pause and the end, never while the montage plays.

export interface PlayheadSnapshot {
  /** Where the playhead is: a whole 100 ms step at rest, anywhere between steps while playing. */
  readonly ms: number;
  readonly playing: boolean;
  /** Where it rests: `ms` while stopped; while playing, the point the playback started from. */
  readonly restMs: number;
}

const START: PlayheadSnapshot = { ms: 0, playing: false, restMs: 0 };

export class PlayheadStore {
  readonly #playback: PlaybackClock;
  readonly #listeners = new Set<() => void>();
  #snapshot: PlayheadSnapshot = START;
  #totalMs = 0;

  constructor(clock: FrameClock = windowFrameClock) {
    this.#playback = new PlaybackClock(clock, (ms, playing) => {
      this.#set(playing ? { ms, playing: true, restMs: this.#snapshot.restMs } : { ms, playing: false, restMs: ms });
    });
  }

  /** The playhead now. The same object until something changes, so it can be a React external store's snapshot. */
  get(): PlayheadSnapshot {
    return this.#snapshot;
  }

  /** Called on EVERY change, each frame of a playback included: a listener that shows less reads less (`usePlayhead.ts`). */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  get totalMs(): number {
    return this.#totalMs;
  }

  /**
   * The montage's length. A change stops a playback (it was timed against the old end) on the step the clock shows, and a
   * shorter montage never leaves the playhead past its end.
   */
  setTotal(totalMs: number): void {
    if (totalMs === this.#totalMs) return;
    this.#totalMs = totalMs;
    const now = this.#snapshot;
    if (now.playing) {
      this.#playback.pause();
      const at = Math.min(clockMs(now.ms), Math.max(0, totalMs));
      this.#set({ ms: at, playing: false, restMs: at });
      return;
    }
    if (now.ms > totalMs) {
      const at = Math.max(0, totalMs);
      this.#set({ ms: at, playing: false, restMs: at });
    }
  }

  /** Moves the playhead to the nearest 100 ms inside the montage, and stops a playback. */
  seek(ms: number): void {
    this.#playback.pause();
    const at = snapPlayhead(ms, this.#totalMs);
    this.#set({ ms: at, playing: false, restMs: at });
  }

  /** «Воспроизвести» / «Пауза»: plays from the playhead (from the start once at the end); a pause lands on the clock's step. */
  toggle(): void {
    const now = this.#snapshot;
    if (now.playing) {
      this.#playback.pause();
      const at = clockMs(now.ms);
      this.#set({ ms: at, playing: false, restMs: at });
      return;
    }
    const from = playStartMs(now.ms, this.#totalMs);
    this.#playback.play(from, this.#totalMs);
    this.#set(this.#playback.playing ? { ms: from, playing: true, restMs: from } : { ms: from, playing: false, restMs: from });
  }

  /** Stops a playback for the editor closing: no frame is asked for after it (a remount, as React's StrictMode makes, may play again). */
  dispose(): void {
    this.#playback.pause();
    const now = this.#snapshot;
    if (now.playing) {
      const at = clockMs(now.ms);
      this.#set({ ms: at, playing: false, restMs: at });
    }
  }

  #set(next: PlayheadSnapshot): void {
    const now = this.#snapshot;
    if (next.ms === now.ms && next.playing === now.playing && next.restMs === now.restMs) return;
    this.#snapshot = next;
    for (const listener of [...this.#listeners]) listener();
  }
}
