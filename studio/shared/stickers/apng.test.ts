import { describe, expect, test } from "bun:test";
import { inspectApng, STICKER_LIMITS, type ApngInspection, type ApngRejectCode } from "./apng";
import { actl, buildApng, chunk, concat, fctl, fdat, idat, iend, ihdr, plte, PNG_SIGNATURE } from "./apng.testkit";
import { crc32 } from "./crc32";

const frames = (n: number, f: { delayNum?: number; delayDen?: number } = {}): { delayNum?: number; delayDen?: number }[] =>
  Array.from({ length: n }, () => f);

function rejected(result: ApngInspection): ApngRejectCode {
  if (result.ok) throw new Error("expected a refusal");
  return result.code;
}

function accepted(result: ApngInspection) {
  if (!result.ok) throw new Error(`expected acceptance, got ${result.code}: ${result.detail}`);
  return result.info;
}

describe("crc32", () => {
  test("matches the standard check value for '123456789'", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });
  test("of nothing is 0", () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe("inspectApng: what it reports", () => {
  test("reports the canvas size", () => {
    const info = accepted(inspectApng(buildApng({ width: 40, height: 30, frames: frames(3) })));
    expect([info.width, info.height]).toEqual([40, 30]);
  });
  test("reports the frame count", () => {
    expect(accepted(inspectApng(buildApng({ frames: frames(5) }))).frameCount).toBe(5);
  });
  test("reports each frame's delay as a rational and in 30 fps frames", () => {
    const info = accepted(
      inspectApng(buildApng({ frames: [{ delayNum: 1, delayDen: 30 }, { delayNum: 2, delayDen: 30 }, { delayNum: 1, delayDen: 15 }, { delayNum: 10, delayDen: 100 }] })),
    );
    expect(info.frames.map((f) => [f.delayNum, f.delayDen, f.delayFrames])).toEqual([
      [1, 30, 1],
      [2, 30, 2],
      [1, 15, 2],
      [10, 100, 3],
    ]);
  });
  test("reads a zero denominator as 100, as the APNG spec says", () => {
    const info = accepted(inspectApng(buildApng({ frames: [{ delayNum: 10, delayDen: 0 }] })));
    expect(info.frames[0]?.delayFrames).toBe(3);
  });
  test("sums the delays into the loop length in 30 fps frames", () => {
    const info = accepted(inspectApng(buildApng({ frames: [{ delayNum: 1, delayDen: 30 }, { delayNum: 3, delayDen: 30 }, { delayNum: 1, delayDen: 30 }] })));
    expect(info.loopFrames).toBe(5);
  });
  test("reports the loop count, 0 meaning forever", () => {
    expect(accepted(inspectApng(buildApng({ frames: frames(2), numPlays: 0 }))).loopCount).toBe(0);
    expect(accepted(inspectApng(buildApng({ frames: frames(2), numPlays: 3 }))).loopCount).toBe(3);
  });
});

describe("inspectApng: the caps", () => {
  test("accepts exactly 720 px on each side", () => {
    accepted(inspectApng(buildApng({ width: 720, height: 720, frames: frames(2) })));
  });
  test("refuses a width of 721", () => {
    expect(rejected(inspectApng(buildApng({ width: 721, height: 10, frames: frames(2) })))).toBe("SIDE_TOO_LARGE");
  });
  test("refuses a height of 721", () => {
    expect(rejected(inspectApng(buildApng({ width: 10, height: 721, frames: frames(2) })))).toBe("SIDE_TOO_LARGE");
  });
  test("refuses a zero-sized canvas", () => {
    expect(rejected(inspectApng(concat([PNG_SIGNATURE, ihdr(0, 8), iend()])))).toBe("BAD_DIMENSIONS");
  });
  test("accepts a loop of exactly 300 frames", () => {
    accepted(inspectApng(buildApng({ frames: frames(300) })));
  });
  test("refuses a loop of 301 frames", () => {
    expect(rejected(inspectApng(buildApng({ frames: frames(301) })))).toBe("TOO_MANY_FRAMES");
  });
  test("refuses a few frames whose delays add up to 301 grid frames", () => {
    expect(rejected(inspectApng(buildApng({ frames: [{ delayNum: 150, delayDen: 30 }, { delayNum: 151, delayDen: 30 }] })))).toBe("LOOP_TOO_LONG");
  });
  test("accepts a file of exactly the byte cap and refuses one byte more, before parsing", () => {
    const limits = { ...STICKER_LIMITS, maxBytes: 4096 };
    const base = buildApng({ frames: frames(2) });
    const padded = (n: number): Uint8Array => concat([base, new Uint8Array(n)]);
    // Trailing zeros would be TRAILING_DATA, so the at-cap file is judged only on size: not TOO_LARGE_FILE.
    expect(rejected(inspectApng(padded(4096 - base.length), limits))).toBe("TRAILING_DATA");
    expect(rejected(inspectApng(padded(4097 - base.length), limits))).toBe("TOO_LARGE_FILE");
  });
  test("refuses an oversized file without reading past its size", () => {
    expect(rejected(inspectApng(new Uint8Array(STICKER_LIMITS.maxBytes + 1)))).toBe("TOO_LARGE_FILE");
  });
  test("refuses a declared frame count above the cap before looking at any frame", () => {
    const bytes = concat([PNG_SIGNATURE, ihdr(8, 8), actl(0x7fffffff, 0), iend()]);
    expect(rejected(inspectApng(bytes))).toBe("TOO_MANY_FRAMES");
  });
});

describe("inspectApng: the 30 fps grid", () => {
  test("refuses a 25 fps delay (1/25 s)", () => {
    expect(rejected(inspectApng(buildApng({ frames: [{ delayNum: 1, delayDen: 25 }, { delayNum: 1, delayDen: 25 }] })))).toBe("OFF_GRID_DELAY");
  });
  test("refuses a 40 ms delay written as 4/100", () => {
    expect(rejected(inspectApng(buildApng({ frames: [{ delayNum: 4, delayDen: 100 }, { delayNum: 4, delayDen: 100 }] })))).toBe("OFF_GRID_DELAY");
  });
  test("refuses a zero delay", () => {
    expect(rejected(inspectApng(buildApng({ frames: [{ delayNum: 0, delayDen: 30 }, { delayNum: 1, delayDen: 30 }] })))).toBe("ZERO_DELAY");
  });
});

describe("inspectApng: malformed input", () => {
  const good = (): Uint8Array => buildApng({ frames: frames(3) });

  test("refuses bytes that are not a PNG", () => {
    expect(rejected(inspectApng(new TextEncoder().encode("GIF89a not a png")))).toBe("NOT_PNG");
  });
  test("refuses an empty input", () => {
    expect(rejected(inspectApng(new Uint8Array(0)))).toBe("NOT_PNG");
  });
  test("refuses a still PNG with no acTL", () => {
    expect(rejected(inspectApng(concat([PNG_SIGNATURE, ihdr(8, 8), idat(), iend()])))).toBe("NOT_ANIMATED");
  });
  test("refuses a file cut short in the middle of a chunk", () => {
    const bytes = good();
    expect(rejected(inspectApng(bytes.subarray(0, bytes.length - 20)))).toBe("TRUNCATED");
  });
  test("refuses a file cut before IEND, on a chunk boundary", () => {
    const bytes = good();
    expect(rejected(inspectApng(bytes.subarray(0, bytes.length - 12)))).toBe("TRUNCATED");
  });
  test("refuses a chunk whose CRC is wrong", () => {
    const bytes = concat([PNG_SIGNATURE, ihdr(8, 8), chunk("acTL", [0, 0, 0, 2, 0, 0, 0, 0], 12345)]);
    expect(rejected(inspectApng(bytes))).toBe("BAD_CRC");
  });
  test("refuses a chunk that claims more bytes than the file has", () => {
    const bytes = concat([PNG_SIGNATURE, Uint8Array.from([0x7f, 0xff, 0xff, 0xff, 0x49, 0x44, 0x41, 0x54])]);
    expect(rejected(inspectApng(bytes))).toBe("TRUNCATED");
  });
  test("refuses a chunk length above the PNG maximum", () => {
    const bytes = concat([PNG_SIGNATURE, Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0x49, 0x44, 0x41, 0x54, 0, 0, 0, 0])]);
    expect(rejected(inspectApng(bytes))).toBe("BAD_CHUNK");
  });
  test("refuses a file whose first chunk is not IHDR", () => {
    expect(rejected(inspectApng(concat([PNG_SIGNATURE, actl(1, 0), iend()])))).toBe("BAD_IHDR");
  });
  test("refuses an IHDR with an impossible colour type and depth pair", () => {
    expect(rejected(inspectApng(buildApng({ frames: frames(2), colorType: 6, bitDepth: 4 })))).toBe("BAD_IHDR");
  });
  test("refuses bytes after IEND", () => {
    expect(rejected(inspectApng(concat([good(), Uint8Array.from([1])])))).toBe("TRAILING_DATA");
  });
  test("refuses acTL declaring more frames than the file holds", () => {
    expect(rejected(inspectApng(buildApng({ frames: frames(2), declaredFrames: 3 })))).toBe("FRAME_COUNT_MISMATCH");
  });
  test("refuses acTL declaring fewer frames than the file holds", () => {
    expect(rejected(inspectApng(buildApng({ frames: frames(3), declaredFrames: 2 })))).toBe("FRAME_COUNT_MISMATCH");
  });
  test("refuses acTL declaring no frames", () => {
    expect(rejected(inspectApng(buildApng({ frames: frames(2), declaredFrames: 0 })))).toBe("BAD_ACTL");
  });
  test("refuses an acTL that is not 8 bytes long", () => {
    expect(rejected(inspectApng(concat([PNG_SIGNATURE, ihdr(8, 8), chunk("acTL", [0, 0, 0, 1]), iend()])))).toBe("BAD_ACTL");
  });
  test("refuses a second acTL", () => {
    expect(rejected(inspectApng(concat([PNG_SIGNATURE, ihdr(8, 8), actl(1, 0), actl(1, 0), iend()])))).toBe("BAD_ACTL");
  });
  test("refuses an acTL after the image data", () => {
    const bytes = concat([PNG_SIGNATURE, ihdr(8, 8), fctl(0, 8, 8, 0, 0, 1, 30), idat(), actl(1, 0), iend()]);
    expect(rejected(inspectApng(bytes))).toBe("NOT_ANIMATED");
  });
  test("refuses default image data that is not the first frame", () => {
    const bytes = concat([PNG_SIGNATURE, ihdr(8, 8), actl(2, 0), idat(), fctl(0, 8, 8, 0, 0, 1, 30), fdat(1), iend()]);
    expect(rejected(inspectApng(bytes))).toBe("DEFAULT_IMAGE_NOT_A_FRAME");
  });
  test("refuses a skipped sequence number", () => {
    expect(rejected(inspectApng(buildApng({ frames: [{}, { seq: 5 }] })))).toBe("BAD_SEQUENCE");
  });
  test("refuses a repeated sequence number", () => {
    const bytes = concat([PNG_SIGNATURE, ihdr(8, 8), actl(2, 0), fctl(0, 8, 8, 0, 0, 1, 30), idat(), fctl(0, 8, 8, 0, 0, 1, 30), fdat(1), iend()]);
    expect(rejected(inspectApng(bytes))).toBe("BAD_SEQUENCE");
  });
  test("refuses an fdAT that carries the wrong sequence number", () => {
    const bytes = concat([PNG_SIGNATURE, ihdr(8, 8), actl(2, 0), fctl(0, 8, 8, 0, 0, 1, 30), idat(), fctl(1, 8, 8, 0, 0, 1, 30), fdat(9), iend()]);
    expect(rejected(inspectApng(bytes))).toBe("BAD_SEQUENCE");
  });
  test("refuses a frame that overflows the canvas", () => {
    expect(rejected(inspectApng(buildApng({ frames: [{}, { x: 4, width: 8 }] })))).toBe("BAD_FRAME_REGION");
  });
  test("refuses a first frame that does not cover the canvas", () => {
    expect(rejected(inspectApng(buildApng({ frames: [{ width: 4 }, {}] })))).toBe("BAD_FRAME_REGION");
  });
  test("refuses a zero-sized frame", () => {
    expect(rejected(inspectApng(buildApng({ frames: [{}, { width: 0 }] })))).toBe("BAD_FRAME_REGION");
  });
  test("refuses a frame with no data", () => {
    const bytes = concat([PNG_SIGNATURE, ihdr(8, 8), actl(2, 0), fctl(0, 8, 8, 0, 0, 1, 30), idat(), fctl(1, 8, 8, 0, 0, 1, 30), iend()]);
    expect(rejected(inspectApng(bytes))).toBe("MISSING_FRAME_DATA");
  });
  test("refuses fdAT data for the first frame", () => {
    const bytes = concat([PNG_SIGNATURE, ihdr(8, 8), actl(1, 0), fctl(0, 8, 8, 0, 0, 1, 30), fdat(1), iend()]);
    expect(rejected(inspectApng(bytes))).toBe("BAD_CHUNK_ORDER");
  });
  test("refuses IDAT chunks split by another chunk", () => {
    const bytes = concat([PNG_SIGNATURE, ihdr(8, 8), actl(1, 0), fctl(0, 8, 8, 0, 0, 1, 30), idat(), chunk("tEXt", [65]), idat(), iend()]);
    expect(rejected(inspectApng(bytes))).toBe("BAD_CHUNK_ORDER");
  });
  test("accepts one frame spread over several IDAT chunks", () => {
    const bytes = concat([PNG_SIGNATURE, ihdr(8, 8), actl(1, 0), fctl(0, 8, 8, 0, 0, 1, 30), idat(), idat(), iend()]);
    expect(accepted(inspectApng(bytes)).frameCount).toBe(1);
  });
  test("refuses a file made of a huge number of tiny chunks", () => {
    const junk = Array.from({ length: 20_001 }, () => chunk("tEXt", []));
    const bytes = concat([PNG_SIGNATURE, ihdr(8, 8), actl(1, 0), ...junk, iend()]);
    expect(rejected(inspectApng(bytes))).toBe("TOO_MANY_CHUNKS");
  });
  test("never throws on any prefix of a valid file", () => {
    const bytes = good();
    for (let n = 0; n < bytes.length; n++) expect(inspectApng(bytes.subarray(0, n)).ok).toBe(false);
  });
  test("never throws on a valid file with any one byte flipped", () => {
    const bytes = good();
    for (let i = 0; i < bytes.length; i++) {
      const copy = Uint8Array.from(bytes);
      copy[i] = (copy[i] ?? 0) ^ 0xff;
      expect(() => inspectApng(copy)).not.toThrow();
    }
  });
});

