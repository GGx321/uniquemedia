import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { removeDir } from "../render/render.testkit";
import { AV_TOLERANCE_MS, VIDEO_TOLERANCE_MS } from "./structure";
import type { VerifyReasonCode, VerifyResult } from "./types";
import { verifyRenderedMp4 } from "./verifyMp4";
import { concat, findAscii, FIXTURE_FRAMES, locate, makeBox, makeForeign, patched, remux, renderFixture, setU32, swapTopLevel, writeCopy, type Fixture } from "./verify.testkit";
useNativeGlobals();

// REAL ffmpeg: the structure checks (invariant 20, A4) on a real render and
// on copies of it, or real foreign encodes, that break one fact each. Every
// case must be refused with the code for that fact.

let fx: Fixture;
beforeAll(async () => {
  fx = await renderFixture("verify-structure");
}, 120_000);
afterAll(() => removeDir(fx.dir));

const EXPECTED = { frames: FIXTURE_FRAMES };
const codesOf = (r: VerifyResult): VerifyReasonCode[] => (r.ok ? [] : r.reasons.map((x) => x.code));
const run = (name: string, bytes: Uint8Array, expected = EXPECTED) => verifyRenderedMp4(writeCopy(fx, name, bytes), expected);
const stsdEntryAt = (bytes: Uint8Array, nth: number): number => locate(bytes, "moov/trak/mdia/minf/stbl/stsd", nth).start + 16;
const u32At = (bytes: Uint8Array, at: number): number => new DataView(bytes.buffer, bytes.byteOffset).getUint32(at);
const setU16 = (bytes: Uint8Array, at: number, value: number): void => new DataView(bytes.buffer, bytes.byteOffset).setUint16(at, value);

/** Offsets of the fields the duration checks read (version 0 boxes, movie timescale 1000). */
const mvhdDurationAt = (b: Uint8Array): number => locate(b, "moov/mvhd").start + 24;
const tkhdDurationAt = (b: Uint8Array, trak: number): number => locate(b, "moov/trak/tkhd", trak).start + 28;

describe("the frame count (invariant 20)", () => {
  test("accepts exactly the expected number of frames", async () => {
    expect(await verifyRenderedMp4(fx.path, EXPECTED)).toEqual({ ok: true });
  });

  test.each([FIXTURE_FRAMES - 1, FIXTURE_FRAMES + 1])("refuses an expected count of %i against the 45 frames in the file, with FRAME_COUNT_MISMATCH", async (frames) => {
    const r = await verifyRenderedMp4(fx.path, { frames });
    expect(codesOf(r)).toContain("FRAME_COUNT_MISMATCH");
    expect(!r.ok && r.reasons.find((x) => x.code === "FRAME_COUNT_MISMATCH")?.message).toContain(`${FIXTURE_FRAMES}`);
  });

  test("refuses a file whose stsz sample count was raised by one, with FRAME_COUNT_MISMATCH", async () => {
    const stsz = locate(fx.bytes, "moov/trak/mdia/minf/stbl/stsz");
    const at = stsz.start + 16;
    const bytes = patched(fx.bytes, (b) => setU32(b, at, u32At(b, at) + 1));
    expect(codesOf(await run("stsz.mp4", bytes))).toContain("FRAME_COUNT_MISMATCH");
  });
});

