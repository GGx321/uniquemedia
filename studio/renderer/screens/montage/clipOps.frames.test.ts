import { describe, expect, test } from "bun:test";
import { type MediaOrigin, MontageDraft } from "../../../shared/engine";
import { appendPhotoClip, appendVideoClip, duplicateClip, type Edit, framePhotoIds, framesKnown, insertPhotoClip, insertVideoClip, type OriginOf, setCellPhoto, splitClipAt } from "./clipOps";
import { actionWhyLabel } from "./labels";
import { duplicateSelected, selectionActions, splitSelected } from "./selection";
import { collageClip, draftSpec, photoClip } from "./testkit";

// 5b.2 part A (S5.WA4; plan I5.60, Q-F = 1, §5.1.3 `clipOps.ts:104`): a photo and every clip made from it are ONE frame. The editor's in-draft check counts
// the frames, not only the scene photos: a draft's frames are its scene photos plus the photo of each own video that is a clip's montage copy (its
// `MediaSummary.origin`, read from the media list). So a photo whose clip copy is in the draft is not placed again, a copy whose photo or sibling clip is in
// the draft is not placed, and the same copy goes in once. A copy is never split or duplicated: both would repeat its frame.

const AVATAR = "avatar-mia-0001";
const P1 = "photo-mia-0001";
const P2 = "photo-mia-0002";
const P3 = "photo-mia-0003";
const COPY_A = "media-copy-0001";
const COPY_B = "media-copy-0002";
const OWN = "media-own-0009";

const origin = (clipId: string, photoId: string): MediaOrigin => ({ kind: "clip", avatarId: AVATAR, clipId, photoId });
/** Clip «clip-a» and «clip-b» are two clips of P3; COPY_A is clip-a's copy, COPY_B clip-b's. OWN is the owner's own video, no clip's copy. */
const ORIGINS: ReadonlyMap<string, MediaOrigin> = new Map([
  [COPY_A, origin("clip-a", P3)],
  [COPY_B, origin("clip-b", P3)],
]);
/** Every video of the drafts below is known: COPY_A and COPY_B are copies, any other is the owner's own (null). */
const originOf: OriginOf = (mediaId) => ORIGINS.get(mediaId) ?? null;
/** The media list has not answered (or could not be read): no video's origin is known. */
const unknown: OriginOf = () => undefined;

const copyClip = (index: number, mediaId: string, durationMs = 2_000): Extract<MontageDraft["clips"][number], { kind: "video" }> => ({
  clipId: `clip-${String(index + 1).padStart(3, "0")}`,
  durationMs,
  transitionIn: "cut",
  kind: "video",
  mediaId,
  trimStartMs: 0,
  focus: null,
});

function ok(edit: Edit): MontageDraft {
  if (!edit.ok) throw new Error(`refused: ${edit.reason}`);
  expect(MontageDraft.safeParse(edit.spec).success).toBe(true);
  return edit.spec;
}

describe("the draft's frames (framePhotoIds)", () => {
  test("its scene photos and the photo of each clip copy; an own video that is no clip's copy adds nothing", () => {
    const spec = draftSpec([photoClip(0, P1), collageClip(1, [P2, null]), copyClip(2, COPY_A), copyClip(3, OWN)]);
    expect([...framePhotoIds(spec, originOf)].sort()).toEqual([P1, P2, P3]);
  });

  // S5.WA4 round 2 (review M3): this pinned the fail-OPEN reading (a video of unknown origin counted as no copy, so its frame was free to place again).
  // Now a video's origin is a copy's, null (the owner's own, or one gone), or undefined (not known yet), and the frames are known only when no video is
  // undefined; the default (`NO_COPIES`) is a caller saying the draft holds no copy.
  test("the frames are known when every video's origin is (a copy, or null for an own video); one not known leaves them unknown", () => {
    const spec = draftSpec([photoClip(0, P1), copyClip(1, COPY_A)]);
    expect(framesKnown(spec, originOf)).toBe(true);
    expect(framesKnown(spec, unknown)).toBe(false);
    expect(framesKnown(draftSpec([photoClip(0, P1)]), unknown)).toBe(true);
    // The default: the caller says the draft holds no copy.
    expect(framesKnown(spec)).toBe(true);
    expect([...framePhotoIds(spec)]).toEqual([P1]);
  });
});

