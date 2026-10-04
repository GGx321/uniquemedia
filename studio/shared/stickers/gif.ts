import { STICKER_LIMITS, type StickerLimits } from "./apng";
import { clampGifDelayCs } from "./quantise";

// A bounded GIF reader (3f.5), the sibling of `inspectApng` for a sticker the owner imports as a GIF. It walks the block list once and
// decodes every frame's LZW stream with COUNTS only: it keeps no pixel, so a hostile file costs one linear pass over bytes already in
// memory and a table of 4096 lengths. It never throws.
//
// What it promises: STRUCTURE and a complete image stream. Every block is well formed and in bounds; the logical screen and every frame
// descriptor are inside the caps (side, frame count, bytes) and every frame lies inside the screen; every frame's LZW data is a valid
// code stream whose pixel count is EXACTLY the frame's area (no short or long data, no code past the table, a minimum code size of 2
// to 8); the file ends with the trailer and nothing follows it; and each frame has a colour table (global or local).
//
// What it does NOT promise: that ffmpeg decodes the frames to the pictures a browser would. Disposal, transparency and the palette
// are a decoder's business; the importer cross-checks the frame count against ffmpeg's own decode and writes the pixels ffmpeg decoded.
//
// The delay: a GIF counts in centiseconds. 0 and 1 cs are what some encoders write for "no delay", and players replace them with 10 cs
// (browsers for 0 and 1; ffmpeg's gif demuxer for anything under 2 cs). `playedCs` is the delay after that clamp. A frame with no
// graphic control extension has a delay of 0, so it is played for 10 cs.
//
// The loop count (NETSCAPE2.0 / ANIMEXTS1.0) is reported and never trusted: a sticker loops forever whatever it says.

export type GifRejectCode =
  | "NOT_GIF"
  | "TOO_LARGE_FILE"
  | "TRUNCATED"
  | "BAD_SCREEN"
  | "SIDE_TOO_LARGE"
  | "NO_FRAMES"
  | "TOO_MANY_FRAMES"
  | "NO_TRAILER"
  | "TRAILING_DATA"
  | "BAD_BLOCK"
  | "BAD_FRAME_REGION"
  | "NO_PALETTE"
  | "BAD_LZW"
  | "FRAME_DATA_MISMATCH"
  | "TOO_MANY_BLOCKS";

export interface GifFrameInfo {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** The delay as written, in centiseconds (0 when the frame has no graphic control extension). */
  readonly delayCs: number;
  /** The delay the frame is played for: 0 and 1 cs become 10 cs. */
  readonly playedCs: number;
  readonly disposal: number;
  readonly transparent: boolean;
  readonly interlaced: boolean;
}

export interface GifInfo {
  /** The logical screen: the canvas every frame is drawn on. */
  readonly width: number;
  readonly height: number;
  readonly frameCount: number;
  readonly frames: readonly GifFrameInfo[];
  /** The loop count a NETSCAPE2.0 or ANIMEXTS1.0 block gives (0 is forever), or null when there is none. */
  readonly loopCount: number | null;
}

export type GifInspection =
  | { readonly ok: true; readonly info: GifInfo }
  | { readonly ok: false; readonly code: GifRejectCode; readonly detail: string };

/** Blocks beyond this are refused: a 5 MB file of 2-byte blocks would otherwise cost millions of iterations. */
const MAX_BLOCKS = 20_000;
const MAX_LZW_WIDTH = 12;
const TABLE_SIZE = 1 << MAX_LZW_WIDTH;

const fail = (code: GifRejectCode, detail: string): GifInspection => ({ ok: false, code, detail });

const ascii = (bytes: Uint8Array, at: number, length: number): string => String.fromCharCode(...bytes.subarray(at, at + length));

/** What a frame's data turned out to be: the pixels its codes make, or the code that was wrong. */
type LzwOutcome = { readonly ok: true; readonly pixels: number } | { readonly ok: false; readonly bad: "BAD_LZW" | "FRAME_DATA_MISMATCH" };

/**
 * Counts the pixels an LZW stream makes, reading its bits straight from the sub-blocks (`blocks` are the data's [start, end) ranges inside
 * `bytes`). Stops as soon as the count passes `expected`. Keeps no pixel: only each table entry's length.
 */
