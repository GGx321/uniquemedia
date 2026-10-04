import { describe, expect, test } from "bun:test";
import { inspectGif, type GifInspection, type GifRejectCode } from "./gif";
import { STICKER_LIMITS } from "./apng";
import {
  TRAILER,
  TEST_PALETTE,
  buildGif,
  comment,
  concatBytes,
  descriptor,
  framesOf,
  gce,
  gifHeader,
  lzw,
  netscape,
  screen,
  subBlocks,
} from "./gif.testkit";

function rejected(result: GifInspection): GifRejectCode {
  if (result.ok) throw new Error("expected a refusal");
  return result.code;
}

function accepted(result: GifInspection) {
  if (!result.ok) throw new Error(`expected acceptance, got ${result.code}: ${result.detail}`);
  return result.info;
}

const flat = (count: number, value = 0): number[] => Array.from({ length: count }, () => value);

describe("inspectGif: what it reports", () => {
  test("reports the logical screen and the frame count", () => {
    const info = accepted(inspectGif(buildGif({ width: 12, height: 9, frames: framesOf(4) })));
    expect([info.width, info.height, info.frameCount]).toEqual([12, 9, 4]);
  });

  test("reports each frame's delay as written and as it will be played", () => {
    const info = accepted(inspectGif(buildGif({ frames: [{ delayCs: 7 }, { delayCs: 2 }, { delayCs: 0 }, { delayCs: 1 }, { delayCs: null }] })));
    expect(info.frames.map((f) => [f.delayCs, f.playedCs])).toEqual([
      [7, 7],
      [2, 2],
      [0, 10],
      [1, 10],
      [0, 10],
    ]);
  });

  test("reports a frame's own region and flags", () => {
    const info = accepted(inspectGif(buildGif({ width: 8, height: 8, frames: [{ width: 8, height: 8 }, { x: 2, y: 3, width: 4, height: 2, disposal: 2, transparent: 1, interlaced: true }] })));
    expect(info.frames[1]).toMatchObject({ x: 2, y: 3, width: 4, height: 2, disposal: 2, transparent: true, interlaced: true });
  });

  test("accepts the GIF87a signature", () => {
    expect(accepted(inspectGif(buildGif({ version: "87a", frames: framesOf(2) }))).frameCount).toBe(2);
  });

  test("accepts a comment extension between frames", () => {
    const bytes = buildGif({ frames: framesOf(2), early: [comment("hello")] });
    expect(accepted(inspectGif(bytes)).frameCount).toBe(2);
  });

  test("never throws, whatever the bytes", () => {
    for (const bytes of [new Uint8Array(0), Uint8Array.of(0x47), new TextEncoder().encode("GIF89a"), new Uint8Array(64).fill(0xff)]) {
      expect(() => inspectGif(bytes)).not.toThrow();
    }
  });
});

describe("inspectGif: NETSCAPE loop variants", () => {
  test("a loop count of 0 (forever) is read", () => {
    expect(accepted(inspectGif(buildGif({ frames: framesOf(2), loop: 0 }))).loopCount).toBe(0);
  });

  test("a finite loop count is read", () => {
    expect(accepted(inspectGif(buildGif({ frames: framesOf(2), loop: 5 }))).loopCount).toBe(5);
  });

  test("no NETSCAPE block at all is accepted, with no loop count", () => {
    expect(accepted(inspectGif(buildGif({ frames: framesOf(2), loop: null }))).loopCount).toBeNull();
  });

  test("the ANIMEXTS1.0 spelling is read the same way", () => {
    const bytes = buildGif({ frames: framesOf(2), loop: null, early: [netscape(3, "ANIMEXTS1.0")] });
    expect(accepted(inspectGif(bytes)).loopCount).toBe(3);
  });

  test("an application extension of another name is skipped and says nothing of the loop", () => {
    const other = Uint8Array.from([0x21, 0xff, 11, ...new TextEncoder().encode("XMP DataXMP"), 2, 9, 9, 0]);
    expect(accepted(inspectGif(buildGif({ frames: framesOf(2), loop: null, early: [other] }))).loopCount).toBeNull();
  });

  test("a NETSCAPE block whose sub-block has the wrong length is skipped, not trusted", () => {
    const odd = Uint8Array.from([0x21, 0xff, 11, ...new TextEncoder().encode("NETSCAPE2.0"), 2, 1, 7, 0]);
    expect(accepted(inspectGif(buildGif({ frames: framesOf(2), loop: null, early: [odd] }))).loopCount).toBeNull();
  });

  test("the first NETSCAPE block wins when there are two", () => {
    expect(accepted(inspectGif(buildGif({ frames: framesOf(2), loop: 2, early: [netscape(9)] }))).loopCount).toBe(2);
  });
});

