import { describe, expect, test } from "bun:test";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { servedMediaRecord } from "./mediaRecords";
useNativeGlobals();

// What main reads of a record to SERVE a stored file (3f.2's `media/<id>` route, 3f.5's `media.stickerBytes`): which file to open and what it must be.
// 3f.5 adds the hash and the canvas and loop the stored sticker was made with, so main can check the exact bytes it sends.

const record = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  schemaVersion: 1,
  id: "media-0000001",
  kind: "sticker",
  name: "party.gif",
  createdAt: "2026-10-04T10:00:00.000Z",
  bytes: 1234,
  sha256: "b".repeat(64),
  format: "apng",
  file: "media-0000001.png",
  width: 12,
  height: 8,
  durationMs: null,
  sourceFps: null,
  hdrToSdr: false,
  loopFrames: 6,
  delayFrames: [3, 3],
  ...patch,
});

describe("servedMediaRecord", () => {
  test("answers the file, its size and format, and what its bytes must be: the hash, the canvas and the loop", () => {
    expect(servedMediaRecord(record())).toEqual({ id: "media-0000001", kind: "sticker", format: "apng", bytes: 1234, file: "media-0000001.png", sha256: "b".repeat(64), width: 12, height: 8, loopFrames: 6 });
  });

  test("a photo has a canvas and no loop", () => {
    const served = servedMediaRecord(record({ kind: "photo", format: "jpeg", file: "media-0000001.jpg", loopFrames: null, delayFrames: null }));
    expect(served).toMatchObject({ kind: "photo", width: 12, height: 8, loopFrames: null });
  });

  test("a track has neither canvas nor loop", () => {
    const served = servedMediaRecord(record({ kind: "audio", format: "m4a", file: "media-0000001.m4a", width: null, height: null, durationMs: 1000, loopFrames: null, delayFrames: null }));
    expect(served).toMatchObject({ kind: "audio", width: null, height: null, loopFrames: null });
  });

  test("a record without a hash is not served", () => {
    const { sha256: _omitted, ...without } = record();
    expect(servedMediaRecord(without)).toBeNull();
    expect(servedMediaRecord(record({ sha256: "not a hash" }))).toBeNull();
  });
});
