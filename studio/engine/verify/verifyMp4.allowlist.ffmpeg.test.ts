import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { exiftool } from "exiftool-vendored";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { readBytes, removeDir } from "../render/render.testkit";
import type { VerifyReasonCode, VerifyResult } from "./types";
import { verifyRenderedMp4 } from "./verifyMp4";
import { appendChild, concat, FIXTURE_FRAMES, locate, makeBox, patched, renderFixture, setU32, spliceInside, writeCopy, type Fixture } from "./verify.testkit";
useNativeGlobals();

// REAL ffmpeg: the metadata allowlist (invariant 14) on a real render and on
// copies of it with one thing added or changed. Each change must be refused
// with the code for that change. The one exception: a string only the 6.1.1
// build (Windows) would write must pass.

const SENTINELS = ["SENTINEL-ARTIST-ZQX", "SENTINEL-COPYRIGHT-ZQX", "SENTINEL-XMP-ZQX"];

let fx: Fixture;
let laden: Fixture;
beforeAll(async () => {
  fx = await renderFixture("verify-allow");
  laden = await renderFixture("verify-laden", async (photo) => {
    await exiftool.write(photo, { Artist: SENTINELS[0], Copyright: SENTINELS[1], Creator: SENTINELS[2] }, { writeArgs: ["-overwrite_original"] });
  });
}, 180_000);
afterAll(() => {
  removeDir(fx.dir);
  removeDir(laden.dir);
});

const EXPECTED = { frames: FIXTURE_FRAMES };
const codesOf = (r: VerifyResult): VerifyReasonCode[] => (r.ok ? [] : r.reasons.map((x) => x.code));
const run = (name: string, bytes: Uint8Array) => verifyRenderedMp4(writeCopy(fx, name, bytes), EXPECTED);
const ascii = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0));

/** Offsets in the real file (all boxes here are version 0, 32-bit). */
const TOO = "moov/udta/meta/ilst/©too";
const tooPayloadAt = (bytes: Uint8Array): number => locate(bytes, TOO).start + 8 + 16;
const stsdEntryAt = (bytes: Uint8Array, nth: number): number => locate(bytes, "moov/trak/mdia/minf/stbl/stsd", nth).start + 16;

/** The `©too` value replaced by `value`, with every enclosing size fixed. */
function withEncoder(bytes: Uint8Array, value: string): Uint8Array {
  const too = locate(bytes, TOO);
  return spliceInside(bytes, too, tooPayloadAt(bytes), too.end - tooPayloadAt(bytes), ascii(value), [too.start + 8]);
}

/** The video sample entry's compressor name replaced by `name` (a Pascal string in a 32-byte field). */
function withCompressor(bytes: Uint8Array, name: string): Uint8Array {
  return patched(bytes, (b) => {
    const at = stsdEntryAt(b, 0) + 50;
    b.fill(0, at, at + 32);
    b[at] = name.length;
    b.set(ascii(name), at + 1);
  });
}

describe("the clean render", () => {
  test("passes the allowlist", async () => {
    expect(await verifyRenderedMp4(fx.path, EXPECTED)).toEqual({ ok: true });
  });

  test("really carries ffmpeg 6.0's version strings, so the 6.1.1 cases below change something", () => {
    const text = new TextDecoder("latin1").decode(fx.bytes);
    expect(text).toMatch(/Lavf60\.3\.100/);
    expect(text).toMatch(/Lavc60\.3\.100 libx264/);
  });
});