describe("inspectApng: files the preview and the render could read differently", () => {
  test("refuses a chunk type with a digit in it", () => {
    expect(rejected(inspectApng(buildApng({ frames: frames(2), early: [chunk("tE1t", [65])] })))).toBe("BAD_CHUNK_TYPE");
  });
  test("refuses a chunk type with a control byte in it", () => {
    expect(rejected(inspectApng(buildApng({ frames: frames(2), early: [chunk("tE\u0001t", [65])] })))).toBe("BAD_CHUNK_TYPE");
  });
  test("accepts an unknown ancillary chunk (lower-case first letter)", () => {
    accepted(inspectApng(buildApng({ frames: frames(2), early: [chunk("teXt", [65])] })));
  });
  test("refuses an unknown critical chunk (upper-case first letter)", () => {
    expect(rejected(inspectApng(buildApng({ frames: frames(2), early: [chunk("ABCD", [1])] })))).toBe("UNKNOWN_CRITICAL_CHUNK");
  });
  test("refuses colour type 3 (palette) with no PLTE", () => {
    expect(rejected(inspectApng(buildApng({ frames: frames(2), colorType: 3 })))).toBe("MISSING_PLTE");
  });
  test("accepts colour type 3 with a PLTE before the image data", () => {
    accepted(inspectApng(buildApng({ frames: frames(2), colorType: 3, early: [plte()] })));
  });
  test("refuses a PLTE that comes after the image data", () => {
    const bytes = concat([PNG_SIGNATURE, ihdr(8, 8), actl(1, 0), fctl(0, 8, 8, 0, 0, 1, 30), idat(), plte(), iend()]);
    expect(rejected(inspectApng(bytes))).toBe("BAD_CHUNK_ORDER");
  });
  test("refuses a PLTE whose length is not a multiple of 3", () => {
    expect(rejected(inspectApng(buildApng({ frames: frames(2), colorType: 3, early: [chunk("PLTE", [1, 2, 3, 4])] })))).toBe("BAD_CHUNK");
  });
  test("refuses a zero-length IDAT", () => {
    const bytes = concat([PNG_SIGNATURE, ihdr(8, 8), actl(1, 0), fctl(0, 8, 8, 0, 0, 1, 30), chunk("IDAT", []), iend()]);
    expect(rejected(inspectApng(bytes))).toBe("EMPTY_IDAT");
  });
  test("refuses a zero-length IDAT among others", () => {
    const bytes = concat([PNG_SIGNATURE, ihdr(8, 8), actl(1, 0), fctl(0, 8, 8, 0, 0, 1, 30), idat(), chunk("IDAT", []), iend()]);
    expect(rejected(inspectApng(bytes))).toBe("EMPTY_IDAT");
  });
});

