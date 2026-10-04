import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, open, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { tempDirFor } from "../../testing/tempDir";
import { NODE_OPEN_OPS } from "../library/openRegular";
import type { MediaLookup } from "../media/service";
import { flatApng, type Rgba } from "../media/stickerFixtures.testkit";
import { RenderFailure } from "../renderQueue/queue";
import { ownStickerSourceOf, readVerifiedOwnSticker, type OwnStickerSource } from "./ownStickers";
useNativeGlobals();

// The render reads a VERIFIED COPY of each own sticker (3f.5), as it does for an own photo (3f.2), a built-in sticker (catalogue sha256) and a
// track: ffmpeg is never pointed at the library file, so a file swapped, truncated or replaced by a link after the render was admitted changes
// nothing it reads. The bytes are inspected again with the strict APNG reader and must be the sticker the record describes. Whatever fails
// fails the job without a path in its text.

const tmp = tempDirFor({ beforeEach, afterEach }, "studio-own-stickers-");
const libraryDir = (): string => join(tmp(), "library");

beforeEach(async () => {
  await mkdir(libraryDir(), { recursive: true });
});

const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const RED: Rgba = [255, 0, 0, 255];
const GREEN: Rgba = [0, 255, 0, 255];

/** A real two-frame APNG (8 x 6, one slot a frame), stored where the library would. */
async function stored(mediaId: string, bytes: Uint8Array = flatApng([RED, GREEN]), over: Partial<OwnStickerSource> = {}): Promise<OwnStickerSource> {
  const path = join(libraryDir(), `${mediaId}.png`);
  await writeFile(path, bytes);
  return { mediaId, path, sha256: sha(bytes), bytes: bytes.length, width: 8, height: 6, loopFrames: 2, ...over };
}

const failureOf = async (work: Promise<unknown>): Promise<RenderFailure> => {
  try {
    await work;
  } catch (error) {
    if (error instanceof RenderFailure) return error;
    throw error;
  }
  throw new Error("expected a RenderFailure");
};

const signal = (): AbortSignal => new AbortController().signal;

describe("ownStickerSourceOf", () => {
  const summary = { mediaId: "media-0000001", kind: "sticker" as const, name: "a.gif", bytes: 100, createdAt: "2026-10-04T10:00:00.000Z", width: 8, height: 6, durationMs: null, sourceFps: null, hdrToSdr: false, loopFrames: 6, delayFrames: [3, 3] };
  const found = (over: Partial<MediaLookup["summary"]> = {}): MediaLookup => ({ summary: { ...summary, ...over }, path: "/library/media/media-0000001.png", sha256: "a".repeat(64), bytes: 100, format: "apng" });

  test("keeps where the file is, what it must hash to, and the size and loop the record gave", () => {
    expect(ownStickerSourceOf(found())).toEqual({ mediaId: "media-0000001", path: "/library/media/media-0000001.png", sha256: "a".repeat(64), bytes: 100, width: 8, height: 6, loopFrames: 6 });
  });

  test("is null for a record without a size or a loop (the contract's refinement makes that impossible; the render still does not guess)", () => {
    expect(ownStickerSourceOf(found({ width: null }))).toBeNull();
    expect(ownStickerSourceOf(found({ height: null }))).toBeNull();
    expect(ownStickerSourceOf(found({ loopFrames: null }))).toBeNull();
  });
});

describe("readVerifiedOwnSticker: what it answers", () => {
  test("the file's own bytes, with the loop and the canvas the strict reader found", async () => {
    const bytes = flatApng([RED, GREEN]);
    const source = await stored("media-0000001", bytes);
    const asset = await readVerifiedOwnSticker(source, signal());
    expect(asset.bytes).toEqual(bytes);
    expect([asset.loopFrames, asset.width, asset.height]).toEqual([2, 8, 6]);
  });
});

