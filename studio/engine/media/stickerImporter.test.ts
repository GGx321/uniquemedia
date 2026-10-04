import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MEDIA_BYTE_CAPS, MediaSummary, type MediaUnsupportedReason } from "../../shared/engine";
import { inspectApng, STICKER_LIMITS } from "../../shared/stickers/apng";
import { inspectGif } from "../../shared/stickers/gif";
import { createApngEncoder, encodeApng } from "../../shared/stickers/apngWriter";
import { buildGif, concatBytes, framesOf, gifHeader } from "../../shared/stickers/gif.testkit";
import { decodeFrames } from "../../scripts/stickers/apngDecode.testkit";
import type { FfmpegSpawner } from "../../node/runFfmpeg";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { tempDirFor } from "../../testing/tempDir";
import { EncodeTooLargeError, EncodeWorkerError } from "../stickers/encodeErrors";
import { encodeStickerFrames } from "../stickers/encodeJob";
import { exitingChild, hangingChild, progressChild, recordingSpawner } from "./ffmpegChildren.testkit";
import type { MediaImportOutcome } from "./imports";
import { handoff, type Handoff } from "./photoFixtures.testkit";
import {
  flatApng,
  flatGif,
  GIF_BLUE,
  GIF_GREEN,
  GIF_RED,
  withDeclaredFrames,
  withDelays,
  withFctl,
  withPoster,
  type Rgba,
} from "./stickerFixtures.testkit";
import { createStickerImporter, type StickerImporterDeps } from "./stickerImporter";
useNativeGlobals();

// The own-sticker importer (Stage 3, 3f.5), against the bundled ffmpeg and the real APNG writer: what it accepts, what it turns away and why, the
// 30 fps quantisation by accumulated time, what the stored APNG holds (pixels, delays), and that a cancel stops its child process and writes nothing.
// The pure pieces (the GIF reader, the delay quantiser, the writer) are tested in studio/shared/stickers, the worker in studio/engine/stickers.

const tmp = tempDirFor({ beforeEach, afterEach }, "studio-sticker-importer-");

/** The encode step in this thread: the same job the worker does, over a raw file read whole. Its own tests are in studio/engine/stickers. */
const encodeHere: StickerImporterDeps["encode"] = async (job, signal) => {
  signal.throwIfAborted();
  const raw = readFileSync(job.rawPath);
  const frameBytes = job.width * job.height * 4;
  return encodeStickerFrames(job, (index, into) => into.set(raw.subarray(index * frameBytes, (index + 1) * frameBytes)));
};

const importerWith = (extra: Partial<StickerImporterDeps> = {}): ReturnType<typeof createStickerImporter> => createStickerImporter({ encode: encodeHere, ...extra });

/** `folder`: where the staged copy and the work files go; a test that imports twice gives each its own, since the work names repeat in one folder. */
async function runWith(
  bytes: Uint8Array,
  format: "gif" | "apng" | "png" | "jpeg" | "webp",
  extra: Partial<StickerImporterDeps> = {},
  folder: string = tmp(),
): Promise<{ outcome: MediaImportOutcome; hand: Handoff }> {
  const hand = await handoff(folder, bytes, { format, kind: "sticker" });
  const outcome = await importerWith(extra)(hand.request);
  return { outcome, hand };
}

interface Stored {
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly loopFrames: number;
  readonly delayFrames: readonly number[];
}

/** The stored file of an accepted import, with the facts it declared. */
async function accepted(result: { outcome: MediaImportOutcome }): Promise<Stored> {
  const { outcome } = result;
  if (!outcome.ok) throw new Error(`refused: ${outcome.reason}`);
  if (outcome.output === undefined) throw new Error("no output file");
  expect(outcome.output.format).toBe("apng");
  const { facts } = outcome;
  return {
    bytes: new Uint8Array(await readFile(outcome.output.file.path)),
    width: facts.width ?? -1,
    height: facts.height ?? -1,
    loopFrames: facts.loopFrames ?? -1,
    delayFrames: facts.delayFrames ?? [],
  };
}

const refusedWith = (result: { outcome: MediaImportOutcome }): MediaUnsupportedReason | "accepted" => (result.outcome.ok ? "accepted" : result.outcome.reason);

function pixel(stored: Stored, frame: number, x: number, y: number): Rgba {
  const frames = decodeFrames(stored.bytes, stored.width, stored.height);
  const at = (y * stored.width + x) * 4;
  const data = frames[frame] ?? new Uint8Array(0);
  return [data[at] ?? -1, data[at + 1] ?? -1, data[at + 2] ?? -1, data[at + 3] ?? -1];
}

