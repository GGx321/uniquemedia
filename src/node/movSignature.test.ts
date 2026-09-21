import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findMovSignatureFields, scrubMovSignature } from "./movSignature";

/**
 * ffmpeg's MOV muxer hardcodes two things no flag reaches: `minor_version`
 * 0x200 in `ftyp` (an iPhone writes 0) and the vendor `FFMP` in the video
 * sample entry (an iPhone writes zeros). These tests pin the walker that finds
 * the two fields — on synthetic boxes, so every layout it must refuse can be
 * built to order — and the in-place scrub that zeroes them.
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

/**
 * A QuickTime sample entry as ffmpeg's `mov_write_video_tag`/`_audio_tag`
 * lay it out: 6 reserved bytes, data-reference index, then version, revision
 * and the 4-byte vendor — vendor at +20 from the start of the entry.
 */
function sampleEntry(type: string, vendor: string): Buffer {
  return box(
    type,
    Buffer.alloc(6), // reserved
    Buffer.from([0, 1]), // data reference index
    Buffer.alloc(2), // version
    Buffer.alloc(2), // revision
    latin1(vendor),
    Buffer.alloc(40) // temporal/spatial quality, dimensions, ... — not read
  );
}

/** `stsd` is a full box: version + flags, entry count, then the entries. */
const stsd = (...entries: Buffer[]): Buffer =>
  box("stsd", u32(0), u32(entries.length), ...entries);

const trak = (...entries: Buffer[]): Buffer =>
  box("trak", box("tkhd", Buffer.alloc(84)), box("mdia", box("minf", box("stbl", stsd(...entries)))));

const moov = (...traks: Buffer[]): Buffer => box("moov", box("mvhd", Buffer.alloc(100)), ...traks);

const mdat = (n = 64): Buffer => box("mdat", Buffer.alloc(n, 0xab));

/** What the muxer produces for a spoofed copy: video with `FFMP`, audio with zeros. */
const ffmpegMov = (): Buffer =>
  Buffer.concat([
    ftyp(),
    moov(trak(sampleEntry("avc1", "FFMP")), trak(sampleEntry("mp4a", "\0\0\0\0"))),
    box("wide"),
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

test("refuses a ftyp whose major brand is not qt", () => {
  const file = Buffer.concat([ftyp("isom"), moov(), mdat()]);
  expect(() => findMovSignatureFields(file)).toThrow(/isom/);
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
