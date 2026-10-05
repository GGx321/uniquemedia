import { describe, expect, test } from "bun:test";
import { MontageDraft } from "../../../shared/engine";
import {
  ADD_CLIP_MS,
  appendOwnPhotoClip,
  appendVideoClip,
  type Edit,
  fillOwnFocus,
  insertOwnPhotoClip,
  insertVideoClip,
  ownSlots,
  setCellOwnPhoto,
} from "./clipOps";
import { collageClip, draftSpec, photoClip, photoClips, videoClip } from "./testkit";

// 3f.6: the «Мои» tab's own photos and videos placed on the clip track, by the editor's rules for scene photos (P12, AM7): a click appends
// a clip of min(2.0 s, the room) or fills the selected empty cell, a drag inserts a clip at a boundary. An own file may be placed more than
// once (only SCENE photos are one photo → one video). An own video plays from its start, for min(2.0 s, the room, its own length on the
// 100 ms grid); one under the shortest clip (0.1 s) is never placed. Every result is a draft the contract takes.

const OWN_PHOTO = "media-photo-0001";
const OWN_VIDEO = "media-video-0001";
const FACE = { x: 0.4, y: 0.3 } as const;

function ok(edit: Edit): MontageDraft {
  if (!edit.ok) throw new Error(`refused: ${edit.reason}`);
  expect(MontageDraft.safeParse(edit.spec).success).toBe(true);
  return edit.spec;
}

const video = (durationMs: number) => ({ mediaId: OWN_VIDEO, durationMs });

describe("an own photo as a new clip", () => {
  test("appended: a photo clip of 2 s with Ken Burns, the own source, and the focus asked for later", () => {
    const edit = appendOwnPhotoClip(draftSpec(2), OWN_PHOTO);
    const spec = ok(edit);
    expect(spec.clips).toHaveLength(3);
    expect(spec.clips[2]).toEqual({ clipId: "clip-003", durationMs: ADD_CLIP_MS, transitionIn: "cut", kind: "photo", cell: { photo: { source: "own", mediaId: OWN_PHOTO }, focus: null }, motion: "kenburns" });
    expect(edit.ok && edit.id).toBe("clip-003");
  });

  test("inserted at a boundary; the same own photo may be placed again", () => {
    const once = ok(insertOwnPhotoClip(draftSpec(2), 1, OWN_PHOTO));
    const twice = ok(insertOwnPhotoClip(once, 0, OWN_PHOTO));
    expect(twice.clips.map((c) => (c.kind === "photo" ? (c.cell.photo?.source === "own" ? "own" : "scene") : c.kind))).toEqual(["own", "scene", "own", "scene"]);
  });

  test("the room left shortens it; 20 clips or no room at all refuse it", () => {
    const tight = draftSpec([photoClip(0, "photo-mia-0001", 14_200)]);
    expect(ok(appendOwnPhotoClip(tight, OWN_PHOTO)).clips[1]?.durationMs).toBe(800);
    expect(appendOwnPhotoClip(draftSpec(photoClips(20, 500)), OWN_PHOTO)).toEqual({ ok: false, reason: "clip-cap" });
    expect(appendOwnPhotoClip(draftSpec([photoClip(0, "photo-mia-0001", 15_000)]), OWN_PHOTO)).toEqual({ ok: false, reason: "no-room" });
    expect(ok(appendOwnPhotoClip(draftSpec([photoClip(0, "photo-mia-0001", 14_900)]), OWN_PHOTO)).clips[1]?.durationMs).toBe(100);
    expect(() => insertOwnPhotoClip(draftSpec(1), 3, OWN_PHOTO)).toThrow(RangeError);
  });
});

describe("an own photo into a cell", () => {
  test("fills the empty cell of a collage; the same media already there is the same draft", () => {
    const base = draftSpec([collageClip(0, ["photo-mia-0001", null])]);
    const spec = ok(setCellOwnPhoto(base, 0, 1, OWN_PHOTO));
    const clip = spec.clips[0];
    expect(clip?.kind === "collage" && clip.cells[1]).toEqual({ photo: { source: "own", mediaId: OWN_PHOTO }, focus: null });
    expect(ok(setCellOwnPhoto(spec, 0, 1, OWN_PHOTO))).toBe(spec);
  });

  test("a video clip has no cells; a cell outside the clip is a programming error", () => {
    expect(() => setCellOwnPhoto(draftSpec([videoClip(0)]), 0, 0, OWN_PHOTO)).toThrow(RangeError);
    expect(() => setCellOwnPhoto(draftSpec(1), 0, 1, OWN_PHOTO)).toThrow(RangeError);
  });
});