/** Recomputes every chunk CRC in place, walking as far as the lengths allow, so a mutation is judged on its structure and not stopped by BAD_CRC. */
function fixCrcs(bytes: Uint8Array): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let pos = 8; pos + 12 <= bytes.length; ) {
    const len = view.getUint32(pos);
    if (len > bytes.length || pos + 12 + len > bytes.length) return;
    view.setUint32(pos + 8 + len, crc32(bytes.subarray(pos + 4, pos + 8 + len)));
    pos += 12 + len;
  }
}

describe("inspectApng: mutation fuzz with the CRCs repaired", () => {
  test("never throws, and whatever it accepts obeys the caps and its own totals (200k mutations)", () => {
    const seeds = [buildApng({ frames: frames(3) }), buildApng({ frames: frames(4), colorType: 3, early: [plte()] })];
    let state = 12345;
    const next = (n: number): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return (state >>> 8) % n;
    };
    let accepted = 0;
    for (let i = 0; i < 200_000; i++) {
      const copy = Uint8Array.from(seeds[i % seeds.length] ?? new Uint8Array(0));
      const edits = 1 + next(3);
      for (let e = 0; e < edits; e++) copy[next(copy.length)] = next(256);
      fixCrcs(copy);
      const result = inspectApng(copy);
      if (!result.ok) continue;
      accepted += 1;
      const { info } = result;
      expect(info.frames.length).toBe(info.frameCount);
      expect(info.frames.reduce((n, f) => n + f.delayFrames, 0)).toBe(info.loopFrames);
      expect(info.loopFrames).toBeLessThanOrEqual(STICKER_LIMITS.maxLoopFrames);
      expect(Math.max(info.width, info.height)).toBeLessThanOrEqual(STICKER_LIMITS.maxSide);
      for (const f of info.frames) {
        expect(f.x + f.width).toBeLessThanOrEqual(info.width);
        expect(f.y + f.height).toBeLessThanOrEqual(info.height);
        expect(Number.isInteger(f.delayFrames) && f.delayFrames >= 1).toBe(true);
      }
    }
    expect(accepted).toBeGreaterThan(0);
  });
});