const RED: Rgba = [255, 0, 0, 255];
const GREEN: Rgba = [0, 255, 0, 255];
const BLUE: Rgba = [0, 0, 255, 255];

describe("the sticker importer: a GIF", () => {
  test("is stored as an APNG the strict reader accepts, of the GIF's size", async () => {
    const stored = await accepted(await runWith(flatGif([0, 1, 2], [10, 10, 10], { width: 10, height: 6 }), "gif"));
    const inspected = inspectApng(stored.bytes);
    if (!inspected.ok) throw new Error(inspected.code);
    expect([inspected.info.width, inspected.info.height, stored.width, stored.height]).toEqual([10, 6, 10, 6]);
  });

  test("keeps each frame's picture, in order", async () => {
    const stored = await accepted(await runWith(flatGif([0, 1, 2], [10, 10, 10]), "gif"));
    expect([pixel(stored, 0, 3, 2), pixel(stored, 1, 3, 2), pixel(stored, 2, 3, 2)]).toEqual([GIF_RED, GIF_GREEN, GIF_BLUE]);
  });

  test("puts 10 cs on the 30 fps grid as 3 slots a frame, and declares them", async () => {
    const stored = await accepted(await runWith(flatGif([0, 1, 2], [10, 10, 10]), "gif"));
    expect([stored.loopFrames, stored.delayFrames]).toEqual([9, [3, 3, 3]]);
    const inspected = inspectApng(stored.bytes);
    if (!inspected.ok) throw new Error(inspected.code);
    expect(inspected.info.frames.map((f) => f.delayFrames)).toEqual([3, 3, 3]);
  });

  test("quantises by ACCUMULATED time: seven 4 cs frames (25 fps) become an 8 frame loop and none is lost", async () => {
    const stored = await accepted(await runWith(flatGif([0, 1, 2, 3, 0, 1, 2], [4, 4, 4, 4, 4, 4, 4]), "gif"));
    expect([stored.delayFrames, stored.loopFrames]).toEqual([[1, 1, 2, 1, 1, 1, 1], 8]);
  });

  test("a delay of 0 or 1 cs, or no delay at all, is played for 10 cs, as browsers and ffmpeg do", async () => {
    const stored = await accepted(await runWith(flatGif([0, 1, 2], [0, 1, null]), "gif"));
    expect(stored.delayFrames).toEqual([3, 3, 3]);
  });

  test("ffmpeg is given the delays as they are played: no frame reaches it with 0 or 1 cs, whatever its version does with those", async () => {
    const seen: number[][] = [];
    const spawner = recordingSpawner([], (argv) => {
      const result = inspectGif(new Uint8Array(readFileSync(argv[argv.indexOf("-i") + 1] ?? "")));
      if (!result.ok) throw new Error(result.code);
      seen.push(result.info.frames.map((f) => f.delayCs));
      return argv;
    });
    await accepted(await runWith(flatGif([0, 1, 2, 3], [0, 1, 7, null]), "gif", { spawner }));
    // A frame with no graphic control extension is given one (10 cs, as every ffmpeg that reads the file as a browser does): the Windows ffmpeg did not
    // count such a frame the way the macOS one does.
    expect(seen).toEqual([
      [10, 10, 7, 10],
      [10, 10, 7, 10],
    ]);
  });

  test("a frame with no graphic control extension is given one even when every other delay is already as played", async () => {
    const seen: number[][] = [];
    const spawner = recordingSpawner([], (argv) => {
      const result = inspectGif(new Uint8Array(readFileSync(argv[argv.indexOf("-i") + 1] ?? "")));
      if (!result.ok) throw new Error(result.code);
      seen.push(result.info.frames.map((f) => f.delayCs));
      return argv;
    });
    await accepted(await runWith(flatGif([0, 1, 2], [null, 10, 10]), "gif", { spawner }));
    expect(seen).toEqual([
      [10, 10, 10],
      [10, 10, 10],
    ]);
  });

  test("a GIF that gets graphic control extensions inserted still keeps each frame's picture, in order", async () => {
    const stored = await accepted(await runWith(flatGif([0, 1, 2], [null, 1, null]), "gif"));
    expect([pixel(stored, 0, 3, 2), pixel(stored, 1, 3, 2), pixel(stored, 2, 3, 2)]).toEqual([GIF_RED, GIF_GREEN, GIF_BLUE]);
    expect(stored.delayFrames).toEqual([3, 3, 3]);
  });

  test("the file the owner gave is not touched by the rewrite of the delays: the stored picture and loop are the same", async () => {
    const stored = await accepted(await runWith(flatGif([0, 1, 2], [1, 1, 1]), "gif"));
    expect([stored.loopFrames, stored.delayFrames]).toEqual([9, [3, 3, 3]]);
  });

  test("a delay of 2 cs is kept as it is, and a frame too short for any slot is left out of the loop", async () => {
    const stored = await accepted(await runWith(flatGif([0, 1, 2], [2, 2, 2]), "gif"));
    expect(stored.delayFrames).toEqual([1, 1]);
    expect(stored.loopFrames).toBe(2);
    expect([pixel(stored, 0, 0, 0), pixel(stored, 1, 0, 0)]).toEqual([GIF_RED, GIF_BLUE]);
  });

  test("a loop that quantises to exactly 300 frames is accepted", async () => {
    const colours = Array.from({ length: 100 }, (_, i) => i % 4);
    const stored = await accepted(await runWith(flatGif(colours, colours.map(() => 10), { width: 2, height: 2 }), "gif"));
    expect(stored.loopFrames).toBe(300);
  });

  test("a loop that quantises to 301 frames is refused as loop-too-long", async () => {
    const colours = Array.from({ length: 101 }, (_, i) => i % 4);
    const delays = colours.map((_, i) => (i === 100 ? 4 : 10));
    expect(refusedWith(await runWith(flatGif(colours, delays, { width: 2, height: 2 }), "gif"))).toBe("loop-too-long");
  });

  test("more than 300 source frames are refused as loop-too-long, however short", async () => {
    const colours = Array.from({ length: 301 }, (_, i) => i % 4);
    expect(refusedWith(await runWith(flatGif(colours, colours.map(() => 10), { width: 2, height: 2 }), "gif"))).toBe("loop-too-long");
  });

  test("a transparent pixel stays transparent", async () => {
    const gif = buildGif({
      width: 4,
      height: 4,
      frames: [
        { delayCs: 10, transparent: 3, indices: Array.from({ length: 16 }, (_, i) => (i === 5 ? 3 : 0)) },
        { delayCs: 10, transparent: 3, indices: Array.from({ length: 16 }, (_, i) => (i === 5 ? 3 : 1)) },
      ],
    });
    const stored = await accepted(await runWith(gif, "gif"));
    expect(pixel(stored, 0, 1, 1)[3]).toBe(0);
    expect(pixel(stored, 0, 0, 0)).toEqual(GIF_RED);
  });

  test("a frame smaller than the screen is drawn where it sits, over what the frame before left (the canvas is the screen)", async () => {
    const gif = buildGif({
      width: 8,
      height: 8,
      frames: [
        { delayCs: 10, indices: Array.from({ length: 64 }, () => 0) },
        { delayCs: 10, x: 2, y: 2, width: 4, height: 4, indices: Array.from({ length: 16 }, () => 2) },
      ],
    });
    const stored = await accepted(await runWith(gif, "gif"));
    expect([stored.width, stored.height]).toEqual([8, 8]);
    expect([pixel(stored, 1, 0, 0), pixel(stored, 1, 3, 3)]).toEqual([GIF_RED, GIF_BLUE]);
  });

  test("the NETSCAPE loop count does not matter: a sticker loops, whatever the file says", async () => {
    const gif = buildGif({ width: 4, height: 4, loop: 2, frames: framesOf(3, 10) });
    expect((await accepted(await runWith(gif, "gif"))).loopFrames).toBe(9);
  });

  test("its facts make a record the contract takes", async () => {
    const { outcome } = await runWith(flatGif([0, 1], [10, 10]), "gif");
    if (!outcome.ok) throw new Error("refused");
    const record = { mediaId: "media-00000001", kind: "sticker", name: "a.gif", bytes: 100, createdAt: "2026-10-04T10:00:00.000Z", ...outcome.facts };
    expect(MediaSummary.safeParse(record).success).toBe(true);
  });
});