function countLzw(bytes: Uint8Array, blocks: readonly (readonly [number, number])[], minCodeSize: number, expected: number): LzwOutcome {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  const lengths = new Uint16Array(TABLE_SIZE);
  for (let i = 0; i < clear; i++) lengths[i] = 1;
  let width = minCodeSize + 1;
  let next = eoi + 1;
  let previous = -1;
  let pixels = 0;
  let acc = 0;
  let bits = 0;
  for (const [start, end] of blocks) {
    for (let at = start; at < end; at++) {
      acc |= (bytes[at] ?? 0) << bits;
      bits += 8;
      while (bits >= width) {
        const code = acc & ((1 << width) - 1);
        acc >>>= width;
        bits -= width;
        if (code === clear) {
          width = minCodeSize + 1;
          next = eoi + 1;
          previous = -1;
          continue;
        }
        if (code === eoi) return pixels === expected ? { ok: true, pixels } : { ok: false, bad: "FRAME_DATA_MISMATCH" };
        let length: number;
        if (previous === -1) {
          // The first code after a clear is a literal.
          if (code >= clear) return { ok: false, bad: "BAD_LZW" };
          length = 1;
        } else if (code < next) {
          length = lengths[code] ?? 0;
        } else if (code === next && next < TABLE_SIZE) {
          length = (lengths[previous] ?? 0) + 1;
        } else {
          return { ok: false, bad: "BAD_LZW" };
        }
        if (previous !== -1 && next < TABLE_SIZE) {
          lengths[next] = (lengths[previous] ?? 0) + 1;
          next += 1;
          if (next === 1 << width && width < MAX_LZW_WIDTH) width += 1;
        }
        previous = code;
        pixels += length;
        if (pixels > expected) return { ok: false, bad: "FRAME_DATA_MISMATCH" };
      }
    }
  }
  // The data ended with no end code: accepted only when it made exactly the pixels the frame holds.
  return pixels === expected ? { ok: true, pixels } : { ok: false, bad: "FRAME_DATA_MISMATCH" };
}

/**
 * Validates a GIF from its bytes. Refuses (never throws) a file over `limits.maxBytes`, a screen over `limits.maxSide`, more frames
 * than `limits.maxLoopFrames`, and any structural or LZW fault. Callers should `stat` first and not read a file already over the byte cap.
 */
