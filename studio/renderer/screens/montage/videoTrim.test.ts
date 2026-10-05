import { describe, expect, test } from "bun:test";
import { MAX_SOURCE_OFFSET_MS } from "../../../shared/engine";
import { durationLimitMs, growMs, slideTrim, sourceEndMs, trimEndTo, trimLimits, trimStartTo, trimView } from "./videoTrim";
import { draftSpec, photoClip, photoClips, videoClip } from "./testkit";

// 3f.3b: «Обрезка», the own video clip's trim (EditorMine.dc.html, R16): which part of the stored video the clip plays. Pure, on the contract's grid:
// `trimStartMs` and the clip's length are whole 100 ms steps (the engine refuses anything else), the clip is at least 0.1 s, the montage at most 15 s,
// and the clip never reaches past the stored video's end (`video-too-short`). The window slides (the length kept), its left edge moves the start (the
// end kept, as dragging a film's head does) and its right edge the end (the start kept).

/** The EditorMine artboard's montage: 2.4 + 3.2 s of photos, the video clip 1.8 → 3.8 s of a 6.4 s file, 2.0 s of a photo: 9.6 s, 5.4 s of room. */
const artboard = draftSpec([photoClip(0, "photo-mia-0001", 2_400), photoClip(1, "photo-mia-0002", 3_200), videoClip(2, 2_000, 1_800), photoClip(3, "photo-mia-0003", 2_000)]);
const SOURCE = 6_400;
const clip = (spec: ReturnType<typeof draftSpec>, index: number) => {
  const found = spec.clips[index];
  if (found?.kind !== "video") throw new Error(`clip ${index} is not a video`);
  return found;
};

describe("sourceEndMs: how far into a stored video a clip may reach", () => {
  test("the video's length down to the 100 ms grid (a start and a length on the grid can only end on it)", () => {
    expect(sourceEndMs(6_400)).toBe(6_400);
    expect(sourceEndMs(6_433)).toBe(6_400);
    expect(sourceEndMs(499)).toBe(400);
    expect(sourceEndMs(33)).toBe(0);
  });
});

describe("trimView: the strip", () => {
  test("the clip's part of the video as fractions of it, and the times", () => {
    expect(trimView(clip(artboard, 2), SOURCE)).toEqual({ startMs: 1_800, endMs: 3_800, sourceMs: 6_400, from: 1_800 / 6_400, width: 2_000 / 6_400 });
  });

  test("a clip past the video's end is drawn up to the end, never beyond the strip", () => {
    const view = trimView(clip(draftSpec([videoClip(0, 3_000, 5_000)]), 0), SOURCE);
    expect(view.from).toBe(5_000 / 6_400);
    expect(view.width).toBe(1_400 / 6_400);
    expect(view.endMs).toBe(8_000);
  });
});

describe("trimLimits", () => {
  test("the artboard's clip: slide 0–4.4 s, the start 0–3.7 s (its end kept), the end 1.9–6.4 s (its start kept)", () => {
    expect(trimLimits(artboard, 2, SOURCE)).toEqual({ slide: { min: 0, max: 4_400 }, start: { min: 0, max: 3_700 }, end: { min: 1_900, max: 6_400 } });
  });

  test("the 15 s cap holds the edges: a clip may grow only by the montage's room", () => {
    // 13 s of photos and a 1 s clip 5 s into a 14 s video: 1 s of room.
    const tight = draftSpec([...photoClips(13, 1_000), videoClip(13, 1_000, 5_000)]);
    expect(trimLimits(tight, 13, 14_000)).toEqual({ slide: { min: 0, max: 13_000 }, start: { min: 4_000, max: 5_900 }, end: { min: 5_100, max: 7_000 } });
  });

  test("a clip already longer than the video can only slide to its start", () => {
    expect(trimLimits(draftSpec([videoClip(0, 8_000, 1_000)]), 0, SOURCE).slide).toEqual({ min: 0, max: 0 });
  });

  test("never a start past the contract's furthest offset", () => {
    const deep = draftSpec([videoClip(0, 2_000, 0)]);
    expect(trimLimits(deep, 0, 700_000).slide.max).toBe(MAX_SOURCE_OFFSET_MS);
  });

  test("a clip that is not a video, or a clip that is not there, is a programming error", () => {
    expect(() => trimLimits(artboard, 0, SOURCE)).toThrow(RangeError);
    expect(() => trimLimits(artboard, 9, SOURCE)).toThrow(RangeError);
  });
});