describe("the sticker importer: an APNG", () => {
  test("is stored again as an APNG with the same pictures and delays", async () => {
    const stored = await accepted(await runWith(flatApng([RED, GREEN, BLUE]), "apng"));
    expect(stored.delayFrames).toEqual([1, 1, 1]);
    expect([pixel(stored, 0, 1, 1), pixel(stored, 1, 1, 1), pixel(stored, 2, 1, 1)]).toEqual([RED, GREEN, BLUE]);
  });

  test("delays that are whole numbers of 30 fps frames are kept (1/15, 1/10 and 1/6 s: 2, 3 and 5)", async () => {
    const source = withDelays(flatApng([RED, GREEN, BLUE]), [[1, 15], [1, 10], [1, 6]]);
    expect((await accepted(await runWith(source, "apng"))).delayFrames).toEqual([2, 3, 5]);
  });

  test("delays that are off the grid are quantised by accumulated time (three 1/25 s frames: 1, 1 and 2 slots)", async () => {
    const source = withDelays(flatApng([RED, GREEN, BLUE]), [[1, 25], [1, 25], [1, 25]]);
    const stored = await accepted(await runWith(source, "apng"));
    expect([stored.delayFrames, stored.loopFrames]).toEqual([[1, 1, 2], 4]);
  });

  test("a delay written with a zero denominator is read as hundredths", async () => {
    const source = withDelays(flatApng([RED, GREEN]), [[10, 0], [10, 0]]);
    expect((await accepted(await runWith(source, "apng"))).delayFrames).toEqual([3, 3]);
  });

  test("a zero delay is refused", async () => {
    const source = withDelays(flatApng([RED, GREEN]), [[0, 100], [1, 30]]);
    expect(refusedWith(await runWith(source, "apng"))).toBe("format");
  });

  test("a default image that is not a frame (a poster before the first frame) is refused", async () => {
    expect(refusedWith(await runWith(withPoster(flatApng([RED, GREEN, BLUE])), "apng"))).toBe("format");
  });

  test("a frame outside the canvas (fcTL out of bounds) is refused", async () => {
    const source = withFctl(flatApng([RED, GREEN]), 1, (view) => view.setUint32(12, 100));
    expect(refusedWith(await runWith(source, "apng"))).toBe("format");
  });

  test("an acTL that declares more frames than the file holds is refused", async () => {
    expect(refusedWith(await runWith(withDeclaredFrames(flatApng([RED, GREEN]), 5), "apng"))).toBe("format");
  });

  test("an acTL that declares fewer frames than the file holds is refused", async () => {
    expect(refusedWith(await runWith(withDeclaredFrames(flatApng([RED, GREEN, BLUE]), 2), "apng"))).toBe("format");
  });

  test("an APNG of one frame is not an animation", async () => {
    expect(refusedWith(await runWith(flatApng([RED]), "apng"))).toBe("not-animated");
  });

  test("a loop of more than 300 frames after the quantisation is refused", async () => {
    const source = withDelays(flatApng([RED, GREEN]), [[6, 1], [6, 1]]);
    expect(refusedWith(await runWith(source, "apng"))).toBe("loop-too-long");
  });
});

