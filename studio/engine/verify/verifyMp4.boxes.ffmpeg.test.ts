import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { removeDir } from "../render/render.testkit";
import { VerifyIoError, type VerifyReasonCode, type VerifyResult } from "./types";
import { verifyRenderedMp4 } from "./verifyMp4";
import { appendChild, concat, FIXTURE_FRAMES, locate, makeBox, patched, renderFixture, setU32, writeCopy, type Fixture } from "./verify.testkit";
useNativeGlobals();

// REAL ffmpeg: the verifier's box walk on the bytes of a real render and on
// copies of it with their box structure damaged. Every damaged copy must be
// refused with the code for that damage and no other structural code.

let fx: Fixture;
beforeAll(async () => {
  fx = await renderFixture("verify-boxes");
}, 120_000);
afterAll(() => removeDir(fx.dir));

const EXPECTED = { frames: FIXTURE_FRAMES };
const codesOf = (r: VerifyResult): VerifyReasonCode[] => (r.ok ? [] : r.reasons.map((x) => x.code));
const verifyBytes = (name: string, bytes: Uint8Array, expected = EXPECTED) => verifyRenderedMp4(writeCopy(fx, name, bytes), expected);

describe("verifyRenderedMp4: the box walk", () => {
  test("accepts the untouched render", async () => {
    expect(await verifyRenderedMp4(fx.path, EXPECTED)).toEqual({ ok: true });
  });

  test("accepts an mdat written with a 64-bit largesize header", async () => {
    const mdat = locate(fx.bytes, "mdat");
    const header = new Uint8Array(16);
    const view = new DataView(header.buffer);
    view.setUint32(0, 1);
    header.set([0x6d, 0x64, 0x61, 0x74], 4);
    view.setBigUint64(8, BigInt(mdat.end - mdat.start + 8));
    const bytes = concat(fx.bytes.subarray(0, mdat.start), header, fx.bytes.subarray(mdat.start + 8));
    expect(await verifyBytes("largesize.mp4", bytes)).toEqual({ ok: true });
  });

  test("accepts a last mdat whose size is 0, meaning to the end of the file", async () => {
    const mdat = locate(fx.bytes, "mdat");
    const bytes = patched(fx.bytes, (b) => setU32(b, mdat.start, 0));
    expect(await verifyBytes("mdat-size0.mp4", bytes)).toEqual({ ok: true });
  });

  test("refuses a file cut off inside mdat with FILE_TRUNCATED", async () => {
    const mdat = locate(fx.bytes, "mdat");
    const r = await verifyBytes("cut-mdat.mp4", fx.bytes.slice(0, mdat.start + 1000));
    expect(codesOf(r)).toContain("FILE_TRUNCATED");
  });

  test("refuses a file cut off inside moov with FILE_TRUNCATED", async () => {
    const moov = locate(fx.bytes, "moov");
    const r = await verifyBytes("cut-moov.mp4", fx.bytes.slice(0, moov.start + 200));
    expect(codesOf(r)).toContain("FILE_TRUNCATED");
  });

  test("refuses a file that ends inside a box header with FILE_TRUNCATED", async () => {
    const r = await verifyBytes("cut-header.mp4", concat(fx.bytes, new Uint8Array([0, 0, 0])));
    expect(codesOf(r)).toContain("FILE_TRUNCATED");
  });

  test("refuses an empty file, naming the boxes it lacks", async () => {
    const codes = codesOf(await verifyBytes("empty.mp4", new Uint8Array(0)));
    expect(codes).toContain("MISSING_BOX");
    expect(codes).not.toContain("FILE_TRUNCATED");
  });

  test("refuses a nested box that claims more than its parent holds with BOX_OUT_OF_BOUNDS", async () => {
    const mvhd = locate(fx.bytes, "moov/mvhd");
    const codes = codesOf(await verifyBytes("nested-too-big.mp4", patched(fx.bytes, (b) => setU32(b, mvhd.start, 0x00ffffff))));
    expect(codes).toContain("BOX_OUT_OF_BOUNDS");
    expect(codes).not.toContain("FILE_TRUNCATED");
  });

  test("refuses a top-level box that claims more than the file holds with FILE_TRUNCATED", async () => {
    const free = locate(fx.bytes, "free");
    expect(codesOf(await verifyBytes("top-too-big.mp4", patched(fx.bytes, (b) => setU32(b, free.start, 0x7fffffff))))).toContain("FILE_TRUNCATED");
  });

  test("refuses a 64-bit largesize beyond the file, and one beyond 2^53, without allocating for it", async () => {
    const free = locate(fx.bytes, "free");
    for (const [name, size] of [["large-a.mp4", 1n << 40n], ["large-b.mp4", (1n << 63n) + 5n]] as const) {
      const header = new Uint8Array(16);
      const view = new DataView(header.buffer);
      view.setUint32(0, 1);
      header.set([0x66, 0x72, 0x65, 0x65], 4);
      view.setBigUint64(8, size);
      const bytes = concat(fx.bytes.subarray(0, free.start), header, fx.bytes.subarray(free.end));
      expect(codesOf(await verifyBytes(name, bytes))).toContain("FILE_TRUNCATED");
    }
  });

  test("refuses a box whose size is smaller than its own header with BOX_BAD_SIZE", async () => {
    const mvhd = locate(fx.bytes, "moov/mvhd");
    expect(codesOf(await verifyBytes("size-4.mp4", patched(fx.bytes, (b) => setU32(b, mvhd.start, 4))))).toContain("BOX_BAD_SIZE");
  });

  test("refuses a size of 0 on a box in the middle with BOX_ZERO_SIZE", async () => {
    const trak = locate(fx.bytes, "moov/trak");
    expect(codesOf(await verifyBytes("size0-trak.mp4", patched(fx.bytes, (b) => setU32(b, trak.start, 0))))).toContain("BOX_ZERO_SIZE");
  });

  test("refuses a size of 0 on the top-level moov with BOX_ZERO_SIZE, since only mdat may run to the end", async () => {
    const moov = locate(fx.bytes, "moov");
    expect(codesOf(await verifyBytes("size0-moov.mp4", patched(fx.bytes, (b) => setU32(b, moov.start, 0))))).toContain("BOX_ZERO_SIZE");
  });

  test("refuses a second moov with DUPLICATE_BOX", async () => {
    const free = locate(fx.bytes, "free");
    const bytes = concat(fx.bytes.subarray(0, free.start), makeBox("moov"), fx.bytes.subarray(free.start));
    expect(codesOf(await verifyBytes("two-moov.mp4", bytes))).toContain("DUPLICATE_BOX");
  });

  test("refuses a file with no mdat with MISSING_BOX", async () => {
    const mdat = locate(fx.bytes, "mdat");
    expect(codesOf(await verifyBytes("no-mdat.mp4", fx.bytes.slice(0, mdat.start)))).toContain("MISSING_BOX");
  });

  test("refuses a file that does not start with ftyp with FTYP_NOT_FIRST", async () => {
    const ftyp = locate(fx.bytes, "ftyp");
    const bytes = concat(makeBox("free"), fx.bytes.subarray(ftyp.start));
    expect(codesOf(await verifyBytes("free-first.mp4", bytes))).toContain("FTYP_NOT_FIRST");
  });

  test("meets 200 levels of nested udta boxes with UNKNOWN_BOX, not with a deep walk", async () => {
    let nested: Uint8Array = makeBox("udta");
    for (let i = 0; i < 200; i++) nested = makeBox("udta", nested);
    const codes = codesOf(await verifyBytes("deep.mp4", appendChild(fx.bytes, "moov/udta", nested)));
    expect(codes).toContain("UNKNOWN_BOX");
  });

  test("refuses a file over the size cap with FILE_TOO_LARGE, without reading it", async () => {
    const r = await verifyRenderedMp4(fx.path, EXPECTED, { maxBytes: fx.bytes.length - 1 });
    expect(codesOf(r)).toEqual(["FILE_TOO_LARGE"]);
  });

  test("accepts a file of exactly the size cap", async () => {
    expect(await verifyRenderedMp4(fx.path, EXPECTED, { maxBytes: fx.bytes.length })).toEqual({ ok: true });
  });

  test("reports a missing file as a not_found I/O error, not as a reason", async () => {
    const error = await verifyRenderedMp4(join(fx.dir, "nope.mp4"), EXPECTED).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VerifyIoError);
    expect(error instanceof VerifyIoError && error.kind).toBe("not_found");
  });

  test("reports a directory as a not_a_file I/O error", async () => {
    const error = await verifyRenderedMp4(fx.dir, EXPECTED).catch((e: unknown) => e);
    expect(error instanceof VerifyIoError && error.kind).toBe("not_a_file");
  });
});
