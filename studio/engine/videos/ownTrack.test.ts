import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, open, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { tempDirFor } from "../../testing/tempDir";
import { NODE_OPEN_OPS } from "../library/openRegular";
import type { MediaLookup } from "../media/service";
import { TrackUnavailableError } from "../music/renderTrack";
import { lyingHandle } from "./testing/handleKit";
import { openOwnTrack, OwnTrackUnavailableError, ownTrackFactsOf, ownTrackSourceOf, type OwnTrackSource } from "./ownTrack";
useNativeGlobals();

// The render reads a VERIFIED COPY of an own track (3f.4), as it does for an own photo (3f.2) and a trending track (`TrackStore.openForRender`): the bytes
// are read ONCE from an open handle, within the record's size, against the record's sha256, and ffmpeg works on the private copy the runner writes.
// A file swapped, grown, shrunk or turned into a link after the render was admitted changes nothing ffmpeg reads.

const tmp = tempDirFor({ beforeEach, afterEach }, "studio-own-track-");
const libraryDir = (): string => join(tmp(), "library");
beforeEach(async () => {
  await mkdir(libraryDir(), { recursive: true });
});

const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const signal = (): AbortSignal => new AbortController().signal;
const M4A = Uint8Array.from([0, 0, 0, 0x14, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20, 0, 0, 2, 0, 1, 2, 3, 4]);
const oneAudio = async (): Promise<readonly string[]> => ["Audio"];

async function stored(bytes: Uint8Array = M4A, extra: Partial<OwnTrackSource> = {}): Promise<OwnTrackSource> {
  const path = join(libraryDir(), "media-0000001.m4a");
  await writeFile(path, bytes);
  return { mediaId: "media-0000001", path, sha256: sha(bytes), bytes: bytes.length, durationMs: 9_000, name: "my song.mp3", ...extra };
}

async function unavailable(work: Promise<unknown>): Promise<OwnTrackUnavailableError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof OwnTrackUnavailableError) return error;
    throw error;
  }
  throw new Error("expected the track to be unavailable");
}

const lookupOf = (patch: Partial<MediaLookup["summary"]> = {}, found: Partial<MediaLookup> = {}): MediaLookup => ({
  summary: { mediaId: "media-0000001", kind: "audio", name: "my song.mp3", bytes: 20, createdAt: "2026-10-04T10:00:00.000Z", width: null, height: null, durationMs: 9_000, sourceFps: null, hdrToSdr: false, loopFrames: null, delayFrames: null, ...patch },
  path: "/lib/media/media-0000001.m4a",
  sha256: "a".repeat(64),
  bytes: 20,
  format: "m4a",
  ...found,
});

describe("what the render keeps of a lookup", () => {
  test("is the stored M4A: where it is, what it must be, how long it is and what it is called", () => {
    expect(ownTrackSourceOf(lookupOf())).toEqual({ mediaId: "media-0000001", path: "/lib/media/media-0000001.m4a", sha256: "a".repeat(64), bytes: 20, durationMs: 9_000, name: "my song.mp3" });
  });

  test("is nothing for a media that is not a track", () => {
    expect(ownTrackSourceOf(lookupOf({ kind: "photo", width: 10, height: 10, durationMs: null }))).toBeNull();
  });

  test("is nothing for a track with no length", () => {
    expect(ownTrackSourceOf(lookupOf({ durationMs: null }))).toBeNull();
  });

  test.each(["mp3", "wav", "flac", "ogg", "aac", "mov", "mp4"] as const)("is nothing for a track stored as %s: only the importer's M4A is something the render's chain reads", (format) => {
    expect(ownTrackSourceOf(lookupOf({}, { format }))).toBeNull();
  });

  test("the facts a draft is judged by are the same: the decoded length of an M4A track, and nothing for the rest", () => {
    expect(ownTrackFactsOf(lookupOf())).toEqual({ durationMs: 9_000 });
    expect(ownTrackFactsOf(lookupOf({}, { format: "mp3" }))).toBeNull();
    expect(ownTrackFactsOf(lookupOf({ durationMs: null }))).toBeNull();
  });
});