describe("the sticker importer: what is not a sticker", () => {
  test("a still PNG (the staging names it png, not apng) is refused as not-animated, and nothing is spawned", async () => {
    const spawner: FfmpegSpawner = () => {
      throw new Error("must not be spawned");
    };
    const png = encodeApng({ width: 4, height: 4, frames: [new Uint8Array(64).fill(200)] });
    expect(refusedWith(await runWith(png, "png", { spawner }))).toBe("not-animated");
  });

  test("a GIF of one frame is refused as not-animated", async () => {
    expect(refusedWith(await runWith(flatGif([0], [10]), "gif"))).toBe("not-animated");
  });

  test("a GIF whose frames all fall into one slot is refused as not-animated", async () => {
    expect(refusedWith(await runWith(flatGif([0, 1], [2, 2]), "gif"))).toBe("not-animated");
  });

  test("a container that is neither GIF nor APNG is refused as format", async () => {
    expect(refusedWith(await runWith(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]), "jpeg"))).toBe("format");
    expect(refusedWith(await runWith(new Uint8Array(32), "webp"))).toBe("format");
  });

  test("a file over the sticker cap is too-large, before it is read as a GIF", async () => {
    const huge = concatBytes([gifHeader(), new Uint8Array(MEDIA_BYTE_CAPS.sticker)]);
    expect(refusedWith(await runWith(huge, "gif"))).toBe("too-large");
  });

  test("a staged copy whose hash is not the staging's is failed", async () => {
    const bytes = flatGif([0, 1], [10, 10]);
    const hand = await handoff(tmp(), bytes, { format: "gif", kind: "sticker", sha256: "0".repeat(64) });
    expect(await importerWith()(hand.request)).toEqual({ ok: false, reason: "failed" });
  });

  test("a side over 720 px is refused as dimensions", async () => {
    expect(refusedWith(await runWith(flatGif([0, 1], [10, 10], { width: STICKER_LIMITS.maxSide + 1, height: 4 }), "gif"))).toBe("dimensions");
  });

  test("a side of 720 px is taken", async () => {
    const stored = await accepted(await runWith(flatGif([0, 1], [10, 10], { width: STICKER_LIMITS.maxSide, height: 2 }), "gif"));
    expect(stored.width).toBe(STICKER_LIMITS.maxSide);
  });

  test("a side under 2 px is refused as too-small", async () => {
    expect(refusedWith(await runWith(flatGif([0, 1], [10, 10], { width: 1, height: 8 }), "gif"))).toBe("too-small");
  });
});

