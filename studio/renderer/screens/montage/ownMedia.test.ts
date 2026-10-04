import { describe, expect, test } from "bun:test";
import type { MediaSummary, MontageDraft } from "../../../shared/engine";
import { changeTouches, draftMediaIds } from "./ownMedia";
import { draftSpec, photoClip, stickerLayer, videoClip } from "./testkit";

// 3f.3b fix round 1 (M1): the engine's verdict on the open draft is read again when the library changes under one of the draft's own files (deleted in
// «Мои», another window, a record replaced): a `media.changed` that touches an own photo, video, sticker or track the draft names. A change to a file the
// draft does not name reads nothing.

const own = (mediaId: string): MontageDraft["clips"][number] => ({ ...photoClip(0, "photo-mia-0001"), clipId: "clip-009", cell: { photo: { source: "own", mediaId }, focus: null } });
const spec: MontageDraft = draftSpec([own("media-photo-0001"), { ...videoClip(1), mediaId: "media-video-0001" }], {
  layers: [{ ...stickerLayer(0, 0, 1_000), sticker: { source: "own", mediaId: "media-stick-0001" } }, stickerLayer(1, 0, 1_000)],
  music: { source: "own", mediaId: "media-track-0001", startMs: 0 },
});

const summary = (mediaId: string): MediaSummary => ({
  mediaId,
  kind: "video",
  name: "x.mov",
  bytes: 10,
  createdAt: "2026-10-04T10:00:00.000Z",
  width: 10,
  height: 10,
  durationMs: 1_000,
  sourceFps: 30,
  hdrToSdr: false,
  loopFrames: null,
  delayFrames: null,
});

describe("draftMediaIds", () => {
  test("every own file the draft names: a photo in a cell, a video clip, a sticker layer, the track", () => {
    expect([...draftMediaIds(spec)].sort()).toEqual(["media-photo-0001", "media-stick-0001", "media-track-0001", "media-video-0001"]);
  });

  test("none for a draft of scene photos, built-in stickers and a trending track", () => {
    expect(draftMediaIds(draftSpec(2, { layers: [stickerLayer(0, 0, 1_000)], music: { source: "trending", trackId: "track-0000001", startMs: 0 } })).size).toBe(0);
  });
});

describe("changeTouches", () => {
  const ids = draftMediaIds(spec);

  test("a file the draft names removed or replaced touches it", () => {
    expect(changeTouches({ change: "removed", mediaId: "media-video-0001" }, ids)).toBe(true);
    expect(changeTouches({ change: "removed", mediaId: "media-photo-0001" }, ids)).toBe(true);
    expect(changeTouches({ change: "removed", mediaId: "media-stick-0001" }, ids)).toBe(true);
    expect(changeTouches({ change: "upserted", media: summary("media-track-0001") }, ids)).toBe(true);
  });

  test("a file the draft does not name does not", () => {
    expect(changeTouches({ change: "removed", mediaId: "media-other-0001" }, ids)).toBe(false);
    expect(changeTouches({ change: "upserted", media: summary("media-other-0002") }, ids)).toBe(false);
  });
});