describe("forbidden boxes, each refused with its own code", () => {
  test("a uuid box at the top level is UUID_BOX", async () => {
    const codes = codesOf(await run("uuid-top.mp4", concat(fx.bytes, makeBox("uuid", new Uint8Array(32).fill(7)))));
    expect(codes).toContain("UUID_BOX");
    expect(codes).not.toContain("XMP_BOX");
  });

  test("a uuid box inside moov is UUID_BOX and not also UNKNOWN_BOX", async () => {
    const codes = codesOf(await run("uuid-moov.mp4", appendChild(fx.bytes, "moov", makeBox("uuid", new Uint8Array(32).fill(7)))));
    expect(codes).toContain("UUID_BOX");
    expect(codes).not.toContain("UNKNOWN_BOX");
  });

  test("a uuid box with the XMP identifier BE7ACFCB-97A9-42E8-9C71-999491E3AFAC is XMP_BOX", async () => {
    const xmpId = Uint8Array.from([0xbe, 0x7a, 0xcf, 0xcb, 0x97, 0xa9, 0x42, 0xe8, 0x9c, 0x71, 0x99, 0x94, 0x91, 0xe3, 0xaf, 0xac]);
    const codes = codesOf(await run("uuid-xmp.mp4", concat(fx.bytes, makeBox("uuid", concat(xmpId, ascii("<x:xmpmeta/>"))))));
    expect(codes).toContain("XMP_BOX");
    expect(codes).not.toContain("UUID_BOX");
  });

  test("an XMP_ box is XMP_BOX", async () => {
    expect(codesOf(await run("xmp-box.mp4", concat(fx.bytes, makeBox("XMP_", ascii("<x:xmpmeta/>")))))).toContain("XMP_BOX");
  });

  test.each(["jumb", "c2pa"])("a %s box is PROVENANCE_BOX", async (type) => {
    expect(codesOf(await run(`prov-${type}.mp4`, concat(fx.bytes, makeBox(type, new Uint8Array(16)))))).toContain("PROVENANCE_BOX");
  });

  test("a chpl chapter box in udta is CHAPTER_BOX", async () => {
    expect(codesOf(await run("chpl.mp4", appendChild(fx.bytes, "moov/udta", makeBox("chpl", new Uint8Array(9)))))).toContain("CHAPTER_BOX");
  });

  test("an Exif box is EXIF_BOX", async () => {
    expect(codesOf(await run("exif.mp4", concat(fx.bytes, makeBox("Exif", ascii("Exif\u0000\u0000II*\u0000")))))).toContain("EXIF_BOX");
  });

  test("a ©xyz GPS atom in udta is LOCATION_BOX", async () => {
    const gps = makeBox("©xyz", ascii("\u0000\u000f\u0015Ç+52.5200+013.4050/"));
    expect(codesOf(await run("gps.mp4", appendChild(fx.bytes, "moov/udta", gps)))).toContain("LOCATION_BOX");
  });

  test("a ©xyz atom among the ilst items is LOCATION_BOX, not a mere unknown key", async () => {
    const codes = codesOf(await run("gps-ilst.mp4", appendChild(fx.bytes, "moov/udta/meta/ilst", makeBox("©xyz", new Uint8Array(8)))));
    expect(codes).toContain("LOCATION_BOX");
    expect(codes).not.toContain("METADATA_KEY_NOT_ALLOWED");
  });

  test("a ©day date atom is DATE_BOX", async () => {
    expect(codesOf(await run("date.mp4", appendChild(fx.bytes, "moov/udta", makeBox("©day", ascii("2026-09-29")))))).toContain("DATE_BOX");
  });

  test("a payload hidden in the free box is FREE_BOX_NOT_EMPTY", async () => {
    const free = locate(fx.bytes, "free");
    const bytes = concat(fx.bytes.subarray(0, free.start), makeBox("free", ascii("hidden note")), fx.bytes.subarray(free.end));
    expect(codesOf(await run("free-payload.mp4", bytes))).toContain("FREE_BOX_NOT_EMPTY");
  });

  test("a box the format allows but the engine never writes is UNKNOWN_BOX", async () => {
    expect(codesOf(await run("skip.mp4", concat(fx.bytes, makeBox("skip", new Uint8Array(4)))))).toContain("UNKNOWN_BOX");
  });

  test("a meta box directly under moov is UNKNOWN_BOX", async () => {
    expect(codesOf(await run("meta-moov.mp4", appendChild(fx.bytes, "moov", makeBox("meta", new Uint8Array(4)))))).toContain("UNKNOWN_BOX");
  });
});