describe("the sticker importer: hostile GIFs are refused by the reader, before ffmpeg", () => {
  const noSpawn: FfmpegSpawner = () => {
    throw new Error("must not be spawned for a file the reader refuses");
  };
  const flat = (n: number, v = 0): number[] => Array.from({ length: n }, () => v);
  const hostile: [string, () => Uint8Array, MediaUnsupportedReason][] = [
    ["an LZW minimum code size of 1", () => buildGif({ frames: [{ minCodeSize: 1 }, {}] }), "format"],
    ["an LZW minimum code size of 12", () => buildGif({ frames: [{ minCodeSize: 12 }, {}] }), "format"],
    ["LZW data for fewer pixels than the frame holds", () => buildGif({ frames: [{ indices: flat(5) }, {}] }), "format"],
    ["LZW data for more pixels than the frame holds", () => buildGif({ frames: [{ indices: flat(500) }, {}] }), "format"],
    ["a frame descriptor outside the screen", () => buildGif({ width: 8, height: 8, frames: [{ x: 6, y: 6, width: 4, height: 4 }, {}] }), "format"],
    ["a huge logical screen", () => buildGif({ width: 65535, height: 65535, frames: [{ width: 4, height: 4 }, { width: 4, height: 4 }] }), "dimensions"],
    ["no frame at all", () => buildGif({ frames: [] }), "format"],
    ["a missing trailer", () => buildGif({ frames: framesOf(2), omitTrailer: true }), "format"],
    ["bytes after the trailer", () => buildGif({ frames: framesOf(2), trailing: Uint8Array.of(1, 2, 3) }), "format"],
    ["an extension with endless sub-blocks", () => concatBytes([buildGif({ frames: framesOf(2), omitTrailer: true }), Uint8Array.from([0x21, 0xfe, ...Array.from({ length: 2000 }, () => [1, 65]).flat()])]), "format"],
    ["a file cut in the middle", () => buildGif({ frames: framesOf(2) }).subarray(0, 60), "format"],
  ];
  for (const [name, make, reason] of hostile) {
    test(`${name} is refused as ${reason}`, async () => {
      expect(refusedWith(await runWith(make(), "gif", { spawner: noSpawn }))).toBe(reason);
    });
  }

  test("NETSCAPE loop variants (forever, a count, none) are all taken", async () => {
    for (const loop of [0, 3, null]) {
      const stored = await accepted(await runWith(buildGif({ width: 4, height: 4, loop, frames: framesOf(2, 10) }), "gif", {}, join(tmp(), `loop-${loop}`)));
      expect(stored.loopFrames).toBe(6);
    }
  });
});

