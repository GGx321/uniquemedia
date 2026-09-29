import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { removeDir } from "../render/render.testkit";
import type { VerifyExpected, VerifyReasonCode, VerifyResult } from "./types";
import { verifyRenderedMp4 } from "./verifyMp4";
import { appendChild, concat, findAscii, FIXTURE_FRAMES, locate, makeBox, makeForeign, patched, remux, renderFixture, setU32, spliceInside, writeCopy, type Fixture } from "./verify.testkit";
useNativeGlobals();

// REAL ffmpeg: review round 1 of the verifier. Everything here was accepted
// (or crashed it) before: boxes hidden in the sample tables, text hidden in
// fixed fields and after leaf boxes, file contents echoed into messages,
// media-data slack, and a duration window twice as loose as invariant 20.

let fx: Fixture;
beforeAll(async () => {
  fx = await renderFixture("verify-hard");
}, 120_000);
afterAll(() => fx && removeDir(fx.dir));

const EXPECTED = { frames: FIXTURE_FRAMES };
const codesOf = (r: VerifyResult): VerifyReasonCode[] => (r.ok ? [] : r.reasons.map((x) => x.code));
const run = (name: string, bytes: Uint8Array, expected: VerifyExpected = EXPECTED) => verifyRenderedMp4(writeCopy(fx, name, bytes), expected);
const ascii = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0));
const u32At = (bytes: Uint8Array, at: number): number => new DataView(bytes.buffer, bytes.byteOffset).getUint32(at);
const STBL = "moov/trak/mdia/minf/stbl";
const TOO = "moov/udta/meta/ilst/\u00a9too";
const dataItem = (text: string): Uint8Array => makeBox("data", concat(new Uint8Array([0, 0, 0, 1, 0, 0, 0, 0]), ascii(text)));

describe("HIGH: the sample tables and dinf are as strict as the rest", () => {
  const CASES: [string, string, () => Uint8Array][] = [
    [STBL, "a note box", () => makeBox("note", ascii("Jane Doe, 52.52N 13.40E, Canon EOS R5"))],
    [STBL, "a meta/ilst/\u00a9ART item", () => makeBox("meta", concat(new Uint8Array(4), makeBox("ilst", makeBox("\u00a9ART", dataItem("Jane Doe")))))],
    [STBL, "a udta with \u00a9nam", () => makeBox("udta", makeBox("\u00a9nam", ascii("secret title")))],
    [STBL, "a free box with text", () => makeBox("free", ascii("Jane Doe notes"))],
    [STBL, "a wrapper around a uuid", () => makeBox("wrap", makeBox("uuid", new Uint8Array(32).fill(3)))],
    ["moov/trak/mdia/minf/dinf", "a note with a path", () => makeBox("note", ascii("C:/Users/jane/Pictures/IMG_0001.JPG"))],
  ];

  test.each(CASES)("refuses, in %s, %s with UNKNOWN_BOX", async (parent, _what, make) => {
    expect(codesOf(await run("tolerant.mp4", appendChild(fx.bytes, parent, make())))).toContain("UNKNOWN_BOX");
  });

  /** The dref replaced by one holding `entry`, with the enclosing sizes and chunk offsets fixed. */
  const withDref = (entry: Uint8Array, count = 1): Uint8Array => {
    const dref = locate(fx.bytes, "moov/trak/mdia/minf/dinf/dref");
    const out = spliceInside(fx.bytes, dref, dref.start + 16, dref.end - dref.start - 16, entry);
    out[dref.start + 15] = count; // the entry count is the low byte of the u32 after version and flags
    return out;
  };

  test("refuses a dref urn entry naming a person and a path with UNKNOWN_BOX", async () => {
    const urn = makeBox("urn ", concat(new Uint8Array(4), ascii("Jane Doe\u0000file:///Users/jane/IMG_0001.HEIC\u0000")));
    expect(codesOf(await run("dref-urn.mp4", withDref(urn)))).toContain("UNKNOWN_BOX");
  });

  test("refuses a self-contained url entry that is not the 12 real bytes, with FIELD_NOT_CANONICAL", async () => {
    const url = makeBox("url ", concat(new Uint8Array([0, 0, 0, 1]), ascii("file:///Users/jane/x")));
    expect(codesOf(await run("dref-url-text.mp4", withDref(url)))).toContain("FIELD_NOT_CANONICAL");
  });

  test("refuses a url entry that points outside the file (flags 0) with FIELD_NOT_CANONICAL", async () => {
    const url = makeBox("url ", new Uint8Array(4));
    expect(codesOf(await run("dref-url-flags0.mp4", withDref(url)))).toContain("FIELD_NOT_CANONICAL");
  });

  test("refuses a dref whose entry count disagrees with its entries with FIELD_NOT_CANONICAL", async () => {
    const url = makeBox("url ", new Uint8Array([0, 0, 0, 1]));
    expect(codesOf(await run("dref-count.mp4", withDref(url, 2)))).toContain("FIELD_NOT_CANONICAL");
  });

  test("accepts the real dref: one url entry with the bytes 0000000c75726c2000000001", () => {
    const dref = locate(fx.bytes, "moov/trak/mdia/minf/dinf/dref");
    expect(Buffer.from(fx.bytes.subarray(dref.start + 16, dref.end)).toString("hex")).toBe("0000000c75726c2000000001");
  });
});