describe("the duration (invariant 20, and the AAC priming note)", () => {
  // The audio is built one AAC frame (1024 samples, 21.333 ms) short of the video at most, and
  // the priming edit can add one more; a stream-copied concat reported 22 ms over (spike README).
  // So the movie and the audio track may differ from the video by two AAC frames, 42.67 ms,
  // rounded up to the 43 ms the movie timescale (1 ms) can state.
  const ms = (b: Uint8Array, at: number): number => u32At(b, at);

  test("states the tolerances the checks below pin", () => {
    expect({ av: AV_TOLERANCE_MS, video: VIDEO_TOLERANCE_MS }).toEqual({ av: 43, video: 2 });
  });

  test("the real render has a video of exactly 1500 ms and an audio under it by less than one AAC frame", () => {
    expect(ms(fx.bytes, tkhdDurationAt(fx.bytes, 0))).toBe(1500);
    const gap = 1500 - ms(fx.bytes, tkhdDurationAt(fx.bytes, 1));
    expect(gap).toBeGreaterThanOrEqual(0);
    expect(gap).toBeLessThanOrEqual(22);
  });

  test("accepts a movie duration 43 ms over the video's", async () => {
    expect(await run("mvhd-43.mp4", patched(fx.bytes, (b) => setU32(b, mvhdDurationAt(b), 1500 + AV_TOLERANCE_MS)))).toEqual({ ok: true });
  });

  test("refuses a movie duration 44 ms over the video's with DURATION_MISMATCH", async () => {
    expect(codesOf(await run("mvhd-44.mp4", patched(fx.bytes, (b) => setU32(b, mvhdDurationAt(b), 1500 + AV_TOLERANCE_MS + 1))))).toContain("DURATION_MISMATCH");
  });

  test("refuses a movie duration 44 ms under the video's with DURATION_MISMATCH", async () => {
    expect(codesOf(await run("mvhd-under.mp4", patched(fx.bytes, (b) => setU32(b, mvhdDurationAt(b), 1500 - AV_TOLERANCE_MS - 1))))).toContain("DURATION_MISMATCH");
  });

  test("accepts an audio track 43 ms under the video and refuses one 44 ms under, with DURATION_MISMATCH", async () => {
    const audioAt = tkhdDurationAt(fx.bytes, 1);
    expect(await run("audio-43.mp4", patched(fx.bytes, (b) => setU32(b, audioAt, 1500 - AV_TOLERANCE_MS)))).toEqual({ ok: true });
    expect(codesOf(await run("audio-44.mp4", patched(fx.bytes, (b) => setU32(b, audioAt, 1500 - AV_TOLERANCE_MS - 1))))).toContain("DURATION_MISMATCH");
  });

  test("refuses an audio track 44 ms over the video with DURATION_MISMATCH", async () => {
    expect(codesOf(await run("audio-over.mp4", patched(fx.bytes, (b) => setU32(b, tkhdDurationAt(b, 1), 1500 + AV_TOLERANCE_MS + 1))))).toContain("DURATION_MISMATCH");
  });

  test("accepts a video track 2 ms off the frame count's length and refuses 3 ms, with DURATION_MISMATCH", async () => {
    // The movie duration follows the video track so that only the video-versus-frames check can fire.
    const both = (b: Uint8Array, video: number): void => {
      setU32(b, tkhdDurationAt(b, 0), video);
      setU32(b, mvhdDurationAt(b), video);
    };
    expect(await run("video-2.mp4", patched(fx.bytes, (b) => both(b, 1500 + VIDEO_TOLERANCE_MS)))).toEqual({ ok: true });
    expect(codesOf(await run("video-3.mp4", patched(fx.bytes, (b) => both(b, 1500 + VIDEO_TOLERANCE_MS + 1))))).toContain("DURATION_MISMATCH");
  });

  test("refuses a movie timescale of 0 with DURATION_MISMATCH instead of dividing by it", async () => {
    const at = locate(fx.bytes, "moov/mvhd").start + 20;
    expect(codesOf(await run("timescale0.mp4", patched(fx.bytes, (b) => setU32(b, at, 0))))).toContain("DURATION_MISMATCH");
  });
});

describe("the index before the media data (+faststart)", () => {
  test("refuses moov placed after mdat with NOT_FASTSTART", async () => {
    const codes = codesOf(await run("moov-last.mp4", swapTopLevel(fx.bytes, "moov", "mdat")));
    expect(codes).toContain("NOT_FASTSTART");
  });

  test("refuses a real ffmpeg copy written without +faststart with NOT_FASTSTART", async () => {
    const out = join(fx.dir, "no-faststart.mp4");
    await remux(fx.path, out, ["-map", "0", "-c", "copy", "-map_metadata", "-1"]);
    expect(codesOf(await verifyRenderedMp4(out, EXPECTED))).toContain("NOT_FASTSTART");
  });
});

