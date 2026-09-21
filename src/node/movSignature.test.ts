import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findMovSignatureFields, scrubMovSignature } from "./movSignature";

/**
 * ffmpeg's MOV/MP4 muxer hardcodes three things no flag reaches: `minor_version`
 * 0x200 in `ftyp` (an iPhone writes 0), the vendor `FFMP` in the video sample
 * entry in MOV mode (an iPhone writes zeros), and — once `bitexact` has taken
 * the version out of it — the compressor name `Lavc libx264` in that same
 * entry, which the iphone branch overrides with `encoder=H.264` and the clean
 * branch does not. These tests pin the walker that finds the three fields — on
 * synthetic boxes, so every layout it must refuse can be built to order — and
 * the in-place scrub that zeroes them.
 */

const latin1 = (s: string): Buffer => Buffer.from(s, "latin1");
const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};

/** A plain box: 32-bit size, fourcc, payload. */
function box(type: string, ...payload: Buffer[]): Buffer {
  const body = Buffer.concat(payload);
  return Buffer.concat([u32(8 + body.length), latin1(type), body]);
}

/** A box with a 64-bit `largesize`, as a >4 GB `mdat` is written. */
function largeBox(type: string, ...payload: Buffer[]): Buffer {
  const body = Buffer.concat(payload);
  const size = Buffer.alloc(8);
  size.writeBigUInt64BE(BigInt(16 + body.length));
  return Buffer.concat([u32(1), latin1(type), size, body]);
}

const ftyp = (major = "qt  ", minor = 0x200): Buffer =>
  box("ftyp", latin1(major), u32(minor), latin1("qt  "));

/** The 32-byte compressor-name field: one length byte, then up to 31 bytes of
 *  name, zero-padded to the end of the field. */
function compressorName(name: string): Buffer {
  const field = Buffer.alloc(32);
  field[0] = name.length;
  field.write(name, 1, "latin1");
  return field;
}

/**
 * A QuickTime sample entry as ffmpeg's `mov_write_video_tag`/`_audio_tag`
 * lay it out: 6 reserved bytes, data-reference index, then version, revision
 * and the 4-byte vendor — vendor at +20 from the start of the entry — then
 * the quality, size and resolution fields, the frame count, and the 32-byte
 * compressor name at +50. An audio entry ends before the name; the walker
 * only reads it on `avc1`, so the shared builder pads the tail either way.
 */
function sampleEntry(type: string, vendor: string, compressor = ""): Buffer {
  return box(
    type,
    Buffer.alloc(6), // reserved
    Buffer.from([0, 1]), // data reference index
    Buffer.alloc(2), // version
    Buffer.alloc(2), // revision
    latin1(vendor),
    Buffer.alloc(8), // temporal + spatial quality
    Buffer.from([0x01, 0x40, 0x00, 0xf0]), // 320x240
    Buffer.from([0x00, 0x48, 0x00, 0x00, 0x00, 0x48, 0x00, 0x00]), // 72 dpi x2
    Buffer.alloc(4), // reserved
    Buffer.from([0, 1]), // frame count
    compressorName(compressor),
    Buffer.from([0x00, 0x18, 0xff, 0xff]) // depth 24, colour table -1
  );
}

/** `stsd` is a full box: version + flags, entry count, then the entries. */
const stsd = (...entries: Buffer[]): Buffer =>
  box("stsd", u32(0), u32(entries.length), ...entries);

const trak = (...entries: Buffer[]): Buffer =>
  box("trak", box("tkhd", Buffer.alloc(84)), box("mdia", box("minf", box("stbl", stsd(...entries)))));

const moov = (...traks: Buffer[]): Buffer => box("moov", box("mvhd", Buffer.alloc(100)), ...traks);

const mdat = (n = 64): Buffer => box("mdat", Buffer.alloc(n, 0xab));

/** What the MOV muxer produces for an iphone copy: video with `FFMP` and the
 *  compressor name the graph asked for, audio with zeros. */
const ffmpegMov = (): Buffer =>
  Buffer.concat([
    ftyp(),
    moov(trak(sampleEntry("avc1", "FFMP", "H.264")), trak(sampleEntry("mp4a", "\0\0\0\0"))),
    box("wide"),
    mdat(),
  ]);

/** What the MP4 muxer produces for a clean copy under bitexact: `isom`, a zero
 *  vendor, and the un-versioned compressor name it hardcodes. */
const ffmpegMp4 = (): Buffer =>
  Buffer.concat([
    ftyp("isom"),
    moov(trak(sampleEntry("avc1", "\0\0\0\0", "Lavc libx264")), trak(sampleEntry("mp4a", "\0\0\0\0"))),
    mdat(),
  ]);