describe("a scene photo whose clip copy is in the draft is not placed again", () => {
  const spec = draftSpec([photoClip(0, P1), copyClip(1, COPY_A)]);

  test("appended or inserted: refused `photo-in-draft`, as the photo itself would be", () => {
    expect(appendPhotoClip(spec, P3, null, originOf)).toEqual({ ok: false, reason: "photo-in-draft" });
    expect(insertPhotoClip(spec, 0, P3, null, originOf)).toEqual({ ok: false, reason: "photo-in-draft" });
    // Another photo goes in as always.
    expect(ok(appendPhotoClip(spec, P2, null, originOf)).clips).toHaveLength(3);
  });

  test("into a cell: refused `photo-in-draft`", () => {
    const withCollage = draftSpec([collageClip(0, [P1, null]), copyClip(1, COPY_A)]);
    expect(setCellPhoto(withCollage, 0, 1, P3, null, originOf)).toEqual({ ok: false, reason: "photo-in-draft" });
    expect(ok(setCellPhoto(withCollage, 0, 1, P2, null, originOf)).clips[0]).toMatchObject({ cells: [{ photo: { photoId: P1 } }, { photo: { photoId: P2 } }] });
  });

  // S5.WA4 round 2 (review M3): this pinned the fail-OPEN rule («with no origins known, only the scene photos are checked»). It is fail-CLOSED now: while a
  // video's origin is not known, no frame is placed at all, since any photo may be that copy's frame.
  test("while a video's origin is not known, no frame is placed (fail closed): `frame-unknown`", () => {
    expect(appendPhotoClip(spec, P2, null, unknown)).toEqual({ ok: false, reason: "frame-unknown" });
    expect(insertPhotoClip(spec, 0, P2, null, unknown)).toEqual({ ok: false, reason: "frame-unknown" });
    const withCollage = draftSpec([collageClip(0, [P1, null]), copyClip(1, COPY_A)]);
    expect(setCellPhoto(withCollage, 0, 1, P2, null, unknown)).toEqual({ ok: false, reason: "frame-unknown" });
    // Emptying a cell places no frame.
    expect(ok(setCellPhoto(withCollage, 0, 0, null, null, unknown)).clips[0]).toMatchObject({ cells: [{ photo: null }, { photo: null }] });
    // The default says the draft holds no copy: the scene photos alone are checked.
    expect(ok(appendPhotoClip(spec, P3)).clips).toHaveLength(3);
  });
});

describe("a clip copy goes in once, and never beside its frame", () => {
  const copyA = { mediaId: COPY_A, durationMs: 5_000, origin: origin("clip-a", P3) };
  const copyB = { mediaId: COPY_B, durationMs: 5_000, origin: origin("clip-b", P3) };

  test("into a draft that does not hold its frame: a video clip from its start, up to 2 s", () => {
    const spec = ok(appendVideoClip(draftSpec([photoClip(0, P1)]), copyA, originOf));
    expect(spec.clips[1]).toEqual({ clipId: "clip-002", durationMs: 2_000, transitionIn: "cut", kind: "video", mediaId: COPY_A, trimStartMs: 0, focus: null });
  });

  test("the same copy again: refused `photo-in-draft`, even before the media list told its origin", () => {
    const spec = draftSpec([copyClip(0, COPY_A)]);
    expect(appendVideoClip(spec, copyA, originOf)).toEqual({ ok: false, reason: "photo-in-draft" });
    expect(appendVideoClip(spec, copyA)).toEqual({ ok: false, reason: "photo-in-draft" });
  });

  test("a sibling clip of its photo is in the draft: refused `photo-in-draft`", () => {
    expect(insertVideoClip(draftSpec([copyClip(0, COPY_B)]), 0, copyA, originOf)).toEqual({ ok: false, reason: "photo-in-draft" });
  });

  test("its photo is a scene photo of the draft: refused `photo-in-draft`", () => {
    expect(appendVideoClip(draftSpec([collageClip(0, [P1, P3])]), copyB, originOf)).toEqual({ ok: false, reason: "photo-in-draft" });
  });

  test("the caps are told first, as for any clip", () => {
    const full = draftSpec([photoClip(0, P3, 15_000)]);
    expect(appendVideoClip(full, copyA, originOf)).toEqual({ ok: false, reason: "no-room" });
  });

  test("while another video's origin is not known a copy is not placed (`frame-unknown`); an own video, which holds no frame, still is", () => {
    const spec = draftSpec([photoClip(0, P1), copyClip(1, COPY_B)]);
    expect(appendVideoClip(spec, copyA, unknown)).toEqual({ ok: false, reason: "frame-unknown" });
    expect(ok(appendVideoClip(spec, { mediaId: OWN, durationMs: 5_000 }, unknown)).clips).toHaveLength(3);
    // Its own origin it carries: in a draft of photos only, the frames are known.
    expect(ok(appendVideoClip(draftSpec([photoClip(0, P1)]), copyA, unknown)).clips).toHaveLength(2);
  });

  test("an own video that is no clip's copy is still placed as often as the owner likes", () => {
    const own = { mediaId: OWN, durationMs: 5_000 };
    const twice = ok(appendVideoClip(ok(appendVideoClip(draftSpec([photoClip(0, P1)]), own, originOf)), own, originOf));
    expect(twice.clips.filter((c) => c.kind === "video" && c.mediaId === OWN)).toHaveLength(2);
  });
});

