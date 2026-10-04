import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { tempDirFor } from "../../testing/tempDir";
import type { MediaLookup } from "../media/service";
import { RenderFailure } from "../renderQueue/queue";
import { copyOwnVideos, ownVideoCopyName, ownVideoFactsOf, OwnVideoUnavailableError, ownVideoSourceOf, type OwnVideoSource } from "./ownVideos";
useNativeGlobals();

// The render's private copy of each own video (3f.3b). `MediaService.lookup` answers where a stored mezzanine is and what it must hash to; the render does NOT point
// ffmpeg at that file: each mezzanine is STREAMED into the job folder, verified as it goes (`ownMedia.ts`'s `copyVerifiedOwnMedia`), and ffmpeg reads the copy.

const tmp = tempDirFor({ beforeEach, afterEach }, "studio-own-videos-");
const libraryDir = (): string => join(tmp(), "library");
const jobDir = (): string => join(tmp(), "job");
beforeEach(async () => {
  await mkdir(libraryDir(), { recursive: true });
  await mkdir(jobDir(), { recursive: true });
});

const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const pattern = (length: number, seed = 1) => Uint8Array.from({ length }, (_, i) => (i * 13 + seed) & 0xff);
const signal = (): AbortSignal => new AbortController().signal;
const IO = { freeBytes: async () => null, chunkBytes: 16 };

async function stored(mediaId: string, bytes: Uint8Array): Promise<OwnVideoSource> {
  const path = join(libraryDir(), `${mediaId}.mp4`);
  await writeFile(path, bytes);
  return { mediaId, path, sha256: sha(bytes), bytes: bytes.length, width: 1080, height: 570, durationMs: 3_000 };
}

const lookupOf = (patch: Partial<MediaLookup["summary"]> = {}, found: Partial<MediaLookup> = {}): MediaLookup => ({
  summary: { mediaId: "media-0000001", kind: "video", name: "holiday.mov", bytes: 5_000_000, createdAt: "2026-10-04T10:00:00.000Z", width: 1080, height: 570, durationMs: 3_000, sourceFps: 29.97, hdrToSdr: false, loopFrames: null, delayFrames: null, ...patch },
  path: "/lib/media/media-0000001.mp4",
  sha256: "a".repeat(64),
  bytes: 5_000_000,
  format: "mp4",
  ...found,
});

describe("ownVideoFactsOf", () => {
  test("is the stored size and the decoded length of a library media that IS a video the render can read", () => {
    expect(ownVideoFactsOf(lookupOf())).toEqual({ width: 1080, height: 570, durationMs: 3_000 });
  });

  test("is null for a media that is not a video", () => {
    expect(ownVideoFactsOf(lookupOf({ kind: "audio", width: null, height: null }))).toBeNull();
    expect(ownVideoFactsOf(lookupOf({ kind: "photo", durationMs: null, sourceFps: null }))).toBeNull();
  });

  test("is null for a video the importer did not store as its MP4 mezzanine", () => {
    expect(ownVideoFactsOf(lookupOf({}, { format: "mov" }))).toBeNull();
  });

  test("is null when the record has no size or no length", () => {
    expect(ownVideoFactsOf(lookupOf({ width: null }))).toBeNull();
    expect(ownVideoFactsOf(lookupOf({ height: null }))).toBeNull();
    expect(ownVideoFactsOf(lookupOf({ durationMs: null }))).toBeNull();
  });
});

describe("ownVideoSourceOf", () => {
  test("keeps where the file is, what it must be, its stored size and its length, and nothing the renderer sent", () => {
    expect(ownVideoSourceOf(lookupOf())).toEqual({ mediaId: "media-0000001", path: "/lib/media/media-0000001.mp4", sha256: "a".repeat(64), bytes: 5_000_000, width: 1080, height: 570, durationMs: 3_000 });
  });

  test("is null for what the render cannot read", () => {
    expect(ownVideoSourceOf(lookupOf({ kind: "audio", width: null, height: null }))).toBeNull();
    expect(ownVideoSourceOf(lookupOf({}, { format: "mov" }))).toBeNull();
  });
});

describe("ownVideoCopyName", () => {
  test("names the copy after the media id, in the job folder", () => {
    expect(ownVideoCopyName("media-0000001")).toBe("own-media-0000001.mp4");
  });

  test("two media never share a name, and a video's copy is not an own photo's", () => {
    expect(ownVideoCopyName("media-0000001")).not.toBe(ownVideoCopyName("media-0000002"));
    expect(ownVideoCopyName("media-0000001")).not.toBe("own-media-0000001.jpg");
  });
});

describe("copyOwnVideos", () => {
  test("writes a byte-identical private copy of each video into the job folder", async () => {
    const a = await stored("media-0000001", pattern(100, 1));
    const b = await stored("media-0000002", pattern(70, 2));
    await copyOwnVideos(jobDir(), [a, b], signal(), IO);
    expect(new Uint8Array(await readFile(join(jobDir(), ownVideoCopyName("media-0000001"))))).toEqual(pattern(100, 1));
    expect(new Uint8Array(await readFile(join(jobDir(), ownVideoCopyName("media-0000002"))))).toEqual(pattern(70, 2));
  });

  test("copies nothing for no videos", async () => {
    await copyOwnVideos(jobDir(), [], signal(), IO);
    expect(await readdir(jobDir())).toEqual([]);
  });

  test("a video whose bytes changed fails the copy as OwnVideoUnavailableError naming the media (an id) and no path, and leaves no partial copy of it", async () => {
    const a = await stored("media-0000001", pattern(100, 1));
    await writeFile(a.path, pattern(100, 5));
    try {
      await copyOwnVideos(jobDir(), [a], signal(), IO);
      throw new Error("expected a failure");
    } catch (error) {
      expect(error).toBeInstanceOf(OwnVideoUnavailableError);
      if (!(error instanceof OwnVideoUnavailableError)) throw error;
      expect(error.mediaId).toBe("media-0000001");
      expect(error.message).not.toContain(tmp());
      expect(error.message).not.toContain("media-0000001");
    }
    expect(await readdir(jobDir())).toEqual([]);
  });

  test("stops at the first video that fails: a later one is never copied", async () => {
    const a = await stored("media-0000001", pattern(100, 1));
    const b = await stored("media-0000002", pattern(70, 2));
    await writeFile(a.path, pattern(100, 5));
    await expect(copyOwnVideos(jobDir(), [a, b], signal(), IO)).rejects.toBeInstanceOf(OwnVideoUnavailableError);
    expect(await readdir(jobDir())).toEqual([]);
  });

  test("a full disk is NOT the media being unavailable: it comes out as the render's own RENDER_FAILED, so the owner is not told the file is gone", async () => {
    const a = await stored("media-0000001", pattern(100, 1));
    const error = await copyOwnVideos(jobDir(), [a], signal(), { ...IO, freeBytes: async () => 1 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RenderFailure);
    expect(error).not.toBeInstanceOf(OwnVideoUnavailableError);
    expect(await readdir(jobDir())).toEqual([]);
  });

  test("a cancel before the next video is copied stops it and leaves nothing", async () => {
    const a = await stored("media-0000001", pattern(100, 1));
    const controller = new AbortController();
    controller.abort(new Error("stopped"));
    await expect(copyOwnVideos(jobDir(), [a], controller.signal, IO)).rejects.toThrow("stopped");
    expect(await readdir(jobDir())).toEqual([]);
  });
});
