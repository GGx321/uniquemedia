// 3d.3a: «Воспроизвести» drives the playhead clock and nothing else yet: the preview follows the playhead in 3d.4,
// and the track's `<audio>` joins it with the music (3d.3b). The clock is frame-driven (requestAnimationFrame in
// the window, a hand-moved clock in tests) and measures elapsed time, so a slow frame never slows the playback.

/** A source of time and frames. */
export interface FrameClock {
  /** Milliseconds, monotonic. */
  now(): number;
  /** Runs `callback` on the next frame; the returned function cancels it. */
  frame(callback: () => void): () => void;
}

/** The window's own clock. */
export const windowFrameClock: FrameClock = {
  now: () => performance.now(),
  frame(callback) {
    const handle = requestAnimationFrame(() => callback());
    return () => cancelAnimationFrame(handle);
  },
};

/** Where «Воспроизвести» starts: the playhead, or the start again once the playhead is at the end. */
export function playStartMs(playheadMs: number, totalMs: number): number {
  return playheadMs >= totalMs ? 0 : Math.max(0, playheadMs);
}

/** The playhead `elapsedMs` after starting at `fromMs`: it stops on the end, which ends the playback. */
export function playPositionMs(fromMs: number, elapsedMs: number, totalMs: number): { ms: number; ended: boolean } {
  const ms = fromMs + Math.max(0, elapsedMs);
  return ms >= totalMs ? { ms: totalMs, ended: true } : { ms, ended: false };
}

/** Plays from a point to the montage's end, telling `onTick` the playhead on every frame (and `false` on the last). */
export class PlaybackClock {
  readonly #clock: FrameClock;
  readonly #onTick: (ms: number, playing: boolean) => void;
  #cancel: (() => void) | null = null;

  constructor(clock: FrameClock, onTick: (ms: number, playing: boolean) => void) {
    this.#clock = clock;
    this.#onTick = onTick;
  }

  get playing(): boolean {
    return this.#cancel !== null;
  }

  /** Plays from `fromMs` (a new call starts over); a montage of no length does not play. */
  play(fromMs: number, totalMs: number): void {
    this.pause();
    if (totalMs <= 0) return;
    const startedAt = this.#clock.now();
    const step = (): void => {
      const { ms, ended } = playPositionMs(fromMs, this.#clock.now() - startedAt, totalMs);
      if (ended) {
        this.#cancel = null;
        this.#onTick(ms, false);
        return;
      }
      this.#cancel = this.#clock.frame(step);
      this.#onTick(ms, true);
    };
    this.#cancel = this.#clock.frame(step);
  }

  /** Stops where it is; nothing ticks after it. */
  pause(): void {
    this.#cancel?.();
    this.#cancel = null;
  }
}
