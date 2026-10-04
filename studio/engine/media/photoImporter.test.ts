import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { MediaSummary } from "../../shared/engine";
import type { FfmpegChild, FfmpegSpawner } from "../../node/runFfmpeg";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { heavyTest } from "../../testing/bunTiers";
import { tempDirFor } from "../../testing/tempDir";
import { runFfmpegOk } from "../render/ffmpeg.testkit";
import { DecodeWorkerError } from "../decode/decodeGate";
import { createRealDecodeBackend } from "../decode/realBackend";
import { createWasmImageDecoder } from "../decode/wasmDecode";
import type { MediaImportOutcome } from "./imports";
import { createPhotoImporter, MAX_PHOTO_PIXELS, MAX_PHOTO_SIDE, type PhotoImporterDeps } from "./photoImporter";
import {
  animatedWebp,
  BLUE,
  encodePixels,
  handoff,
  jpegSegmentMarkers,
  jpegWithExif,
  pngWithExif,
  quadrantPicture,
  quadrantPixels,
  RED,
  webpWithExif,
  type Handoff,
} from "./photoFixtures.testkit";
useNativeGlobals();

// The own-photo importer (Stage 3, 3f.2), against the real WASM decoders and the bundled ffmpeg: what it accepts, what it turns away and
// why, the orientation applied after decode, what the stored file holds (a JPEG with no metadata at all), and that a cancel stops its
// child process. The unit tests of the pieces (exif.ts, webp.ts, orient.ts) are in their own files.

const tmp = tempDirFor({ beforeEach, afterEach }, "studio-photo-importer-");
const NODE_MODULES_DIR = join(import.meta.dir, "../../../node_modules");
let decoder: ReturnType<typeof createWasmImageDecoder>;

beforeAll(async () => {
  decoder = createWasmImageDecoder(await createRealDecodeBackend(NODE_MODULES_DIR), { maxPixels: MAX_PHOTO_PIXELS });
});

const importerWith = (extra: Partial<PhotoImporterDeps> = {}): ReturnType<typeof createPhotoImporter> => createPhotoImporter({ decode: decoder, ...extra });

async function runWith(bytes: Uint8Array, format: Parameters<typeof handoff>[2]["format"], extra: Partial<PhotoImporterDeps> = {}): Promise<{ outcome: MediaImportOutcome; hand: Handoff }> {
  const hand = await handoff(tmp(), bytes, { format });
  const outcome = await importerWith(extra)(hand.request);
  return { outcome, hand };
}

/** The stored file of an accepted import, with the facts it declared. */
async function accepted(result: { outcome: MediaImportOutcome }): Promise<{ file: Uint8Array; width: number; height: number }> {
  const { outcome } = result;
  if (!outcome.ok) throw new Error(`refused: ${outcome.reason}`);
  if (outcome.output === undefined) throw new Error("no output file");
  expect(outcome.output.format).toBe("jpeg");
  const file = new Uint8Array(await readFile(outcome.output.file.path));
  return { file, width: outcome.facts.width ?? -1, height: outcome.facts.height ?? -1 };
}

async function pixelAt(jpeg: Uint8Array, x: number, y: number): Promise<{ r: number; g: number; b: number; width: number; height: number }> {
  const image = await decoder(jpeg, new AbortController().signal);
  const at = (y * image.width + x) * 4;
  return { r: image.data[at] ?? -1, g: image.data[at + 1] ?? -1, b: image.data[at + 2] ?? -1, width: image.width, height: image.height };
}

const isRed = (p: { r: number; b: number }): boolean => p.r > 150 && p.b < 100;
const isBlue = (p: { r: number; b: number }): boolean => p.b > 150 && p.r < 100;

/** A PNG that is only a signature and an IHDR: enough for a header check, and never decoded. */
function headerOnlyPng(width: number, height: number): Uint8Array {
  const u32 = (n: number): number[] => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...u32(13), 0x49, 0x48, 0x44, 0x52, ...u32(width), ...u32(height), 8, 2, 0, 0, 0, 0, 0, 0, 0]);
}

