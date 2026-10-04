import { describe, expect, test } from "bun:test";
import { fakeFrameClock } from "./clock.testkit";
import { PlayheadStore } from "./playhead";

// 3d.4: the playhead is the preview's clock, and it lives in a store of its own (the 3d.3a / 3d.3b note: it lived in the editor's
// React state, so every frame of a playback re-rendered the whole editor). A component subscribes to as much of it as it shows:
// the live time (the preview, 30 frames a second), the 100 ms step (the clock), or where it RESTS (the toolbar, the panels),
// which moves only on a seek, a pause and the end. Playback measures elapsed time, so a slow frame never slows it.

function store(totalMs = 9_600) {
  const fake = fakeFrameClock();
  const playhead = new PlayheadStore(fake.clock);
  playhead.setTotal(totalMs);
  const seen: number[] = [];
  playhead.subscribe(() => seen.push(playhead.get().ms));
  return { fake, playhead, seen };
}

describe("at rest", () => {
  test("starts at 0, not playing, resting at 0", () => {
    const { playhead } = store();
    expect(playhead.get()).toEqual({ ms: 0, playing: false, restMs: 0 });
  });

  test("a seek lands on the nearest 100 ms inside the montage, and tells its listeners once", () => {
    const { playhead, seen } = store();
    playhead.seek(4_149);
    expect(playhead.get()).toEqual({ ms: 4_100, playing: false, restMs: 4_100 });
    playhead.seek(20_000);
    expect(playhead.get().ms).toBe(9_600);
    playhead.seek(-50);
    expect(playhead.get().ms).toBe(0);
    expect(seen).toEqual([4_100, 9_600, 0]);
  });

  test("a seek to where it already rests changes nothing and tells nobody (the snapshot stays the same object)", () => {
    const { playhead, seen } = store();
    playhead.seek(2_000);
    const before = playhead.get();
    playhead.seek(2_040);
    expect(playhead.get()).toBe(before);
    expect(seen).toEqual([2_000]);
  });

  test("a shorter montage pulls a playhead past its end back to the end", () => {
    const { playhead } = store();
    playhead.seek(9_000);
    playhead.setTotal(6_000);
    expect(playhead.get()).toEqual({ ms: 6_000, playing: false, restMs: 6_000 });
  });

  test("a longer montage leaves the playhead where it is", () => {
    const { playhead, seen } = store();
    playhead.seek(3_000);
    playhead.setTotal(12_000);
    expect(playhead.get().ms).toBe(3_000);
    expect(seen).toEqual([3_000]);
  });
});

describe("playing", () => {
  test("plays from the playhead on every frame; the rest stays where playback started", () => {
    const { fake, playhead } = store();
    playhead.seek(1_000);
    playhead.toggle();
    expect(playhead.get()).toEqual({ ms: 1_000, playing: true, restMs: 1_000 });
    fake.advance(16);
    expect(playhead.get()).toEqual({ ms: 1_016, playing: true, restMs: 1_000 });
    fake.advance(500);
    expect(playhead.get()).toEqual({ ms: 1_516, playing: true, restMs: 1_000 });
  });

  test("a slow frame does not slow playback: the time is measured, not counted", () => {
    const { fake, playhead } = store();
    playhead.toggle();
    fake.advance(250);
    expect(playhead.get().ms).toBe(250);
  });

  test("a pause lands on the step the clock shows, and rests there", () => {
    const { fake, playhead } = store();
    playhead.toggle();
    fake.advance(1_287);
    playhead.toggle();
    expect(playhead.get()).toEqual({ ms: 1_200, playing: false, restMs: 1_200 });
    // Nothing ticks after a pause.
    fake.advance(100);
    expect(playhead.get().ms).toBe(1_200);
    expect(fake.pending()).toBe(0);
  });

  test("the end stops it on the end itself; the next play starts over from 0", () => {
    const { fake, playhead } = store(2_000);
    playhead.seek(1_500);
    playhead.toggle();
    fake.advance(400);
    expect(playhead.get().playing).toBe(true);
    fake.advance(400);
    expect(playhead.get()).toEqual({ ms: 2_000, playing: false, restMs: 2_000 });
    playhead.toggle();
    expect(playhead.get()).toEqual({ ms: 0, playing: true, restMs: 0 });
  });

  test("a seek while playing stops the playback at the seek", () => {
    const { fake, playhead } = store();
    playhead.toggle();
    fake.advance(700);
    playhead.seek(5_000);
    expect(playhead.get()).toEqual({ ms: 5_000, playing: false, restMs: 5_000 });
    fake.advance(100);
    expect(playhead.get().ms).toBe(5_000);
  });

  test("a change of the montage's length stops a playback (it was timed against the old end), on the clock's step", () => {
    const { fake, playhead } = store();
    playhead.toggle();
    fake.advance(1_234);
    playhead.setTotal(9_000);
    expect(playhead.get()).toEqual({ ms: 1_200, playing: false, restMs: 1_200 });
  });

  test("the same length heard again does not stop it", () => {
    const { fake, playhead } = store();
    playhead.toggle();
    fake.advance(300);
    playhead.setTotal(9_600);
    expect(playhead.get().playing).toBe(true);
  });

  test("a montage of no length does not play", () => {
    const { playhead } = store(0);
    playhead.toggle();
    expect(playhead.get()).toEqual({ ms: 0, playing: false, restMs: 0 });
  });

  test("every frame of a playback is told to the listeners", () => {
    const { fake, playhead, seen } = store();
    playhead.toggle();
    for (let i = 0; i < 5; i++) fake.advance(20);
    expect(seen).toEqual([0, 20, 40, 60, 80, 100]);
  });

  test("an unsubscribed listener hears nothing more", () => {
    const { fake, playhead } = store();
    const heard: number[] = [];
    const stop = playhead.subscribe(() => heard.push(playhead.get().ms));
    playhead.toggle();
    fake.advance(20);
    stop();
    fake.advance(20);
    expect(heard).toEqual([0, 20]);
  });

  test("dispose (the editor closing) stops a playback on the clock's step: no frame is asked for after it", () => {
    const { fake, playhead } = store();
    playhead.toggle();
    fake.advance(120);
    playhead.dispose();
    expect(fake.pending()).toBe(0);
    expect(playhead.get()).toEqual({ ms: 100, playing: false, restMs: 100 });
  });
});
