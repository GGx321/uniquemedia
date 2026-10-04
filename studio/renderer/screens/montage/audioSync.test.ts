import { describe, expect, test } from "bun:test";
import { audioCorrection, audioTarget, HARD_DRIFT_MS, NUDGE_RATE, SOFT_DRIFT_MS } from "./audioSync";

// 3d.4: the montage's music plays in the preview from an `<audio>` element kept in step with the playhead clock, the master (the
// picture is drawn from it). The track plays from `music.startMs` (3c.5: the render cuts the track there, for exactly the
// montage's length). The element drifts against the clock and starts late, so on each frame the window compares where it is with
// where the clock says it should be: a little off, it is nudged by its playback rate; far off, it is moved there.

const MUSIC = { startMs: 42_000 };
const playingAt = (ms: number) => ({ ms, playing: true });

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
    expect(audioCorrection(target, { currentTimeSec: 0, paused: true, durationSec: 180 })).toEqual({ seekSec: 43.5, rate: 1, play: true });
  });

  test("within a frame of the clock it is left alone, at normal speed", () => {
    const off = SOFT_DRIFT_MS / 1000 - 0.001;
    expect(audioCorrection(target, { currentTimeSec: 43.5 + off, paused: false, durationSec: 180 })).toEqual({ seekSec: null, rate: 1, play: null });
    expect(audioCorrection(target, { currentTimeSec: 43.5 - off, paused: false, durationSec: 180 })).toEqual({ seekSec: null, rate: 1, play: null });
  });

  test("a little ahead it slows down, a little behind it speeds up, so it meets the clock without a jump", () => {
    expect(audioCorrection(target, { currentTimeSec: 43.6, paused: false, durationSec: 180 })).toEqual({ seekSec: null, rate: 1 - NUDGE_RATE, play: null });
    expect(audioCorrection(target, { currentTimeSec: 43.4, paused: false, durationSec: 180 })).toEqual({ seekSec: null, rate: 1 + NUDGE_RATE, play: null });
  });

  test("far off (a slow start, a hidden window) it is moved to its place", () => {
    const far = HARD_DRIFT_MS / 1000 + 0.001;
    expect(audioCorrection(target, { currentTimeSec: 43.5 + far, paused: false, durationSec: 180 })).toEqual({ seekSec: 43.5, rate: 1, play: null });
    expect(audioCorrection(target, { currentTimeSec: 43.5 - far, paused: false, durationSec: 180 })).toEqual({ seekSec: 43.5, rate: 1, play: null });
  });

  test("the playhead stopped: a playing element is paused, a paused one left as it is", () => {
    expect(audioCorrection({ play: false, atSec: 43.5 }, { currentTimeSec: 43.5, paused: false, durationSec: 180 })).toEqual({ seekSec: null, rate: 1, play: false });
    expect(audioCorrection({ play: false, atSec: 43.5 }, { currentTimeSec: 10, paused: true, durationSec: 180 })).toEqual({ seekSec: null, rate: 1, play: null });
  });

  test("no music: a playing element is paused", () => {
    expect(audioCorrection({ play: false, atSec: null }, { currentTimeSec: 5, paused: false, durationSec: 180 })).toEqual({ seekSec: null, rate: 1, play: false });
  });

  test("past the file's own end there is nothing to play (the engine refuses such a render; the preview stays silent)", () => {
    expect(audioCorrection({ play: true, atSec: 181 }, { currentTimeSec: 180, paused: true, durationSec: 180 })).toEqual({ seekSec: null, rate: 1, play: null });
    expect(audioCorrection({ play: true, atSec: 181 }, { currentTimeSec: 179, paused: false, durationSec: 180 })).toEqual({ seekSec: null, rate: 1, play: false });
  });

  test("before the element knows its length it is still started", () => {
    expect(audioCorrection(target, { currentTimeSec: 0, paused: true, durationSec: Number.NaN })).toEqual({ seekSec: 43.5, rate: 1, play: true });
  });
});
