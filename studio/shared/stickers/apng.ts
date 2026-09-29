import { crc32 } from "./crc32";

// A bounded APNG header reader. It walks the chunk list once, checks every
// chunk's CRC and the acTL/fcTL/fdAT structure, and never inflates a pixel, so
// a hostile file costs one linear pass over bytes already in memory. It is the
// gate for the built-in set (the generator's self-check) and for own stickers
// (3b.6, 3f.5): what it accepts, the render's in-graph loop reads exactly as
// the preview does.

export const STICKER_FPS = 30;

export interface StickerLimits {
  /** Largest allowed width or height, in pixels. */
  readonly maxSide: number;
  /** Largest allowed file, in bytes. */
  readonly maxBytes: number;
  /** Longest allowed loop, in 30 fps frames (the in-graph loop cache holds 300). */
  readonly maxLoopFrames: number;
}

export const STICKER_LIMITS: StickerLimits = { maxSide: 720, maxBytes: 5 * 1024 * 1024, maxLoopFrames: 300 };

/** Chunks beyond this are refused: a 5 MB file of 12-byte chunks would otherwise cost 400k iterations. */
const MAX_CHUNKS = 20_000;
const MAX_CHUNK_LENGTH = 0x7fffffff;

export type ApngRejectCode =
  | "NOT_PNG"
  | "TOO_LARGE_FILE"
  | "TRAILING_DATA"
  | "SIDE_TOO_LARGE"
  | "BAD_DIMENSIONS"
  | "TOO_MANY_FRAMES"
  | "LOOP_TOO_LONG"
  | "OFF_GRID_DELAY"
  | "ZERO_DELAY"
  | "NOT_ANIMATED"
  | "TRUNCATED"
  | "BAD_CRC"
  | "BAD_CHUNK"
  | "BAD_IHDR"
  | "FRAME_COUNT_MISMATCH"
  | "BAD_ACTL"
  | "DEFAULT_IMAGE_NOT_A_FRAME"
  | "BAD_SEQUENCE"
  | "BAD_FRAME_REGION"
  | "MISSING_FRAME_DATA"
  | "BAD_CHUNK_ORDER"
  | "TOO_MANY_CHUNKS";

export interface ApngFrameInfo {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** The delay as written in fcTL (`delayDen` 0 is already read as 100). */
  readonly delayNum: number;
  readonly delayDen: number;
  /** The delay in 30 fps frames: always an integer >= 1 in an accepted file. */
  readonly delayFrames: number;
}

export interface ApngInfo {
  readonly width: number;
  readonly height: number;
  readonly bitDepth: number;
  readonly colorType: number;
  readonly interlaced: boolean;
  readonly frameCount: number;
  readonly frames: readonly ApngFrameInfo[];
  /** The sum of the delays in 30 fps frames: the loop period the render and the preview share. */
  readonly loopFrames: number;
  /** acTL `num_plays`; 0 means forever. The render loops in the graph whatever it says. */
  readonly loopCount: number;
}

export type ApngInspection =
  | { readonly ok: true; readonly info: ApngInfo }
  | { readonly ok: false; readonly code: ApngRejectCode; readonly detail: string };

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const VALID_DEPTHS: Readonly<Record<number, readonly number[]>> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
};

const fail = (code: ApngRejectCode, detail: string): ApngInspection => ({ ok: false, code, detail });

/**
 * Validates an APNG from its bytes. Refuses (never throws) a file over
 * `limits.maxBytes`, a canvas over `limits.maxSide`, a loop over
 * `limits.maxLoopFrames` 30 fps frames, a delay that is not a whole number of
 * 30 fps frames, and any structural fault. Callers should `stat` first and
 * not read a file already over the byte cap.
 */