describe("the metadata keys and values", () => {
  test("an ilst key other than the encoder tag is METADATA_KEY_NOT_ALLOWED", async () => {
    const item = makeBox("©nam", makeBox("data", concat(new Uint8Array([0, 0, 0, 1, 0, 0, 0, 0]), ascii("My title"))));
    expect(codesOf(await run("nam.mp4", appendChild(fx.bytes, "moov/udta/meta/ilst", item)))).toContain("METADATA_KEY_NOT_ALLOWED");
  });

  test("an encoder tag that does not look like a Lavf version is METADATA_VALUE_NOT_ALLOWED", async () => {
    expect(codesOf(await run("enc-adobe.mp4", withEncoder(fx.bytes, "Adobe Premiere Pro 2026")))).toContain("METADATA_VALUE_NOT_ALLOWED");
  });

  test.each(["Lavf", "Lavf60.3", "Lavf60.3.100 (owner)", "lavf60.3.100", "Lavc60.3.100", "Lavf60.3.100\u0000junk"])("refuses the encoder tag %j", async (value) => {
    expect(codesOf(await run("enc-bad.mp4", withEncoder(fx.bytes, value)))).toContain("METADATA_VALUE_NOT_ALLOWED");
  });

  test("accepts a 6.1.1-style container encoder tag, Lavf60.16.100", async () => {
    expect(await run("enc-611.mp4", withEncoder(fx.bytes, "Lavf60.16.100"))).toEqual({ ok: true });
  });

  test("accepts a 6.1.1-style video compressor name, Lavc60.16.100 libx264", async () => {
    expect(await run("comp-611.mp4", withCompressor(fx.bytes, "Lavc60.16.100 libx264"))).toEqual({ ok: true });
  });

  test("accepts both 6.1.1-style strings together", async () => {
    expect(await run("both-611.mp4", withCompressor(withEncoder(fx.bytes, "Lavf60.16.100"), "Lavc60.16.100 libx264"))).toEqual({ ok: true });
  });

  test.each(["Adobe Media Encoder", "Lavc60.3.100 libx265", "Lavc60.3.100 libx264 x", "Lavc libx264"])("refuses the video compressor name %j", async (name) => {
    expect(codesOf(await run("comp-bad.mp4", withCompressor(fx.bytes, name)))).toContain("METADATA_VALUE_NOT_ALLOWED");
  });

  test("refuses a stream handler name other than VideoHandler", async () => {
    const hdlr = locate(fx.bytes, "moov/trak/mdia/hdlr");
    const bytes = patched(fx.bytes, (b) => b.set(ascii("EvilHandler!"), hdlr.start + 32));
    expect(codesOf(await run("handler.mp4", bytes))).toContain("METADATA_VALUE_NOT_ALLOWED");
  });

  test("refuses a media language other than und", async () => {
    const mdhd = locate(fx.bytes, "moov/trak/mdia/mdhd");
    const bytes = patched(fx.bytes, (b) => b.set([0x15, 0xc7], mdhd.start + 28)); // "eng"
    expect(codesOf(await run("lang.mp4", bytes))).toContain("METADATA_VALUE_NOT_ALLOWED");
  });

  test.each([["video", 0], ["audio", 1]])("refuses a vendor id other than zeros in the %s sample entry", async (_kind, nth) => {
    const bytes = patched(fx.bytes, (b) => b.set(ascii("FFMP"), stsdEntryAt(b, nth) + 20));
    expect(codesOf(await run("vendor.mp4", bytes))).toContain("METADATA_VALUE_NOT_ALLOWED");
  });

  test("refuses a major brand other than isom", async () => {
    const bytes = patched(fx.bytes, (b) => b.set(ascii("qt  "), locate(b, "ftyp").start + 8));
    expect(codesOf(await run("brand-qt.mp4", bytes))).toContain("FTYP_BRAND_NOT_ALLOWED");
  });

  test("refuses a compatible brand outside isom, iso2, avc1 and mp41", async () => {
    const bytes = patched(fx.bytes, (b) => b.set(ascii("heic"), locate(b, "ftyp").start + 28));
    expect(codesOf(await run("brand-heic.mp4", bytes))).toContain("FTYP_BRAND_NOT_ALLOWED");
  });
});

