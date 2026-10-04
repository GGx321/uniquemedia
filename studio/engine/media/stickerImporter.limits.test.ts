import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FfmpegSpawner } from "../../node/runFfmpeg";
import { MediaUnsupportedReason } from "../../shared/engine";
import { buildGif, concatBytes, descriptor, gce, gifHeader, lzwCompress, subBlocks, TEST_PALETTE, TRAILER } from "../../shared/stickers/gif.testkit";
import { decodeFrames } from "../../scripts/stickers/apngDecode.testkit";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { tempDirFor } from "../../testing/tempDir";
import { MAX_ANIMATION_LOOP_PIXELS } from "../render/layerPass";
import { encodeStickerFrames } from "../stickers/encodeJob";
import { exitingChild, progressChild, recordingSpawner } from "./ffmpegChildren.testkit";
import type { MediaImportOutcome } from "./imports";
import { handoff } from "./photoFixtures.testkit";
import { flatApng, flatGif, repeatedFramesApng, withDelays, type Rgba } from "./stickerFixtures.testkit";
import { createStickerImporter, RAW_FREE_MARGIN_BYTES, type StickerImporterDeps } from "./stickerImporter";
useNativeGlobals();

// The own-sticker importer, fix round 1 of 3f.5: the decoder's pixel cap with room for its stride alignment, the raw work file bounded and the disk
// asked before it is written, an APNG loop that ends on half a slot, the transparent background of a GIF, and the bytes ffmpeg reads being the bytes
// that were judged. The importer's main behaviour is in stickerImporter.test.ts.

const tmp = tempDirFor({ beforeEach, afterEach }, "studio-sticker-limits-");

const encodeHere: StickerImporterDeps["encode"] = async (job, signal) => {
  signal.throwIfAborted();
  const raw = readFileSync(job.rawPath);
  const frameBytes = job.width * job.height * 4;
  return encodeStickerFrames(job, (index, into) => into.set(raw.subarray(index * frameBytes, (index + 1) * frameBytes)));
};

async function run(bytes: Uint8Array, format: "gif" | "apng", extra: Partial<StickerImporterDeps> = {}): Promise<MediaImportOutcome> {
  const hand = await handoff(tmp(), bytes, { format, kind: "sticker" });
  return createStickerImporter({ encode: encodeHere, ...extra })(hand.request);
}

const reasonOf = (outcome: MediaImportOutcome): MediaUnsupportedReason | "accepted" => (outcome.ok ? "accepted" : outcome.reason);

async function stored(outcome: MediaImportOutcome): Promise<{ bytes: Uint8Array; width: number; height: number; loopFrames: number; delayFrames: readonly number[] }> {
  if (!outcome.ok || outcome.output === undefined) throw new Error(`refused: ${outcome.ok ? "no output" : outcome.reason}`);
  return {
    bytes: new Uint8Array(await readFile(outcome.output.file.path)),
    width: outcome.facts.width ?? -1,
    height: outcome.facts.height ?? -1,
    loopFrames: outcome.facts.loopFrames ?? -1,
    delayFrames: outcome.facts.delayFrames ?? [],
  };
}

function pixelOf(file: { bytes: Uint8Array; width: number; height: number }, frame: number, x: number, y: number): Rgba {
  const data = decodeFrames(file.bytes, file.width, file.height)[frame] ?? new Uint8Array(0);
  const at = (y * file.width + x) * 4;
  return [data[at] ?? -1, data[at + 1] ?? -1, data[at + 2] ?? -1, data[at + 3] ?? -1];
}

const argOf = (argv: readonly string[], flag: string): string | undefined => argv[argv.indexOf(flag) + 1];

