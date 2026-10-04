import { describe, expect, test } from "bun:test";
import { inspectApng, inspectApngRaw, STICKER_LIMITS, type ApngRawInspection, type ApngRejectCode } from "./apng";
import { actl, buildApng, chunk, concat, fctl, fdat, idat, iend, ihdr, PNG_SIGNATURE } from "./apng.testkit";

// 3f.5: `inspectApngRaw`, the importer's way to read an APNG. The strict `inspectApng` (the built-in set, the render's re-check) refuses a
// delay that is not a whole number of 1/30 s frames; an owner's APNG is written in any fraction of a second, so the importer reads the RAW
// delays here and puts them on the 30 fps grid itself (`quantise.ts`). Everything else about the structure is judged the same way.

function rejected(result: ApngRawInspection): ApngRejectCode {
  if (result.ok) throw new Error("expected a refusal");
  return result.code;
}

function accepted(result: ApngRawInspection) {
  if (!result.ok) throw new Error(`expected acceptance, got ${result.code}: ${result.detail}`);
  return result.info;
}

describe("inspectApngRaw: the delays are not forced onto the grid", () => {
  test("a delay of 1/100 s is read as written, where the strict reader refuses it as off the grid", () => {
    const bytes = buildApng({ frames: [{ delayNum: 1, delayDen: 100 }, { delayNum: 7, delayDen: 1000 }] });
    const strict = inspectApng(bytes);
    expect(strict.ok ? "ok" : strict.code).toBe("OFF_GRID_DELAY");
    expect(accepted(inspectApngRaw(bytes)).frames.map((f) => [f.delayNum, f.delayDen])).toEqual([
      [1, 100],
      [7, 1000],
    ]);
  });

  test("a zero denominator is read as 100, as the APNG spec says", () => {
    expect(accepted(inspectApngRaw(buildApng({ frames: [{ delayNum: 10, delayDen: 0 }, { delayNum: 1, delayDen: 30 }] }))).frames[0]).toMatchObject({ delayNum: 10, delayDen: 100 });
  });

  test("a zero delay is refused: players disagree on how long it lasts", () => {
    expect(rejected(inspectApngRaw(buildApng({ frames: [{ delayNum: 0, delayDen: 100 }, { delayNum: 1, delayDen: 30 }] })))).toBe("ZERO_DELAY");
  });

  test("a loop that is long in seconds is not refused here: its length is judged after the quantisation", () => {
    const bytes = buildApng({ frames: Array.from({ length: 200 }, () => ({ delayNum: 1, delayDen: 10 })) });
    expect(accepted(inspectApngRaw(bytes)).frameCount).toBe(200);
    // 200 frames of 3 grid frames each: the strict reader caps that loop at 300.
    const strict = inspectApng(bytes);
    expect(strict.ok ? "ok" : strict.code).toBe("LOOP_TOO_LONG");
  });

  test("the frame count is still capped", () => {
    const frames = Array.from({ length: STICKER_LIMITS.maxLoopFrames + 1 }, () => ({}));
    expect(rejected(inspectApngRaw(buildApng({ width: 2, height: 2, frames })))).toBe("TOO_MANY_FRAMES");
  });

  test("reports the canvas, the loop count and the frame regions", () => {
    const info = accepted(inspectApngRaw(buildApng({ width: 16, height: 12, numPlays: 4, frames: [{}, { x: 2, y: 3, width: 5, height: 4 }] })));
    expect([info.width, info.height, info.loopCount, info.frameCount]).toEqual([16, 12, 4, 2]);
    expect(info.frames[1]).toMatchObject({ x: 2, y: 3, width: 5, height: 4 });
  });
});

describe("inspectApngRaw: DEFAULT_IMAGE_NOT_A_FRAME is refused", () => {
  // Decision (3f.5): an APNG whose default image (the IDAT) is NOT the first frame (a poster before the first fcTL) is refused. Chrome
  // skips that image and ffmpeg's decoder draws it as a frame, so the preview and the render would play different loops.
  test("image data before the first fcTL", () => {
    const bytes = concat([PNG_SIGNATURE, ihdr(8, 8), actl(2, 0), idat(), fctl(0, 8, 8, 0, 0, 1, 30), idat(), fctl(1, 8, 8, 0, 0, 1, 30), fdat(2), iend()]);
    expect(rejected(inspectApngRaw(bytes))).toBe("DEFAULT_IMAGE_NOT_A_FRAME");
  });

  test("acTL after the image data (a still PNG that grew a chunk)", () => {
    const bytes = concat([PNG_SIGNATURE, ihdr(8, 8), idat(), actl(2, 0), fctl(0, 8, 8, 0, 0, 1, 30), fdat(1), iend()]);
    expect(rejected(inspectApngRaw(bytes))).toBe("NOT_ANIMATED");
  });
});

describe("inspectApngRaw: the structure is judged as the strict reader judges it", () => {
  test("an fcTL outside the canvas", () => {
    expect(rejected(inspectApngRaw(buildApng({ width: 8, height: 8, frames: [{}, { x: 6, width: 4 }] })))).toBe("BAD_FRAME_REGION");
  });

  test("an fcTL whose width is larger than the IHDR canvas", () => {
    expect(rejected(inspectApngRaw(buildApng({ width: 8, height: 8, frames: [{ width: 9 }] })))).toBe("BAD_FRAME_REGION");
  });

  test("an acTL that declares more frames than the file holds", () => {
    expect(rejected(inspectApngRaw(buildApng({ frames: [{}, {}], declaredFrames: 3 })))).toBe("FRAME_COUNT_MISMATCH");
  });

  test("an acTL that declares fewer frames than the file holds", () => {
    expect(rejected(inspectApngRaw(buildApng({ frames: [{}, {}, {}], declaredFrames: 2 })))).toBe("FRAME_COUNT_MISMATCH");
  });

  test("an acTL that declares a huge frame count is refused before it is trusted", () => {
    expect(rejected(inspectApngRaw(buildApng({ frames: [{}, {}], declaredFrames: 4_000_000_000 })))).toBe("TOO_MANY_FRAMES");
  });

  test("a still PNG", () => {
    expect(rejected(inspectApngRaw(buildApng({ frames: [], omitActl: true })))).toBe("NOT_ANIMATED");
  });

  test("a damaged CRC", () => {
    const bytes = concat([PNG_SIGNATURE, chunk("IHDR", [0, 0, 0, 8, 0, 0, 0, 8, 8, 6, 0, 0, 0], 12345), iend()]);
    expect(rejected(inspectApngRaw(bytes))).toBe("BAD_CRC");
  });

  test("a file over the byte cap", () => {
    expect(rejected(inspectApngRaw(new Uint8Array(STICKER_LIMITS.maxBytes + 1)))).toBe("TOO_LARGE_FILE");
  });

  test("a canvas over the side cap", () => {
    expect(rejected(inspectApngRaw(buildApng({ width: STICKER_LIMITS.maxSide + 1, height: 4, frames: [{}] })))).toBe("SIDE_TOO_LARGE");
  });
});