describe("the photo importer: what it stores", () => {
  test("stores a JPEG as a JPEG of the same size and says its size", async () => {
    const picture = await quadrantPicture(tmp(), "p", 64, 48, "jpeg");
    const result = await runWith(picture, "jpeg");
    const stored = await accepted(result);
    expect([stored.width, stored.height]).toEqual([64, 48]);
    const probe = await pixelAt(stored.file, 0, 0);
    expect([probe.width, probe.height]).toEqual([64, 48]);
  });

  test("stores a PNG as a JPEG", async () => {
    const picture = await quadrantPicture(tmp(), "p", 40, 30, "png");
    const stored = await accepted(await runWith(picture, "png"));
    expect([stored.width, stored.height]).toEqual([40, 30]);
    expect(stored.file.subarray(0, 3)).toEqual(Uint8Array.from([0xff, 0xd8, 0xff]));
  });

  test("decodes a still WebP in ffmpeg and stores it as a JPEG", async () => {
    const picture = await quadrantPicture(tmp(), "p", 48, 32, "webp");
    const stored = await accepted(await runWith(picture, "webp"));
    expect([stored.width, stored.height]).toEqual([48, 32]);
    expect(isRed(await pixelAt(stored.file, 12, 8))).toBe(true);
  });

  test("decodes a lossless WebP too", async () => {
    const picture = await quadrantPicture(tmp(), "p", 48, 32, "webp-lossless");
    const stored = await accepted(await runWith(picture, "webp"));
    expect([stored.width, stored.height]).toEqual([48, 32]);
    expect(isBlue(await pixelAt(stored.file, 36, 24))).toBe(true);
  });

  test("keeps the colours of the picture", async () => {
    const picture = await quadrantPicture(tmp(), "p", 32, 32, "jpeg");
    const stored = await accepted(await runWith(picture, "jpeg"));
    expect(isRed(await pixelAt(stored.file, 8, 8))).toBe(true);
    expect(isBlue(await pixelAt(stored.file, 24, 24))).toBe(true);
  });

  test("its facts make a record the contract takes", async () => {
    const picture = await quadrantPicture(tmp(), "p", 20, 10, "jpeg");
    const { outcome } = await runWith(picture, "jpeg");
    if (!outcome.ok) throw new Error("refused");
    const record = { mediaId: "media-00000001", kind: "photo", name: "a.jpg", bytes: 100, createdAt: "2026-10-04T10:00:00.000Z", ...outcome.facts };
    expect(MediaSummary.safeParse(record).success).toBe(true);
  });

  test("stores no metadata at all: no JFIF, no EXIF, no comment, no maker string", async () => {
    const jpeg = jpegWithExif(await quadrantPicture(tmp(), "p", 32, 32, "jpeg"), 1);
    expect(jpegSegmentMarkers(jpeg)).toContain(0xe1);
    const stored = await accepted(await runWith(jpeg, "jpeg"));
    const markers = jpegSegmentMarkers(stored.file);
    expect(markers.filter((m) => (m >= 0xe0 && m <= 0xef) || m === 0xfe)).toEqual([]);
    expect(Buffer.from(stored.file).includes(Buffer.from("Acme"))).toBe(false);
    expect(Buffer.from(stored.file).includes(Buffer.from("Lavc"))).toBe(false);
  });

  test("drops the EXIF and text chunks of a PNG", async () => {
    const png = pngWithExif(await quadrantPicture(tmp(), "p", 32, 32, "png"), 1);
    const stored = await accepted(await runWith(png, "png"));
    expect(Buffer.from(stored.file).includes(Buffer.from("Acme"))).toBe(false);
  });

  test("flattens transparency onto black", async () => {
    const w = 16;
    const h = 16;
    const rgba = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) rgba.set([RED[0], RED[1], RED[2], i % w < w / 2 ? 255 : 0], i * 4);
    const raw = tmp() + "/alpha.rgba";
    await writeFile(raw, rgba);
    const png = tmp() + "/alpha.png";
    await runFfmpegOk(["-hide_banner", "-y", "-nostdin", "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", `${w}x${h}`, "-i", raw, "-frames:v", "1", "-c:v", "png", "-f", "image2pipe", png]);
    const stored = await accepted(await runWith(new Uint8Array(await readFile(png)), "png"));
    const opaque = await pixelAt(stored.file, 3, 8);
    const clear = await pixelAt(stored.file, 12, 8);
    expect(isRed(opaque)).toBe(true);
    expect(Math.max(clear.r, clear.g, clear.b)).toBeLessThan(25);
  });
});

