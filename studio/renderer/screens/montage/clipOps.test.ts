import { describe, expect, test } from "bun:test";
import { MAX_SOURCE_OFFSET_MS, MontageDraft } from "../../../shared/engine";
import {
  addRefusal,
  ADD_CLIP_MS,
  appendPhotoClip,
  clampDuration,
  clipStartMs,
  duplicateClip,
  type Edit,
  evenOut,
  fillFocus,
  insertPhotoClip,
  isEven,
  layoutOf,
  maxDurationMs,
  moveClip,
  nextClipId,
  nextLayerId,
  removeClip,
  roomMs,
  setCellPhoto,
  setDuration,
  setLayout,
  setMotion,
  setStagger,
  splitClipAt,
  totalMs,
} from "./clipOps";
import { collageClip, draftSpec, photoClip, photoClips, stickerLayer, textLayer, videoClip } from "./testkit";

// 3d.3a: the clip track's edits, pure over a draft. Every result must still be a draft the contract takes
// (`MontageDraft`), never pass 15 s, never hold a clip under 0.1 s, and never repeat a scene photo.

const FACE = { x: 0.5, y: 0.35 } as const;

/** The edited draft, after checking it is one the contract takes. */
function ok(edit: Edit): MontageDraft {
  if (!edit.ok) throw new Error(`refused: ${edit.reason}`);
  expect(MontageDraft.safeParse(edit.spec).success).toBe(true);
  return edit.spec;
}

const durations = (spec: MontageDraft): number[] => spec.clips.map((c) => c.durationMs);
const ids = (spec: MontageDraft): string[] => spec.clips.map((c) => c.clipId);

describe("length and room", () => {
  test("the total is the sum of the clips; the room is what is left of 15 s, never below 0", () => {
    expect(totalMs(draftSpec([]))).toBe(0);
    expect(roomMs(draftSpec([]))).toBe(15_000);
    expect(totalMs(draftSpec(3))).toBe(6_000);
    expect(roomMs(draftSpec(3))).toBe(9_000);
    // A draft from elsewhere may already be longer than a render takes: no room, never a negative one.
    const long = draftSpec([photoClip(0, "photo-mia-0001", 15_100)]);
    expect(roomMs(long)).toBe(0);
  });

  test("a clip starts where the clips before it end", () => {
    const spec = draftSpec([photoClip(0, "photo-mia-0001", 2_400), photoClip(1, "photo-mia-0002", 3_200), photoClip(2, "photo-mia-0003", 2_000)]);
    expect([0, 1, 2].map((i) => clipStartMs(spec, i))).toEqual([0, 2_400, 5_600]);
    expect(() => clipStartMs(spec, 3)).toThrow(RangeError);
    expect(() => clipStartMs(spec, -1)).toThrow(RangeError);
  });
});

describe("ids", () => {
  test("a new clip id follows the highest numbered one and never collides", () => {
    expect(nextClipId(draftSpec([]))).toBe("clip-001");
    expect(nextClipId(draftSpec(3))).toBe("clip-004");
    const gap = draftSpec([photoClip(4, "photo-mia-0001")]);
    expect(nextClipId(gap)).toBe("clip-006");
    // Ids not of the `clip-NNN` form (headless drafts) are skipped over, never reused.
    const foreign = draftSpec([{ ...photoClip(0, "photo-mia-0001"), clipId: "intro-photo" }]);
    expect(nextClipId(foreign)).toBe("clip-001");
  });

  test("a new layer id follows the highest numbered layer", () => {
    expect(nextLayerId(draftSpec(1))).toBe("layer-001");
    expect(nextLayerId(draftSpec(1, { layers: [textLayer(0, 0, 1_000), stickerLayer(6, 0, 1_000)] }))).toBe("layer-008");
  });
});

