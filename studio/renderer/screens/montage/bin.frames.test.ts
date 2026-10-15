import { describe, expect, test } from "bun:test";
import type { MediaOrigin, MontageDraft, PhotoSummary } from "../../../shared/engine";
import { scenePhoto } from "../../engine/mockEngine.testkit";
import { binTiles, tileAction } from "./bin";
import { copyFramePhotoIds, type OriginOf } from "./clipOps";
import { draftSpec, photoClip } from "./testkit";

// 5b.2 part A (S5.WA4; plan I5.60, Q-F = 1; mockup 57e): in the «Фото» tab a photo whose clip copy is in the draft is that clip's frame. It stays in the
// bin with its number, dimmed with «клип этого фото уже в ролике», and a click or a drag cannot add it (the bin's `taken`). A photo placed itself is still
// «в кадре N»; with no origins known (the media list not answered yet) nothing changes.

const id = (n: number): string => `photo-mia-${String(n).padStart(4, "0")}`;
const PHOTOS: PhotoSummary[] = [scenePhoto(1), scenePhoto(2), scenePhoto(3)];
const COPY = "media-copy-0001";
const OWN = "media-own-0001";
const ORIGIN: MediaOrigin = { kind: "clip", avatarId: "avatar-mia-0001", clipId: "clip-0000004", photoId: id(2) };
const originOf: OriginOf = (mediaId) => (mediaId === COPY ? ORIGIN : undefined);
const video = (index: number, mediaId: string): MontageDraft["clips"][number] => ({ clipId: `clip-${String(index + 1).padStart(3, "0")}`, durationMs: 2_000, transitionIn: "cut", kind: "video", mediaId, trimStartMs: 0, focus: null });
/** Photo 1 in clip 1, the copy of photo 2's clip as clip 2, an own video as clip 3. */
const SPEC = draftSpec([photoClip(0, id(1)), video(1, COPY), video(2, OWN)]);
const ALL = { unusedOnly: false, category: null } as const;

describe("the photo of a clip copy in the draft (57e)", () => {
  test("the copies' frames are the photos their clips were made from; an own video holds none", () => {
    expect([...copyFramePhotoIds(SPEC, originOf)]).toEqual([id(2)]);
    expect([...copyFramePhotoIds(SPEC)]).toEqual([]);
  });

  test("its tile keeps its number and is `clip-in`: taken, whatever a click would otherwise do", () => {
    const tiles = binTiles(PHOTOS, SPEC, ALL, copyFramePhotoIds(SPEC, originOf));
    expect(tiles.map((t) => [t.n, t.slot, t.state])).toEqual([
      [1, 1, "placed"],
      [2, null, "clip-in"],
      [3, null, "free"],
    ]);
    const clipIn = tiles[1];
    if (clipIn === undefined) throw new Error("no tile");
    expect(tileAction(clipIn, null, null)).toBe("taken");
    expect(tileAction(clipIn, { clip: 0, cell: 0 }, null)).toBe("taken");
    expect(tileAction(clipIn, null, "clip-cap")).toBe("taken");
  });

  test("a photo placed itself is `placed`, even if a copy of its clip were in the draft too", () => {
    const both = draftSpec([photoClip(0, id(2)), video(1, COPY)]);
    expect(binTiles(PHOTOS, both, ALL, copyFramePhotoIds(both, originOf))[1]).toMatchObject({ n: 2, slot: 1, state: "placed" });
  });

  test("no origins known yet: the photo reads free, as before 5b.2", () => {
    expect(binTiles(PHOTOS, SPEC, ALL)[1]).toMatchObject({ n: 2, state: "free" });
  });
});