describe("the sticker importer: ffmpeg decodes what was judged, or the file is refused", () => {
  test("a decode that counts other frames than the reader did is refused as format", async () => {
    // The first call (the count) says nine frames where the reader's quantisation said six.
    let call = 0;
    const spawner: FfmpegSpawner = (command, args, options) => (call++ === 0 ? progressChild(9) : recordingSpawner([])(command, args, options));
    expect(refusedWith(await runWith(flatGif([0, 1], [10, 10]), "gif", { spawner }))).toBe("format");
  });

  test("a raw file that is not the size of the frames the reader counted is refused as format", async () => {
    const spawner = recordingSpawner([], (argv) => {
      if (argv.includes("rawvideo")) argv.splice(argv.indexOf("-map"), 0, "-frames:v", "1");
      return argv;
    });
    expect(refusedWith(await runWith(flatGif([0, 1, 2], [10, 10, 10]), "gif", { spawner }))).toBe("format");
  });

  test("an ffmpeg that fails on the file (-xerror) is refused as format, and nothing of its stderr travels", async () => {
    const spawner: FfmpegSpawner = () => exitingChild(1, { stderrText: "Error opening /Users/secret/stickers/private.gif: Invalid data" });
    const { outcome } = await runWith(flatGif([0, 1], [10, 10]), "gif", { spawner });
    expect(outcome).toEqual({ ok: false, reason: "format" });
    expect(JSON.stringify(outcome)).not.toContain("secret");
  });

  test("an ffmpeg that runs past its time limit is killed and the sticker is refused as failed", async () => {
    const { child, killed } = hangingChild();
    const { outcome } = await runWith(flatGif([0, 1], [10, 10]), "gif", { spawner: () => child, ffmpegTimeoutMs: 25 });
    expect(outcome).toEqual({ ok: false, reason: "failed" });
    expect(killed()).toEqual(["SIGKILL"]);
  });

  test("an ffmpeg that cannot be started is failed", async () => {
    const spawner: FfmpegSpawner = () => {
      throw new Error("spawn ENOENT /Users/secret/ffmpeg");
    };
    const { outcome } = await runWith(flatGif([0, 1], [10, 10]), "gif", { spawner });
    expect(outcome).toEqual({ ok: false, reason: "failed" });
  });

  test("every ffmpeg call pins the decoder: the container, the codec whitelist and the codec from the verdict, the file protocol only, caps, no stdin", async () => {
    for (const [source, format, codec] of [
      [flatGif([0, 1], [10, 10]), "gif", "gif"],
      [flatApng([RED, GREEN]), "apng", "apng"],
    ] as const) {
      const calls: string[][] = [];
      await accepted(await runWith(source, format, { spawner: recordingSpawner(calls) }, join(tmp(), format)));
      expect(calls).toHaveLength(2);
      for (const argv of calls) {
        const at = (flag: string): string | undefined => argv[argv.indexOf(flag) + 1];
        expect(at("-f")).toBe(format);
        expect(argv.indexOf("-f")).toBeLessThan(argv.indexOf("-i"));
        expect(at("-codec_whitelist")).toBe(codec);
        expect(argv.indexOf("-codec_whitelist")).toBeLessThan(argv.indexOf("-i"));
        expect(at("-c:v")).toBe(codec);
        expect(argv.indexOf("-c:v")).toBeLessThan(argv.indexOf("-i"));
        expect(at("-protocol_whitelist")).toBe("file");
        expect(Number(at("-max_alloc"))).toBeGreaterThan(0);
        expect(Number(at("-max_pixels"))).toBe(STICKER_LIMITS.maxSide * STICKER_LIMITS.maxSide);
        expect(argv).toContain("-nostdin");
        expect(argv).toContain("-xerror");
        expect(at("-threads")).toBe("1");
      }
    }
  });

  test("the count decode is `fps=30` into the null muxer, and the pixels come as rgba from a passthrough decode", async () => {
    const calls: string[][] = [];
    await accepted(await runWith(flatGif([0, 1], [10, 10]), "gif", { spawner: recordingSpawner(calls) }));
    expect(calls[0]).toContain("fps=30");
    expect(calls[0]?.[calls[0].indexOf("-f", calls[0].indexOf("-i")) + 1]).toBe("null");
    expect(calls[1]).toContain("rgba");
    expect(calls[1]).toContain("passthrough");
    // The raw file is made new: ffmpeg never overwrites what is at its name.
    expect(calls[1]).toContain("-n");
    expect(calls[1]).not.toContain("-y");
    expect(calls[1]?.[calls[1].indexOf("-f", calls[1].indexOf("-i")) + 1]).toBe("rawvideo");
  });

  test("the ffmpeg never gets the owner's path: it reads the staged copy and writes the work file only", async () => {
    const calls: string[][] = [];
    const hand = await handoff(tmp(), flatGif([0, 1], [10, 10]), { format: "gif", kind: "sticker", name: "holiday.gif" });
    await importerWith({ spawner: recordingSpawner(calls) })(hand.request);
    const mentioned = calls.flat().filter((token) => token.includes("/") || token.includes("\\"));
    const allowed = new Set([hand.request.staged.path, ...hand.works.map((w) => w.path)]);
    for (const token of mentioned) expect(allowed.has(token)).toBe(true);
    expect(calls.flat().join(" ")).not.toContain("holiday");
  });
});