describe("the decoder's pixel cap (M1)", () => {
  test("leaves room for the decoder's stride alignment: a 720 px row aligned up to 64 bytes, times 720 rows, fits under it", async () => {
    const calls: string[][] = [];
    await stored(await run(flatGif([0, 1], [10, 10]), "gif", { spawner: recordingSpawner(calls) }));
    expect(calls.length).toBeGreaterThan(0);
    for (const argv of calls) {
      const cap = Number(argOf(argv, "-max_pixels"));
      expect(cap).toBeGreaterThanOrEqual(Math.ceil(720 / 64) * 64 * 720);
      expect(cap).toBeLessThanOrEqual(1024 * 720);
    }
  });

  test("a 720 x 720 GIF of two frames is stored whole (the widest canvas a sticker may have)", async () => {
    const picture = lzwCompress(new Uint8Array(720 * 720).fill(1));
    const gif = buildGif({ width: 720, height: 720, frames: [{ delayCs: 10, indices: [], rawData: picture }, { delayCs: 10, indices: [], rawData: picture }] });
    const file = await stored(await run(gif, "gif"));
    expect([file.width, file.height, file.loopFrames]).toEqual([720, 720, 6]);
  });
});

describe("the raw work file (M2)", () => {
  const spawnNever = (calls: string[][]): FfmpegSpawner => () => {
    calls.push([]);
    throw new Error("ffmpeg must not be started");
  };

  test("source frames times canvas over what the layer pass can hold is dimensions, before any ffmpeg, however short the loop is", async () => {
    const frames = Math.floor(MAX_ANIMATION_LOOP_PIXELS / (720 * 720)) + 1;
    const apng = repeatedFramesApng(720, 720, frames, [1, 1000]);
    const calls: string[][] = [];
    expect(reasonOf(await run(apng, "apng", { spawner: spawnNever(calls) }))).toBe("dimensions");
    expect(calls).toHaveLength(0);
  });

  test("a disk with less room than the raw frames and the margin is no-space, and the pixel decode is never started", async () => {
    const calls: string[][] = [];
    const needed = 3 * 8 * 6 * 4;
    const outcome = await run(flatGif([0, 1, 2], [10, 10, 10]), "gif", { spawner: recordingSpawner(calls), freeBytes: async () => needed + RAW_FREE_MARGIN_BYTES - 1 });
    expect(reasonOf(outcome)).toBe("no-space");
    expect(calls).toHaveLength(1);
  });

  test("a disk with exactly the raw frames and the margin is enough", async () => {
    const needed = 3 * 8 * 6 * 4;
    const outcome = await run(flatGif([0, 1, 2], [10, 10, 10]), "gif", { freeBytes: async () => needed + RAW_FREE_MARGIN_BYTES });
    expect(reasonOf(outcome)).toBe("accepted");
  });

  test("a disk whose free room cannot be told does not refuse the file", async () => {
    expect(reasonOf(await run(flatGif([0, 1], [10, 10]), "gif", { freeBytes: async () => null }))).toBe("accepted");
  });

  test("the folder asked for room is the one the raw file goes to", async () => {
    const asked: string[] = [];
    const hand = await handoff(tmp(), flatGif([0, 1], [10, 10]), { format: "gif", kind: "sticker" });
    const outcome = await createStickerImporter({ encode: encodeHere, freeBytes: async (dir) => (asked.push(dir), null) })(hand.request);
    expect(outcome.ok).toBe(true);
    expect(asked.length).toBeGreaterThan(0);
    expect(new Set(asked)).toEqual(new Set([tmp()]));
  });

  test("a pixel decode that fails on a disk with room left is failed, not a wrong file", async () => {
    let call = 0;
    const spawner: FfmpegSpawner = (command, args, options) => (call++ === 0 ? recordingSpawner([])(command, args, options) : exitingChild(1, { stderrText: "Error writing output" }));
    expect(reasonOf(await run(flatGif([0, 1, 2], [10, 10, 10]), "gif", { spawner, freeBytes: async () => 1e12 }))).toBe("failed");
  });

  test("a pixel decode that fails because the disk filled up meanwhile is no-space, not a wrong file", async () => {
    let call = 0;
    const spawner: FfmpegSpawner = (command, args, options) => (call++ === 0 ? recordingSpawner([])(command, args, options) : exitingChild(1, { stderrText: "No space left on device" }));
    let asked = 0;
    const freeBytes = async (): Promise<number> => (asked++ === 0 ? 1e12 : 0);
    expect(reasonOf(await run(flatGif([0, 1, 2], [10, 10, 10]), "gif", { spawner, freeBytes }))).toBe("no-space");
  });

  test("a count decode that fails stays a wrong file: -xerror on the file itself", async () => {
    const spawner: FfmpegSpawner = () => exitingChild(1, { stderrText: "Invalid data" });
    expect(reasonOf(await run(flatGif([0, 1, 2], [10, 10, 10]), "gif", { spawner, freeBytes: async () => 1e12 }))).toBe("format");
  });
});

