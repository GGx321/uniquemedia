import { describe, expect, test } from "bun:test";
import { HARD_DRIFT_MS, HAVE_FUTURE_DATA, NUDGE_RATE } from "./audioSync";
import { HALF_FRAME_SEC, HAVE_METADATA, MAX_SEEK_LEAD_SEC, peekTarget, storedFrames, videoCorrection, videoFrameAt, type VideoState, videoTarget } from "./videoSync";
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
    expect(videoTarget(spec, rest(2_000), unknown)).toEqual({ clipId: "clip-002", mediaId: MEDIA, play: false, offsetMs: -200, endSec: 3.8, frame: 54, atSec: 54.5 / 30 });
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
    expect(videoTarget(spec, playing(2_416.5), unknown)).toEqual({ clipId: "clip-002", mediaId: MEDIA, play: true, offsetMs: -200, endSec: 3.8, frame: 54 + 12, atSec: (1_800 + 416.5) / 1000 });
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

  test("every frame's own start reads as that frame, those whose n / 30 × 30 floats below n included (123, 245: the tolerance)", () => {
    expect(Math.floor((123 / 30) * 30)).toBe(122);
    expect(videoFrameAt(123 / 30)).toBe(123);
    expect(videoFrameAt(245 / 30)).toBe(245);
    const wrong: number[] = [];
    // Three minutes of frames, the longest own video.
    for (let n = 0; n < 5_400; n++) if (videoFrameAt(n / 30) !== n || videoFrameAt((n + 0.5) / 30) !== n) wrong.push(n);
    expect(wrong).toEqual([]);
  });
});

describe("videoCorrection: at rest, the exact frame", () => {
  const target = { clipId: "clip-002", mediaId: MEDIA, play: false, frame: 66, offsetMs: -200, endSec: 3.8, atSec: 66.5 / 30 };

  test("a playing element is paused and sought to the frame", () => {
    expect(videoCorrection(target, element({ paused: false, currentTimeSec: 2.31 }))).toEqual({ play: false, seekSec: 66.5 / 30, rate: 1, anchorMs: -200 });
  });

  test("an element already showing that frame is left alone (no seek per frame of a held playhead)", () => {
    expect(videoCorrection(target, element({ currentTimeSec: 66.5 / 30 }))).toEqual({ play: null, seekSec: null, rate: 1, anchorMs: -200 });
    expect(videoCorrection(target, element({ currentTimeSec: 66 / 30 }))).toEqual({ play: null, seekSec: null, rate: 1, anchorMs: -200 });
  });

  test("another frame is sought, even one frame off", () => {
    expect(videoCorrection(target, element({ currentTimeSec: 65.5 / 30 }))).toEqual({ play: null, seekSec: 66.5 / 30, rate: 1, anchorMs: -200 });
    expect(videoCorrection(target, element({ currentTimeSec: 67 / 30 }))).toEqual({ play: null, seekSec: 66.5 / 30, rate: 1, anchorMs: -200 });
  });

  test("never a second seek while one is under way (its end asks again); a playing element is still paused", () => {
    expect(videoCorrection(target, element({ seeking: true, currentTimeSec: 1 }))).toEqual({ play: null, seekSec: null, rate: 1, anchorMs: -200 });
    expect(videoCorrection(target, element({ seeking: true, paused: false, currentTimeSec: 1 }))).toEqual({ play: false, seekSec: null, rate: 1, anchorMs: -200 });
  });

  test("nothing is sought before the element knows the file (its metadata event asks again)", () => {
    expect(videoCorrection(target, element({ readyState: HAVE_METADATA - 1, durationSec: Number.NaN }))).toEqual({ play: null, seekSec: null, rate: 1, anchorMs: -200 });
    expect(videoCorrection(target, element({ readyState: HAVE_METADATA, currentTimeSec: 0 }))).toEqual({ play: null, seekSec: 66.5 / 30, rate: 1, anchorMs: -200 });
  });

  test("a nudged rate is put back at rest", () => {
    expect(videoCorrection(target, element({ currentTimeSec: 66.5 / 30, rate: 1 + NUDGE_RATE }))).toEqual({ play: null, seekSec: null, rate: 1, anchorMs: -200 });
  });
});