describe("adding a photo clip (AM7: min(2.0 s, room), refused when no room is left)", () => {
  test("into an empty draft: a 2.0 s Ken Burns photo clip with the given focus", () => {
    const spec = ok(appendPhotoClip(draftSpec([]), "photo-mia-0009", FACE));
    expect(spec.clips).toEqual([
      { clipId: "clip-001", durationMs: ADD_CLIP_MS, transitionIn: "cut", kind: "photo", cell: { photo: { source: "scene", photoId: "photo-mia-0009" }, focus: FACE }, motion: "kenburns" },
    ]);
  });

  test("the edit names the new clip; an unresolved focus is stored as null", () => {
    const edit = appendPhotoClip(draftSpec(2), "photo-mia-0009");
    expect(edit.ok && edit.id).toBe("clip-003");
    const spec = ok(edit);
    const last = spec.clips.at(-1);
    expect(last?.kind === "photo" && last.cell.focus).toBeNull();
  });

  test("an insert goes before the clip at its boundary; 0 is the start, the clip count the end", () => {
    const base = draftSpec(2);
    expect(ok(insertPhotoClip(base, 0, "photo-mia-0009")).clips[0]?.clipId).toBe("clip-003");
    expect(ids(ok(insertPhotoClip(base, 1, "photo-mia-0009")))).toEqual(["clip-001", "clip-003", "clip-002"]);
    expect(ids(ok(insertPhotoClip(base, 2, "photo-mia-0009")))).toEqual(["clip-001", "clip-002", "clip-003"]);
    expect(() => insertPhotoClip(base, 3, "photo-mia-0009")).toThrow(RangeError);
    expect(() => insertPhotoClip(base, -1, "photo-mia-0009")).toThrow(RangeError);
  });

  test("the 20-clip cap: the 20th is added, the 21st is refused", () => {
    const nineteen = draftSpec(photoClips(19, 500));
    const twenty = ok(appendPhotoClip(nineteen, "photo-mia-0099"));
    expect(twenty.clips).toHaveLength(20);
    expect(addRefusal(nineteen)).toBeNull();
    expect(addRefusal(twenty)).toBe("clip-cap");
    expect(appendPhotoClip(twenty, "photo-mia-0098")).toEqual({ ok: false, reason: "clip-cap" });
  });

  test("the room: 13.0 s takes 2.0 s, 13.1 s takes 1.9 s, 14.5 s takes 0.5 s, 14.9 s takes the last 0.1 s", () => {
    const at = (ms: number): MontageDraft => draftSpec([photoClip(0, "photo-mia-0001", ms)]);
    expect(ok(appendPhotoClip(at(13_000), "photo-mia-0009")).clips[1]?.durationMs).toBe(2_000);
    expect(ok(appendPhotoClip(at(13_100), "photo-mia-0009")).clips[1]?.durationMs).toBe(1_900);
    expect(ok(appendPhotoClip(at(14_500), "photo-mia-0009")).clips[1]?.durationMs).toBe(500);
    const last = ok(appendPhotoClip(at(14_900), "photo-mia-0009"));
    expect(last.clips[1]?.durationMs).toBe(100);
    expect(totalMs(last)).toBe(15_000);
    expect(addRefusal(at(14_900))).toBeNull();
  });

  test("refused with no room left: exactly 15 s, and a draft already past 15 s", () => {
    for (const ms of [15_000, 15_100]) {
      const spec = draftSpec([photoClip(0, "photo-mia-0001", ms)]);
      expect(addRefusal(spec)).toBe("no-room");
      expect(appendPhotoClip(spec, "photo-mia-0009")).toEqual({ ok: false, reason: "no-room" });
    }
  });

  test("a scene photo already in the montage is refused, in a photo clip or a collage cell", () => {
    expect(appendPhotoClip(draftSpec(2), "photo-mia-0002")).toEqual({ ok: false, reason: "photo-in-draft" });
    const collage = draftSpec([collageClip(0, ["photo-mia-0005", null, "photo-mia-0006"])]);
    expect(appendPhotoClip(collage, "photo-mia-0006")).toEqual({ ok: false, reason: "photo-in-draft" });
  });
});