describe("an APNG loop that ends on half a slot (L3)", () => {
  const HALF: readonly (readonly [number, number])[] = [[1, 120], [1, 120], [1, 15]];
  const half = (): Uint8Array =>
    withDelays(
      flatApng([
        [255, 0, 0, 255],
        [0, 255, 0, 255],
        [0, 0, 255, 255],
      ]),
      HALF,
    );

  test("is taken whichever way the demuxer's rounding of the delays falls, and stored by the exact rule (a half rounds up)", async () => {
    const file = await stored(await run(half(), "apng"));
    expect([file.loopFrames, file.delayFrames]).toEqual([3, [1, 2]]);
  });

  test("a count one below the loop is accepted at a half", async () => {
    let call = 0;
    const spawner: FfmpegSpawner = (command, args, options) => (call++ === 0 ? progressChild(2) : recordingSpawner([])(command, args, options));
    expect(reasonOf(await run(half(), "apng", { spawner }))).toBe("accepted");
  });

  test("a count one above the loop is accepted at a half", async () => {
    let call = 0;
    const spawner: FfmpegSpawner = (command, args, options) => (call++ === 0 ? progressChild(4) : recordingSpawner([])(command, args, options));
    expect(reasonOf(await run(half(), "apng", { spawner }))).toBe("accepted");
  });

  test("a count two off is still a wrong file, even at a half", async () => {
    const spawner: FfmpegSpawner = () => progressChild(1);
    expect(reasonOf(await run(half(), "apng", { spawner }))).toBe("format");
  });

  test("away from a half a count one off is a wrong file", async () => {
    const whole = withDelays(
      flatApng([
        [255, 0, 0, 255],
        [0, 255, 0, 255],
      ]),
      [[1, 15], [1, 15]],
    );
    const spawner: FfmpegSpawner = () => progressChild(3);
    expect(reasonOf(await run(whole, "apng", { spawner }))).toBe("format");
  });
});