describe("videoCorrection: playing, as the music is kept in step", () => {
  const at = 2.2165;
  const target = { clipId: "clip-002", mediaId: MEDIA, play: true, frame: 66, offsetMs: -200, endSec: 3.8, atSec: at };

  test("a paused element is moved to its place and started", () => {
    expect(videoCorrection(target, element({ currentTimeSec: 0 }))).toEqual({ play: true, seekSec: at, rate: 1, anchorMs: -200 });
  });

  test("in step: nothing; a little behind: nudged faster; far off: moved", () => {
    expect(videoCorrection(target, element({ paused: false, currentTimeSec: at + 0.005 }))).toEqual({ play: null, seekSec: null, rate: 1, anchorMs: -200 });
    expect(videoCorrection(target, element({ paused: false, currentTimeSec: at - 0.06 }))).toEqual({ play: null, seekSec: null, rate: 1 + NUDGE_RATE, anchorMs: -200 });
    expect(videoCorrection(target, element({ paused: false, currentTimeSec: at - (HARD_DRIFT_MS + 1) / 1000 }))).toEqual({ play: null, seekSec: at, rate: 1, anchorMs: -200 });
  });

  test("nothing is corrected while it seeks or waits for data", () => {
    expect(videoCorrection(target, element({ paused: false, seeking: true, currentTimeSec: 0 }))).toEqual({ play: null, seekSec: null, rate: 1, anchorMs: -200 });
    expect(videoCorrection(target, element({ paused: false, readyState: HAVE_FUTURE_DATA - 1, currentTimeSec: 0 }))).toEqual({ play: null, seekSec: null, rate: 1, anchorMs: -200 });
  });
});

describe("peekTarget: the frame «Обрезка» drags to (fix round 1, L8)", () => {
  test("that frame of the video, at rest, sought to its middle; the clip and offset the playhead's own when it is on this video", () => {
    const onScreen = videoTarget(spec, playing(2_400), unknown);
    expect(peekTarget(onScreen, MEDIA, 160)).toEqual({ clipId: "clip-002", mediaId: MEDIA, play: false, offsetMs: -200, endSec: 3.8, frame: 160, atSec: 160.5 / 30 });
  });

  test("the playhead elsewhere (a photo on screen): the frame all the same, for this video", () => {
    expect(peekTarget(null, MEDIA, 12)).toEqual({ clipId: "", mediaId: MEDIA, play: false, offsetMs: 0, endSec: Number.POSITIVE_INFINITY, frame: 12, atSec: 12.5 / 30 });
  });
});

