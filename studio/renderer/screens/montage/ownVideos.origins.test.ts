import { describe, expect, test } from "bun:test";
import type { MediaOrigin, MediaSummary } from "../../../shared/engine";
import { originOfVideos, ownVideoOf, withPlaced } from "./ownVideos";

// 5b.2 part A (S5.WA4; I5.59, I5.60): the editor knows which of its draft's own videos are clips' montage copies from their records (`MediaSummary.origin`):
// that is what the frame rule reads. A copy the editor placed a moment ago is known at once, before the media list answers for it.

const ORIGIN: MediaOrigin = { kind: "clip", avatarId: "avatar-mia-0001", clipId: "clip-0000004", photoId: "photo-mia-0002" };
const summary = (mediaId: string, origin?: MediaOrigin): MediaSummary => ({
  mediaId,
  kind: "video",
  name: "Клип 2026-10-14 12-00.mp4",
  bytes: 1_000,
  createdAt: "2026-10-14T10:00:00.000Z",
  width: 720,
  height: 1280,
  durationMs: 5_000,
  sourceFps: 24,
  hdrToSdr: false,
  loopFrames: null,
  delayFrames: null,
  ...(origin === undefined ? {} : { origin }),
});

describe("the origin of the draft's own videos", () => {
  test("a copy's record carries its origin; an own video's has none", () => {
    expect(ownVideoOf(summary("media-copy-0001", ORIGIN))?.origin).toEqual(ORIGIN);
    expect(ownVideoOf(summary("media-own-0001"))?.origin).toBeNull();
  });

  test("the origins read from the records the editor holds", () => {
    const copy = ownVideoOf(summary("media-copy-0001", ORIGIN));
    const own = ownVideoOf(summary("media-own-0001"));
    if (copy === null || own === null) throw new Error("no view");
    const originOf = originOfVideos({ held: new Map([[copy.mediaId, copy], [own.mediaId, own]]), answered: new Set([copy.mediaId, own.mediaId, "media-asked-0001"]) });
    expect(originOf("media-copy-0001")).toEqual(ORIGIN);
    // S5.WA4 round 2 (review M3): an origin is three-valued now — a copy's, null (an own video, or one the list answered for and does not hold), or
    // undefined (not answered: not known, and the frame rule fails closed on it). This used to read undefined for the own video.
    expect(originOf("media-own-0001")).toBeNull();
    expect(originOf("media-asked-0001")).toBeNull();
    expect(originOf("media-gone-0001")).toBeUndefined();
  });

  test("a copy placed by this editor is held before the list answers; the list's own record wins once it comes", () => {
    const placed = ownVideoOf(summary("media-copy-0001", ORIGIN));
    if (placed === null) throw new Error("no view");
    const before = withPlaced({ held: new Map(), answered: new Set() }, new Map([[placed.mediaId, placed]]));
    expect(before.held.get("media-copy-0001")?.origin).toEqual(ORIGIN);
    expect(before.answered.has("media-copy-0001")).toBe(true);
    const listed = { ...placed, durationMs: 4_967 };
    const after = withPlaced({ held: new Map([[listed.mediaId, listed]]), answered: new Set([listed.mediaId]) }, new Map([[placed.mediaId, placed]]));
    expect(after.held.get("media-copy-0001")?.durationMs).toBe(4_967);
  });

  test("a placed copy the library has since answered without (deleted with its clip) is not brought back", () => {
    const placed = ownVideoOf(summary("media-copy-0001", ORIGIN));
    if (placed === null) throw new Error("no view");
    const gone = withPlaced({ held: new Map(), answered: new Set(["media-copy-0001"]) }, new Map([[placed.mediaId, placed]]));
    expect(gone.held.has("media-copy-0001")).toBe(false);
  });
});