export function inspectGif(bytes: Uint8Array, limits: StickerLimits = STICKER_LIMITS): GifInspection {
  if (bytes.length > limits.maxBytes) return fail("TOO_LARGE_FILE", `${bytes.length} bytes, the cap is ${limits.maxBytes}`);
  const signature = bytes.length >= 6 ? ascii(bytes, 0, 6) : "";
  if (signature !== "GIF89a" && signature !== "GIF87a") return fail("NOT_GIF", "no GIF signature");
  if (bytes.length < 13) return fail("TRUNCATED", "the file ends inside the logical screen descriptor");

  const u16 = (at: number): number => (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);
  const screenWidth = u16(6);
  const screenHeight = u16(8);
  const screenPacked = bytes[10] ?? 0;
  if (screenWidth === 0 || screenHeight === 0) return fail("BAD_SCREEN", `a ${screenWidth}x${screenHeight} logical screen`);
  if (screenWidth > limits.maxSide || screenHeight > limits.maxSide) {
    return fail("SIDE_TOO_LARGE", `${screenWidth}x${screenHeight}, the cap is ${limits.maxSide} per side`);
  }
  const hasGlobalTable = (screenPacked & 0x80) !== 0;
  let pos = 13;
  if (hasGlobalTable) {
    pos += 3 * (1 << ((screenPacked & 7) + 1));
    if (pos > bytes.length) return fail("TRUNCATED", "the global colour table runs past the end of the file");
  }

  /** Skips the sub-blocks that start at `at`; returns where they end and, when asked, their [start, end) data ranges. Null when the file ends first. */
  const walkSubBlocks = (at: number, ranges?: [number, number][]): number | null => {
    let cursor = at;
    for (;;) {
      if (cursor >= bytes.length) return null;
      const size = bytes[cursor] ?? 0;
      cursor += 1;
      if (size === 0) return cursor;
      if (cursor + size > bytes.length) return null;
      ranges?.push([cursor, cursor + size]);
      cursor += size;
    }
  };

  const frames: GifFrameInfo[] = [];
  let loopCount: number | null = null;
  let pending: { delayCs: number; disposal: number; transparent: boolean } | undefined;
  let blocks = 0;

  for (;;) {
    if (blocks >= MAX_BLOCKS) return fail("TOO_MANY_BLOCKS", `more than ${MAX_BLOCKS} blocks`);
    blocks += 1;
    if (pos >= bytes.length) return fail("NO_TRAILER", "the file ends before its trailer");
    const introducer = bytes[pos] ?? 0;

    if (introducer === 0x3b) {
      if (pos + 1 !== bytes.length) return fail("TRAILING_DATA", "bytes after the trailer");
      if (frames.length === 0) return fail("NO_FRAMES", "the file holds no image");
      return { ok: true, info: { width: screenWidth, height: screenHeight, frameCount: frames.length, frames, loopCount } };
    }

    if (introducer === 0x21) {
      if (pos + 2 > bytes.length) return fail("TRUNCATED", "the file ends inside an extension");
      const label = bytes[pos + 1] ?? 0;
      if (label === 0xf9) {
        // Graphic control extension: a block of exactly 4 bytes, then the terminator.
        if (pos + 8 > bytes.length) return fail("TRUNCATED", "the file ends inside a graphic control extension");
        if (bytes[pos + 2] !== 4 || bytes[pos + 7] !== 0) return fail("BAD_BLOCK", "a graphic control extension is not 4 bytes");
        const packed = bytes[pos + 3] ?? 0;
        const disposal = (packed >> 2) & 7;
        if (disposal > 3) return fail("BAD_BLOCK", `a reserved disposal method (${disposal})`);
        pending = { delayCs: u16(pos + 4), disposal, transparent: (packed & 1) !== 0 };
        pos += 8;
      } else if (label === 0xff) {
        // Application extension: an 11-byte header block, then sub-blocks.
        if (pos + 3 > bytes.length) return fail("TRUNCATED", "the file ends inside an application extension");
        if (bytes[pos + 2] !== 11) return fail("BAD_BLOCK", "an application extension header is not 11 bytes");
        if (pos + 14 > bytes.length) return fail("TRUNCATED", "the file ends inside an application extension");
        const id = ascii(bytes, pos + 3, 11);
        const ranges: [number, number][] = [];
        const end = walkSubBlocks(pos + 14, ranges);
        if (end === null) return fail("TRUNCATED", "the file ends inside an application extension");
        const first = ranges[0];
        if ((id === "NETSCAPE2.0" || id === "ANIMEXTS1.0") && first !== undefined && first[1] - first[0] === 3 && bytes[first[0]] === 1 && loopCount === null) {
          loopCount = u16(first[0] + 1);
        }
        pos = end;
      } else if (label === 0xfe || label === 0x01) {
        // A comment, or a plain text extension (which has a 12-byte block of its own before its sub-blocks).
        let from = pos + 2;
        if (label === 0x01) {
          if (bytes[from] !== 12) return fail("BAD_BLOCK", "a plain text extension header is not 12 bytes");
          from += 13;
        }
        const end = walkSubBlocks(from);
        if (end === null) return fail("TRUNCATED", "the file ends inside an extension");
        pos = end;
      } else {
        return fail("BAD_BLOCK", `an unknown extension label 0x${label.toString(16)}`);
      }
      continue;
    }

    if (introducer === 0x2c) {
      if (pos + 10 > bytes.length) return fail("TRUNCATED", "the file ends inside an image descriptor");
      const x = u16(pos + 1);
      const y = u16(pos + 3);
      const width = u16(pos + 5);
      const height = u16(pos + 7);
      const packed = bytes[pos + 9] ?? 0;
      if (frames.length >= limits.maxLoopFrames) return fail("TOO_MANY_FRAMES", `more than ${limits.maxLoopFrames} frames`);
      if (width === 0 || height === 0 || x + width > screenWidth || y + height > screenHeight) {
        return fail("BAD_FRAME_REGION", `frame ${frames.length} is ${width}x${height} at ${x},${y} on a ${screenWidth}x${screenHeight} screen`);
      }
      pos += 10;
      const hasLocalTable = (packed & 0x80) !== 0;
      if (hasLocalTable) {
        pos += 3 * (1 << ((packed & 7) + 1));
        if (pos > bytes.length) return fail("TRUNCATED", "a local colour table runs past the end of the file");
      } else if (!hasGlobalTable) {
        return fail("NO_PALETTE", `frame ${frames.length} has no colour table`);
      }
      if (pos >= bytes.length) return fail("TRUNCATED", "the file ends before a frame's data");
      const minCodeSize = bytes[pos] ?? 0;
      if (minCodeSize < 2 || minCodeSize > 8) return fail("BAD_LZW", `a minimum LZW code size of ${minCodeSize}`);
      const ranges: [number, number][] = [];
      const end = walkSubBlocks(pos + 1, ranges);
      if (end === null) return fail("TRUNCATED", "the file ends inside a frame's data");
      const outcome = countLzw(bytes, ranges, minCodeSize, width * height);
      if (!outcome.ok) return fail(outcome.bad, outcome.bad === "BAD_LZW" ? `frame ${frames.length}'s LZW codes are not valid` : `frame ${frames.length}'s data does not make ${width}x${height} pixels`);
      const delayCs = pending?.delayCs ?? 0;
      frames.push({
        x,
        y,
        width,
        height,
        delayCs,
        playedCs: clampGifDelayCs(delayCs),
        disposal: pending?.disposal ?? 0,
        transparent: pending?.transparent ?? false,
        interlaced: (packed & 0x40) !== 0,
      });
      pending = undefined;
      pos = end;
      continue;
    }

    return fail("BAD_BLOCK", `a block that starts with 0x${introducer.toString(16)}`);
  }
}