describe("readVerifiedOwnSticker: what it refuses", () => {
  test("a file whose bytes changed but whose size did not", async () => {
    const bytes = flatApng([RED, GREEN]);
    const source = await stored("media-0000001", bytes);
    const changed = Uint8Array.from(bytes);
    changed[changed.length - 20] = (changed[changed.length - 20] ?? 0) ^ 0xff;
    await writeFile(source.path, changed);
    const failure = await failureOf(readVerifiedOwnSticker(source, signal()));
    expect(failure.engineError.code).toBe("RENDER_FAILED");
  });

  test("a file that grew by one byte, shrank by one byte, or is gone", async () => {
    const bytes = flatApng([RED, GREEN]);
    const source = await stored("media-0000001", bytes);
    await writeFile(source.path, Uint8Array.from([...bytes, 0]));
    await failureOf(readVerifiedOwnSticker(source, signal()));
    await writeFile(source.path, bytes.subarray(0, bytes.length - 1));
    await failureOf(readVerifiedOwnSticker(source, signal()));
    await failureOf(readVerifiedOwnSticker({ ...source, path: join(libraryDir(), "nothing.png") }, signal()));
  });

  test("a library file that is a link, even to a file with the right bytes", async () => {
    const real = await stored("media-0000002");
    const link = join(libraryDir(), "media-0000001.png");
    await symlink(real.path, link);
    await failureOf(readVerifiedOwnSticker({ ...real, mediaId: "media-0000001", path: link }, signal()));
  });

  test.skipIf(process.platform === "win32")("a FIFO where the file should be, at once, without waiting on it", async () => {
    const real = await stored("media-0000001");
    const fifo = join(libraryDir(), "fifo.png");
    execFileSync("mkfifo", [fifo]);
    await failureOf(readVerifiedOwnSticker({ ...real, path: fifo }, signal()));
  });

  test("a handle whose size is not the record's, without a byte of it being read", async () => {
    const source = await stored("media-0000001");
    let reads = 0;
    const real = await open(source.path, "r");
    const handle = new Proxy(real, {
      get(target, property) {
        // The open's own identity check (`stat({bigint: true})`) sees the real file; the render's look at the handle's size sees a huge one.
        if (property === "stat") return async (options?: { bigint?: boolean }) => (options?.bigint === true ? target.stat({ bigint: true }) : Object.assign(Object.create(await target.stat()) as object, { size: 10 ** 12 }));
        if (property === "read") return async () => void reads++;
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    await failureOf(readVerifiedOwnSticker(source, signal(), { ...NODE_OPEN_OPS, open: async () => handle }));
    expect(reads).toBe(0);
    await real.close().catch(() => undefined);
  });

  test("a different but valid APNG of the same size, canvas and loop (the frames swapped): only its hash tells it is not the one stored", async () => {
    const stored1 = flatApng([RED, GREEN]);
    const swapped = flatApng([GREEN, RED]);
    expect(swapped.length).toBe(stored1.length);
    const source = await stored("media-0000001", stored1);
    await writeFile(source.path, swapped);
    await failureOf(readVerifiedOwnSticker(source, signal()));
  });

  test("a cancel that lands while the file is being read rejects with its reason, not as a file that went missing", async () => {
    const source = await stored("media-0000001");
    const controller = new AbortController();
    const real = await open(source.path, "r");
    const handle = new Proxy(real, {
      get(target, property) {
        if (property === "stat") {
          return async (options?: { bigint?: boolean }) => {
            if (options?.bigint !== true) controller.abort(new Error("stopped"));
            return target.stat(options);
          };
        }
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    await expect(readVerifiedOwnSticker(source, controller.signal, { ...NODE_OPEN_OPS, open: async () => handle })).rejects.toThrow("stopped");
    await real.close().catch(() => undefined);
  });

  test("a file that grew after it was measured: the read is bounded by the record's size plus one byte", async () => {
    const source = await stored("media-0000001");
    const real = await open(source.path, "r");
    let asked = 0;
    const handle = new Proxy(real, {
      get(target, property) {
        if (property === "read") {
          return async (buffer: Uint8Array, offset: number, length: number) => {
            asked += length;
            buffer.fill(9, offset, offset + length);
            return { bytesRead: length, buffer };
          };
        }
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    await failureOf(readVerifiedOwnSticker(source, signal(), { ...NODE_OPEN_OPS, open: async () => handle }));
    expect(asked).toBeLessThanOrEqual(source.bytes + 1);
    await real.close().catch(() => undefined);
  });

  test("bytes that hash to the record's but are not an APNG the strict reader takes", async () => {
    const junk = new Uint8Array(64).fill(7);
    const source = await stored("media-0000001", junk);
    await failureOf(readVerifiedOwnSticker(source, signal()));
  });

  test("an APNG whose loop is not the one the record says (the render loops at the STORED period)", async () => {
    const source = await stored("media-0000001", flatApng([RED, GREEN]), { loopFrames: 5 });
    await failureOf(readVerifiedOwnSticker(source, signal()));
  });

  test("an APNG whose canvas is not the one the record says", async () => {
    await failureOf(readVerifiedOwnSticker(await stored("media-0000001", flatApng([RED, GREEN]), { width: 9 }), signal()));
    await failureOf(readVerifiedOwnSticker(await stored("media-0000002", flatApng([RED, GREEN]), { height: 7 }), signal()));
  });

  test("a failure names no path", async () => {
    const source = await stored("media-0000001");
    await writeFile(source.path, new Uint8Array(source.bytes).fill(1));
    const failure = await failureOf(readVerifiedOwnSticker(source, signal()));
    expect(JSON.stringify(failure.engineError)).not.toContain(tmp());
    expect(failure.message).not.toContain(tmp());
    expect(failure.message).not.toContain("media-0000001");
  });

  test("a cancel rejects with the signal's reason", async () => {
    const source = await stored("media-0000001");
    const controller = new AbortController();
    controller.abort(new Error("stopped"));
    await expect(readVerifiedOwnSticker(source, controller.signal)).rejects.toThrow("stopped");
  });
});