describe("removing and moving clips", () => {
  test("removing takes the clip out and keeps the others in order", () => {
    const spec = draftSpec(3);
    expect(ids(removeClip(spec, 1))).toEqual(["clip-001", "clip-003"]);
    expect(removeClip(draftSpec(1), 0).clips).toEqual([]);
    expect(() => removeClip(spec, 3)).toThrow(RangeError);
  });

  test("a move puts the clip at a boundary of the ORIGINAL order; its own two boundaries change nothing", () => {
    const spec = draftSpec(4);
    expect(ids(moveClip(spec, 0, 4))).toEqual(["clip-002", "clip-003", "clip-004", "clip-001"]);
    expect(ids(moveClip(spec, 3, 0))).toEqual(["clip-004", "clip-001", "clip-002", "clip-003"]);
    expect(ids(moveClip(spec, 1, 3))).toEqual(["clip-001", "clip-003", "clip-002", "clip-004"]);
    expect(moveClip(spec, 1, 1)).toBe(spec);
    expect(moveClip(spec, 1, 2)).toBe(spec);
    expect(() => moveClip(spec, 0, 5)).toThrow(RangeError);
    expect(() => moveClip(spec, 4, 0)).toThrow(RangeError);
  });

  test("a move keeps every clip's content and the total", () => {
    const spec = draftSpec([photoClip(0, "photo-mia-0001", 2_400), collageClip(1, ["photo-mia-0002", "photo-mia-0003"], 3_200)]);
    const moved = moveClip(spec, 1, 0);
    expect(moved.clips).toEqual([spec.clips[1], spec.clips[0]].filter((c) => c !== undefined));
    expect(totalMs(moved)).toBe(totalMs(spec));
  });
});

describe("trimming a clip (100 ms steps, at least 0.1 s, the total at most 15 s)", () => {
  test("snaps to the nearest 100 ms", () => {
    const spec = draftSpec(2);
    expect(clampDuration(spec, 0, 2_449)).toBe(2_400);
    expect(clampDuration(spec, 0, 2_450)).toBe(2_500);
    expect(clampDuration(spec, 0, 3_000)).toBe(3_000);
  });

  test("never under 0.1 s: 99 and 90 become 100, 49 and 0 too, a negative too", () => {
    const spec = draftSpec(2);
    for (const wanted of [100, 99, 90, 50, 49, 0, -800]) expect(clampDuration(spec, 0, wanted)).toBe(100);
    expect(clampDuration(spec, 0, 200)).toBe(200);
  });

  test("a clip may be trimmed down to exactly 100 ms: setDuration keeps it, a draft the contract takes", () => {
    const spec = draftSpec(2);
    const trimmed = setDuration(spec, 0, 100);
    expect(trimmed.clips[0]?.durationMs).toBe(100);
    expect(MontageDraft.safeParse(trimmed).success).toBe(true);
    expect(setDuration(trimmed, 0, 0)).toBe(trimmed);
  });

  test("never past 15 s: a clip grows by the room at most, exactly to 15.0 s and not to 15.1 s", () => {
    const spec = draftSpec([photoClip(0, "photo-mia-0001", 2_000), photoClip(1, "photo-mia-0002", 10_000)]);
    expect(maxDurationMs(spec, 0)).toBe(5_000);
    expect(clampDuration(spec, 0, 5_000)).toBe(5_000);
    expect(clampDuration(spec, 0, 5_100)).toBe(5_000);
    expect(totalMs(setDuration(spec, 0, 99_000))).toBe(15_000);
  });

  test("at exactly 15 s a clip can only shrink; a draft past 15 s too", () => {
    const full = draftSpec([photoClip(0, "photo-mia-0001", 5_000), photoClip(1, "photo-mia-0002", 10_000)]);
    expect(maxDurationMs(full, 0)).toBe(5_000);
    expect(clampDuration(full, 0, 5_100)).toBe(5_000);
    expect(clampDuration(full, 0, 4_900)).toBe(4_900);
    const over = draftSpec([photoClip(0, "photo-mia-0001", 5_100), photoClip(1, "photo-mia-0002", 10_000)]);
    expect(maxDurationMs(over, 0)).toBe(5_100);
    expect(clampDuration(over, 0, 5_200)).toBe(5_100);
  });

  test("setting the same length returns the same draft (no empty undo step)", () => {
    const spec = draftSpec(2);
    expect(setDuration(spec, 0, 2_000)).toBe(spec);
    expect(setDuration(spec, 0, 2_040)).toBe(spec);
    expect(durations(setDuration(spec, 1, 3_300))).toEqual([2_000, 3_300]);
  });

  test("a length that is not a number is a programming error", () => {
    expect(() => clampDuration(draftSpec(1), 0, Number.NaN)).toThrow(RangeError);
    expect(() => clampDuration(draftSpec(1), 1, 1_000)).toThrow(RangeError);
  });

  test("3f.3b: an own video clip is held to the limit its video sets (from its trim to the video's end), as well as to the room", () => {
    // 2 s from 1.8 s into a 6.4 s video: at most 4.6 s; the room alone would allow 13 s.
    const spec = draftSpec([videoClip(0, 2_000, 1_800)]);
    expect(maxDurationMs(spec, 0, 4_600)).toBe(4_600);
    expect(clampDuration(spec, 0, 9_000, 4_600)).toBe(4_600);
    expect(durations(setDuration(spec, 0, 9_000, 4_600))).toEqual([4_600]);
    // The room still holds when it is the tighter one.
    const tight = draftSpec([...photoClips(6, 2_000), videoClip(6, 2_000, 0)]);
    expect(maxDurationMs(tight, 6, 9_000)).toBe(3_000);
    // A clip already longer than its video comes down to the limit at the first move.
    expect(durations(setDuration(draftSpec([videoClip(0, 6_000, 1_800)]), 0, 5_900, 4_600))).toEqual([4_600]);
    // Without a limit (the video not known yet) only the room counts.
    expect(maxDurationMs(spec, 0)).toBe(15_000);
  });
});