export function inspectApng(bytes: Uint8Array, limits: StickerLimits = STICKER_LIMITS): ApngInspection {
  if (bytes.length > limits.maxBytes) return fail("TOO_LARGE_FILE", `${bytes.length} bytes, the cap is ${limits.maxBytes}`);
  if (bytes.length < SIGNATURE.length || SIGNATURE.some((b, i) => bytes[i] !== b)) return fail("NOT_PNG", "no PNG signature");

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u32 = (at: number): number => view.getUint32(at, false);
  const u16 = (at: number): number => view.getUint16(at, false);
  const type = (at: number): string => String.fromCharCode(bytes[at] ?? 0, bytes[at + 1] ?? 0, bytes[at + 2] ?? 0, bytes[at + 3] ?? 0);

  let pos = SIGNATURE.length;
  let chunks = 0;
  let header: { width: number; height: number; bitDepth: number; colorType: number; interlaced: boolean } | undefined;
  let declaredFrames: number | undefined;
  let loopCount = 0;
  const frames: ApngFrameInfo[] = [];
  let frameHasData = false;
  let nextSeq = 0;
  let loopFrames = 0;
  let sawIdat = false;
  let inIdatRun = false;

  while (true) {
    if (chunks >= MAX_CHUNKS) return fail("TOO_MANY_CHUNKS", `more than ${MAX_CHUNKS} chunks`);
    chunks += 1;
    if (bytes.length - pos < 8) return fail("TRUNCATED", "the file ends inside a chunk header");
    const length = u32(pos);
    const name = type(pos + 4);
    if (length > MAX_CHUNK_LENGTH) return fail("BAD_CHUNK", `${name} claims ${length} bytes`);
    const dataAt = pos + 8;
    if (dataAt + length + 4 > bytes.length) return fail("TRUNCATED", `${name} runs past the end of the file`);
    if (crc32(bytes.subarray(pos + 4, dataAt + length)) !== u32(dataAt + length)) return fail("BAD_CRC", `${name} fails its CRC`);
    if (header === undefined && name !== "IHDR") return fail("BAD_IHDR", "the first chunk is not IHDR");
    const isIdat = name === "IDAT";
    if (inIdatRun && !isIdat) inIdatRun = false;
    else if (isIdat && sawIdat && !inIdatRun) return fail("BAD_CHUNK_ORDER", "IDAT chunks are not consecutive");

    if (name === "IHDR") {
      if (header !== undefined || chunks !== 1) return fail("BAD_IHDR", "IHDR is not the first chunk");
      if (length !== 13) return fail("BAD_IHDR", "IHDR is not 13 bytes");
      const width = u32(dataAt);
      const height = u32(dataAt + 4);
      const bitDepth = bytes[dataAt + 8] ?? 0;
      const colorType = bytes[dataAt + 9] ?? 0;
      const interlace = bytes[dataAt + 12] ?? 0;
      if (!(VALID_DEPTHS[colorType] ?? []).includes(bitDepth)) return fail("BAD_IHDR", `colour type ${colorType} with bit depth ${bitDepth}`);
      if (bytes[dataAt + 10] !== 0 || bytes[dataAt + 11] !== 0 || interlace > 1) return fail("BAD_IHDR", "unknown compression, filter or interlace method");
      if (width === 0 || height === 0) return fail("BAD_DIMENSIONS", `${width}x${height}`);
      if (width > limits.maxSide || height > limits.maxSide) return fail("SIDE_TOO_LARGE", `${width}x${height}, the cap is ${limits.maxSide} per side`);
      header = { width, height, bitDepth, colorType, interlaced: interlace === 1 };
    } else if (name === "acTL") {
      if (declaredFrames !== undefined) return fail("BAD_ACTL", "a second acTL");
      if (sawIdat || frames.length > 0) return fail("NOT_ANIMATED", "acTL comes after the image data");
      if (length !== 8) return fail("BAD_ACTL", "acTL is not 8 bytes");
      const n = u32(dataAt);
      if (n === 0) return fail("BAD_ACTL", "acTL declares no frames");
      if (n > limits.maxLoopFrames) return fail("TOO_MANY_FRAMES", `${n} frames, the cap is ${limits.maxLoopFrames}`);
      declaredFrames = n;
      loopCount = u32(dataAt + 4);
    } else if (name === "fcTL") {
      if (header === undefined) return fail("BAD_IHDR", "fcTL before IHDR");
      if (declaredFrames === undefined) return fail("NOT_ANIMATED", "fcTL without acTL");
      if (length !== 26) return fail("BAD_CHUNK", "fcTL is not 26 bytes");
      if (frames.length > 0 && !frameHasData) return fail("MISSING_FRAME_DATA", `frame ${frames.length - 1} has no image data`);
      if (frames.length === 0 && sawIdat) return fail("DEFAULT_IMAGE_NOT_A_FRAME", "the image data comes before the first fcTL");
      if (frames.length >= declaredFrames) return fail("FRAME_COUNT_MISMATCH", `more than the ${declaredFrames} frames acTL declares`);
      if (u32(dataAt) !== nextSeq) return fail("BAD_SEQUENCE", `fcTL carries sequence ${u32(dataAt)}, expected ${nextSeq}`);
      nextSeq += 1;
      const width = u32(dataAt + 4);
      const height = u32(dataAt + 8);
      const x = u32(dataAt + 12);
      const y = u32(dataAt + 16);
      if (width === 0 || height === 0 || x + width > header.width || y + height > header.height) {
        return fail("BAD_FRAME_REGION", `frame ${frames.length} is ${width}x${height} at ${x},${y} on a ${header.width}x${header.height} canvas`);
      }
      if (frames.length === 0 && (x !== 0 || y !== 0 || width !== header.width || height !== header.height)) {
        return fail("BAD_FRAME_REGION", "the first frame does not cover the canvas");
      }
      if ((bytes[dataAt + 24] ?? 0) > 2 || (bytes[dataAt + 25] ?? 0) > 1) return fail("BAD_CHUNK", "fcTL has an unknown dispose or blend op");
      const delayNum = u16(dataAt + 20);
      const delayDen = u16(dataAt + 22) === 0 ? 100 : u16(dataAt + 22);
      if (delayNum === 0) return fail("ZERO_DELAY", `frame ${frames.length} has a zero delay`);
      if ((delayNum * STICKER_FPS) % delayDen !== 0) {
        return fail("OFF_GRID_DELAY", `frame ${frames.length} lasts ${delayNum}/${delayDen} s, not a whole number of 1/${STICKER_FPS} s frames`);
      }
      const delayFrames = (delayNum * STICKER_FPS) / delayDen;
      loopFrames += delayFrames;
      if (loopFrames > limits.maxLoopFrames) return fail("LOOP_TOO_LONG", `the loop passes ${limits.maxLoopFrames} frames at ${STICKER_FPS} fps`);
      frames.push({ x, y, width, height, delayNum, delayDen, delayFrames });
      frameHasData = false;
    } else if (isIdat) {
      if (declaredFrames === undefined) return fail("NOT_ANIMATED", "IDAT without acTL: a still PNG");
      if (frames.length === 0) return fail("DEFAULT_IMAGE_NOT_A_FRAME", "the image data comes before the first fcTL");
      if (frames.length > 1) return fail("BAD_CHUNK_ORDER", "IDAT after the first frame");
      sawIdat = true;
      inIdatRun = true;
      frameHasData = true;
    } else if (name === "fdAT") {
      if (frames.length < 2) return fail("BAD_CHUNK_ORDER", "fdAT outside a frame after the first");
      if (length < 5) return fail("BAD_CHUNK", "fdAT carries no data");
      if (u32(dataAt) !== nextSeq) return fail("BAD_SEQUENCE", `fdAT carries sequence ${u32(dataAt)}, expected ${nextSeq}`);
      nextSeq += 1;
      frameHasData = true;
    } else if (name === "IEND") {
      if (length !== 0) return fail("BAD_CHUNK", "IEND carries data");
      if (declaredFrames === undefined) return fail("NOT_ANIMATED", "no acTL: a still PNG");
      if (frames.length !== declaredFrames) return fail("FRAME_COUNT_MISMATCH", `acTL declares ${declaredFrames} frames, the file holds ${frames.length}`);
      if (!frameHasData) return fail("MISSING_FRAME_DATA", `frame ${frames.length - 1} has no image data`);
      if (dataAt + length + 4 !== bytes.length) return fail("TRAILING_DATA", "bytes after IEND");
      if (header === undefined) return fail("BAD_IHDR", "no IHDR");
      return {
        ok: true,
        info: { ...header, frameCount: frames.length, frames, loopFrames, loopCount },
      };
    }
    pos = dataAt + length + 4;
  }
}
