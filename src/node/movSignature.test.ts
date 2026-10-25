import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import { findMovSignatureFields, markAppleContainer, scrubMovSignature, stampMovCreationTimes } from "./movSignature";
import { makeTestClip } from "./testClip";

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

// ── creation times ──────────────────────────────────────────────────────────

/** Seconds between the MOV epoch (1904-01-01) and the Unix epoch. */
const MAC_EPOCH_OFFSET = 2_082_844_800;
const WHEN = new Date("2026-10-11T09:30:15Z");
const WHEN_MAC = Math.floor(WHEN.getTime() / 1000) + MAC_EPOCH_OFFSET;

/** A full box (version + flags) whose creation/modification times are zero, as
 *  ffmpeg writes them under bitexact. `size` is the whole payload length. */
function timedBox(type: string, version: number, payloadLength: number): Buffer {
  const payload = Buffer.alloc(payloadLength, 0x11);
  payload[0] = version;
  const timeBytes = version === 1 ? 16 : 8;
  payload.fill(0, 4, 4 + timeBytes);
  return box(type, payload);
}

function movWithTimes(version: number): Buffer {
  const tr = box("trak", timedBox("tkhd", version, 84), box("mdia", timedBox("mdhd", version, 24)));
  return Buffer.concat([ftyp("isom", 0), box("moov", timedBox("mvhd", version, 100), tr, tr), mdat()]);
}

function timesAt(bytes: Buffer, type: string, nth = 0): { created: bigint; modified: bigint } {
  let at = -1;
  for (let i = 0; i <= nth; i++) at = bytes.indexOf(type, at + 1, "latin1");
  const body = at + 4; // after the fourcc
  const v1 = bytes[body] === 1;
  return v1
    ? { created: bytes.readBigUInt64BE(body + 4), modified: bytes.readBigUInt64BE(body + 12) }
    : { created: BigInt(bytes.readUInt32BE(body + 4)), modified: BigInt(bytes.readUInt32BE(body + 8)) };
}