describe("split evenly (the old «Слайды»: the same total over every clip)", () => {
  test("the total is shared on the 100 ms grid, the longer parts first", () => {
    const spec = draftSpec([photoClip(0, "photo-mia-0001", 2_400), photoClip(1, "photo-mia-0002", 3_200), photoClip(2, "photo-mia-0003", 2_000), photoClip(3, "photo-mia-0004", 2_000)]);
    expect(durations(evenOut(spec))).toEqual([2_400, 2_400, 2_400, 2_400]);
    const odd = draftSpec([photoClip(0, "photo-mia-0001", 500), photoClip(1, "photo-mia-0002", 1_000)]);
    expect(durations(evenOut(odd))).toEqual([800, 700]);
  });

  test("keeps the total, at 15 s too, and with 20 clips of 0.5 s", () => {
    const full = draftSpec([photoClip(0, "photo-mia-0001", 14_000), photoClip(1, "photo-mia-0002", 1_000)]);
    expect(durations(evenOut(full))).toEqual([7_500, 7_500]);
    const twenty = draftSpec(photoClips(20, 500));
    expect(evenOut(twenty)).toBe(twenty);
  });

  test("already even (no two clips more than 100 ms apart), one clip, or none: the same draft", () => {
    const empty = draftSpec([]);
    const one = draftSpec(1);
    const even = draftSpec([photoClip(0, "photo-mia-0001", 700), photoClip(1, "photo-mia-0002", 800)]);
    for (const spec of [empty, one, even]) {
      expect(isEven(spec)).toBe(true);
      expect(evenOut(spec)).toBe(spec);
    }
    expect(isEven(draftSpec([photoClip(0, "photo-mia-0001", 700), photoClip(1, "photo-mia-0002", 900)]))).toBe(false);
  });
});