describe("an own video as a new clip", () => {
  test("plays from its start for 2 s when it is longer", () => {
    const edit = appendVideoClip(draftSpec(1), video(6_400));
    const spec = ok(edit);
    expect(spec.clips[1]).toEqual({ clipId: "clip-002", durationMs: 2_000, transitionIn: "cut", kind: "video", mediaId: OWN_VIDEO, trimStartMs: 0, focus: null });
  });

  test("a shorter video plays whole, cut down to the 100 ms grid; the room left cuts it too", () => {
    expect(ok(appendVideoClip(draftSpec(1), video(1_290))).clips[1]?.durationMs).toBe(1_200);
    expect(ok(appendVideoClip(draftSpec(1), video(500))).clips[1]?.durationMs).toBe(500);
    expect(ok(appendVideoClip(draftSpec(1), video(100))).clips[1]?.durationMs).toBe(100);
    expect(ok(appendVideoClip(draftSpec([photoClip(0, "photo-mia-0001", 14_300)]), video(6_400))).clips[1]?.durationMs).toBe(700);
  });

  test("a video under 0.1 s on the grid is never placed (the engine refuses it at import; this holds anyway)", () => {
    expect(appendVideoClip(draftSpec(1), video(99))).toEqual({ ok: false, reason: "too-short" });
    expect(appendVideoClip(draftSpec(1), video(0))).toEqual({ ok: false, reason: "too-short" });
    expect(appendVideoClip(draftSpec(1), video(199))).toEqual({ ok: true, spec: expect.anything(), id: "clip-002" });
    expect(insertVideoClip(draftSpec(1), 0, video(90))).toEqual({ ok: false, reason: "too-short" });
    expect(insertVideoClip(draftSpec(1), 0, video(100))).toEqual({ ok: true, spec: expect.anything(), id: "clip-002" });
  });

  test("the caps come first, as for a photo; inserted at a boundary", () => {
    expect(appendVideoClip(draftSpec(photoClips(20, 500)), video(6_400))).toEqual({ ok: false, reason: "clip-cap" });
    expect(appendVideoClip(draftSpec([photoClip(0, "photo-mia-0001", 15_000)]), video(6_400))).toEqual({ ok: false, reason: "no-room" });
    expect(ok(insertVideoClip(draftSpec(2), 0, video(6_400))).clips.map((c) => c.kind)).toEqual(["video", "photo", "photo"]);
  });
});

describe("where the own files stand (the tiles' badges, M5)", () => {
  test("the number of the first clip holding each own photo or video; scene photos and stickers are not counted", () => {
    const spec = draftSpec([
      photoClip(0, "photo-mia-0001"),
      { ...videoClip(1), mediaId: OWN_VIDEO },
      collageClip(2, ["photo-mia-0002", null]),
      { ...videoClip(3), mediaId: OWN_VIDEO },
    ]);
    const withPhoto = ok(setCellOwnPhoto(spec, 2, 1, OWN_PHOTO));
    expect([...ownSlots(withPhoto)]).toEqual([
      [OWN_VIDEO, 2],
      [OWN_PHOTO, 3],
    ]);
    expect(ownSlots(draftSpec(2)).size).toBe(0);
  });
});

describe("the face focus of an own photo (K6 for own photos): written into the cells still waiting for it", () => {
  test("every cell of the own photo whose focus is null; a stored focus is never replaced; a scene photo of the same id is not touched", () => {
    const placed = ok(appendOwnPhotoClip(ok(appendOwnPhotoClip(draftSpec(1), OWN_PHOTO)), OWN_PHOTO));
    const filled = fillOwnFocus(placed, OWN_PHOTO, FACE);
    expect(filled.clips.slice(1).map((c) => (c.kind === "photo" ? c.cell.focus : null))).toEqual([FACE, FACE]);
    expect(fillOwnFocus(filled, OWN_PHOTO, { x: 0.1, y: 0.1 })).toBe(filled);
    expect(fillOwnFocus(placed, "media-photo-0099", FACE)).toBe(placed);
    const scene = draftSpec([photoClip(0, OWN_PHOTO)]);
    expect(fillOwnFocus(scene, OWN_PHOTO, FACE)).toBe(scene);
  });
});
