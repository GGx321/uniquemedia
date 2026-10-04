import { describe, expect, test } from "bun:test";
import { type AudioState, audioCorrection, audioTarget, HARD_DRIFT_MS, HAVE_FUTURE_DATA, NUDGE_OFF_MS, NUDGE_ON_MS, NUDGE_RATE } from "./audioSync";

// 3d.4: the montage's music plays in the preview from an `<audio>` element kept in step with the playhead clock, the master (the
// picture is drawn from it). The track plays from `music.startMs` (3c.5: the render cuts the track there, for exactly the
// montage's length). The element drifts against the clock and starts late, so on each frame the window compares where it is with
// where the clock says it should be: a little off, it is nudged by its playback rate until it is close again (on past 40 ms, off
// under 10 ms); far off, it is moved there. Review round 1: nothing is corrected while a seek is under way or while the element
// has too little data to play (a cold file on a slow disk), or a slow start would seek again on every frame.

const MUSIC = { startMs: 42_000 };
const playingAt = (ms: number) => ({ ms, playing: true });
/** An element playing smoothly at `currentTimeSec`, with data to play on. */
const at = (currentTimeSec: number, over: Partial<AudioState> = {}): AudioState => ({ currentTimeSec, paused: false, durationSec: 180, seeking: false, readyState: 4, rate: 1, ...over });

describe("where the music should be", () => {
  test("the track's start plus the playhead, playing while the montage plays", () => {
    expect(audioTarget(playingAt(1_500), MUSIC, 9_600)).toEqual({ play: true, atSec: 43.5 });
  });

  test("stopped with the playhead, but at its place", () => {
    expect(audioTarget({ ms: 1_500, playing: false }, MUSIC, 9_600)).toEqual({ play: false, atSec: 43.5 });
  });

  test("silent at the montage's end (the render cuts the track there)", () => {
    expect(audioTarget(playingAt(9_600), MUSIC, 9_600)).toEqual({ play: false, atSec: 51.6 });
  });

  test("no music: nothing to play", () => {
    expect(audioTarget(playingAt(1_500), null, 9_600)).toEqual({ play: false, atSec: null });
  });
});

describe("keeping the element in step", () => {
  const target = { play: true, atSec: 43.5 };

  test("a paused element is moved to its place and started", () => {
    expect(audioCorrection(target, at(0, { paused: true }))).toEqual({ seekSec: 43.5, rate: 1, play: true });
  });

  test("a paused element already seeking is only started (its seek is not repeated)", () => {
    expect(audioCorrection(target, at(43.5, { paused: true, seeking: true }))).toEqual({ seekSec: null, rate: 1, play: true });
  });

  test("while a seek is under way nothing is corrected, however far off it reads", () => {
    expect(audioCorrection(target, at(10, { seeking: true }))).toEqual({ seekSec: null, rate: 1, play: null });
    expect(audioCorrection(target, at(43.6, { seeking: true, rate: 1 + NUDGE_RATE }))).toEqual({ seekSec: null, rate: 1 + NUDGE_RATE, play: null });
  });

  test("with too little data to play on (a slow start), nothing is corrected: no seek on every frame", () => {
    expect(audioCorrection(target, at(10, { readyState: HAVE_FUTURE_DATA - 1 }))).toEqual({ seekSec: null, rate: 1, play: null });
    expect(audioCorrection(target, at(10, { readyState: HAVE_FUTURE_DATA }))).toEqual({ seekSec: 43.5, rate: 1, play: null });
  });

  test("within a frame of the clock it is left alone, at normal speed", () => {
    const off = NUDGE_ON_MS / 1000 - 0.001;
    expect(audioCorrection(target, at(43.5 + off))).toEqual({ seekSec: null, rate: 1, play: null });
    expect(audioCorrection(target, at(43.5 - off))).toEqual({ seekSec: null, rate: 1, play: null });
  });

  test("a little ahead it slows down, a little behind it speeds up, so it meets the clock without a jump", () => {
    expect(audioCorrection(target, at(43.6))).toEqual({ seekSec: null, rate: 1 - NUDGE_RATE, play: null });
    expect(audioCorrection(target, at(43.4))).toEqual({ seekSec: null, rate: 1 + NUDGE_RATE, play: null });
  });

  test("a nudge goes on past 40 ms and stays on until the drift is under 10 ms (hysteresis), then normal speed again", () => {
    expect(NUDGE_ON_MS).toBe(40);
    expect(NUDGE_OFF_MS).toBe(10);
    // 20 ms behind: not nudging yet, it is left alone; already nudging, it keeps catching up.
    expect(audioCorrection(target, at(43.48))).toEqual({ seekSec: null, rate: 1, play: null });
    expect(audioCorrection(target, at(43.48, { rate: 1 + NUDGE_RATE }))).toEqual({ seekSec: null, rate: 1 + NUDGE_RATE, play: null });
    expect(audioCorrection(target, at(43.495, { rate: 1 + NUDGE_RATE }))).toEqual({ seekSec: null, rate: 1, play: null });
  });

  test("far off (a slow start, a hidden window) it is moved to its place", () => {
    const far = HARD_DRIFT_MS / 1000 + 0.001;
    expect(audioCorrection(target, at(43.5 + far))).toEqual({ seekSec: 43.5, rate: 1, play: null });
    expect(audioCorrection(target, at(43.5 - far, { rate: 1 + NUDGE_RATE }))).toEqual({ seekSec: 43.5, rate: 1, play: null });
  });

  test("the playhead stopped: a playing element is paused, a paused one left as it is", () => {
    expect(audioCorrection({ play: false, atSec: 43.5 }, at(43.5))).toEqual({ seekSec: null, rate: 1, play: false });
    expect(audioCorrection({ play: false, atSec: 43.5 }, at(10, { paused: true }))).toEqual({ seekSec: null, rate: 1, play: null });
  });

  test("no music: a playing element is paused", () => {
    expect(audioCorrection({ play: false, atSec: null }, at(5))).toEqual({ seekSec: null, rate: 1, play: false });
  });

  test("past the file's own end there is nothing to play (the engine refuses such a render; the preview stays silent)", () => {
    expect(audioCorrection({ play: true, atSec: 181 }, at(180, { paused: true }))).toEqual({ seekSec: null, rate: 1, play: null });
    expect(audioCorrection({ play: true, atSec: 181 }, at(179))).toEqual({ seekSec: null, rate: 1, play: false });
  });

  test("before the element knows its length it is still started", () => {
    expect(audioCorrection(target, at(0, { paused: true, durationSec: Number.NaN, readyState: 0 }))).toEqual({ seekSec: 43.5, rate: 1, play: true });
  });
});
