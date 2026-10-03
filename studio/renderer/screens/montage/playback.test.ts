import { describe, expect, test } from "bun:test";
import { type FrameClock, PlaybackClock, playPositionMs, playStartMs } from "./playback";

// 3d.3a: «Воспроизвести» drives the playhead clock only (the preview and `<audio>` follow it in 3d.4 / 3d.3b).

/** A clock the test moves by hand: `advance(ms)` then `frame()` runs the pending frame callbacks. */
function fakeClock() {
  let now = 1_000;
  let callbacks: (() => void)[] = [];
  const clock: FrameClock = {
    now: () => now,
    frame: (callback) => {
      callbacks.push(callback);
      return () => {
        callbacks = callbacks.filter((c) => c !== callback);
      };
    },
  };
  return {
    clock,
    advance(ms: number): void {
      now += ms;
      const run = callbacks;
      callbacks = [];
      for (const callback of run) callback();
    },
    pending: (): number => callbacks.length,
  };
}

describe("where playback starts and stands", () => {
  test("from the playhead; from the start when the playhead is at the end (or past it)", () => {
    expect(playStartMs(4_100, 9_600)).toBe(4_100);
    expect(playStartMs(9_600, 9_600)).toBe(0);
    expect(playStartMs(9_700, 9_600)).toBe(0);
    expect(playStartMs(0, 0)).toBe(0);
  });

  test("moves with the elapsed time and stops at the end", () => {
    expect(playPositionMs(4_100, 0, 9_600)).toEqual({ ms: 4_100, ended: false });
    expect(playPositionMs(4_100, 1_234, 9_600)).toEqual({ ms: 5_334, ended: false });
    expect(playPositionMs(4_100, 5_499, 9_600)).toEqual({ ms: 9_599, ended: false });
    expect(playPositionMs(4_100, 5_500, 9_600)).toEqual({ ms: 9_600, ended: true });
    expect(playPositionMs(4_100, 60_000, 9_600)).toEqual({ ms: 9_600, ended: true });
  });
});

describe("the playback clock", () => {
  test("ticks on every frame until the end, then stops on the end itself", () => {
    const fake = fakeClock();
    const ticks: [number, boolean][] = [];
    const playback = new PlaybackClock(fake.clock, (ms, playing) => ticks.push([ms, playing]));
    playback.play(1_000, 2_000);
    expect(playback.playing).toBe(true);
    fake.advance(400);
    fake.advance(500);
    fake.advance(500);
    expect(ticks).toEqual([
      [1_400, true],
      [1_900, true],
      [2_000, false],
    ]);
    expect(playback.playing).toBe(false);
    expect(fake.pending()).toBe(0);
  });

  test("a pause stops the frames and keeps the place; nothing ticks after it", () => {
    const fake = fakeClock();
    const ticks: number[] = [];
    const playback = new PlaybackClock(fake.clock, (ms) => ticks.push(ms));
    playback.play(0, 9_600);
    fake.advance(250);
    playback.pause();
    expect(playback.playing).toBe(false);
    expect(fake.pending()).toBe(0);
    fake.advance(1_000);
    expect(ticks).toEqual([250]);
  });

  test("playing again starts over from where it is asked to, and an empty montage does not play", () => {
    const fake = fakeClock();
    const ticks: number[] = [];
    const playback = new PlaybackClock(fake.clock, (ms) => ticks.push(ms));
    playback.play(500, 9_600);
    playback.play(3_000, 9_600);
    expect(fake.pending()).toBe(1);
    fake.advance(100);
    expect(ticks).toEqual([3_100]);
    playback.pause();
    playback.play(0, 0);
    expect(playback.playing).toBe(false);
    expect(fake.pending()).toBe(0);
  });
});