describe("MEDIUM 1: file contents never make the verifier throw", () => {
  test("a 2 MiB track handler name is METADATA_VALUE_NOT_ALLOWED, not a RangeError", async () => {
    const hdlr = locate(fx.bytes, "moov/trak/mdia/hdlr");
    const r = await run("big-hdlr.mp4", spliceInside(fx.bytes, hdlr, hdlr.end - 1, 0, new Uint8Array(2 << 20).fill(0x41)));
    expect(codesOf(r)).toContain("METADATA_VALUE_NOT_ALLOWED");
  });

  test("a 2 MiB \u00a9too value is METADATA_VALUE_NOT_ALLOWED, not a RangeError", async () => {
    const too = locate(fx.bytes, TOO);
    const r = await run("big-too.mp4", spliceInside(fx.bytes, too, too.end, 0, new Uint8Array(2 << 20).fill(0x41), [too.start + 8]));
    expect(codesOf(r)).toContain("METADATA_VALUE_NOT_ALLOWED");
  });

  test("a handler name of 65 bytes is over the cap and a real one passes", async () => {
    const hdlr = locate(fx.bytes, "moov/trak/mdia/hdlr");
    const r = await run("hdlr-65.mp4", spliceInside(fx.bytes, hdlr, hdlr.end - 1, 0, new Uint8Array(65 - 12).fill(0x41)));
    expect(codesOf(r)).toContain("METADATA_VALUE_NOT_ALLOWED");
  });
});

describe("MEDIUM 2: messages never carry file contents", () => {
  const SENTINEL = "SENTINEL-ARTIST-ZQX";
  const withHandlerName = (name: string): Uint8Array => {
    const hdlr = locate(fx.bytes, "moov/trak/mdia/hdlr");
    return spliceInside(fx.bytes, hdlr, hdlr.start + 32, 13, ascii(`${name}\u0000`));
  };

  test("a caller string sitting in a handler name is not echoed in any message", async () => {
    const r = await run("echo.mp4", withHandlerName(SENTINEL), { ...EXPECTED, forbiddenStrings: [SENTINEL] });
    expect(codesOf(r)).toContain("METADATA_VALUE_NOT_ALLOWED");
    expect(JSON.stringify(r)).not.toContain("SENTINEL");
  });

  test("a 200 KB handler name yields messages of at most 300 characters", async () => {
    const r = await run("big-echo.mp4", withHandlerName("B".repeat(200_000)));
    expect(!r.ok && Math.max(...r.reasons.map((x) => x.message.length))).toBeLessThanOrEqual(300);
  });

  test("an encoder value is quoted to at most 32 characters", async () => {
    const too = locate(fx.bytes, TOO);
    const start = too.start + 24;
    const bytes = spliceInside(fx.bytes, too, start, too.end - start, ascii(`Lavf${"C".repeat(28)}`), [too.start + 8]);
    const r = await run("echo-too.mp4", bytes);
    const message = !r.ok ? (r.reasons.find((x) => x.code === "METADATA_VALUE_NOT_ALLOWED")?.message ?? "") : "";
    expect(message).toContain("Lavf");
    expect(message).not.toContain("C".repeat(30));
  });
});

