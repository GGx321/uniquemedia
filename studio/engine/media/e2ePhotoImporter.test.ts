import { describe, expect, test } from "bun:test";
import { MediaSummary } from "../../shared/engine";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { createE2ePhotoImporter, E2E_PHOTO_IMPORTER_MARKER } from "./e2ePhotoImporter";
import type { MediaImportRequest } from "./imports";
import type { StagedMedia } from "./staging";
useNativeGlobals();

// The packaged E2E's stand-in photo importer (3f.1b): it exists only in an E2E build, so the smoke can drive a whole import (copy, importer,
// record) through the real engine before 3f.2 brings the real one. It keeps the staged copy as it is and reads the picture's size from a
// PNG's header; anything else is refused.

/** A PNG's first 33 bytes: the signature and an IHDR chunk of the given size (the CRC is not read). */
function pngHead(width: number, height: number): Uint8Array {
  const head = new Uint8Array(33);
  head.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  new DataView(head.buffer).setUint32(8, 13);
  head.set([0x49, 0x48, 0x44, 0x52], 12);
  new DataView(head.buffer).setUint32(16, width);
  new DataView(head.buffer).setUint32(20, height);
  return head;
}

function requestFor(format: StagedMedia["format"], head: Uint8Array): MediaImportRequest {
  const staged: StagedMedia = { stagingId: "staged-00000001", kind: "photo", format, bytes: head.length, sha256: "a".repeat(64), path: "/never/read/staged.media", head, dispose: async () => undefined };
  return {
    staged,
    name: "photo.png",
    signal: new AbortController().signal,
    workFile: () => {
      throw new Error("the stand-in makes no file");
    },
  };
}

describe("the E2E photo importer", () => {
  test("keeps the staged copy as it is and says the PNG's own size", async () => {
    const outcome = await createE2ePhotoImporter()(requestFor("png", pngHead(300, 400)));
    expect(outcome).toEqual({ ok: true, facts: { width: 300, height: 400, durationMs: null, sourceFps: null, hdrToSdr: false, loopFrames: null, delayFrames: null } });
    if (!outcome.ok) throw new Error("refused");
    expect(outcome.output).toBeUndefined();
  });

  test("its facts make a record the contract takes", async () => {
    const outcome = await createE2ePhotoImporter()(requestFor("png", pngHead(1, 1)));
    if (!outcome.ok) throw new Error("refused");
    const record = { mediaId: "media-00000001", kind: "photo", name: "a.png", bytes: 33, createdAt: "2026-10-04T10:00:00.000Z", ...outcome.facts };
    expect(MediaSummary.safeParse(record).success).toBe(true);
  });

  test("refuses a container that is not a PNG: it reads no JPEG, WebP or anything else", async () => {
    for (const format of ["jpeg", "webp", "gif", "apng"] as const) {
      expect(await createE2ePhotoImporter()(requestFor(format, pngHead(10, 10)))).toEqual({ ok: false, reason: "format" });
    }
  });

  test("refuses a PNG whose header is cut short or has no IHDR first", async () => {
    expect(await createE2ePhotoImporter()(requestFor("png", pngHead(10, 10).subarray(0, 20)))).toEqual({ ok: false, reason: "format" });
    const wrongChunk = pngHead(10, 10);
    wrongChunk.set([0x74, 0x45, 0x58, 0x74], 12);
    expect(await createE2ePhotoImporter()(requestFor("png", wrongChunk))).toEqual({ ok: false, reason: "format" });
  });

  test("refuses a picture with a side of zero, and one with a side beyond what a photo can be", async () => {
    expect(await createE2ePhotoImporter()(requestFor("png", pngHead(0, 10)))).toEqual({ ok: false, reason: "format" });
    expect(await createE2ePhotoImporter()(requestFor("png", pngHead(10, 0)))).toEqual({ ok: false, reason: "format" });
    expect(await createE2ePhotoImporter()(requestFor("png", pngHead(100_000, 10)))).toEqual({ ok: false, reason: "format" });
  });

  test("reads the staged head only: it never opens a file", async () => {
    // The path in the request does not exist; an importer that opened it would throw.
    const outcome = await createE2ePhotoImporter()(requestFor("png", pngHead(5, 6)));
    expect(outcome.ok).toBe(true);
  });

  test("carries a marker a production bundle is checked for, in its own name", () => {
    expect(E2E_PHOTO_IMPORTER_MARKER).toBe("studio-e2e-photo-importer");
    expect(createE2ePhotoImporter().name).toBe(E2E_PHOTO_IMPORTER_MARKER);
  });
});