describe("splitting at the playhead (CF4: own video clips only; photo and collage clips would repeat a photo)", () => {
  const spec = draftSpec([photoClip(0, "photo-mia-0001", 1_000), videoClip(1, 2_000, 300)]);

  test("a video clip splits in two, the second continuing the source where the first stops", () => {
    const edit = splitClipAt(spec, 1, 1_800);
    const split = ok(edit);
    expect(edit.ok && edit.id).toBe("clip-003");
    expect(split.clips[1]).toMatchObject({ clipId: "clip-002", kind: "video", durationMs: 800, trimStartMs: 300 });
    expect(split.clips[2]).toMatchObject({ clipId: "clip-003", kind: "video", durationMs: 1_200, trimStartMs: 1_100, mediaId: "media-own-0001" });
    expect(totalMs(split)).toBe(totalMs(spec));
  });

  test("each part keeps at least 0.1 s: one step from either end splits", () => {
    expect(durations(ok(splitClipAt(spec, 1, 1_500)))).toEqual([1_000, 500, 1_500]);
    expect(durations(ok(splitClipAt(spec, 1, 2_500)))).toEqual([1_000, 1_500, 500]);
    expect(durations(ok(splitClipAt(spec, 1, 1_100)))).toEqual([1_000, 100, 1_900]);
    expect(durations(ok(splitClipAt(spec, 1, 2_900)))).toEqual([1_000, 1_900, 100]);
  });

  test("a point less than one step from an edge snaps onto the edge, so it is no split (no part under 0.1 s can be made)", () => {
    for (const at of [1_040, 2_960]) expect(splitClipAt(spec, 1, at)).toEqual({ ok: false, reason: "not-splittable" });
  });

  test("a 100 ms video clip cannot be split: both halves would be under a step", () => {
    const tiny = draftSpec([videoClip(0, 100, 300)]);
    for (const at of [0, 50, 100]) expect(splitClipAt(tiny, 0, at)).toEqual({ ok: false, reason: "not-splittable" });
  });

  test("a point on the clip's edges or outside it is not a split", () => {
    for (const at of [1_000, 3_000, 500, 3_500]) expect(splitClipAt(spec, 1, at)).toEqual({ ok: false, reason: "not-splittable" });
  });

  test("photo and collage clips are never split", () => {
    expect(splitClipAt(spec, 0, 500)).toEqual({ ok: false, reason: "not-splittable" });
    const collage = draftSpec([collageClip(0, ["photo-mia-0001", "photo-mia-0002"], 3_000)]);
    expect(splitClipAt(collage, 0, 1_500)).toEqual({ ok: false, reason: "not-splittable" });
  });

  test("a split needs a free clip slot", () => {
    const full = draftSpec([...photoClips(19, 500), videoClip(19, 2_000)]);
    expect(splitClipAt(full, 19, 10_500)).toEqual({ ok: false, reason: "clip-cap" });
  });

  test("3f.3b: the second part never starts past the contract's furthest offset into the video", () => {
    const deep = draftSpec([videoClip(0, 2_000, MAX_SOURCE_OFFSET_MS - 500)]);
    expect(durations(ok(splitClipAt(deep, 0, 500)))).toEqual([500, 1_500]);
    expect(splitClipAt(deep, 0, 600)).toEqual({ ok: false, reason: "not-splittable" });
  });
});