describe("the photo importer: EXIF orientation applied after decode", () => {
  // The red quadrant is the source's top-left; each orientation moves it. A quarter turn also swaps the sides.
  const RED_AT = { 1: "TL", 2: "TR", 3: "BR", 4: "BL", 5: "TL", 6: "TR", 7: "BR", 8: "BL" } as const;
  for (const orientation of [1, 2, 3, 4, 5, 6, 7, 8] as const) {
    test(`a JPEG with orientation ${orientation} is stored upright`, async () => {
      const jpeg = jpegWithExif(await quadrantPicture(tmp(), "p", 32, 16, "jpeg"), orientation);
      const stored = await accepted(await runWith(jpeg, "jpeg"));
      const swapped = orientation >= 5;
      const [w, h] = swapped ? [16, 32] : [32, 16];
      expect([stored.width, stored.height]).toEqual([w, h]);
      const spot = { TL: [w / 4, h / 4], TR: [(3 * w) / 4, h / 4], BR: [(3 * w) / 4, (3 * h) / 4], BL: [w / 4, (3 * h) / 4] } as const;
      const opposite = { TL: "BR", TR: "BL", BR: "TL", BL: "TR" } as const;
      const where = RED_AT[orientation];
      const [rx, ry] = spot[where];
      const [bx, by] = spot[opposite[where]];
      expect(isRed(await pixelAt(stored.file, rx, ry))).toBe(true);
      expect(isBlue(await pixelAt(stored.file, bx, by))).toBe(true);
    });
  }

  test("a PNG with an eXIf orientation of 6 is turned a quarter clockwise", async () => {
    const png = pngWithExif(await quadrantPicture(tmp(), "p", 32, 16, "png"), 6);
    const stored = await accepted(await runWith(png, "png"));
    expect([stored.width, stored.height]).toEqual([16, 32]);
    expect(isRed(await pixelAt(stored.file, 12, 8))).toBe(true);
  });

  test("a WebP with an EXIF orientation of 6 is turned a quarter clockwise", async () => {
    const webp = webpWithExif(await quadrantPicture(tmp(), "p", 32, 16, "webp-lossless"), 6, { w: 32, h: 16 });
    const stored = await accepted(await runWith(webp, "webp"));
    expect([stored.width, stored.height]).toEqual([16, 32]);
    expect(isRed(await pixelAt(stored.file, 12, 8))).toBe(true);
  });

  test("a picture without EXIF is not turned", async () => {
    const stored = await accepted(await runWith(await quadrantPicture(tmp(), "p", 32, 16, "jpeg"), "jpeg"));
    expect([stored.width, stored.height]).toEqual([32, 16]);
  });
});