describe("slideTrim: the window moves, its length kept", () => {
  test("to the nearest 100 ms, held inside the video", () => {
    expect(clip(slideTrim(artboard, 2, 2_449, SOURCE), 2)).toMatchObject({ trimStartMs: 2_400, durationMs: 2_000 });
    expect(clip(slideTrim(artboard, 2, 2_450, SOURCE), 2).trimStartMs).toBe(2_500);
    expect(clip(slideTrim(artboard, 2, -300, SOURCE), 2).trimStartMs).toBe(0);
    expect(clip(slideTrim(artboard, 2, 9_000, SOURCE), 2).trimStartMs).toBe(4_400);
  });

  test("only the clip's trim changes; the same draft when it does not", () => {
    const next = slideTrim(artboard, 2, 2_000, SOURCE);
    expect(next.clips.filter((_, i) => i !== 2)).toEqual(artboard.clips.filter((_, i) => i !== 2));
    expect(next.clips[0]).toBe(artboard.clips[0]);
    expect(slideTrim(artboard, 2, 1_830, SOURCE)).toBe(artboard);
  });
});

describe("trimStartTo: the left edge, the clip's end in the video kept", () => {
  test("earlier makes the clip longer, later shorter; on the grid", () => {
    expect(clip(trimStartTo(artboard, 2, 1_000, SOURCE), 2)).toMatchObject({ trimStartMs: 1_000, durationMs: 2_800 });
    expect(clip(trimStartTo(artboard, 2, 2_740, SOURCE), 2)).toMatchObject({ trimStartMs: 2_700, durationMs: 1_100 });
  });

  test("never under 0.1 s, never before the video's start, never past 15 s in all", () => {
    expect(clip(trimStartTo(artboard, 2, 3_700, SOURCE), 2)).toMatchObject({ trimStartMs: 3_700, durationMs: 100 });
    expect(clip(trimStartTo(artboard, 2, 3_900, SOURCE), 2)).toMatchObject({ trimStartMs: 3_700, durationMs: 100 });
    expect(clip(trimStartTo(artboard, 2, -1_000, SOURCE), 2)).toMatchObject({ trimStartMs: 0, durationMs: 3_800 });
    const tight = draftSpec([...photoClips(13, 1_000), videoClip(13, 1_000, 5_000)]);
    expect(clip(trimStartTo(tight, 13, 0, 14_000), 13)).toMatchObject({ trimStartMs: 4_000, durationMs: 2_000 });
  });

  test("the same draft when nothing moves", () => {
    expect(trimStartTo(artboard, 2, 1_810, SOURCE)).toBe(artboard);
  });
});

describe("trimEndTo: the right edge, the clip's start kept", () => {
  test("later makes the clip longer, earlier shorter; on the grid", () => {
    expect(clip(trimEndTo(artboard, 2, 4_960, SOURCE), 2)).toMatchObject({ trimStartMs: 1_800, durationMs: 3_200 });
    expect(clip(trimEndTo(artboard, 2, 2_600, SOURCE), 2)).toMatchObject({ trimStartMs: 1_800, durationMs: 800 });
  });

  test("never under 0.1 s, never past the video's end, never past 15 s in all", () => {
    expect(clip(trimEndTo(artboard, 2, 1_900, SOURCE), 2).durationMs).toBe(100);
    expect(clip(trimEndTo(artboard, 2, 1_000, SOURCE), 2).durationMs).toBe(100);
    expect(clip(trimEndTo(artboard, 2, 9_000, SOURCE), 2).durationMs).toBe(4_600);
    // A file of 6.43 s: the clip ends by 6.4 s, the last whole step inside it.
    expect(clip(trimEndTo(artboard, 2, 9_000, 6_433), 2).durationMs).toBe(4_600);
    const tight = draftSpec([...photoClips(13, 1_000), videoClip(13, 1_000, 5_000)]);
    expect(clip(trimEndTo(tight, 13, 14_000, 14_000), 13).durationMs).toBe(2_000);
  });

  test("the same draft when nothing moves", () => {
    expect(trimEndTo(artboard, 2, 3_840, SOURCE)).toBe(artboard);
  });
});

describe("how long the clip may get", () => {
  test("durationLimitMs: from its trim to the video's end on the grid, never under 0.1 s (the timeline's handles)", () => {
    expect(durationLimitMs(clip(artboard, 2), SOURCE)).toBe(4_600);
    expect(durationLimitMs(clip(artboard, 2), 6_433)).toBe(4_600);
    expect(durationLimitMs(clip(draftSpec([videoClip(0, 2_000, 6_200)]), 0), SOURCE)).toBe(200);
    expect(durationLimitMs(clip(draftSpec([videoClip(0, 2_000, 6_300)]), 0), SOURCE)).toBe(100);
    expect(durationLimitMs(clip(draftSpec([videoClip(0, 2_000, 6_400)]), 0), SOURCE)).toBe(100);
  });

  test("growMs: by both edges together, within the room and the video", () => {
    expect(growMs(artboard, 2, SOURCE)).toBe(4_400);
    expect(growMs(artboard, 2, 14_000)).toBe(5_400);
    expect(growMs(draftSpec([videoClip(0, 2_000, 0)]), 0, 2_000)).toBe(0);
    expect(growMs(draftSpec([videoClip(0, 3_000, 0)]), 0, 2_000)).toBe(0);
  });
});
