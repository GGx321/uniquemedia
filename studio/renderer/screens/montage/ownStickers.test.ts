import { describe, expect, test } from "bun:test";
import type { MediaSummary } from "../../../shared/engine";
import { applyHeldChange, type MediaChange } from "./ownMedia";
import { ownStickerOf, type OwnSticker } from "./ownStickers";

/** The own stickers held after one change, as `useOwnStickers` keeps them (`useMediaRecords` with `ownStickerOf`). */
const applyMediaChange = (held: ReadonlyMap<string, OwnSticker>, change: MediaChange): ReadonlyMap<string, OwnSticker> => applyHeldChange(held, change, ownStickerOf);

// 3f.5: the editor's picture of the owner's own stickers: what the preview needs of each (its canvas, its loop and its per-frame delays), kept from
// `media.list` and `media.changed`. Pure: the hook that feeds it is exercised by the editor's own test (EditorPreview.test.tsx).

const summary = (over: Partial<MediaSummary> = {}): MediaSummary => ({
  mediaId: "media-0000001",
  kind: "sticker",
  name: "party.gif",
  bytes: 1000,
  createdAt: "2026-10-04T10:00:00.000Z",
  width: 12,
  height: 8,
  durationMs: null,
  sourceFps: null,
  hdrToSdr: false,
  loopFrames: 6,
  delayFrames: [3, 3],
  ...over,
});

describe("ownStickerOf", () => {
  test("keeps the canvas, the loop and the delays of a sticker's record", () => {
    expect(ownStickerOf(summary())).toEqual({ mediaId: "media-0000001", width: 12, height: 8, loopFrames: 6, delayFrames: [3, 3] });
  });

  test("is null for a record that is not a sticker", () => {
    expect(ownStickerOf(summary({ kind: "photo", loopFrames: null, delayFrames: null }))).toBeNull();
  });

  test("is null for a sticker record with no canvas or loop (the contract makes that impossible; the preview does not guess)", () => {
    expect(ownStickerOf({ ...summary(), width: null })).toBeNull();
    expect(ownStickerOf({ ...summary(), loopFrames: null })).toBeNull();
    expect(ownStickerOf({ ...summary(), delayFrames: null })).toBeNull();
  });
});

describe("applyMediaChange", () => {
  const empty = new Map<string, OwnSticker>();

  test("an upserted sticker is kept", () => {
    const next = applyMediaChange(empty, { change: "upserted", media: summary() });
    expect([...next.keys()]).toEqual(["media-0000001"]);
  });

  test("an upserted record replaces the one it had under its id", () => {
    const first = applyMediaChange(empty, { change: "upserted", media: summary() });
    const next = applyMediaChange(first, { change: "upserted", media: summary({ width: 20 }) });
    expect(next.get("media-0000001")?.width).toBe(20);
  });

  test("an upserted record that is not a sticker changes nothing", () => {
    const next = applyMediaChange(empty, { change: "upserted", media: summary({ kind: "photo", loopFrames: null, delayFrames: null }) });
    expect(next).toBe(empty);
  });

  test("a removed media leaves the map; one it never had changes nothing", () => {
    const held = applyMediaChange(empty, { change: "upserted", media: summary() });
    expect(applyMediaChange(held, { change: "removed", mediaId: "media-0000001" }).size).toBe(0);
    expect(applyMediaChange(held, { change: "removed", mediaId: "media-0000009" })).toBe(held);
  });

  test("never changes the map it was given", () => {
    const held = applyMediaChange(empty, { change: "upserted", media: summary() });
    applyMediaChange(held, { change: "removed", mediaId: "media-0000001" });
    expect(held.size).toBe(1);
  });
});