describe("openOwnTrack", () => {
  test("hands over the verified bytes, never a path, with the record's length and the file's name", async () => {
    const source = await stored();
    const track = await openOwnTrack(source, signal(), oneAudio);
    expect(track.data).toEqual(M4A);
    expect(track).toMatchObject({ bytes: M4A.length, sha256: sha(M4A), decodedMs: 9_000, title: "my song.mp3", artist: null });
    expect(JSON.stringify(track)).not.toContain(tmp());
  });

  test("a change to the library file after the read does not reach the bytes it handed over", async () => {
    const source = await stored();
    const track = await openOwnTrack(source, signal(), oneAudio);
    await writeFile(source.path, Uint8Array.from([9, 9, 9]));
    expect(track.data).toEqual(M4A);
  });

  test("its text for the verifier is the tags of the stored file (a stored track has none)", async () => {
    const track = await openOwnTrack(await stored(), signal(), oneAudio);
    expect(track.forbidden).toEqual([]);
  });

  test("a file whose bytes changed but whose size did not is unavailable", async () => {
    const source = await stored();
    const changed = Uint8Array.from(M4A);
    changed[19] = 99;
    await writeFile(source.path, changed);
    await unavailable(openOwnTrack(source, signal(), oneAudio));
  });

  test("a file that grew by one byte is unavailable", async () => {
    const source = await stored();
    await writeFile(source.path, Uint8Array.from([...M4A, 0]));
    await unavailable(openOwnTrack(source, signal(), oneAudio));
  });

  test("a file that shrank by one byte is unavailable", async () => {
    const source = await stored();
    await writeFile(source.path, M4A.subarray(0, M4A.length - 1));
    await unavailable(openOwnTrack(source, signal(), oneAudio));
  });

  test("a file that is gone is unavailable", async () => {
    const source = await stored();
    await unavailable(openOwnTrack({ ...source, path: join(libraryDir(), "nothing.m4a") }, signal(), oneAudio));
  });

  test("a folder where the file should be is unavailable", async () => {
    const source = await stored();
    const folder = join(libraryDir(), "a-folder.m4a");
    await mkdir(folder);
    await unavailable(openOwnTrack({ ...source, path: folder }, signal(), oneAudio));
  });

  test("a library file that is a link is unavailable, even to a file with the right bytes", async () => {
    const real = await stored();
    const link = join(libraryDir(), "link.m4a");
    await symlink(real.path, link);
    await unavailable(openOwnTrack({ ...real, path: link }, signal(), oneAudio));
  });

  test.skipIf(process.platform === "win32")("a FIFO where the file should be is refused at once, not waited on", async () => {
    const source = await stored();
    const fifo = join(libraryDir(), "fifo.m4a");
    execFileSync("mkfifo", [fifo]);
    await unavailable(openOwnTrack({ ...source, path: fifo }, signal(), oneAudio));
  });

  test("a handle whose size is not the record's is refused without a byte of it being read", async () => {
    const source = await stored();
    const real = await open(source.path, "r");
    // The stat keeps `isFile` and the identity, so `openRegularNoFollow` lets the handle through and it is the SIZE check that refuses it.
    const lying = lyingHandle(real, { lyingSize: 10 ** 12, fill: "none" });
    await unavailable(openOwnTrack(source, signal(), oneAudio, { ...NODE_OPEN_OPS, open: async () => lying.handle }));
    expect(lying.reads()).toBe(0);
    await real.close().catch(() => undefined);
  });

  test("a file that grew after it was measured is refused: the read is bounded by the record's size plus one byte", async () => {
    const source = await stored();
    const real = await open(source.path, "r");
    // The handle says the size the record says, and then never stops giving bytes: a file that keeps growing.
    const growing = lyingHandle(real, { fill: "all" });
    await unavailable(openOwnTrack(source, signal(), oneAudio, { ...NODE_OPEN_OPS, open: async () => growing.handle }));
    expect(growing.asked()).toBeLessThanOrEqual(source.bytes + 1);
    expect(growing.asked()).toBeGreaterThan(0);
    await real.close().catch(() => undefined);
  });

  test("an unavailable track names no path", async () => {
    const source = await stored();
    await writeFile(source.path, Uint8Array.from([1, 2, 3]));
    const error = await unavailable(openOwnTrack(source, signal(), oneAudio));
    expect(error.message).not.toContain(tmp());
    expect(JSON.stringify(error)).not.toContain(tmp());
  });

  test("a cancel rejects with the signal's reason, not as an unavailable track", async () => {
    const source = await stored();
    const controller = new AbortController();
    controller.abort(new Error("stopped"));
    await expect(openOwnTrack(source, controller.signal, oneAudio)).rejects.toThrow("stopped");
  });
});

describe("the check ffmpeg is asked to make of the render's private copy", () => {
  test("passes one audio stream", async () => {
    const track = await openOwnTrack(await stored(), signal(), oneAudio);
    await track.check("/job/track.m4a", signal());
  });

  test.each([[[]], [["Video"]], [["Audio", "Video"]], [["Audio", "Audio"]], [["Subtitle"]]])("refuses %j as not-audio", async (kinds) => {
    const track = await openOwnTrack(await stored(), signal(), async () => kinds);
    await expect(track.check("/job/track.m4a", signal())).rejects.toBeInstanceOf(TrackUnavailableError);
  });

  test("an ffmpeg that could not be asked is not-audio too", async () => {
    const track = await openOwnTrack(await stored(), signal(), async () => Promise.reject(new Error("spawn failed")));
    await expect(track.check("/job/track.m4a", signal())).rejects.toMatchObject({ kind: "not-audio" });
  });

  test("a cancel during the check is the signal's own reason", async () => {
    const controller = new AbortController();
    const track = await openOwnTrack(await stored(), signal(), async (_path, checkSignal) => {
      controller.abort(new Error("stopped"));
      checkSignal.throwIfAborted();
      return ["Audio"];
    });
    await expect(track.check("/job/track.m4a", controller.signal)).rejects.toThrow("stopped");
  });

  test("asks about the PRIVATE COPY it is given, not the library file", async () => {
    const asked: string[] = [];
    const source = await stored();
    const track = await openOwnTrack(source, signal(), async (path) => (asked.push(path), ["Audio"]));
    await track.check("/job/track.m4a", signal());
    expect(asked).toEqual(["/job/track.m4a"]);
    expect(asked).not.toContain(source.path);
  });
});

describe("the bytes it hands over are the bytes on disk", () => {
  test("a larger file round-trips exactly", async () => {
    const big = new Uint8Array(300_000).map((_, i) => (i * 31) % 251);
    const source = await stored(big);
    expect((await openOwnTrack(source, signal(), oneAudio)).data).toEqual(big);
    expect(new Uint8Array(await readFile(source.path))).toEqual(big);
  });
});