describe("MEDIUM 4: the esds descriptor flags are all off", () => {
  test("a URL in the ES descriptor (flag 0x40) is AUDIO_FORMAT_WRONG", async () => {
    const esdsAt = findAscii(fx.bytes, "esds") - 4;
    const stsd = locate(fx.bytes, "moov/trak/mdia/minf/stbl/stsd", 1);
    const esTag = esdsAt + 12;
    const flagsAt = esTag + 5 + 2;
    const url = ascii("file:///Users/jane/Pictures/IMG_0001.HEIC");
    const insert = concat(new Uint8Array([url.length]), url);
    const out = spliceInside(fx.bytes, stsd, flagsAt + 1, 0, insert, [esdsAt, stsd.start + 16]);
    out[flagsAt] = 0x40;
    out[esTag + 4] = (out[esTag + 4] ?? 0) + insert.length;
    expect(codesOf(await run("esds-url.mp4", out))).toContain("AUDIO_FORMAT_WRONG");
  });

  test.each([0x80, 0x20])("refuses the ES descriptor flag 0x%s with AUDIO_FORMAT_WRONG", async (flag) => {
    const flagsAt = findAscii(fx.bytes, "esds") - 4 + 12 + 5 + 2;
    expect(codesOf(await run("esds-flag.mp4", patched(fx.bytes, (b) => (b[flagsAt] = flag))))).toContain("AUDIO_FORMAT_WRONG");
  });
});