describe("the photo importer: sizes", () => {
  test("takes a 2 by 2 picture, the smallest", async () => {
    const stored = await accepted(await runWith(await encodePixels(tmp(), "p", quadrantPixels(2, 2, RED, BLUE), 2, 2, "png"), "png"));
    expect([stored.width, stored.height]).toEqual([2, 2]);
  });

  test("refuses a 1 by 1 picture as too small", async () => {
    const picture = await encodePixels(tmp(), "p", Uint8Array.from([5, 6, 7]), 1, 1, "png");
    expect((await runWith(picture, "png")).outcome).toEqual({ ok: false, reason: "too-small" });
  });

  test("refuses a picture with a side of 1 pixel, wide or tall", async () => {
    const wide = await encodePixels(tmp(), "w", quadrantPixels(5, 1, RED, BLUE), 5, 1, "png");
    const tall = await encodePixels(tmp(), "t", quadrantPixels(1, 5, RED, BLUE), 1, 5, "png");
    expect((await runWith(wide, "png")).outcome).toEqual({ ok: false, reason: "too-small" });
    expect((await runWith(tall, "png")).outcome).toEqual({ ok: false, reason: "too-small" });
  });

  test("refuses a 1 pixel WebP as too small without a child process", async () => {
    const picture = await encodePixels(tmp(), "p", Uint8Array.from([5, 6, 7]), 1, 1, "webp-lossless");
    const spawned: string[][] = [];
    const spawner: FfmpegSpawner = () => {
      spawned.push([]);
      throw new Error("must not be spawned");
    };
    expect((await runWith(picture, "webp", { spawner })).outcome).toEqual({ ok: false, reason: "too-small" });
    expect(spawned).toEqual([]);
  });

  test("keeps a picture exactly 4096 pixels wide at 4096", async () => {
    const stored = await accepted(await runWith(await quadrantPicture(tmp(), "p", MAX_PHOTO_SIDE, 16, "jpeg"), "jpeg"));
    expect([stored.width, stored.height]).toEqual([4096, 16]);
  });

  test("scales a picture 4097 pixels wide down to 4096", async () => {
    const stored = await accepted(await runWith(await quadrantPicture(tmp(), "p", MAX_PHOTO_SIDE + 1, 16, "jpeg"), "jpeg"));
    expect([stored.width, stored.height]).toEqual([4096, 16]);
  });

  test("scales a picture 4097 pixels tall down to 4096", async () => {
    const stored = await accepted(await runWith(await quadrantPicture(tmp(), "p", 16, MAX_PHOTO_SIDE + 1, "png"), "png"));
    expect([stored.width, stored.height]).toEqual([16, 4096]);
  });

  test("scales to the side that is too long and keeps the aspect, never below 2 pixels", async () => {
    const stored = await accepted(await runWith(await quadrantPicture(tmp(), "p", 16384, 2, "png"), "png"));
    expect([stored.width, stored.height]).toEqual([4096, 2]);
  });

  test("a quarter turn is judged on the turned size: 4097 by 16 turned is 16 by 4096", async () => {
    const jpeg = jpegWithExif(await quadrantPicture(tmp(), "p", MAX_PHOTO_SIDE + 1, 16, "jpeg"), 6);
    const stored = await accepted(await runWith(jpeg, "jpeg"));
    expect([stored.width, stored.height]).toEqual([16, 4096]);
  });

  test("refuses a header that claims more than 50 megapixels (7072 by 7072 is 50,013,184) as dimensions, without decoding it", async () => {
    expect((await runWith(headerOnlyPng(7072, 7072), "png")).outcome).toEqual({ ok: false, reason: "dimensions" });
    expect((await runWith(headerOnlyPng(65_535, 65_535), "png")).outcome).toEqual({ ok: false, reason: "dimensions" });
  });

  test("refuses a header with a 1 pixel side before it looks at the pixel count", async () => {
    expect((await runWith(headerOnlyPng(1, 1), "png")).outcome).toEqual({ ok: false, reason: "too-small" });
    expect((await runWith(headerOnlyPng(1, 20_000), "png")).outcome).toEqual({ ok: false, reason: "too-small" });
  });

  heavyTest("takes an 8000 by 6000 camera picture (48 megapixels), scaled to 4096 by 3072, rotated when its EXIF says so", async () => {
    const picture = await quadrantPicture(tmp(), "p", 8000, 6000, "jpeg");
    const stored = await accepted(await runWith(picture, "jpeg"));
    expect([stored.width, stored.height]).toEqual([4096, 3072]);
    // A second hand-off needs a folder of its own: the first one's work files are still there.
    const hand = await handoff(join(tmp(), "turned"), jpegWithExif(picture, 6), { format: "jpeg" });
    const turned = await accepted({ outcome: await importerWith()(hand.request) });
    expect([turned.width, turned.height]).toEqual([3072, 4096]);
  }, 180_000);

  heavyTest("takes a 4096 by 4096 picture and stores it at that size", async () => {
    const picture = await quadrantPicture(tmp(), "p", 4096, 4096, "jpeg");
    const stored = await accepted(await runWith(picture, "jpeg"));
    expect([stored.width, stored.height]).toEqual([4096, 4096]);
    expect(stored.file.length).toBeLessThanOrEqual(30 * 1024 * 1024);
  }, 120_000);
});