describe("inspectGif: refusals", () => {
  test("a file that is not a GIF", () => {
    expect(rejected(inspectGif(new TextEncoder().encode("GIF90a......")))).toBe("NOT_GIF");
    expect(rejected(inspectGif(new Uint8Array(0)))).toBe("NOT_GIF");
  });

  test("a file over the byte cap", () => {
    const bytes = new Uint8Array(STICKER_LIMITS.maxBytes + 1);
    bytes.set(gifHeader());
    expect(rejected(inspectGif(bytes))).toBe("TOO_LARGE_FILE");
  });

  test("a logical screen of 0 by 0", () => {
    expect(rejected(inspectGif(buildGif({ width: 0, height: 0, frames: [] })))).toBe("BAD_SCREEN");
  });

  test("a huge logical screen (65535 by 65535) is refused before anything is sized from it", () => {
    const bytes = concatBytes([gifHeader(), screen(65535, 65535), gce(3), descriptor(0, 0, 4, 4), Uint8Array.of(2), subBlocks(lzw(flat(16))), TRAILER]);
    expect(rejected(inspectGif(bytes))).toBe("SIDE_TOO_LARGE");
  });

  test("a screen one pixel over the side cap, and one at the cap", () => {
    const over = STICKER_LIMITS.maxSide + 1;
    expect(rejected(inspectGif(concatBytes([gifHeader(), screen(over, 4), TRAILER])))).toBe("SIDE_TOO_LARGE");
    const edge = concatBytes([gifHeader(), screen(STICKER_LIMITS.maxSide, 2), gce(3), descriptor(0, 0, STICKER_LIMITS.maxSide, 2), Uint8Array.of(2), subBlocks(lzw(flat(STICKER_LIMITS.maxSide * 2))), TRAILER]);
    expect(inspectGif(edge).ok).toBe(true);
  });

  test("no frame at all", () => {
    expect(rejected(inspectGif(buildGif({ frames: [] })))).toBe("NO_FRAMES");
  });

  test("a missing trailer", () => {
    expect(rejected(inspectGif(buildGif({ frames: framesOf(2), omitTrailer: true })))).toBe("NO_TRAILER");
  });

  test("bytes after the trailer", () => {
    expect(rejected(inspectGif(buildGif({ frames: framesOf(2), trailing: Uint8Array.of(0, 0) })))).toBe("TRAILING_DATA");
  });

  test("a file cut in the middle of a frame's data", () => {
    const whole = buildGif({ frames: framesOf(2) });
    expect(rejected(inspectGif(whole.subarray(0, whole.length - 12)))).toBe("TRUNCATED");
  });

  test("a frame descriptor outside the screen", () => {
    expect(rejected(inspectGif(buildGif({ width: 8, height: 8, frames: [{ x: 6, y: 0, width: 4, height: 2 }] })))).toBe("BAD_FRAME_REGION");
    expect(rejected(inspectGif(buildGif({ width: 8, height: 8, frames: [{ x: 0, y: 7, width: 2, height: 2 }] })))).toBe("BAD_FRAME_REGION");
  });

  test("a frame with no area", () => {
    expect(rejected(inspectGif(buildGif({ frames: [{ width: 0, height: 4, indices: [] }] })))).toBe("BAD_FRAME_REGION");
  });

  test("a frame whose coordinates would overflow when added to its size", () => {
    expect(rejected(inspectGif(buildGif({ width: 8, height: 8, frames: [{ x: 65535, y: 65535, width: 65535, height: 65535, indices: [] }] })))).toBe("BAD_FRAME_REGION");
  });

  test("an extension with an endless run of sub-blocks (it never ends before the file does)", () => {
    const endless = Uint8Array.from([0x21, 0xfe, ...Array.from({ length: 3000 }, () => [1, 65]).flat()]);
    const bytes = concatBytes([buildGif({ frames: framesOf(2), omitTrailer: true }), endless]);
    expect(rejected(inspectGif(bytes))).toBe("TRUNCATED");
  });

  test("a comment extension that is only sub-blocks, a very long one, is read in one pass and accepted", () => {
    const long = Uint8Array.from([0x21, 0xfe, ...Array.from({ length: 3000 }, () => [1, 65]).flat(), 0]);
    expect(accepted(inspectGif(buildGif({ frames: framesOf(2), early: [long] }))).frameCount).toBe(2);
  });

  test("a graphic control extension of the wrong size", () => {
    const bad = Uint8Array.from([0x21, 0xf9, 5, 0, 3, 0, 0, 0, 0, 0]);
    expect(rejected(inspectGif(buildGif({ frames: framesOf(2), early: [bad] })))).toBe("BAD_BLOCK");
  });

  test("a graphic control extension whose terminator is not zero", () => {
    const bad = Uint8Array.from([0x21, 0xf9, 4, 0, 3, 0, 0, 1]);
    expect(rejected(inspectGif(buildGif({ frames: framesOf(2), early: [bad] })))).toBe("BAD_BLOCK");
  });

  test("more blocks than the cap (a file of nothing but tiny extensions)", () => {
    const tiny = Uint8Array.of(0x21, 0xfe, 0);
    const many = concatBytes(Array.from({ length: 20_001 }, () => tiny));
    expect(rejected(inspectGif(buildGif({ frames: framesOf(2), early: [many] })))).toBe("TOO_MANY_BLOCKS");
  });

  test("a graphic control extension with a reserved disposal method", () => {
    expect(rejected(inspectGif(buildGif({ frames: [{ disposal: 5 }, { disposal: 0 }] })))).toBe("BAD_BLOCK");
  });

  test("an unknown extension label", () => {
    expect(rejected(inspectGif(buildGif({ frames: framesOf(2), early: [Uint8Array.of(0x21, 0x42, 0)] })))).toBe("BAD_BLOCK");
  });

  test("a block that is none of extension, image or trailer", () => {
    expect(rejected(inspectGif(buildGif({ frames: framesOf(2), early: [Uint8Array.of(0x99)] })))).toBe("BAD_BLOCK");
  });

  test("a frame with no colour table, global or local", () => {
    const bytes = concatBytes([gifHeader(), screen(4, 4, false), gce(3), descriptor(0, 0, 4, 4), Uint8Array.of(2), subBlocks(lzw(flat(16))), TRAILER]);
    expect(rejected(inspectGif(bytes))).toBe("NO_PALETTE");
  });

  test("a local colour table that runs past the end of the file", () => {
    const cut = concatBytes([gifHeader(), screen(4, 4), Uint8Array.of(0x2c, 0, 0, 0, 0, 4, 0, 4, 0, 0x87), Uint8Array.of(1, 2, 3)]);
    expect(rejected(inspectGif(cut))).toBe("TRUNCATED");
  });

  test("a frame with its own local colour table is read (the palette is not needed by the validator beyond existing)", () => {
    const local = concatBytes([
      gifHeader(),
      screen(4, 4, false),
      gce(3),
      Uint8Array.of(0x2c, 0, 0, 0, 0, 4, 0, 4, 0, 0b1000_0001),
      Uint8Array.from(TEST_PALETTE),
      Uint8Array.of(2),
      subBlocks(lzw(flat(16))),
      gce(3),
      Uint8Array.of(0x2c, 0, 0, 0, 0, 4, 0, 4, 0, 0b1000_0001),
      Uint8Array.from(TEST_PALETTE),
      Uint8Array.of(2),
      subBlocks(lzw(flat(16, 1))),
      TRAILER,
    ]);
    expect(accepted(inspectGif(local)).frameCount).toBe(2);
  });
});