describe("duplicating a clip (CF4: a photo or collage copy keeps its shape, not its photos)", () => {
  test("a collage copy keeps layout, length, motion and stagger with empty cells, right after the original", () => {
    const base = draftSpec([{ ...collageClip(0, ["photo-mia-0001", "photo-mia-0002", "photo-mia-0003"], 3_200, false), motion: "pan" }, photoClip(1, "photo-mia-0004")]);
    const edit = duplicateClip(base, 0);
    const spec = ok(edit);
    expect(edit.ok && edit.id).toBe("clip-003");
    expect(ids(spec)).toEqual(["clip-001", "clip-003", "clip-002"]);
    expect(spec.clips[1]).toEqual({
      clipId: "clip-003",
      durationMs: 3_200,
      transitionIn: "cut",
      kind: "collage",
      layout: "collage3",
      cells: [
        { photo: null, focus: null },
        { photo: null, focus: null },
        { photo: null, focus: null },
      ],
      motion: "pan",
      stagger: false,
    });
  });

  test("a photo copy has an empty cell; a video copy is the same video", () => {
    const spec = ok(duplicateClip(draftSpec(1), 0));
    expect(spec.clips[1]).toMatchObject({ kind: "photo", cell: { photo: null, focus: null }, durationMs: 2_000 });
    const video = ok(duplicateClip(draftSpec([videoClip(0, 2_000, 700)]), 0));
    expect(video.clips[1]).toMatchObject({ kind: "video", mediaId: "media-own-0001", trimStartMs: 700, durationMs: 2_000 });
  });

  test("the copy is cut to the room, down to 0.1 s, and refused with no room or at 20 clips", () => {
    const tight = draftSpec([photoClip(0, "photo-mia-0001", 3_000), photoClip(1, "photo-mia-0002", 10_000)]);
    expect(ok(duplicateClip(tight, 0)).clips[1]?.durationMs).toBe(2_000);
    const edge = draftSpec([photoClip(0, "photo-mia-0001", 3_000), photoClip(1, "photo-mia-0002", 11_500)]);
    expect(ok(duplicateClip(edge, 0)).clips[1]?.durationMs).toBe(500);
    const last = draftSpec([photoClip(0, "photo-mia-0001", 3_000), photoClip(1, "photo-mia-0002", 11_900)]);
    expect(ok(duplicateClip(last, 0)).clips[1]?.durationMs).toBe(100);
    const none = draftSpec([photoClip(0, "photo-mia-0001", 3_000), photoClip(1, "photo-mia-0002", 12_000)]);
    expect(duplicateClip(none, 0)).toEqual({ ok: false, reason: "no-room" });
    expect(duplicateClip(draftSpec(photoClips(20, 500)), 0)).toEqual({ ok: false, reason: "clip-cap" });
  });
});

describe("the layout («Раскладка»: cells cut or padded with empty cells)", () => {
  test("names the clip's layout", () => {
    expect(layoutOf(photoClip(0, "photo-mia-0001"))).toBe("photo");
    expect(layoutOf(collageClip(0, ["photo-mia-0001", null, null]))).toBe("collage3");
    expect(layoutOf(videoClip(0))).toBeNull();
  });

  test("one photo → collage 3: the photo in the first cell, two empty cells, stagger on, the motion kept", () => {
    const base = draftSpec([{ ...photoClip(0, "photo-mia-0001", 3_200), motion: "pan" }]);
    const spec = ok(setLayout(base, 0, "collage3"));
    expect(spec.clips[0]).toEqual({
      clipId: "clip-001",
      durationMs: 3_200,
      transitionIn: "cut",
      kind: "collage",
      layout: "collage3",
      cells: [
        { photo: { source: "scene", photoId: "photo-mia-0001" }, focus: null },
        { photo: null, focus: null },
        { photo: null, focus: null },
      ],
      motion: "pan",
      stagger: true,
    });
  });

  test("collage 4 → collage 2 cuts the last cells; collage 2 → collage 4 pads; the stagger is kept", () => {
    const four = draftSpec([collageClip(0, ["photo-mia-0001", "photo-mia-0002", "photo-mia-0003", null], 3_000, false)]);
    const two = ok(setLayout(four, 0, "collage2")).clips[0];
    expect(two?.kind === "collage" && two.cells.map((c) => c.photo)).toEqual([
      { source: "scene", photoId: "photo-mia-0001" },
      { source: "scene", photoId: "photo-mia-0002" },
    ]);
    expect(two?.kind === "collage" && two.stagger).toBe(false);
    const back = ok(setLayout(draftSpec([collageClip(0, ["photo-mia-0001", "photo-mia-0002"])]), 0, "collage4")).clips[0];
    expect(back?.kind === "collage" && back.cells.map((c) => c.photo?.source ?? null)).toEqual(["scene", "scene", null, null]);
  });

  test("a collage → one photo keeps the first cell (its focus too)", () => {
    const base = draftSpec([collageClip(0, ["photo-mia-0001", "photo-mia-0002"])]);
    const withFocus = fillFocus(base, "photo-mia-0001", FACE);
    const one = ok(setLayout(withFocus, 0, "photo")).clips[0];
    expect(one).toMatchObject({ kind: "photo", cell: { photo: { source: "scene", photoId: "photo-mia-0001" }, focus: FACE }, motion: "kenburns" });
    expect(one && "stagger" in one).toBe(false);
  });

  test("the same layout is the same draft; a video clip has no layout", () => {
    const spec = draftSpec(1);
    const same = setLayout(spec, 0, "photo");
    expect(same.ok && same.spec).toBe(spec);
    expect(setLayout(draftSpec([videoClip(0)]), 0, "collage2")).toEqual({ ok: false, reason: "not-a-photo-clip" });
  });
});