test("finds the ftyp minor version of a qt file at byte 12", () => {
  const patches = findMovSignatureFields(Buffer.concat([ftyp(), moov(), mdat()]));
  expect(patches).toContainEqual({ field: "ftyp.minor_version", offset: 12 });
});

test("does not plan a ftyp patch when the minor version is already zero", () => {
  const patches = findMovSignatureFields(Buffer.concat([ftyp("qt  ", 0), moov(), mdat()]));
  expect(patches.filter((p) => p.field === "ftyp.minor_version")).toEqual([]);
});

test("refuses a file that does not start with a ftyp box", () => {
  const file = Buffer.concat([mdat(), ftyp(), moov()]);
  expect(() => findMovSignatureFields(file)).toThrow(/ftyp/);
});

test("refuses a ftyp whose major brand is neither qt nor isom", () => {
  // `isom` used to be refused here too; it is what the MP4 muxer writes for a
  // clean copy, so the walker now knows both of ffmpeg's brands and no other.
  const file = Buffer.concat([ftyp("3gp4"), moov(), mdat()]);
  expect(() => findMovSignatureFields(file)).toThrow(/3gp4/);
});

test("accepts an isom file and finds its ftyp minor version too", () => {
  // The MP4 muxer hardcodes the same 0x200 the MOV muxer does.
  const patches = findMovSignatureFields(Buffer.concat([ftyp("isom"), moov(), mdat()]));
  expect(patches).toContainEqual({ field: "ftyp.minor_version", offset: 12 });
});

test("finds the Lavc compressor name of the avc1 sample entry at entry start + 50", () => {
  // size(4) type(4) reserved(6) dref(2) version(2) revision(2) vendor(4)
  // quality(8) size(4) resolution(8) reserved(4) frames(2) = 50, then the
  // 32-byte Pascal string. The brief's "+42" is the same field counted from
  // the box payload rather than its header.
  const file = ffmpegMp4();
  const entryStart = file.indexOf(latin1("avc1")) - 4;
  expect(file[entryStart + 50]).toBe("Lavc libx264".length);
  expect(file.toString("latin1", entryStart + 51, entryStart + 63)).toBe("Lavc libx264");
  expect(findMovSignatureFields(file)).toContainEqual({
    field: "stsd.compressor_name",
    offset: entryStart + 50,
  });
});

test("leaves a compressor name that is not ffmpeg's alone", () => {
  // The iphone branch names the compressor H.264 on purpose; a file from
  // anywhere else names it whatever it likes. Only `Lavc…` is ffmpeg's.
  const file = ffmpegMov();
  const patches = findMovSignatureFields(file);
  expect(patches.filter((p) => p.field === "stsd.compressor_name")).toEqual([]);
});

test("does not plan a compressor patch when the name is already blank", () => {
  const file = Buffer.concat([ftyp("isom"), moov(trak(sampleEntry("avc1", "\0\0\0\0", ""))), mdat()]);
  const patches = findMovSignatureFields(file);
  expect(patches.filter((p) => p.field === "stsd.compressor_name")).toEqual([]);
});

test("does not look for a compressor name on the audio entry, which has none", () => {
  // `mp4a` ends 36 bytes in; reading +50 from it would be reading the next
  // box. The name is a video-entry field only.
  const file = Buffer.concat([ftyp("isom"), moov(trak(sampleEntry("mp4a", "\0\0\0\0", "Lavc"))), mdat()]);
  const patches = findMovSignatureFields(file);
  expect(patches.filter((p) => p.field === "stsd.compressor_name")).toEqual([]);
});

test("refuses an avc1 entry too short to hold the compressor name", () => {
  // Vendor in place, but the entry stops before the name: not a layout the
  // muxer writes, so not one to patch by offset.
  const short = box("avc1", Buffer.alloc(6), Buffer.from([0, 1]), Buffer.alloc(4), latin1("FFMP"), Buffer.alloc(20));
  const file = Buffer.concat([ftyp(), moov(trak(short)), mdat()]);
  expect(() => findMovSignatureFields(file)).toThrow(/avc1/);
});

test("refuses a compressor length byte that overruns its 31-byte field", () => {
  const file = ffmpegMp4();
  const entryStart = file.indexOf(latin1("avc1")) - 4;
  file[entryStart + 50] = 40;
  expect(() => findMovSignatureFields(file)).toThrow(/compressor/);
});