test.each([0, 1])("stamps mvhd, tkhd and mdhd with the export time (box version %i)", async (version) => {
  const dir = mkdtempSync(join(tmpdir(), "uniq-stamp-"));
  try {
    const path = join(dir, "a.mp4");
    writeFileSync(path, movWithTimes(version));
    await stampMovCreationTimes(path, WHEN);
    const after = readFileSync(path);
    for (const [type, nth] of [["mvhd", 0], ["tkhd", 0], ["tkhd", 1], ["mdhd", 0], ["mdhd", 1]] as const) {
      expect(timesAt(after, type, nth)).toEqual({ created: BigInt(WHEN_MAC), modified: BigInt(WHEN_MAC) });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stamping the times changes nothing else in the file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "uniq-stamp-"));
  try {
    const path = join(dir, "a.mp4");
    const before = movWithTimes(0);
    writeFileSync(path, before);
    await stampMovCreationTimes(path, WHEN);
    const after = readFileSync(path);
    expect(after.length).toBe(before.length);
    let differing = 0;
    for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) differing++;
    // Only the nonzero bytes of 5 boxes x (creation + modification) can differ.
    expect(differing).toBeGreaterThan(0);
    expect(differing).toBeLessThanOrEqual(5 * 8);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refuses to stamp a file that has no moov box", async () => {
  const dir = mkdtempSync(join(tmpdir(), "uniq-stamp-"));
  try {
    const path = join(dir, "a.mp4");
    writeFileSync(path, Buffer.concat([ftyp("isom", 0), mdat()]));
    await expect(stampMovCreationTimes(path, WHEN)).rejects.toThrow(/moov/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a header of an unknown version refuses the whole file and leaves it byte for byte as it was", async () => {
  const dir = mkdtempSync(join(tmpdir(), "uniq-stamp-"));
  try {
    const path = join(dir, "a.mp4");
    const good = timedBox("tkhd", 0, 84);
    const bad = timedBox("mdhd", 2, 24); // version 2 does not exist
    const tr = box("trak", good, box("mdia", bad));
    const bytes = Buffer.concat([ftyp("isom", 0), box("moov", timedBox("mvhd", 0, 100), tr), mdat()]);
    writeFileSync(path, bytes);
    await expect(stampMovCreationTimes(path, WHEN)).rejects.toThrow(/version 2/);
    expect(readFileSync(path).equals(bytes)).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a header too short for its times refuses the whole file and leaves it untouched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "uniq-stamp-"));
  try {
    const path = join(dir, "a.mp4");
    const short = box("tkhd", Buffer.from([0, 0, 0, 0, 1, 2]));
    const bytes = Buffer.concat([ftyp("isom", 0), box("moov", timedBox("mvhd", 0, 100), box("trak", short)), mdat()]);
    writeFileSync(path, bytes);
    await expect(stampMovCreationTimes(path, WHEN)).rejects.toThrow(/too short/);
    expect(readFileSync(path).equals(bytes)).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── modify time differing from create time ──────────────────────────────────

test.each([0, 1])("stamps a modify time apart from the create time (box version %i)", async (version) => {
  const dir = mkdtempSync(join(tmpdir(), "uniq-stamp-"));
  try {
    const path = join(dir, "a.mp4");
    writeFileSync(path, movWithTimes(version));
    await stampMovCreationTimes(path, WHEN, new Date(WHEN.getTime() + 2000));
    const after = readFileSync(path);
    for (const [type, nth] of [["mvhd", 0], ["tkhd", 0], ["tkhd", 1], ["mdhd", 0], ["mdhd", 1]] as const) {
      expect(timesAt(after, type, nth)).toEqual({ created: BigInt(WHEN_MAC), modified: BigInt(WHEN_MAC + 2) });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Apple container fields ──────────────────────────────────────────────────

/**
 * A real MOV the way the iphone branch writes one: bitexact, so the muxer
 * leaves the media language at 0x7FFF and the handler vendors at zero. Rendered
 * from the test clip rather than built by hand because the offsets being
 * patched are the muxer's own.
 */
function realMov(dir: string): string {
  const src = join(dir, "src.mp4");
  makeTestClip(src);
  const out = join(dir, "real.mov");
  const r = spawnSync(
    ffmpegPath as string,
    ["-v", "error", "-y", "-i", src, "-c", "copy", "-fflags", "+bitexact", "-f", "mov", out],
    { encoding: "utf8" }
  );
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
  return out;
}

const exiftoolBin = resolve(import.meta.dir, "../../node_modules/exiftool-vendored.pl/bin/exiftool");

function tagValues(path: string, tag: string): string[] {
  const r = spawnSync(exiftoolBin, ["-a", "-s3", `-${tag}`, path], { encoding: "utf8" });
  return r.stdout.split("\n").filter((l) => l.length > 0);
}

test("markAppleContainer writes the Apple vendor into every handler box of every track", async () => {
  const dir = mkdtempSync(join(tmpdir(), "uniq-apple-"));
  try {
    const path = realMov(dir);
    expect(tagValues(path, "HandlerVendorID")).not.toContain("Apple");
    await markAppleContainer(path);
    expect(tagValues(path, "HandlerVendorID")).toEqual(["Apple", "Apple", "Apple", "Apple"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("markAppleContainer sets the media language of every track to und", async () => {
  const dir = mkdtempSync(join(tmpdir(), "uniq-apple-"));
  try {
    const path = realMov(dir);
    await markAppleContainer(path);
    expect(tagValues(path, "MediaLanguageCode")).toEqual(["und", "und"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("markAppleContainer sets the video header to ditherCopy and an 0x8000 OpColor", async () => {
  const dir = mkdtempSync(join(tmpdir(), "uniq-apple-"));
  try {
    const path = realMov(dir);
    await markAppleContainer(path);
    expect(tagValues(path, "GraphicsMode")).toEqual(["ditherCopy"]);
    expect(tagValues(path, "OpColor")).toEqual(["32768 32768 32768"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("markAppleContainer changes nothing but those fields: the file keeps its length and decodes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "uniq-apple-"));
  try {
    const path = realMov(dir);
    const before = readFileSync(path);
    await markAppleContainer(path);
    const after = readFileSync(path);
    expect(after.length).toBe(before.length);
    let differing = 0;
    for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) differing++;
    // 4 vendors x 4 + 2 languages x 2 + vmhd (2 + 6), as an upper bound
    expect(differing).toBeGreaterThan(0);
    expect(differing).toBeLessThanOrEqual(4 * 4 + 2 * 2 + 8);
    const r = spawnSync(ffmpegPath as string, ["-v", "error", "-i", path, "-f", "null", "-"], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stderr.trim()).toBe("");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("markAppleContainer is idempotent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "uniq-apple-"));
  try {
    const path = realMov(dir);
    await markAppleContainer(path);
    const once = readFileSync(path);
    await markAppleContainer(path);
    expect(readFileSync(path).equals(once)).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A track whose mdhd/hdlr/vmhd are all long enough, for the refusal tests to break one at a time. */
function appleTrack(parts: { mdhd?: Buffer; hdlr?: Buffer; vmhd?: Buffer } = {}): Buffer {
  const mdhd = parts.mdhd ?? box("mdhd", Buffer.alloc(24));
  const hdlr = parts.hdlr ?? box("hdlr", Buffer.alloc(24));
  const vmhd = parts.vmhd ?? box("vmhd", Buffer.alloc(12));
  return box("trak", box("mdia", mdhd, hdlr, box("minf", vmhd, box("hdlr", Buffer.alloc(24)))));
}

async function refuses(file: Buffer, pattern: RegExp): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "uniq-apple-"));
  try {
    const path = join(dir, "a.mov");
    writeFileSync(path, file);
    await expect(markAppleContainer(path)).rejects.toThrow(pattern);
    expect(readFileSync(path).equals(file)).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("markAppleContainer refuses a file with no moov box", async () => {
  await refuses(Buffer.concat([ftyp(), mdat()]), /moov/);
});

test("markAppleContainer refuses an mdhd of an unknown version and leaves the file as it was", async () => {
  const bad = Buffer.alloc(24);
  bad[0] = 2;
  await refuses(Buffer.concat([ftyp(), box("moov", appleTrack({ mdhd: box("mdhd", bad) })), mdat()]), /version 2/);
});

test("markAppleContainer refuses an mdhd too short to hold its language", async () => {
  await refuses(Buffer.concat([ftyp(), box("moov", appleTrack({ mdhd: box("mdhd", Buffer.alloc(20)) })), mdat()]), /too short/);
});

test("markAppleContainer refuses an hdlr too short to hold its manufacturer", async () => {
  await refuses(Buffer.concat([ftyp(), box("moov", appleTrack({ hdlr: box("hdlr", Buffer.alloc(14)) })), mdat()]), /too short/);
});

test("markAppleContainer refuses a vmhd of an unknown version", async () => {
  const bad = Buffer.alloc(12);
  bad[0] = 1;
  await refuses(Buffer.concat([ftyp(), box("moov", appleTrack({ vmhd: box("vmhd", bad) })), mdat()]), /version 1/);
});

test("markAppleContainer refuses a vmhd too short to hold its colour", async () => {
  await refuses(Buffer.concat([ftyp(), box("moov", appleTrack({ vmhd: box("vmhd", Buffer.alloc(8)) })), mdat()]), /too short/);
});