describe("MEDIUM 5: fixed fields and leaf sizes are pinned", () => {
  const TEXT = ascii("Jane Doe Canon EOS");

  test.each([
    ["moov/mvhd", 0],
    ["moov/trak/tkhd", 0],
    ["moov/trak/tkhd", 1],
    ["moov/trak/mdia/mdhd", 0],
    ["moov/trak/mdia/mdhd", 1],
    ["moov/trak/mdia/minf/vmhd", 0],
    ["moov/trak/mdia/minf/smhd", 0],
    ["moov/trak/edts/elst", 0],
  ] as const)("refuses text after the fields of %s[%i] with FIELD_NOT_CANONICAL", async (path, nth) => {
    const box = locate(fx.bytes, path, nth);
    expect(codesOf(await run("leaf-tail.mp4", spliceInside(fx.bytes, box, box.end, 0, TEXT)))).toContain("FIELD_NOT_CANONICAL");
  });

  test("refuses a tail after the avcC configuration with FIELD_NOT_CANONICAL", async () => {
    const stsd = locate(fx.bytes, STBL + "/stsd");
    const avcAt = findAscii(fx.bytes, "avcC") - 4;
    const avcEnd = avcAt + u32At(fx.bytes, avcAt);
    expect(codesOf(await run("avcc-tail.mp4", spliceInside(fx.bytes, stsd, avcEnd, 0, TEXT, [avcAt, stsd.start + 16])))).toContain("FIELD_NOT_CANONICAL");
  });

  test("refuses text in the 12 reserved bytes of the track hdlr with FIELD_NOT_CANONICAL", async () => {
    const hdlr = locate(fx.bytes, "moov/trak/mdia/hdlr");
    expect(codesOf(await run("hdlr-reserved.mp4", patched(fx.bytes, (b) => b.set(ascii("JaneDoe12345"), hdlr.start + 20))))).toContain("FIELD_NOT_CANONICAL");
  });

  test("refuses text in the reserved bytes of the meta hdlr (appl + 8 zeros) with FIELD_NOT_CANONICAL", async () => {
    const hdlr = locate(fx.bytes, "moov/udta/meta/hdlr");
    expect(codesOf(await run("meta-hdlr-reserved.mp4", patched(fx.bytes, (b) => b.set(ascii("JaneDoe1"), hdlr.start + 24))))).toContain("FIELD_NOT_CANONICAL");
  });

  test("refuses text after the compressor name inside its 32-byte field with FIELD_NOT_CANONICAL", async () => {
    const entry = locate(fx.bytes, STBL + "/stsd").start + 16;
    const length = fx.bytes[entry + 50] ?? 0;
    expect(codesOf(await run("compressor-tail.mp4", patched(fx.bytes, (b) => b.set(ascii("JaneDoe"), entry + 50 + 1 + length + 1))))).toContain("FIELD_NOT_CANONICAL");
  });

  test("refuses a \u00a9too data type other than UTF-8 with METADATA_VALUE_NOT_ALLOWED", async () => {
    const too = locate(fx.bytes, TOO);
    expect(codesOf(await run("too-type.mp4", patched(fx.bytes, (b) => (b[too.start + 19] = 0x15))))).toContain("METADATA_VALUE_NOT_ALLOWED");
  });

  test("refuses a \u00a9too locale other than 0 with METADATA_VALUE_NOT_ALLOWED", async () => {
    const too = locate(fx.bytes, TOO);
    expect(codesOf(await run("too-locale.mp4", patched(fx.bytes, (b) => (b[too.start + 23] = 1))))).toContain("METADATA_VALUE_NOT_ALLOWED");
  });

  test.each([["reserved", 16], ["reserved after the times", 24]] as const)("refuses text in the tkhd %s bytes with FIELD_NOT_CANONICAL", async (_what, offset) => {
    const tkhd = locate(fx.bytes, "moov/trak/tkhd");
    expect(codesOf(await run("tkhd-reserved.mp4", patched(fx.bytes, (b) => b.set(ascii("Jane"), tkhd.start + 8 + offset))))).toContain("FIELD_NOT_CANONICAL");
  });

  test("refuses text in the sample entry's reserved bytes with FIELD_NOT_CANONICAL", async () => {
    const entry = locate(fx.bytes, STBL + "/stsd").start + 16;
    expect(codesOf(await run("entry-reserved.mp4", patched(fx.bytes, (b) => b.set(ascii("Jane"), entry + 8))))).toContain("FIELD_NOT_CANONICAL");
  });

  test("refuses text in the audio sample entry's reserved bytes with FIELD_NOT_CANONICAL", async () => {
    const entry = locate(fx.bytes, STBL + "/stsd", 1).start + 16;
    expect(codesOf(await run("aentry-reserved.mp4", patched(fx.bytes, (b) => b.set(ascii("Jane"), entry + 28))))).toContain("FIELD_NOT_CANONICAL");
  });

  test.each(["colr", "pasp", "btrt"])("refuses a tail after the %s box with FIELD_NOT_CANONICAL", async (type) => {
    const stsd = locate(fx.bytes, STBL + "/stsd");
    const at = findAscii(fx.bytes, type, stsd.start) - 4;
    const entry = stsd.start + 16;
    const out = spliceInside(fx.bytes, stsd, at + u32At(fx.bytes, at), 0, TEXT, [at, entry]);
    expect(codesOf(await run("entry-child-tail.mp4", out))).toContain("FIELD_NOT_CANONICAL");
  });

  describe("the safety net: a printable run of 16 bytes or more anywhere in the index", () => {
    test("text appended to a sample-group table, which has no pinned size, is TEXT_IN_INDEX", async () => {
      const sgpd = locate(fx.bytes, STBL + "/sgpd");
      expect(codesOf(await run("net.mp4", spliceInside(fx.bytes, sgpd, sgpd.end, 0, ascii("ABCDEFGHIJKLMNOPQRST"))))).toContain("TEXT_IN_INDEX");
    });

    test("15 printable bytes are not enough to trip it", async () => {
      const sgpd = locate(fx.bytes, STBL + "/sgpd");
      expect(codesOf(await run("net15.mp4", spliceInside(fx.bytes, sgpd, sgpd.end, 0, ascii("ABCDEFGHIJKLMNO"))))).not.toContain("TEXT_IN_INDEX");
    });

    test("the real render, a foreign encode and a three-track file raise no TEXT_IN_INDEX", async () => {
      const foreign = join(fx.dir, "net-foreign.mp4");
      await makeForeign(foreign);
      const three = join(fx.dir, "net-three.mp4");
      await remux(fx.path, three, ["-i", fx.path, "-map", "0", "-map", "1:a", "-c", "copy", "-map_metadata", "-1", "-movflags", "+faststart"]);
      for (const path of [fx.path, foreign, three]) expect(codesOf(await verifyRenderedMp4(path, { frames: path === foreign ? 30 : FIXTURE_FRAMES }))).not.toContain("TEXT_IN_INDEX");
    });
  });
});