describe("the tracks", () => {
  test("refuses a real file with a second audio track with UNEXPECTED_TRACKS", async () => {
    const out = join(fx.dir, "three-tracks.mp4");
    await remux(fx.path, out, ["-i", fx.path, "-map", "0", "-map", "1:a", "-c", "copy", "-map_metadata", "-1", "-movflags", "+faststart"]);
    expect(codesOf(await verifyRenderedMp4(out, EXPECTED))).toContain("UNEXPECTED_TRACKS");
  });

  test("refuses a real video-only file with MISSING_TRACK", async () => {
    const out = join(fx.dir, "video-only.mp4");
    await remux(fx.path, out, ["-map", "0:v", "-c", "copy", "-map_metadata", "-1", "-movflags", "+faststart"]);
    const r = await verifyRenderedMp4(out, EXPECTED);
    expect(codesOf(r)).toContain("MISSING_TRACK");
    expect(!r.ok && r.reasons.find((x) => x.code === "MISSING_TRACK")?.message).toContain("audio");
  });

  test("refuses a real audio-only file with MISSING_TRACK", async () => {
    const out = join(fx.dir, "audio-only.mp4");
    await remux(fx.path, out, ["-map", "0:a", "-c", "copy", "-map_metadata", "-1", "-movflags", "+faststart"]);
    const r = await verifyRenderedMp4(out, EXPECTED);
    expect(!r.ok && r.reasons.find((x) => x.code === "MISSING_TRACK")?.message).toContain("video");
  });

  test("refuses a track whose handler is neither video nor sound with UNEXPECTED_TRACKS", async () => {
    const hdlr = locate(fx.bytes, "moov/trak/mdia/hdlr", 1);
    const bytes = patched(fx.bytes, (b) => b.set([0x74, 0x65, 0x78, 0x74], hdlr.start + 16)); // "text"
    expect(codesOf(await run("text-track.mp4", bytes))).toContain("UNEXPECTED_TRACKS");
  });
});

describe("the video format (H.264, 1080x1920)", () => {
  test("refuses a real 320x240 encode with VIDEO_FORMAT_WRONG", async () => {
    const out = join(fx.dir, "foreign.mp4");
    await makeForeign(out);
    expect(codesOf(await verifyRenderedMp4(out, { frames: 30 }))).toContain("VIDEO_FORMAT_WRONG");
  });

  test("refuses a sample entry that is not avc1 with VIDEO_FORMAT_WRONG", async () => {
    const bytes = patched(fx.bytes, (b) => b.set([0x68, 0x76, 0x63, 0x31], stsdEntryAt(b, 0) + 4)); // "hvc1"
    expect(codesOf(await run("hvc1.mp4", bytes))).toContain("VIDEO_FORMAT_WRONG");
  });

  test.each([["width", 32, 1078], ["height", 34, 1918]] as const)("refuses a sample entry %s off by two with VIDEO_FORMAT_WRONG", async (which, offset, value) => {
    const at = stsdEntryAt(fx.bytes, 0) + offset;
    expect(codesOf(await run(`entry-${which}.mp4`, patched(fx.bytes, (b) => setU16(b, at, value))))).toContain("VIDEO_FORMAT_WRONG");
  });

  test("refuses a track header that says 720 wide with VIDEO_FORMAT_WRONG", async () => {
    const tkhd = locate(fx.bytes, "moov/trak/tkhd");
    expect(codesOf(await run("tkhd-width.mp4", patched(fx.bytes, (b) => setU32(b, tkhd.end - 8, 720 * 65536))))).toContain("VIDEO_FORMAT_WRONG");
  });

  test("refuses a video entry with no avcC configuration with VIDEO_FORMAT_WRONG", async () => {
    const bytes = patched(fx.bytes, (b) => b.set([0x78, 0x76, 0x63, 0x43], findAscii(b, "avcC"))); // "xvcC"
    expect(codesOf(await run("no-avcc.mp4", bytes))).toContain("VIDEO_FORMAT_WRONG");
  });

  test("refuses a video sample entry too short to hold its fields with STRUCTURE_UNRECOGNISED", async () => {
    const at = stsdEntryAt(fx.bytes, 0);
    expect(codesOf(await run("short-entry.mp4", patched(fx.bytes, (b) => setU32(b, at, 40))))).toContain("STRUCTURE_UNRECOGNISED");
  });
});