describe("motion and stagger", () => {
  test("motion is set on photo and collage clips, never on a video", () => {
    expect(ok(setMotion(draftSpec(1), 0, "static")).clips[0]).toMatchObject({ motion: "static" });
    expect(setMotion(draftSpec([videoClip(0)]), 0, "pan")).toEqual({ ok: false, reason: "not-a-photo-clip" });
  });

  test("stagger is a collage's alone", () => {
    const collage = draftSpec([collageClip(0, ["photo-mia-0001", "photo-mia-0002"], 3_000, true)]);
    expect(ok(setStagger(collage, 0, false)).clips[0]).toMatchObject({ stagger: false });
    expect(setStagger(draftSpec(1), 0, true)).toEqual({ ok: false, reason: "not-a-photo-clip" });
  });
});

describe("a photo into a cell", () => {
  const base = draftSpec([collageClip(0, ["photo-mia-0001", null, null]), photoClip(1, "photo-mia-0002")]);

  test("fills an empty cell with the photo and its focus", () => {
    const spec = ok(setCellPhoto(base, 0, 1, "photo-mia-0009", FACE));
    const clip = spec.clips[0];
    expect(clip?.kind === "collage" && clip.cells[1]).toEqual({ photo: { source: "scene", photoId: "photo-mia-0009" }, focus: FACE });
  });

  test("replaces a photo clip's photo; null empties the cell", () => {
    expect(ok(setCellPhoto(base, 1, 0, "photo-mia-0009")).clips[1]).toMatchObject({ cell: { photo: { source: "scene", photoId: "photo-mia-0009" }, focus: null } });
    expect(ok(setCellPhoto(base, 0, 0, null)).clips[0]).toMatchObject({ cells: [{ photo: null, focus: null }, { photo: null }, { photo: null }] });
  });

  test("a photo already elsewhere in the montage is refused; the same photo in its own cell changes nothing", () => {
    expect(setCellPhoto(base, 0, 1, "photo-mia-0002")).toEqual({ ok: false, reason: "photo-in-draft" });
    const same = setCellPhoto(base, 0, 0, "photo-mia-0001");
    expect(same.ok && same.spec).toBe(base);
  });

  test("a cell outside the clip, or a video clip, is a programming error", () => {
    expect(() => setCellPhoto(base, 0, 3, "photo-mia-0009")).toThrow(RangeError);
    expect(() => setCellPhoto(base, 1, 1, "photo-mia-0009")).toThrow(RangeError);
    expect(() => setCellPhoto(draftSpec([videoClip(0)]), 0, 0, "photo-mia-0009")).toThrow(RangeError);
  });
});

describe("the focus found for a placed photo (K6)", () => {
  test("fills every unresolved cell of that photo, and nothing else", () => {
    const base = draftSpec([collageClip(0, ["photo-mia-0001", "photo-mia-0002"]), photoClip(1, "photo-mia-0003")]);
    const spec = fillFocus(base, "photo-mia-0002", FACE);
    const clip = spec.clips[0];
    expect(clip?.kind === "collage" && clip.cells.map((c) => c.focus)).toEqual([null, FACE]);
    expect(spec.clips[1]).toEqual(base.clips[1]);
  });

  test("a focus already stored is not replaced, and an absent photo changes nothing (the same draft)", () => {
    const placed = fillFocus(draftSpec(1), "photo-mia-0001", FACE);
    expect(fillFocus(placed, "photo-mia-0001", { x: 0.1, y: 0.1 })).toBe(placed);
    const spec = draftSpec(1);
    expect(fillFocus(spec, "photo-mia-0099", FACE)).toBe(spec);
  });
});