describe("the sticker importer: the encode and the files it writes", () => {
  test("hands the encode the raw file ffmpeg wrote, the canvas, the slots of every source frame and the byte cap", async () => {
    const jobs: Parameters<StickerImporterDeps["encode"]>[0][] = [];
    const encode: StickerImporterDeps["encode"] = async (job, signal) => {
      jobs.push(job);
      return encodeHere(job, signal);
    };
    const hand = await handoff(tmp(), flatGif([0, 1, 2], [2, 2, 2], { width: 6, height: 4 }), { format: "gif", kind: "sticker" });
    await importerWith({ encode })(hand.request);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ rawPath: hand.works[0]?.path, width: 6, height: 4, slots: [1, 0, 1], maxBytes: MEDIA_BYTE_CAPS.sticker });
  });

  test("an encode that passes the byte cap is refused as too-large", async () => {
    const encode: StickerImporterDeps["encode"] = async () => {
      throw new EncodeTooLargeError(MEDIA_BYTE_CAPS.sticker);
    };
    expect(refusedWith(await runWith(flatGif([0, 1], [10, 10]), "gif", { encode }))).toBe("too-large");
  });

  test("an encode worker that failed is refused as failed", async () => {
    const encode: StickerImporterDeps["encode"] = async () => {
      throw new EncodeWorkerError("the encode worker stopped");
    };
    expect(refusedWith(await runWith(flatGif([0, 1], [10, 10]), "gif", { encode }))).toBe("failed");
  });

  test("an APNG with another loop than the one judged (a worker that lied) is refused, and not stored", async () => {
    const encode: StickerImporterDeps["encode"] = async () => encodeApng({ width: 8, height: 6, frames: [new Uint8Array(8 * 6 * 4), new Uint8Array(8 * 6 * 4)] });
    const { outcome, hand } = await runWith(flatGif([0, 1], [10, 10]), "gif", { encode });
    expect(outcome).toEqual({ ok: false, reason: "failed" });
    expect(existsSync(hand.works[1]?.path ?? "")).toBe(false);
  });

  test("bytes that are not an APNG at all are refused, and not stored", async () => {
    const encode: StickerImporterDeps["encode"] = async () => new Uint8Array(64);
    const { outcome, hand } = await runWith(flatGif([0, 1], [10, 10]), "gif", { encode });
    expect(outcome).toEqual({ ok: false, reason: "failed" });
    expect(existsSync(hand.works[1]?.path ?? "")).toBe(false);
  });

  /** An encode that answers a file of its own making: `width` by `height`, each frame lasting the given slots. */
  const liar =
    (width: number, height: number, delays: readonly number[]): StickerImporterDeps["encode"] =>
    async () => {
      const encoder = createApngEncoder({ width, height, frameCount: delays.length });
      for (const delay of delays) encoder.add(new Uint8Array(width * height * 4), delay);
      return encoder.finish();
    };

  test("an APNG as wide as another canvas than the one judged is refused (only the width differs)", async () => {
    expect(refusedWith(await runWith(flatGif([0, 1], [10, 10], { width: 8, height: 6 }), "gif", { encode: liar(4, 6, [3, 3]) }))).toBe("failed");
  });

  test("an APNG as high as another canvas than the one judged is refused (only the height differs)", async () => {
    expect(refusedWith(await runWith(flatGif([0, 1], [10, 10], { width: 8, height: 6 }), "gif", { encode: liar(8, 4, [3, 3]) }))).toBe("failed");
  });

  test("an APNG with the same canvas, the same frame count and the same loop but other delays is refused", async () => {
    expect(refusedWith(await runWith(flatGif([0, 1], [10, 10], { width: 8, height: 6 }), "gif", { encode: liar(8, 6, [2, 4]) }))).toBe("failed");
  });

  test("an APNG with fewer frames than the ones judged is refused", async () => {
    expect(refusedWith(await runWith(flatGif([0, 1], [10, 10], { width: 8, height: 6 }), "gif", { encode: liar(8, 6, [3]) }))).toBe("failed");
  });

  test("the judged file itself is accepted: the checks above are not too strict", async () => {
    expect(refusedWith(await runWith(flatGif([0, 1], [10, 10], { width: 8, height: 6 }), "gif", { encode: liar(8, 6, [3, 3]) }))).toBe("accepted");
  });

  test("bytes over the sticker cap come back as too-large, whatever the worker said", async () => {
    const encode: StickerImporterDeps["encode"] = async () => new Uint8Array(MEDIA_BYTE_CAPS.sticker + 1);
    expect(refusedWith(await runWith(flatGif([0, 1], [10, 10]), "gif", { encode }))).toBe("too-large");
  });

  test("the size the staging reported is judged against the cap before the file is read", async () => {
    const hand = await handoff(tmp(), flatGif([0, 1], [10, 10]), { format: "gif", kind: "sticker" });
    const request = { ...hand.request, staged: { ...hand.request.staged, bytes: MEDIA_BYTE_CAPS.sticker + 1 } };
    expect(await importerWith()(request)).toEqual({ ok: false, reason: "too-large" });
  });

  test("the raw file is never written through a link: a link already at its name is refused and its target untouched", async () => {
    const hand = await handoff(tmp(), flatGif([0, 1], [10, 10]), { format: "gif", kind: "sticker" });
    const victim = join(tmp(), "victim.bin");
    await writeFile(victim, "keep me");
    const link = join(tmp(), "work-link.media");
    await symlink(victim, link);
    const request = { ...hand.request, workFile: async () => ({ path: link, release: async () => undefined }) };
    expect(await importerWith()(request)).toEqual({ ok: false, reason: "failed" });
    expect(await readFile(victim, "utf8")).toBe("keep me");
  });

  test("the stored file is written with `wx`: a link already at its name is refused and its target untouched", async () => {
    const hand = await handoff(tmp(), flatGif([0, 1], [10, 10]), { format: "gif", kind: "sticker" });
    const victim = join(tmp(), "victim.bin");
    await writeFile(victim, "keep me");
    const link = join(tmp(), "out-link.media");
    await symlink(victim, link);
    let call = 0;
    const request = { ...hand.request, workFile: async () => (call++ === 0 ? hand.request.workFile() : { path: link, release: async () => undefined }) };
    expect(await importerWith()(request)).toEqual({ ok: false, reason: "failed" });
    expect(await readFile(victim, "utf8")).toBe("keep me");
  });
});