test("scrubMovSignature blanks the whole 32-byte compressor field of a clean MP4 and nothing else", async () => {
  const dir = mkdtempSync(join(tmpdir(), "uniq-movsig-"));
  try {
    const path = join(dir, "clip.mp4");
    const before = ffmpegMp4();
    writeFileSync(path, before);
    const entryStart = before.indexOf(latin1("avc1")) - 4;

    const patches = await scrubMovSignature(path);

    const expected = Buffer.from(before);
    expected.fill(0, 12, 16);
    expected.fill(0, entryStart + 50, entryStart + 82);
    const after = readFileSync(path);
    expect(patches.map((p) => p.field).sort()).toEqual(["ftyp.minor_version", "stsd.compressor_name"]);
    expect(after.includes("Lavc")).toBe(false);
    expect(after.includes("x264")).toBe(false);
    expect(after.subarray(entryStart + 50, entryStart + 82).every((b) => b === 0)).toBe(true);
    // The depth field right after the name is untouched.
    expect(after.readUInt16BE(entryStart + 82)).toBe(0x18);
    expect(after.equals(expected)).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("finds the FFMP vendor of the avc1 sample entry at entry start + 20", () => {
  const file = ffmpegMov();
  const entryStart = file.indexOf(latin1("avc1")) - 4;
  const patches = findMovSignatureFields(file);
  expect(patches).toContainEqual({ field: "stsd.vendor", offset: entryStart + 20 });
  expect(file.toString("latin1", entryStart + 20, entryStart + 24)).toBe("FFMP");
});

test("plans exactly one vendor patch when only the video entry carries FFMP", () => {
  const patches = findMovSignatureFields(ffmpegMov());
  expect(patches.filter((p) => p.field === "stsd.vendor").length).toBe(1);
});

test("does not plan a vendor patch when the vendor is already zero", () => {
  const file = Buffer.concat([ftyp(), moov(trak(sampleEntry("avc1", "\0\0\0\0"))), mdat()]);
  const patches = findMovSignatureFields(file);
  expect(patches.filter((p) => p.field === "stsd.vendor")).toEqual([]);
});

test("leaves a vendor that is neither FFMP nor zero alone", () => {
  // Only what ffmpeg is known to write gets overwritten; anything else is
  // evidence of a file this code did not produce and must not be touched.
  const file = Buffer.concat([ftyp(), moov(trak(sampleEntry("avc1", "appl"))), mdat()]);
  const patches = findMovSignatureFields(file);
  expect(patches.filter((p) => p.field === "stsd.vendor")).toEqual([]);
});

test("finds the vendor in a moov that sits behind a 64-bit mdat", () => {
  // The walker only reads box headers on the way to the moov, so a large mdat
  // in front of it (no faststart) costs nothing and must not confuse it.
  const file = Buffer.concat([ftyp(), largeBox("mdat", Buffer.alloc(32)), moov(trak(sampleEntry("avc1", "FFMP")))]);
  const entryStart = file.indexOf(latin1("avc1")) - 4;
  expect(findMovSignatureFields(file)).toContainEqual({ field: "stsd.vendor", offset: entryStart + 20 });
});

test("refuses a file with no moov box", () => {
  const file = Buffer.concat([ftyp(), mdat()]);
  expect(() => findMovSignatureFields(file)).toThrow(/moov/);
});

test("refuses a box whose size runs past the end of the file", () => {
  const file = Buffer.concat([ftyp(), moov(trak(sampleEntry("avc1", "FFMP"))), mdat()]);
  const truncated = file.subarray(0, file.length - 20); // cuts into the mdat
  expect(() => findMovSignatureFields(truncated)).toThrow(/past the end/);
});

test("refuses a sample entry too short to hold a vendor field", () => {
  const short = box("avc1", Buffer.alloc(8)); // reserved + data-ref index only
  const file = Buffer.concat([ftyp(), moov(trak(short)), mdat()]);
  expect(() => findMovSignatureFields(file)).toThrow(/avc1/);
});

test("scrubMovSignature zeroes both fields in place and leaves every other byte alone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "uniq-movsig-"));
  try {
    const path = join(dir, "clip.mov");
    const before = ffmpegMov();
    writeFileSync(path, before);

    const patches = await scrubMovSignature(path);

    const expected = Buffer.from(before);
    for (const p of patches) expected.fill(0, p.offset, p.offset + 4);
    const after = readFileSync(path);
    expect(patches.map((p) => p.field).sort()).toEqual(["ftyp.minor_version", "stsd.vendor"]);
    expect(after.readUInt32BE(12)).toBe(0);
    expect(after.includes("FFMP")).toBe(false);
    expect(after.equals(expected)).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scrubMovSignature is idempotent: a second pass finds nothing to patch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "uniq-movsig-"));
  try {
    const path = join(dir, "clip.mov");
    writeFileSync(path, ffmpegMov());
    await scrubMovSignature(path);
    const once = readFileSync(path);
    expect(await scrubMovSignature(path)).toEqual([]);
    expect(readFileSync(path).equals(once)).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