describe("the photo importer: what it turns away", () => {
  test("refuses an empty file", async () => {
    expect((await runWith(new Uint8Array(0), "jpeg")).outcome).toEqual({ ok: false, reason: "format" });
  });

  test("refuses bytes that are not a picture although the staging named them a JPEG", async () => {
    expect((await runWith(Uint8Array.from([0xff, 0xd8, 0xff, 1, 2, 3, 4, 5, 6, 7, 8]), "jpeg")).outcome).toEqual({ ok: false, reason: "format" });
  });

  test("refuses a PNG cut off in the middle of its pixels", async () => {
    const png = await quadrantPicture(tmp(), "p", 64, 64, "png");
    expect((await runWith(png.subarray(0, png.length - 40), "png")).outcome).toEqual({ ok: false, reason: "format" });
  });

  test("refuses a JPEG cut off in the middle of its scan", async () => {
    const jpeg = await quadrantPicture(tmp(), "p", 64, 64, "jpeg");
    expect((await runWith(jpeg.subarray(0, Math.floor(jpeg.length / 2)), "jpeg")).outcome).toEqual({ ok: false, reason: "format" });
  });

  test("refuses a GIF, an APNG and every container that is not a still picture of ours", async () => {
    for (const format of ["gif", "apng", "mp4", "mov", "m4a", "wav", "flac", "ogg", "mp3", "aac"] as const) {
      expect((await runWith(await quadrantPicture(tmp(), "p", 8, 8, "png"), format)).outcome).toEqual({ ok: false, reason: "format" });
    }
  });

  test("refuses an animated WebP without starting a child process", async () => {
    const animated = await animatedWebp(tmp(), "a", 32, 32);
    const spawner: FfmpegSpawner = () => {
      throw new Error("must not be spawned");
    };
    expect((await runWith(animated, "webp", { spawner })).outcome).toEqual({ ok: false, reason: "animated-webp" });
  });

  test("refuses a WebP whose header cannot be read", async () => {
    const webp = await quadrantPicture(tmp(), "p", 16, 16, "webp");
    expect((await runWith(webp.subarray(0, 14), "webp")).outcome).toEqual({ ok: false, reason: "format" });
  });

  test("refuses a staged copy that no longer hashes to what the staging recorded", async () => {
    const picture = await quadrantPicture(tmp(), "p", 16, 16, "jpeg");
    const hand = await handoff(tmp(), picture, { format: "jpeg", sha256: "0".repeat(64) });
    expect(await importerWith()(hand.request)).toEqual({ ok: false, reason: "failed" });
  });

  test("answers cancelled, and starts nothing, when the signal fired before it began", async () => {
    const picture = await quadrantPicture(tmp(), "p", 16, 16, "webp");
    const hand = await handoff(tmp(), picture, { format: "webp" });
    hand.controller.abort();
    const spawner: FfmpegSpawner = () => {
      throw new Error("must not be spawned");
    };
    expect(await importerWith({ spawner })(hand.request)).toEqual({ ok: false, reason: "cancelled" });
    expect(hand.works).toHaveLength(0);
  });
});

/** A child process that never finishes by itself: it ends only when it is killed. */
function hangingChild(): { child: FfmpegChild; killed: () => string[] } {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const closers: ((code: number | null, signal: NodeJS.Signals | null) => void)[] = [];
  const kills: string[] = [];
  const self: { exitCode: number | null } = { exitCode: null };
  const child: FfmpegChild = {
    get exitCode() {
      return self.exitCode;
    },
    stdout,
    stderr,
    kill: (signal) => {
      kills.push(String(signal));
      self.exitCode = 137;
      queueMicrotask(() => closers.forEach((close) => close(null, "SIGKILL")));
      return true;
    },
    on: ((event: string, listener: (...args: never[]) => void) => {
      if (event === "close") closers.push(listener as (code: number | null, signal: NodeJS.Signals | null) => void);
      return child;
    }) as FfmpegChild["on"],
  };
  return { child, killed: () => kills };
}

/** A child that exits at once with `code`, having written `stderrText`. */
function failingChild(code: number, stderrText: string): FfmpegChild {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const closers: ((code: number | null, signal: NodeJS.Signals | null) => void)[] = [];
  const child: FfmpegChild = {
    exitCode: null,
    stdout,
    stderr,
    kill: () => true,
    on: ((event: string, listener: (...args: never[]) => void) => {
      if (event === "close") {
        closers.push(listener as (code: number | null, signal: NodeJS.Signals | null) => void);
        setTimeout(() => {
          stderr.write(stderrText);
          closers.forEach((close) => close(code, null));
        }, 0);
      }
      return child;
    }) as FfmpegChild["on"],
  };
  return child;
}

async function folderListing(dir: string): Promise<string> {
  const names = (await readdir(dir)).sort();
  const sizes = await Promise.all(names.map(async (name) => `${name}:${(await stat(join(dir, name))).size}`));
  return sizes.join(",");
}