/** The names in a folder with their sizes, to see that nothing moves after a cancel. */
async function folderListing(dir: string): Promise<string> {
  const names = (await readdir(dir)).sort();
  const sizes = await Promise.all(names.map(async (name) => `${name}:${(await stat(join(dir, name))).size}`));
  return sizes.join(",");
}

describe("the sticker importer: a cancel", () => {
  test("answers cancelled, and starts nothing, when the signal fired before it began", async () => {
    const hand = await handoff(tmp(), flatGif([0, 1], [10, 10]), { format: "gif", kind: "sticker" });
    hand.controller.abort();
    const spawner: FfmpegSpawner = () => {
      throw new Error("must not be spawned");
    };
    expect(await importerWith({ spawner })(hand.request)).toEqual({ ok: false, reason: "cancelled" });
    expect(hand.works).toHaveLength(0);
  });

  test("in the count decode kills ffmpeg, answers cancelled and writes nothing more", async () => {
    const { child, killed } = hangingChild();
    let spawnedCall: () => void = () => undefined;
    const spawned = new Promise<void>((resolve) => (spawnedCall = resolve));
    const spawner: FfmpegSpawner = () => {
      spawnedCall();
      return child;
    };
    const hand = await handoff(tmp(), flatGif([0, 1], [10, 10]), { format: "gif", kind: "sticker" });
    const running = importerWith({ spawner })(hand.request);
    await spawned;
    hand.controller.abort();
    expect(await running).toEqual({ ok: false, reason: "cancelled" });
    expect(killed()).toEqual(["SIGKILL"]);
    const after = await folderListing(tmp());
    for (let turn = 0; turn < 5; turn++) await new Promise<void>((resolve) => setImmediate(resolve));
    expect(await folderListing(tmp())).toBe(after);
  });

  test("in the pixel decode kills ffmpeg and answers cancelled", async () => {
    const { child, killed } = hangingChild();
    let call = 0;
    let spawnedSecond: () => void = () => undefined;
    const second = new Promise<void>((resolve) => (spawnedSecond = resolve));
    const spawner: FfmpegSpawner = (command, args, options) => {
      if (call++ === 0) return recordingSpawner([])(command, args, options);
      spawnedSecond();
      return child;
    };
    const hand = await handoff(tmp(), flatGif([0, 1], [10, 10]), { format: "gif", kind: "sticker" });
    const running = importerWith({ spawner })(hand.request);
    await second;
    hand.controller.abort();
    expect(await running).toEqual({ ok: false, reason: "cancelled" });
    expect(killed()).toEqual(["SIGKILL"]);
  });

  test("in the encode is passed to it as its signal, answers cancelled, and no file is stored", async () => {
    const hand = await handoff(tmp(), flatGif([0, 1], [10, 10]), { format: "gif", kind: "sticker" });
    let started: () => void = () => undefined;
    const encoding = new Promise<void>((resolve) => (started = resolve));
    const encode: StickerImporterDeps["encode"] = (_job, signal) =>
      new Promise<Uint8Array>((_resolve, reject) => {
        started();
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    const running = importerWith({ encode })(hand.request);
    await encoding;
    hand.controller.abort();
    expect(await running).toEqual({ ok: false, reason: "cancelled" });
    expect(existsSync(hand.works[1]?.path ?? "")).toBe(false);
  });

  test("that lands while the stored file's name is being made stores nothing", async () => {
    const hand = await handoff(tmp(), flatGif([0, 1], [10, 10]), { format: "gif", kind: "sticker" });
    let call = 0;
    const request = {
      ...hand.request,
      workFile: async () => {
        const work = await hand.request.workFile();
        if (call++ === 1) hand.controller.abort();
        return work;
      },
    };
    expect(await importerWith()(request)).toEqual({ ok: false, reason: "cancelled" });
    expect(existsSync(hand.works[1]?.path ?? "")).toBe(false);
  });

  test("that lands just as the encode returns stores nothing: the signal is looked at before the file is written", async () => {
    const hand = await handoff(tmp(), flatGif([0, 1], [10, 10]), { format: "gif", kind: "sticker" });
    const encode: StickerImporterDeps["encode"] = async (job, signal) => {
      const bytes = await encodeHere(job, signal);
      hand.controller.abort();
      return bytes;
    };
    expect(await importerWith({ encode })(hand.request)).toEqual({ ok: false, reason: "cancelled" });
    expect(existsSync(hand.works[1]?.path ?? "")).toBe(false);
  });
});