describe("the audio format (AAC-LC, 48 kHz, stereo)", () => {
  const ascAt = (b: Uint8Array): number => findAscii(b, "\u0005\u0080\u0080\u0080\u0005\u0011\u0090") + 5;

  test("refuses a real mono 44.1 kHz encode with AUDIO_FORMAT_WRONG", async () => {
    const out = join(fx.dir, "foreign-audio.mp4");
    await makeForeign(out);
    expect(codesOf(await verifyRenderedMp4(out, { frames: 30 }))).toContain("AUDIO_FORMAT_WRONG");
  });

  test("refuses one channel with AUDIO_FORMAT_WRONG", async () => {
    expect(codesOf(await run("mono.mp4", patched(fx.bytes, (b) => setU16(b, stsdEntryAt(b, 1) + 24, 1))))).toContain("AUDIO_FORMAT_WRONG");
  });

  test("refuses a 44.1 kHz sample entry with AUDIO_FORMAT_WRONG", async () => {
    expect(codesOf(await run("rate.mp4", patched(fx.bytes, (b) => setU16(b, stsdEntryAt(b, 1) + 32, 44100))))).toContain("AUDIO_FORMAT_WRONG");
  });

  test("refuses an AudioSpecificConfig of HE-AAC (object type 5) with AUDIO_FORMAT_WRONG", async () => {
    expect(codesOf(await run("he-aac.mp4", patched(fx.bytes, (b) => (b[ascAt(b)] = 0x29))))).toContain("AUDIO_FORMAT_WRONG");
  });

  test("refuses an AudioSpecificConfig that says 44.1 kHz with AUDIO_FORMAT_WRONG", async () => {
    // 0x12 0x10: object type 2, frequency index 4 (44100), two channels.
    expect(codesOf(await run("asc-rate.mp4", patched(fx.bytes, (b) => b.set([0x12, 0x10], ascAt(b)))))).toContain("AUDIO_FORMAT_WRONG");
  });

  test("refuses a sample entry that is not mp4a with AUDIO_FORMAT_WRONG", async () => {
    expect(codesOf(await run("ac3.mp4", patched(fx.bytes, (b) => b.set([0x61, 0x63, 0x2d, 0x33], stsdEntryAt(b, 1) + 4))))).toContain("AUDIO_FORMAT_WRONG");
  });
});

describe("the report", () => {
  test("reports every fault at once, not only the first", async () => {
    const mvhd = locate(fx.bytes, "moov/mvhd");
    const bytes = concat(patched(fx.bytes, (b) => setU32(b, mvhd.start + 12, 7)), makeBox("uuid", new Uint8Array(20)));
    const codes = codesOf(await verifyRenderedMp4(writeCopy(fx, "many.mp4", bytes), { frames: FIXTURE_FRAMES + 3 }));
    expect(new Set(codes)).toEqual(new Set(["NONZERO_TIMESTAMP", "UUID_BOX", "FRAME_COUNT_MISMATCH", "DURATION_MISMATCH"]));
  });

  test("does not repeat a reason", async () => {
    const r = await verifyRenderedMp4(writeCopy(fx, "repeat.mp4", swapTopLevel(fx.bytes, "moov", "mdat")), { frames: FIXTURE_FRAMES });
    const keys = !r.ok ? r.reasons.map((x) => `${x.code}|${x.path}|${x.message}`) : [];
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("the colour tags (colr nclx, BT.709, limited range)", () => {
  /** The offset of the `colr` type, then: `nclx` +4, primaries +8, transfer +10, matrix +12, flags +14. */
  const colrAt = (b: Uint8Array): number => findAscii(b, "colr", locate(b, "moov").start);

  test("the real render carries a colr box tagged BT.709 limited range, so the cases below change something", () => {
    const at = colrAt(fx.bytes);
    expect(new TextDecoder("latin1").decode(fx.bytes.subarray(at + 4, at + 8))).toBe("nclx");
    expect([u32At(fx.bytes, at + 4), fx.bytes[at + 14]]).toEqual([0x6e636c78, 0]);
    expect(new DataView(fx.bytes.buffer, fx.bytes.byteOffset).getUint16(at + 8)).toBe(1);
  });

  test.each([["primaries", 8, 5], ["transfer", 10, 6], ["matrix", 12, 5]] as const)("refuses BT.601 %s with COLOUR_TAG_WRONG", async (which, offset, value) => {
    expect(codesOf(await run(`colr-${which}.mp4`, patched(fx.bytes, (b) => setU16(b, colrAt(b) + offset, value))))).toContain("COLOUR_TAG_WRONG");
  });

  test("refuses the full-range flag with COLOUR_TAG_WRONG", async () => {
    expect(codesOf(await run("colr-full.mp4", patched(fx.bytes, (b) => (b[colrAt(b) + 14] = 0x80))))).toContain("COLOUR_TAG_WRONG");
  });

  test("refuses an ICC-profile colr box (prof) with COLOUR_TAG_WRONG", async () => {
    expect(codesOf(await run("colr-prof.mp4", patched(fx.bytes, (b) => b.set([0x70, 0x72, 0x6f, 0x66], colrAt(b) + 4))))).toContain("COLOUR_TAG_WRONG");
  });

  test("accepts a file with no colr box at all, since the tags are checked only if present", async () => {
    // The colr box is retyped as `fiel`, another box the entry may hold, so that only the tag is gone.
    expect(await run("no-colr.mp4", patched(fx.bytes, (b) => b.set([0x66, 0x69, 0x65, 0x6c], colrAt(b))))).toEqual({ ok: true });
  });
});