describe("the photo importer: ffmpeg is a child process that a cancel kills", () => {
  test("a cancel during the WebP decode kills ffmpeg and answers cancelled", async () => {
    const picture = await quadrantPicture(tmp(), "p", 32, 32, "webp");
    const { child, killed } = hangingChild();
    let spawnedCall: () => void = () => undefined;
    const spawned = new Promise<void>((resolve) => (spawnedCall = resolve));
    const spawner: FfmpegSpawner = () => {
      spawnedCall();
      return child;
    };
    const hand = await handoff(tmp(), picture, { format: "webp" });
    const running = importerWith({ spawner })(hand.request);
    await spawned;
    hand.controller.abort();
    expect(await running).toEqual({ ok: false, reason: "cancelled" });
    expect(killed()).toEqual(["SIGKILL"]);
  });

  test("a cancel during the encode kills ffmpeg, answers cancelled and writes nothing more", async () => {
    const picture = await quadrantPicture(tmp(), "p", 32, 32, "jpeg");
    const { child, killed } = hangingChild();
    let spawnedCall: () => void = () => undefined;
    const spawned = new Promise<void>((resolve) => (spawnedCall = resolve));
    const spawner: FfmpegSpawner = () => {
      spawnedCall();
      return child;
    };
    const hand = await handoff(tmp(), picture, { format: "jpeg" });
    const running = importerWith({ spawner })(hand.request);
    await spawned;
    hand.controller.abort();
    expect(await running).toEqual({ ok: false, reason: "cancelled" });
    expect(killed()).toEqual(["SIGKILL"]);
    const after = await folderListing(tmp());
    for (let turn = 0; turn < 5; turn++) await new Promise<void>((resolve) => setImmediate(resolve));
    expect(await folderListing(tmp())).toBe(after);
  });

  test("a decode worker that failed or ran out of time is `failed`, not a picture that cannot be read", async () => {
    const picture = await quadrantPicture(tmp(), "p", 16, 16, "jpeg");
    const hand = await handoff(tmp(), picture, { format: "jpeg" });
    const broken: PhotoImporterDeps["decode"] = async () => {
      throw new DecodeWorkerError("the decode worker stopped");
    };
    expect(await createPhotoImporter({ decode: broken })(hand.request)).toEqual({ ok: false, reason: "failed" });
  });

  test("a cancel during the WASM decode is seen before ffmpeg is started", async () => {
    const picture = await quadrantPicture(tmp(), "p", 32, 32, "jpeg");
    const hand = await handoff(tmp(), picture, { format: "jpeg" });
    const spawner: FfmpegSpawner = () => {
      throw new Error("must not be spawned after the cancel");
    };
    const slowDecode: PhotoImporterDeps["decode"] = async (bytes, signal) => {
      const image = await decoder(bytes, signal);
      hand.controller.abort();
      return image;
    };
    expect(await createPhotoImporter({ decode: slowDecode, spawner })(hand.request)).toEqual({ ok: false, reason: "cancelled" });
  });

  test("an ffmpeg that fails is refused as failed, and nothing of its stderr travels", async () => {
    const picture = await quadrantPicture(tmp(), "p", 32, 32, "jpeg");
    const spawner: FfmpegSpawner = () => failingChild(1, "Error opening /Users/secret/photos/private.jpg: Invalid data");
    const { outcome } = await runWith(picture, "jpeg", { spawner });
    expect(outcome).toEqual({ ok: false, reason: "failed" });
    expect(JSON.stringify(outcome)).not.toContain("secret");
  });

  test("an ffmpeg that runs past its time limit is killed and the photo is refused as failed", async () => {
    const picture = await quadrantPicture(tmp(), "p", 32, 32, "jpeg");
    const { child, killed } = hangingChild();
    const { outcome } = await runWith(picture, "jpeg", { spawner: () => child, ffmpegTimeoutMs: 25 });
    expect(outcome).toEqual({ ok: false, reason: "failed" });
    expect(killed()).toEqual(["SIGKILL"]);
  });

  test("every ffmpeg call is hardened: file protocol only, an explicit demuxer, capped allocations, no stdin, no metadata", async () => {
    const picture = await quadrantPicture(tmp(), "p", 32, 32, "webp");
    const calls: string[][] = [];
    const spawner: FfmpegSpawner = (command, args, options) => {
      calls.push([...args]);
      const { env, ...rest } = options;
      return spawn(command, [...args], { ...rest, ...(env === undefined ? {} : { env }), stdio: [...options.stdio] });
    };
    await accepted(await runWith(picture, "webp", { spawner }));
    expect(calls).toHaveLength(2);
    for (const argv of calls) {
      const at = (flag: string): string | undefined => argv[argv.indexOf(flag) + 1];
      expect(at("-protocol_whitelist")).toBe("file");
      expect(Number(at("-max_alloc"))).toBeGreaterThan(0);
      expect(argv).toContain("-nostdin");
      expect(argv.indexOf("-f")).toBeGreaterThan(-1);
      expect(argv.indexOf("-f")).toBeLessThan(argv.indexOf("-i"));
    }
    expect(calls[0]?.[(calls[0]?.indexOf("-f") ?? 0) + 1]).toBe("webp_pipe");
    expect(calls[1]?.[(calls[1]?.indexOf("-f") ?? 0) + 1]).toBe("rawvideo");
    expect(calls[1]).toContain("-map_metadata");
  });

  test("the ffmpeg never gets the owner's path: it reads the staged copy and the work files only", async () => {
    const picture = await quadrantPicture(tmp(), "p", 32, 32, "webp");
    const calls: string[][] = [];
    const spawner: FfmpegSpawner = (command, args, options) => {
      calls.push([...args]);
      const { env, ...rest } = options;
      return spawn(command, [...args], { ...rest, ...(env === undefined ? {} : { env }), stdio: [...options.stdio] });
    };
    const hand = await handoff(tmp(), picture, { format: "webp", name: "holiday.webp" });
    await importerWith({ spawner })(hand.request);
    const mentioned = calls.flat().filter((token) => token.includes("/") || token.includes("\\"));
    const allowed = new Set([hand.request.staged.path, ...hand.works.map((w) => w.path)]);
    for (const token of mentioned) expect(allowed.has(token)).toBe(true);
    expect(calls.flat().join(" ")).not.toContain("holiday");
  });
});