describe("the background of a GIF (L4)", () => {
  /** A 8 x 8 screen, a global table of 4 colours whose background index is 2 (blue); frame 0 is a red 4 x 4 at the corner with no transparency, frame 1 is green over the whole screen. */
  function cornerGif(): Uint8Array {
    const screen = Uint8Array.from([8, 0, 8, 0, 0b1111_0001, 2, 0, ...TEST_PALETTE]);
    const first = concatBytes([gce(10), descriptor(0, 0, 4, 4), Uint8Array.of(2), subBlocks(lzwCompress(new Uint8Array(16).fill(0)))]);
    const second = concatBytes([gce(10), descriptor(0, 0, 8, 8), Uint8Array.of(2), subBlocks(lzwCompress(new Uint8Array(64).fill(1)))]);
    return concatBytes([gifHeader(), screen, first, second, TRAILER]);
  }

  test("what a first frame leaves uncovered is transparent, as a browser shows it, not the background colour the file names", async () => {
    const file = await stored(await run(cornerGif(), "gif"));
    expect(pixelOf(file, 0, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(pixelOf(file, 0, 7, 7)).toEqual([0, 0, 0, 0]);
  });

  test("a global table of 256 colours has no index outside it: such a file keeps the background colour its file names (a known limit)", async () => {
    const palette: number[] = Array.from({ length: 256 * 3 }, () => 0);
    palette.splice(0, 9, 255, 0, 0, 0, 255, 0, 0, 0, 255);
    const screen = Uint8Array.from([8, 0, 8, 0, 0b1111_0111, 2, 0, ...palette]);
    const first = concatBytes([gce(10), descriptor(0, 0, 4, 4), Uint8Array.of(8), subBlocks(lzwCompress(new Uint8Array(16).fill(0), 8))]);
    const second = concatBytes([gce(10), descriptor(0, 0, 8, 8), Uint8Array.of(8), subBlocks(lzwCompress(new Uint8Array(64).fill(1), 8))]);
    const file = await stored(await run(concatBytes([gifHeader(), screen, first, second, TRAILER]), "gif"));
    expect(pixelOf(file, 0, 7, 7)).toEqual([0, 0, 255, 255]);
  });

  test("the next frame still covers the screen with its own picture", async () => {
    const file = await stored(await run(cornerGif(), "gif"));
    expect(pixelOf(file, 1, 7, 7)).toEqual([0, 255, 0, 255]);
  });
});

describe("what ffmpeg reads is what was judged (L5)", () => {
  /** The bytes of the file named after `-i` in each call, read when the call is made. */
  function reading(into: Uint8Array[], paths: string[]): FfmpegSpawner {
    return recordingSpawner([], (argv) => {
      const path = argOf(argv, "-i") ?? "";
      paths.push(path);
      into.push(new Uint8Array(readFileSync(path)));
      return argv;
    });
  }

  test("an APNG is decoded from a work file that holds exactly the judged bytes, not from the staged copy", async () => {
    const source = withDelays(flatApng([[255, 0, 0, 255], [0, 255, 0, 255]]), [[1, 10], [1, 10]]);
    const hand = await handoff(tmp(), source, { format: "apng", kind: "sticker" });
    const seen: Uint8Array[] = [];
    const paths: string[] = [];
    const outcome = await createStickerImporter({ encode: encodeHere, spawner: reading(seen, paths) })(hand.request);
    expect(outcome.ok).toBe(true);
    expect(paths.every((p) => p !== hand.request.staged.path)).toBe(true);
    expect(seen.length).toBe(2);
    for (const bytes of seen) expect(Buffer.from(bytes).equals(Buffer.from(source))).toBe(true);
  });

  test("a GIF that needs no rewrite is decoded from a work file of the judged bytes too", async () => {
    const source = flatGif([0, 1], [10, 10]);
    const hand = await handoff(tmp(), source, { format: "gif", kind: "sticker" });
    const seen: Uint8Array[] = [];
    const paths: string[] = [];
    await createStickerImporter({ encode: encodeHere, spawner: reading(seen, paths) })(hand.request);
    expect(paths.every((p) => p !== hand.request.staged.path)).toBe(true);
  });

  test("the work file of the judged bytes is written with `wx`: a link already at its name is refused and its target untouched", async () => {
    const hand = await handoff(tmp(), flatGif([0, 1], [10, 10]), { format: "gif", kind: "sticker" });
    const victim = join(tmp(), "victim.bin");
    await writeFile(victim, "keep me");
    const link = join(tmp(), "input-link.media");
    await symlink(victim, link);
    const request = { ...hand.request, workFile: async () => ({ path: link, release: async () => undefined }) };
    expect(await createStickerImporter({ encode: encodeHere })(request)).toEqual({ ok: false, reason: "failed" });
    expect(await readFile(victim, "utf8")).toBe("keep me");
  });

  test("a staged copy that grew since the staging looked at it is failed", async () => {
    const hand = await handoff(tmp(), flatGif([0, 1], [10, 10]), { format: "gif", kind: "sticker" });
    await writeFile(hand.request.staged.path, Buffer.concat([readFileSync(hand.request.staged.path), Buffer.alloc(64)]));
    expect(await createStickerImporter({ encode: encodeHere })(hand.request)).toEqual({ ok: false, reason: "failed" });
  });
});

describe("the stored file's size is checked after it is written (I24)", () => {
  test("a file whose size is not the bytes that were written is failed", async () => {
    let asked = 0;
    const fileSize = async (path: string): Promise<number> => {
      const size = (await stat(path)).size;
      return ++asked === 2 ? size + 1 : size;
    };
    expect(reasonOf(await run(flatGif([0, 1], [10, 10]), "gif", { fileSize }))).toBe("failed");
    expect(asked).toBe(2);
  });
});
