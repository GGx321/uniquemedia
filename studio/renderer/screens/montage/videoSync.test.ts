import { describe, expect, test } from "bun:test";
import { HARD_DRIFT_MS, HAVE_FUTURE_DATA, NUDGE_RATE } from "./audioSync";
import { HAVE_METADATA, storedFrames, videoCorrection, videoFrameAt, type VideoState, videoTarget } from "./videoSync";
import { draftSpec, photoClip, videoClip } from "./testkit";

// 3f.3b: an own video clip in the preview. The `<video>` element of the clip's mezzanine follows the playhead clock, which is the master (3d.4):
// - at rest (paused, scrubbed, seeked) it is paused and shows EXACTLY the stored frame the render cuts for the playhead's frame: `trimStartMs` + the
//   frame's place in the clip, sought to the middle of that frame so no rounding shows its neighbour, and never sought again while it is getting there;
// - while the montage plays it plays too, from the same place, corrected as the music is (audioSync.ts: nudged with hysteresis, moved when far off,
//   nothing while a seek is under way or data is short).

const MEDIA = "media-own-0001";
/** 2 s of a photo, then 2 s of the own video from 1.8 s into it, then 1 s of a photo. */
const spec = draftSpec([photoClip(0, "photo-mia-0001", 2_000), videoClip(1, 2_000, 1_800), photoClip(2, "photo-mia-0002", 1_000)]);
const rest = (ms: number) => ({ ms, playing: false });
const playing = (ms: number) => ({ ms, playing: true });
const unknown = (): number | null => null;

/** An element that has its data, paused at `currentTimeSec`. */
const element = (over: Partial<VideoState> = {}): VideoState => ({ currentTimeSec: 0, paused: true, durationSec: 14, seeking: false, readyState: 4, rate: 1, ...over });

describe("videoTarget: which stored frame the playhead asks for", () => {
  test("no video clip under the playhead (a photo, an empty draft): nothing to show", () => {
    expect(videoTarget(spec, rest(0), unknown)).toBeNull();
    expect(videoTarget(spec, rest(4_500), unknown)).toBeNull();
    expect(videoTarget(draftSpec([]), rest(0), unknown)).toBeNull();
  });

  test("at rest on the clip's first frame: the trim's frame, sought to its middle", () => {
    // 1.8 s into the video is frame 54; the middle of it is 54.5 / 30 s.
    expect(videoTarget(spec, rest(2_000), unknown)).toEqual({ clipId: "clip-002", mediaId: MEDIA, play: false, frame: 54, atSec: 54.5 / 30 });
  });

  test("at rest inside the clip: the trim plus the frame's place in the clip, frame-exact", () => {
    // 2.4 s on the timeline is frame 72, the clip's frame 12: the video's frame 54 + 12.
    expect(videoTarget(spec, rest(2_400), unknown)).toMatchObject({ frame: 66, atSec: 66.5 / 30, play: false });
    // A time between frames (a scrub lands anywhere) shows the frame it is in, as the preview's stage does.
    expect(videoTarget(spec, rest(2_449), unknown)).toMatchObject({ frame: 67 });
  });

  test("at the montage's end on a video clip: its last frame, as the stage shows the last frame", () => {
    const last = draftSpec([photoClip(0, "photo-mia-0001", 2_000), videoClip(1, 2_000, 1_800)]);
    // The clip's 60 frames from 54: the last is 113.
    expect(videoTarget(last, rest(4_000), unknown)).toMatchObject({ frame: 113, play: false });
  });

  test("while playing: the continuous time in the video, and it plays", () => {
    expect(videoTarget(spec, playing(2_416.5), unknown)).toEqual({ clipId: "clip-002", mediaId: MEDIA, play: true, frame: 54 + 12, atSec: (1_800 + 416.5) / 1000 });
  });

  test("a playback stopped by the end does not play", () => {
    const last = draftSpec([photoClip(0, "photo-mia-0001", 2_000), videoClip(1, 2_000, 1_800)]);
    expect(videoTarget(last, playing(4_000), unknown)).toMatchObject({ play: false, frame: 113, atSec: 113.5 / 30 });
  });

  test("a clip that asks past the stored video's end (video-too-short) shows the video's last frame, never a time it does not have", () => {
    // The video is 2.5 s (75 frames): the clip wants frames 54 to 113.
    const frames = (mediaId: string): number | null => (mediaId === MEDIA ? 75 : null);
    expect(videoTarget(spec, rest(3_900), frames)).toMatchObject({ frame: 74, atSec: 74.5 / 30 });
    expect(videoTarget(spec, rest(2_000), frames)).toMatchObject({ frame: 54 });
  });

  test("two parts of a split video name their own clip and continue the same video", () => {
    const split = draftSpec([videoClip(0, 1_000, 0), { ...videoClip(1, 1_000, 1_000) }]);
    expect(videoTarget(split, rest(999), unknown)).toMatchObject({ clipId: "clip-001", frame: 29 });
    expect(videoTarget(split, rest(1_000), unknown)).toMatchObject({ clipId: "clip-002", frame: 30 });
  });
});