describe("inspectGif: the LZW data is decoded with a bound", () => {
  test("a minimum code size of 0, 1 or 9 is refused", () => {
    for (const minCodeSize of [0, 1, 9, 12, 255]) {
      expect(rejected(inspectGif(buildGif({ frames: [{ minCodeSize }, {}] })))).toBe("BAD_LZW");
    }
  });

  test("a code that names a table entry that does not exist yet", () => {
    // 3-bit codes, LSB first: clear (4), the literal 0, then code 7 while the table's next entry is 6.
    const bits = new Uint8Array([0b11_000_100, 0b0000_0001]);
    const bytes = buildGif({ frames: [{ rawData: bits, indices: [] }, {}] });
    expect(rejected(inspectGif(bytes))).toBe("BAD_LZW");
  });

  test("a first code after the clear that is not a literal", () => {
    // 3-bit codes, LSB first: clear (4), then 6, which is neither a literal nor an entry the table has.
    const bits = new Uint8Array([0b00_110_100, 0]);
    expect(rejected(inspectGif(buildGif({ frames: [{ rawData: bits, indices: [] }, {}] })))).toBe("BAD_LZW");
  });

  test("data for fewer pixels than the frame holds", () => {
    expect(rejected(inspectGif(buildGif({ width: 8, height: 8, frames: [{ indices: flat(10) }, {}] })))).toBe("FRAME_DATA_MISMATCH");
  });

  test("data for more pixels than the frame holds", () => {
    expect(rejected(inspectGif(buildGif({ width: 8, height: 8, frames: [{ indices: flat(70) }, {}] })))).toBe("FRAME_DATA_MISMATCH");
  });

  test("a code stream that never ends the image and grows its codes past 12 bits is bounded, not followed", () => {
    // Four thousand literal codes with no clear: the table fills, the width stops at 12, and the pixel count passes the frame's.
    const bytes = buildGif({ width: 8, height: 8, frames: [{ indices: flat(5000) }, {}] });
    expect(rejected(inspectGif(bytes))).toBe("FRAME_DATA_MISMATCH");
  });

  test("a well-formed stream of the longest sort (a table that fills and is cleared) is accepted", () => {
    const side = 100;
    const indices = Array.from({ length: side * side }, (_, i) => (i * 7 + (i >> 5)) % 4);
    const bytes = buildGif({ width: side, height: side, frames: [{ indices }, { indices: indices.map((v) => (v + 1) % 4) }] });
    expect(accepted(inspectGif(bytes)).frameCount).toBe(2);
  });

  test("a frame with no data blocks at all", () => {
    const bytes = concatBytes([gifHeader(), screen(4, 4), gce(3), descriptor(0, 0, 4, 4), Uint8Array.of(2), Uint8Array.of(0), TRAILER]);
    expect(rejected(inspectGif(bytes))).toBe("FRAME_DATA_MISMATCH");
  });
});

describe("inspectGif: the frame count and the caps", () => {
  test("exactly the cap on frames is accepted, one more is refused", () => {
    expect(accepted(inspectGif(buildGif({ width: 2, height: 2, frames: framesOf(STICKER_LIMITS.maxLoopFrames) }))).frameCount).toBe(STICKER_LIMITS.maxLoopFrames);
    expect(rejected(inspectGif(buildGif({ width: 2, height: 2, frames: framesOf(STICKER_LIMITS.maxLoopFrames + 1) })))).toBe("TOO_MANY_FRAMES");
  });

  test("a still GIF (one frame) is reported as one frame; it is the importer that turns it away", () => {
    expect(accepted(inspectGif(buildGif({ frames: framesOf(1) }))).frameCount).toBe(1);
  });

  test("a graphic control extension with no image after it adds no frame", () => {
    const bytes = concatBytes([gifHeader(), screen(4, 4), gce(3), descriptor(0, 0, 4, 4), Uint8Array.of(2), subBlocks(lzw(flat(16))), gce(9), TRAILER]);
    expect(accepted(inspectGif(bytes)).frameCount).toBe(1);
  });
});