describe("creation and modification times (wall clock)", () => {
  const CASES: [string, string, number][] = [
    ["mvhd", "moov/mvhd", 12],
    ["tkhd", "moov/trak/tkhd", 12],
    ["mdhd", "moov/trak/mdia/mdhd", 12],
  ];

  test.each(CASES)("refuses a non-zero creation time in %s", async (_name, path, offset) => {
    const box = locate(fx.bytes, path);
    const bytes = patched(fx.bytes, (b) => setU32(b, box.start + offset, 3_800_000_000));
    const r = await run("ctime.mp4", bytes);
    expect(codesOf(r)).toContain("NONZERO_TIMESTAMP");
    expect(!r.ok && r.reasons.find((x) => x.code === "NONZERO_TIMESTAMP")?.path).toBe(path);
  });

  test.each(CASES)("refuses a non-zero modification time in %s", async (_name, path, offset) => {
    const box = locate(fx.bytes, path);
    expect(codesOf(await run("mtime.mp4", patched(fx.bytes, (b) => setU32(b, box.start + offset + 4, 1))))).toContain("NONZERO_TIMESTAMP");
  });

  test("refuses a non-zero time in the audio track's headers too", async () => {
    const box = locate(fx.bytes, "moov/trak/tkhd", 1);
    expect(codesOf(await run("atime.mp4", patched(fx.bytes, (b) => setU32(b, box.start + 12, 5))))).toContain("NONZERO_TIMESTAMP");
  });
});

describe("source-photo metadata strings", () => {
  test("the source photo really carried the sentinels, so their absence below means something", async () => {
    const photoBytes = readBytes(`${laden.dir}/photo.jpg`);
    const text = new TextDecoder("latin1").decode(photoBytes);
    for (const s of SENTINELS) expect(text).toContain(s);
  });

  test("a render of a photo laden with EXIF and XMP passes with those strings forbidden", async () => {
    expect(await verifyRenderedMp4(laden.path, { ...EXPECTED, forbiddenStrings: SENTINELS })).toEqual({ ok: true });
  });

  test("a caller string found inside the media data is SOURCE_METADATA_STRING", async () => {
    const mdat = locate(fx.bytes, "mdat");
    const bytes = patched(fx.bytes, (b) => b.set(ascii(SENTINELS[0] ?? ""), mdat.start + 5000));
    const r = await verifyRenderedMp4(writeCopy(fx, "sentinel.mp4", bytes), { ...EXPECTED, forbiddenStrings: SENTINELS });
    expect(codesOf(r)).toContain("SOURCE_METADATA_STRING");
  });

  test("a reason about a caller string does not repeat the string", async () => {
    const mdat = locate(fx.bytes, "mdat");
    const bytes = patched(fx.bytes, (b) => b.set(ascii(SENTINELS[0] ?? ""), mdat.start + 5000));
    const r = await verifyRenderedMp4(writeCopy(fx, "sentinel2.mp4", bytes), { ...EXPECTED, forbiddenStrings: SENTINELS });
    expect(JSON.stringify(r)).not.toContain("SENTINEL");
  });

  test.each(["http://ns.adobe.com/xap/1.0/", "<x:xmpmeta xmlns:x=", "<?xpacket begin=", "Exif\u0000\u0000II*\u0000", "Exif\u0000\u0000MM\u0000*", "urn:c2pa:", "ICC_PROFILE\u0000"])("the built-in marker %j inside the media data is SOURCE_METADATA_STRING", async (marker) => {
    const mdat = locate(fx.bytes, "mdat");
    const bytes = patched(fx.bytes, (b) => b.set(ascii(marker), mdat.start + 9000));
    expect(codesOf(await run("marker.mp4", bytes))).toContain("SOURCE_METADATA_STRING");
  });

  test("refuses, as a caller error, a forbidden string too short to be told from video data", async () => {
    const error = await verifyRenderedMp4(fx.path, { ...EXPECTED, forbiddenStrings: ["abc"] }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RangeError);
  });

  test("refuses, as a caller error, an expected frame count that is not a whole number", async () => {
    const error = await verifyRenderedMp4(fx.path, { frames: 44.5 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RangeError);
  });
});