describe("storedFrames and videoFrameAt", () => {
  test("a stored video's frames from its record's length (the mezzanine is a constant 30 fps: round(frames × 1000 / 30))", () => {
    expect(storedFrames(14_000)).toBe(420);
    expect(storedFrames(6_433)).toBe(193);
    expect(storedFrames(33)).toBe(1);
  });

  test("the frame a time is in, steady at a frame's own start whatever the float says", () => {
    expect(videoFrameAt(0)).toBe(0);
    expect(videoFrameAt(61 / 30)).toBe(61);
    expect(videoFrameAt(61.5 / 30)).toBe(61);
    expect(videoFrameAt(61.999 / 30)).toBe(61);
    expect(videoFrameAt(2.0333333333333332)).toBe(61);
  });
});

describe("videoCorrection: at rest, the exact frame", () => {
  const target = { clipId: "clip-002", mediaId: MEDIA, play: false, frame: 66, atSec: 66.5 / 30 };

  test("a playing element is paused and sought to the frame", () => {
    expect(videoCorrection(target, element({ paused: false, currentTimeSec: 2.31 }))).toEqual({ play: false, seekSec: 66.5 / 30, rate: 1 });
  });

  test("an element already showing that frame is left alone (no seek per frame of a held playhead)", () => {
    expect(videoCorrection(target, element({ currentTimeSec: 66.5 / 30 }))).toEqual({ play: null, seekSec: null, rate: 1 });
    expect(videoCorrection(target, element({ currentTimeSec: 66 / 30 }))).toEqual({ play: null, seekSec: null, rate: 1 });
  });

  test("another frame is sought, even one frame off", () => {
    expect(videoCorrection(target, element({ currentTimeSec: 65.5 / 30 }))).toEqual({ play: null, seekSec: 66.5 / 30, rate: 1 });
    expect(videoCorrection(target, element({ currentTimeSec: 67 / 30 }))).toEqual({ play: null, seekSec: 66.5 / 30, rate: 1 });
  });

  test("never a second seek while one is under way (its end asks again); a playing element is still paused", () => {
    expect(videoCorrection(target, element({ seeking: true, currentTimeSec: 1 }))).toEqual({ play: null, seekSec: null, rate: 1 });
    expect(videoCorrection(target, element({ seeking: true, paused: false, currentTimeSec: 1 }))).toEqual({ play: false, seekSec: null, rate: 1 });
  });

  test("nothing is sought before the element knows the file (its metadata event asks again)", () => {
    expect(videoCorrection(target, element({ readyState: HAVE_METADATA - 1, durationSec: Number.NaN }))).toEqual({ play: null, seekSec: null, rate: 1 });
    expect(videoCorrection(target, element({ readyState: HAVE_METADATA, currentTimeSec: 0 }))).toEqual({ play: null, seekSec: 66.5 / 30, rate: 1 });
  });

  test("a nudged rate is put back at rest", () => {
    expect(videoCorrection(target, element({ currentTimeSec: 66.5 / 30, rate: 1 + NUDGE_RATE }))).toEqual({ play: null, seekSec: null, rate: 1 });
  });
});

describe("videoCorrection: playing, as the music is kept in step", () => {
  const at = 2.2165;
  const target = { clipId: "clip-002", mediaId: MEDIA, play: true, frame: 66, atSec: at };

  test("a paused element is moved to its place and started", () => {
    expect(videoCorrection(target, element({ currentTimeSec: 0 }))).toEqual({ play: true, seekSec: at, rate: 1 });
  });

  test("in step: nothing; a little behind: nudged faster; far off: moved", () => {
    expect(videoCorrection(target, element({ paused: false, currentTimeSec: at + 0.005 }))).toEqual({ play: null, seekSec: null, rate: 1 });
    expect(videoCorrection(target, element({ paused: false, currentTimeSec: at - 0.06 }))).toEqual({ play: null, seekSec: null, rate: 1 + NUDGE_RATE });
    expect(videoCorrection(target, element({ paused: false, currentTimeSec: at - (HARD_DRIFT_MS + 1) / 1000 }))).toEqual({ play: null, seekSec: at, rate: 1 });
  });

  test("nothing is corrected while it seeks or waits for data", () => {
    expect(videoCorrection(target, element({ paused: false, seeking: true, currentTimeSec: 0 }))).toEqual({ play: null, seekSec: null, rate: 1 });
    expect(videoCorrection(target, element({ paused: false, readyState: HAVE_FUTURE_DATA - 1, currentTimeSec: 0 }))).toEqual({ play: null, seekSec: null, rate: 1 });
  });
});