describe("the photo importer: what the review of 3f.2 found (round 1)", () => {
  test("M3: the PNG ffmpeg made of a WebP is looked at before it is read: over the ceiling it is refused as dimensions", async () => {
    const picture = await quadrantPicture(tmp(), "p", 48, 32, "webp");
    expect((await runWith(picture, "webp", { maxDecodedPngBytes: 16 })).outcome).toEqual({ ok: false, reason: "dimensions" });
  });

  test("M3: the same WebP is taken when the PNG is under the ceiling", async () => {
    const picture = await quadrantPicture(tmp(), "p", 48, 32, "webp");
    expect((await runWith(picture, "webp", { maxDecodedPngBytes: 10_000_000 })).outcome.ok).toBe(true);
  });

  test("L2: the RGB work file is written with `wx`: a link already at its name is never written through", async () => {
    const picture = await quadrantPicture(tmp(), "p", 16, 16, "jpeg");
    const hand = await handoff(tmp(), picture, { format: "jpeg" });
    const victim = join(tmp(), "victim.bin");
    await writeFile(victim, "keep me");
    const link = join(tmp(), "work-link.media");
    await symlink(victim, link);
    const request = { ...hand.request, workFile: async () => ({ path: link, release: async () => undefined }) };
    expect(await importerWith()(request)).toEqual({ ok: false, reason: "failed" });
    expect(await readFile(victim, "utf8")).toBe("keep me");
  });

  test("L2: a stored JPEG whose own header is not the size that was meant is refused", async () => {
    const picture = await quadrantPicture(tmp(), "p", 32, 32, "jpeg");
    // The encode is told to make a 2x2 picture instead of the 32x32 one the importer meant.
    const spawner: FfmpegSpawner = (command, args, options) => {
      const argv = [...args];
      if (argv.includes("rawvideo")) argv.splice(argv.indexOf("-frames:v"), 0, "-vf", "scale=2:2");
      const { env, ...rest } = options;
      return spawn(command, argv, { ...rest, ...(env === undefined ? {} : { env }), stdio: [...options.stdio] });
    };
    expect((await runWith(picture, "jpeg", { spawner })).outcome).toEqual({ ok: false, reason: "failed" });
  });
});