describe("videoCorrection: a jump in the video's own time while playing (fix round 1, M2)", () => {
  // The render shows a jump cut where the video's time jumps; rate catch-up (right for audio) would slide into it over seconds instead.
  const frames = (): number => 420;

  test("an A → B join where B starts 0.2 s later in the video: moved there at the cut, not nudged", () => {
    const spec = draftSpec([videoClip(0, 2_000, 0), videoClip(1, 2_000, 2_200)]);
    const a = videoTarget(spec, playing(1_990), frames);
    const b = videoTarget(spec, playing(2_000), frames);
    if (a === null || b === null) throw new Error("no target");
    expect([a.offsetMs, b.offsetMs]).toEqual([0, 200]);
    // The element played A on and is at 2.0 s in the video; B wants 2.2 s.
    expect(videoCorrection(b, element({ paused: false, currentTimeSec: 2.0 }), a.offsetMs)).toEqual({ play: null, seekSec: b.atSec, rate: 1, anchorMs: 200 });
  });

  test("a trim moved during playback (the window slid 0.1 s) is a jump too", () => {
    const before = videoTarget(draftSpec([videoClip(0, 4_000, 1_000)]), playing(1_000), frames);
    const after = videoTarget(draftSpec([videoClip(0, 4_000, 1_100)]), playing(1_000), frames);
    if (before === null || after === null) throw new Error("no target");
    expect([before.offsetMs, after.offsetMs]).toEqual([1_000, 1_100]);
    expect(videoCorrection(after, element({ paused: false, currentTimeSec: before.atSec }), before.offsetMs)).toEqual({ play: null, seekSec: after.atSec, rate: 1, anchorMs: 1_100 });
  });

  test("the two parts of a plain split continue the video: no jump, so no seek at the cut (a little drift stays the nudge's)", () => {
    const spec = draftSpec([videoClip(0, 2_000, 0), videoClip(1, 2_000, 2_000)]);
    const a = videoTarget(spec, playing(1_990), frames);
    const b = videoTarget(spec, playing(2_000), frames);
    if (a === null || b === null) throw new Error("no target");
    expect(b.offsetMs).toBe(a.offsetMs);
    expect(videoCorrection(b, element({ paused: false, currentTimeSec: 2.0 - 0.03 }), a.offsetMs)).toEqual({ play: null, seekSec: null, rate: 1, anchorMs: 0 });
  });

  test("a jump the element already sits on (within half a frame) moves nothing", () => {
    const b = { clipId: "clip-002", mediaId: MEDIA, play: true, frame: 66, offsetMs: 200, endSec: 4.2, atSec: 2.2 };
    expect(videoCorrection(b, element({ paused: false, currentTimeSec: 2.2 + 0.01 }), 0)).toEqual({ play: null, seekSec: null, rate: 1, anchorMs: 200 });
  });

  test("a jump while a seek is under way waits for it, keeping the old anchor so the jump is seen again", () => {
    const b = { clipId: "clip-002", mediaId: MEDIA, play: true, frame: 66, offsetMs: 200, endSec: 4.2, atSec: 2.2 };
    expect(videoCorrection(b, element({ paused: false, seeking: true, currentTimeSec: 2.0 }), 0)).toEqual({ play: null, seekSec: null, rate: 1, anchorMs: 0 });
  });

  test("a slow decoder: a seek while playing is led by how long the last one took, so it lands where the clock will be, not behind it", () => {
    const b = { clipId: "clip-002", mediaId: MEDIA, play: true, frame: 66, offsetMs: 200, endSec: 4.2, atSec: 2.2 };
    // Probed in Chrome at 6× CPU throttling: a seek took 340 ms, and the element landed that far behind the clock and was sought again.
    expect(videoCorrection(b, element({ paused: false, currentTimeSec: 2.0 }), 0, 0.34)).toMatchObject({ seekSec: 2.2 + 0.34 });
    expect(videoCorrection(b, element({ paused: false, currentTimeSec: 1.0 }), 200, 0.34)).toMatchObject({ seekSec: 2.2 + 0.34 });
    expect(videoCorrection(b, element({ currentTimeSec: 0 }), null, 0.34)).toEqual({ play: true, seekSec: 2.2 + 0.34, rate: 1, anchorMs: 200 });
    // Never more than a second, never into the file's last half frame (fix round 2: its very end is `ended`, and a play() there rewinds to 0).
    expect(videoCorrection(b, element({ paused: false, currentTimeSec: 2.0 }), 0, 5)).toMatchObject({ seekSec: 2.2 + MAX_SEEK_LEAD_SEC });
    expect(videoCorrection(b, element({ paused: false, currentTimeSec: 2.0, durationSec: 2.4 }), 0, 0.34)).toMatchObject({ seekSec: 2.4 - HALF_FRAME_SEC });
    // At rest the frame is exact: no lead.
    const rest = { ...b, play: false, atSec: 66.5 / 30 };
    expect(videoCorrection(rest, element({ currentTimeSec: 0 }), 200, 0.34)).toMatchObject({ seekSec: 66.5 / 30 });
    // Nudges are not seeks: untouched.
    expect(videoCorrection(b, element({ paused: false, currentTimeSec: 2.2 - 0.06 }), 200, 0.34)).toEqual({ play: null, seekSec: null, rate: 1 + NUDGE_RATE, anchorMs: 200 });
  });

  test("fix round 2: the lead never carries the seek past the clip's own end in the video, nor to the file's very end", () => {
    const frames420 = (): number => 420;
    // A 0.5 s clip of 5.0–5.5 s entered with a 0.8 s lead: held inside it, half a frame short of its end.
    const short = draftSpec([videoClip(0, 2_000, 0), videoClip(1, 500, 5_000), videoClip(2, 2_000, 9_000)]);
    const a = videoTarget(short, playing(1_990), frames420);
    const b = videoTarget(short, playing(2_000), frames420);
    if (a === null || b === null) throw new Error("no target");
    expect(b.endSec).toBe(5.5);
    const intoShort = videoCorrection(b, element({ paused: false, currentTimeSec: 2.0 }), a.offsetMs, 0.8).seekSec ?? 0;
    expect(intoShort).toBe(5.5 - HALF_FRAME_SEC);
    expect(intoShort).toBeLessThan(5.5);
    // A clip ending at the file's end (14 s) entered with a 0.7 s lead: never 14 itself, where the element ends and a play() starts it over at 0.
    const tail = draftSpec([videoClip(0, 2_000, 0), videoClip(1, 500, 13_500)]);
    const ta = videoTarget(tail, playing(1_990), frames420);
    const tb = videoTarget(tail, playing(2_000), frames420);
    if (ta === null || tb === null) throw new Error("no target");
    const intoTail = videoCorrection(tb, element({ paused: false, currentTimeSec: 2.0 }), ta.offsetMs, 0.7).seekSec ?? 14;
    expect(intoTail).toBeLessThan(14);
    expect(intoTail).toBe(14 - HALF_FRAME_SEC);
    // Already inside the last half frame: the time itself, never pulled back behind it.
    const late = { ...tb, atSec: 13.99 };
    expect(videoCorrection(late, element({ paused: false, currentTimeSec: 12.0 }), tb.offsetMs, 0.7).seekSec).toBe(13.99);
  });

  test("fix round 2: once a led seek has landed, one settling seek puts an element the lead overshot back on the clock; never a second", () => {
    const b = { clipId: "clip-002", mediaId: MEDIA, play: true, frame: 66, offsetMs: 200, endSec: 4.2, atSec: 2.2 };
    // A 340 ms lead, but the seek took 40 ms: the element is 0.2 s ahead. Settling: moved to the clock plus the new, short lead.
    expect(videoCorrection(b, element({ paused: false, currentTimeSec: 2.4 }), 200, 0.04, true)).toEqual({ play: null, seekSec: 2.2 + 0.04, rate: 1, anchorMs: 200 });
    // Not settling: the same 0.2 s is the nudge's (as before).
    expect(videoCorrection(b, element({ paused: false, currentTimeSec: 2.4 }), 200, 0.04, false)).toEqual({ play: null, seekSec: null, rate: 1 - NUDGE_RATE, anchorMs: 200 });
    // Landed in step (within the nudge's own threshold): nothing to settle.
    expect(videoCorrection(b, element({ paused: false, currentTimeSec: 2.2 + 0.02 }), 200, 0.04, true)).toEqual({ play: null, seekSec: null, rate: 1, anchorMs: 200 });
    // Still seeking: nothing yet.
    expect(videoCorrection(b, element({ paused: false, seeking: true, currentTimeSec: 2.4 }), 200, 0.04, true)).toEqual({ play: null, seekSec: null, rate: 1, anchorMs: 200 });
    // At rest the frame is exact anyway.
    expect(videoCorrection({ ...b, play: false, atSec: 66.5 / 30 }, element({ currentTimeSec: 66.5 / 30 }), 200, 0.04, true)).toMatchObject({ seekSec: null });
  });

  test("no anchor yet (the element's first sync) is no jump", () => {
    const b = { clipId: "clip-002", mediaId: MEDIA, play: true, frame: 66, offsetMs: 200, endSec: 4.2, atSec: 2.2 };
    expect(videoCorrection(b, element({ paused: false, currentTimeSec: 2.0 }), null)).toEqual({ play: null, seekSec: null, rate: 1 + NUDGE_RATE, anchorMs: 200 });
  });
});