describe("a clip copy is neither split nor duplicated (its frame would repeat)", () => {
  const spec = draftSpec([photoClip(0, P1, 2_000), copyClip(1, COPY_A, 2_000), copyClip(2, OWN, 2_000)]);

  test("the edits refuse it `clip-frame`; an own video is split and copied as before", () => {
    expect(splitClipAt(spec, 1, 3_000, originOf)).toEqual({ ok: false, reason: "clip-frame" });
    expect(duplicateClip(spec, 1, originOf)).toEqual({ ok: false, reason: "clip-frame" });
    expect(ok(splitClipAt(spec, 2, 5_000, originOf)).clips).toHaveLength(4);
    expect(ok(duplicateClip(spec, 2, originOf)).clips).toHaveLength(4);
  });

  test("the toolbar says why: «Клип не режется» and «Клип не копируется», whatever the playhead", () => {
    const selection = { kind: "clip", clipId: "clip-002", cell: 0 } as const;
    expect(selectionActions(spec, selection, 3_000, originOf)).toMatchObject({ split: { enabled: false, why: "clip-split" }, duplicate: { enabled: false, why: "clip-copy" }, remove: { enabled: true } });
    expect(selectionActions(spec, selection, 0, originOf)).toMatchObject({ split: { enabled: false, why: "clip-split" } });
    expect(actionWhyLabel("clip-split")).toBe("Клип не режется: одно фото — один раз в ролике");
    expect(actionWhyLabel("clip-copy")).toBe("Клип не копируется: одно фото — один раз в ролике");
    // The owner's own video keeps its actions.
    expect(selectionActions(spec, { kind: "clip", clipId: "clip-003", cell: 0 }, 5_000, originOf)).toMatchObject({ split: { enabled: true }, duplicate: { enabled: true } });
  });

  test("a video whose origin is not known yet is neither split nor copied, and the toolbar says it waits (fail closed)", () => {
    const selection = { kind: "clip", clipId: "clip-003", cell: 0 } as const;
    expect(splitClipAt(spec, 2, 5_000, unknown)).toEqual({ ok: false, reason: "frame-unknown" });
    expect(duplicateClip(spec, 2, unknown)).toEqual({ ok: false, reason: "frame-unknown" });
    expect(selectionActions(spec, selection, 5_000, unknown)).toMatchObject({ split: { enabled: false, why: "frame-unknown" }, duplicate: { enabled: false, why: "frame-unknown" }, remove: { enabled: true } });
    expect(actionWhyLabel("frame-unknown")).toBe("Читаем видео в кадрах — подождите");
    // A photo clip is not a video: its copy (empty cells) holds no frame.
    expect(selectionActions(spec, { kind: "clip", clipId: "clip-001", cell: 0 }, 0, unknown).duplicate).toEqual({ enabled: true });
  });

  test("the commands refuse it too", () => {
    const selection = { kind: "clip", clipId: "clip-002", cell: 0 } as const;
    expect(splitSelected(spec, selection, 3_000, originOf)).toBe("clip-frame");
    expect(duplicateSelected(spec, selection, originOf)).toBe("clip-frame");
  });
});