describe("MEDIUM 6: the media data is exactly what the index describes", () => {
  test("4 KiB of zeros appended inside mdat is MEDIA_DATA_MISMATCH", async () => {
    const mdat = locate(fx.bytes, "mdat");
    expect(codesOf(await run("slack.mp4", spliceInside(fx.bytes, mdat, mdat.end, 0, new Uint8Array(4096))))).toContain("MEDIA_DATA_MISMATCH");
  });

  test("a 100-byte gap inside mdat, between two chunks, is MEDIA_DATA_MISMATCH", async () => {
    const mdat = locate(fx.bytes, "mdat");
    expect(codesOf(await run("gap.mp4", spliceInside(fx.bytes, mdat, mdat.start + 20_000, 0, new Uint8Array(100))))).toContain("MEDIA_DATA_MISMATCH");
  });

  test("a chunk offset outside mdat is MEDIA_DATA_MISMATCH", async () => {
    const stco = locate(fx.bytes, STBL + "/stco");
    expect(codesOf(await run("offset-out.mp4", patched(fx.bytes, (b) => setU32(b, stco.start + 16, 40))))).toContain("MEDIA_DATA_MISMATCH");
  });

  test("a sample size raised by one byte is MEDIA_DATA_MISMATCH", async () => {
    const stsz = locate(fx.bytes, STBL + "/stsz");
    expect(codesOf(await run("size-plus.mp4", patched(fx.bytes, (b) => setU32(b, stsz.start + 20, u32At(b, stsz.start + 20) + 1))))).toContain("MEDIA_DATA_MISMATCH");
  });

  test("two chunks pointing at the same bytes is MEDIA_DATA_MISMATCH", async () => {
    const stco = locate(fx.bytes, STBL + "/stco");
    expect(codesOf(await run("overlap.mp4", patched(fx.bytes, (b) => setU32(b, stco.start + 20, u32At(b, stco.start + 16)))))).toContain("MEDIA_DATA_MISMATCH");
  });

  test("the real render's chunks tile mdat exactly", async () => {
    expect(await verifyRenderedMp4(fx.path, EXPECTED)).toEqual({ ok: true });
  });
});

describe("LOW: limits, options and markers", () => {
  test("1001 top-level boxes is TOO_MANY_BOXES", async () => {
    const many = concat(...Array.from({ length: 1001 }, () => makeBox("free")));
    expect(codesOf(await run("many-top.mp4", concat(fx.bytes, many)))).toContain("TOO_MANY_BOXES");
  });

  test("10 001 boxes inside stbl is TOO_MANY_BOXES", async () => {
    const many = concat(...Array.from({ length: 10_001 }, () => makeBox("sdtp")));
    expect(codesOf(await run("many-nested.mp4", appendChild(fx.bytes, STBL, many)))).toContain("TOO_MANY_BOXES");
  });

  test("a 17 MiB moov is BOX_TOO_LARGE and is not read", async () => {
    const big = makeBox("sdtp", new Uint8Array(17 << 20));
    expect(codesOf(await run("big-moov.mp4", appendChild(fx.bytes, STBL, big)))).toContain("BOX_TOO_LARGE");
  });

  test("a second top-level free box is DUPLICATE_BOX", async () => {
    const free = locate(fx.bytes, "free");
    const bytes = concat(fx.bytes.subarray(0, free.end), makeBox("free"), fx.bytes.subarray(free.end));
    expect(codesOf(await run("two-free.mp4", bytes))).toContain("DUPLICATE_BOX");
  });

  test.each([Number.NaN, 0, -1, Number.POSITIVE_INFINITY])("refuses maxBytes %f as a caller error", async (maxBytes) => {
    const error = await verifyRenderedMp4(fx.path, EXPECTED, { maxBytes }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RangeError);
  });

  test.each(["II*\u0000\u0008\u0000\u0000\u0000", "MM\u0000*\u0000\u0000\u0000\u0008", "\u0063\u0032\u0070\u0061\u0000\u0011\u0000\u0010\u0080\u0000\u0000\u00aa\u0000\u0038\u009b\u0071"])("the built-in marker %j inside the media data is SOURCE_METADATA_STRING", async (marker) => {
    const mdat = locate(fx.bytes, "mdat");
    expect(codesOf(await run("marker2.mp4", patched(fx.bytes, (b) => b.set(ascii(marker), mdat.start + 9000))))).toContain("SOURCE_METADATA_STRING");
  });

  test.each([["utf-16le", (s: string) => Buffer.from(s, "utf16le")], ["utf-16be", (s: string) => Buffer.from(s, "utf16le").swap16()]] as const)("a caller string stored as %s is SOURCE_METADATA_STRING", async (_name, encode) => {
    const mdat = locate(fx.bytes, "mdat");
    const bytes = patched(fx.bytes, (b) => b.set(encode("SENTINEL-ARTIST-ZQX"), mdat.start + 9000));
    expect(codesOf(await run("utf16.mp4", bytes, { ...EXPECTED, forbiddenStrings: ["SENTINEL-ARTIST-ZQX"] }))).toContain("SOURCE_METADATA_STRING");
  });
});
