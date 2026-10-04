import { describe, expect, test } from "bun:test";
import { demuxerOf, durationMsOf, judgeDump, judgeStoredDump, streamLinesOf, type AudioDemuxer } from "./audioProbe";
import type { MediaFormat } from "./sniff";

// What ffmpeg's input dump says of a file, read as text (3f.4). The dump is TEXT THE FILE PARTLY WRITES (a tag, a handler name), so the reader
// is held to the rules of `decodeCheck.inspectStreams`: the stream numbers are 0..n-1 in order, and a line a tag printed cannot pass for a stream.

const dump = (...lines: string[]): string => lines.join("\n");

const MP3 = dump("Input #0, mp3, from 'a.mp3':", "  Duration: 00:00:00.63, start: 0.025057, bitrate: 50 kb/s", "  Stream #0:0: Audio: mp3, 44100 Hz, stereo, fltp, 48 kb/s");
const M4A_AAC = dump(
  "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'a.m4a':",
  "  Duration: 00:00:00.60, start: 0.000000, bitrate: 58 kb/s",
  "  Stream #0:0[0x1](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 45 kb/s (default)",
);
const COVER_MP3 = dump(
  "Input #0, mp3, from 'cover.mp3':",
  "  Metadata:",
  "    title           : Some Title",
  "  Duration: 00:00:00.63, start: 0.025056, bitrate: 55 kb/s",
  "  Stream #0:0: Audio: mp3, 44100 Hz, stereo, fltp, 48 kb/s",
  "    Metadata:",
  "      encoder         : Lavf lame",
  "  Stream #0:1: Video: mjpeg, none(bt470bg/unknown/unknown), 90k tbr, 90k tbn (attached pic)",
  "    Metadata:",
  "      comment         : Other",
);

describe("which demuxer a sniffed container is read with", () => {
  test.each<[MediaFormat, AudioDemuxer | null]>([
    ["mp3", "mp3"],
    ["aac", "aac"],
    ["wav", "wav"],
    ["flac", "flac"],
    ["ogg", "ogg"],
    ["m4a", "mov"],
    ["mp4", "mov"],
    ["mov", "mov"],
    ["jpeg", null],
    ["png", null],
    ["webp", null],
    ["gif", null],
    ["apng", null],
  ])("%s is read with %s", (format, expected) => {
    expect(demuxerOf(format)).toBe(expected);
  });
});

describe("the stream lines of a dump", () => {
  test("lists each stream with its number and kind", () => {
    expect(streamLinesOf(COVER_MP3).map((s) => [s.index, s.kind])).toEqual([
      [0, "Audio"],
      [1, "Video"],
    ]);
  });

  test("reads the stream of an MP4 whose line carries a hex id and a language", () => {
    expect(streamLinesOf(M4A_AAC).map((s) => [s.index, s.kind])).toEqual([[0, "Audio"]]);
  });

  test("a text that merely mentions a stream is no stream", () => {
    const text = dump("  Stream #0:0: Audio: mp3, 44100 Hz, stereo", "      comment         : Stream #0:1: Video: mjpeg (attached pic)");
    expect(streamLinesOf(text)).toHaveLength(1);
  });
});

describe("the header duration", () => {
  test("is read in milliseconds from the top-level line", () => {
    expect(durationMsOf(MP3)).toBe(630);
    expect(durationMsOf(dump("  Duration: 00:10:00.00, start: 0.000000, bitrate: 138 kb/s"))).toBe(600_000);
    expect(durationMsOf(dump("  Duration: 01:02:03.04, bitrate: 1 kb/s"))).toBe(3_723_040);
  });

  test("is null when the file has none", () => {
    expect(durationMsOf(dump("  Duration: N/A, bitrate: N/A"))).toBeNull();
    expect(durationMsOf("nothing")).toBeNull();
  });

  test("a tag's own line, with its key's indent, does not count as the header's", () => {
    const text = dump("  Metadata:", "                    : Duration: 00:00:01.00, start: 0", "    title           : Duration: 00:00:02.00", "  Duration: 00:00:09.00, bitrate: 1 kb/s");
    expect(durationMsOf(text)).toBe(9_000);
  });

  test("two header lines is not a header: a key can print a line that reads as one, so the length is unknown", () => {
    const text = dump("  Metadata:", "    x", "  Duration: 00:00:01.00, bitrate: 1 kb/s", "  Duration: 00:10:00.00, bitrate: 1 kb/s");
    expect(durationMsOf(text)).toBeNull();
  });
});

describe("judging a source's dump", () => {
  test("an mp3 is read by the mp3float decoder and its header length is an estimate", () => {
    expect(judgeDump(MP3, "mp3")).toEqual({ ok: true, codec: "mp3", decoder: "mp3float", headerMs: 630, exactLength: false });
  });

  test("an AAC in an m4a is read by the aac decoder and its length is exact", () => {
    expect(judgeDump(M4A_AAC, "mov")).toEqual({ ok: true, codec: "aac", decoder: "aac", headerMs: 600, exactLength: true });
  });

  test.each<[string, AudioDemuxer, string, string, boolean]>([
    ["  Stream #0:0[0x1](und): Audio: alac (alac / 0x63616C61), 44100 Hz, stereo, s16p, 136 kb/s (default)", "mov", "alac", "alac", true],
    ["  Stream #0:0: Audio: aac (LC), 44100 Hz, stereo, fltp, 47 kb/s", "aac", "aac", "aac", false],
    ["  Stream #0:0: Audio: flac, 44100 Hz, stereo, s16", "flac", "flac", "flac", true],
    ["  Stream #0:0: Audio: vorbis, 44100 Hz, stereo, fltp, 64 kb/s", "ogg", "vorbis", "vorbis", true],
    ["  Stream #0:0: Audio: opus, 48000 Hz, stereo, fltp", "ogg", "opus", "opus", true],
    ["  Stream #0:0: Audio: pcm_s16le ([1][0][0][0] / 0x0001), 44100 Hz, 1 channels, s16, 705 kb/s", "wav", "pcm_s16le", "pcm_s16le", true],
    ["  Stream #0:0: Audio: pcm_u8 ([1][0][0][0] / 0x0001), 8000 Hz, mono, u8, 64 kb/s", "wav", "pcm_u8", "pcm_u8", true],
    ["  Stream #0:0: Audio: pcm_f32le ([3][0][0][0] / 0x0003), 48000 Hz, stereo, flt, 3072 kb/s", "wav", "pcm_f32le", "pcm_f32le", true],
  ])("%s", (line, demuxer, codec, decoder, exactLength) => {
    const verdict = judgeDump(dump("  Duration: 00:00:01.00, bitrate: 1 kb/s", line), demuxer);
    expect(verdict).toEqual({ ok: true, codec, decoder, headerMs: 1_000, exactLength });
  });

  test("a header with no duration is still judged, with no length to hold the decode to", () => {
    expect(judgeDump(dump("  Duration: N/A, bitrate: N/A", "  Stream #0:0: Audio: flac, 44100 Hz, stereo, s16"), "flac")).toMatchObject({ ok: true, headerMs: null });
  });

  test("attached cover art is tolerated and is no stream the decode will see", () => {
    expect(judgeDump(COVER_MP3, "mp3")).toMatchObject({ ok: true, codec: "mp3" });
  });

  test("several attached pictures are tolerated too", () => {
    const pics = dump(MP3, "  Stream #0:1: Video: mjpeg, none, 90k tbr, 90k tbn (attached pic)", "  Stream #0:2: Video: png, none, 90k tbr, 90k tbn (attached pic)");
    expect(judgeDump(pics, "mp3")).toMatchObject({ ok: true });
  });

  test("a real video stream is refused as the wrong kind of file, even beside audio", () => {
    const video = dump(M4A_AAC, "  Stream #0:1[0x2](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p, 64x64, 86 kb/s, 25 fps, 25 tbr, 12800 tbn (default)");
    expect(judgeDump(video, "mov")).toEqual({ ok: false, reason: "format" });
  });

  test("a file with no audio at all is refused", () => {
    expect(judgeDump(dump("  Duration: 00:00:00.60, bitrate: 1 kb/s", "  Stream #0:0[0x1](und): Video: mpeg4, yuv420p, 64x64, 86 kb/s"), "mov")).toEqual({ ok: false, reason: "format" });
    expect(judgeDump("Input #0, mp3, from 'a.mp3':", "mp3")).toEqual({ ok: false, reason: "format" });
  });

  test("two audio streams are refused: the one that is decoded must be the one that was judged", () => {
    const two = dump(M4A_AAC, "  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 45 kb/s");
    expect(judgeDump(two, "mov")).toEqual({ ok: false, reason: "format" });
  });

  test.each(["Subtitle: mov_text (text / 0x74786574)", "Data: none (tmcd / 0x64636D74)", "Attachment: ttf (ignored)"])("a %s stream is refused", (stream) => {
    expect(judgeDump(dump(M4A_AAC, `  Stream #0:1[0x2](und): ${stream}`), "mov")).toEqual({ ok: false, reason: "format" });
  });

  test("a codec the importer does not take is refused as a codec, not as a format", () => {
    expect(judgeDump(dump("  Stream #0:0: Audio: adpcm_ms ([2][0][0][0] / 0x0002), 22050 Hz, 1 channels, s16, 88 kb/s"), "wav")).toEqual({ ok: false, reason: "codec" });
    expect(judgeDump(dump("  Stream #0:0: Audio: mp2, 44100 Hz, stereo, fltp, 128 kb/s"), "mp3")).toEqual({ ok: false, reason: "codec" });
    expect(judgeDump(dump("  Stream #0:0[0x1](und): Audio: ac3 (ac-3 / 0x332D6361), 48000 Hz, 5.1(side), fltp, 448 kb/s"), "mov")).toEqual({ ok: false, reason: "codec" });
  });

  test("a codec that belongs to another container is refused: an opus stream cannot be read as an mp3", () => {
    expect(judgeDump(dump("  Stream #0:0: Audio: opus, 48000 Hz, stereo, fltp"), "mp3")).toEqual({ ok: false, reason: "codec" });
    expect(judgeDump(dump("  Stream #0:0: Audio: flac, 44100 Hz, stereo, s16"), "ogg")).toEqual({ ok: false, reason: "codec" });
  });

  test("a dump with two header lines is refused: a tag printed one, and which is the file's is not known", () => {
    const forged = dump("  Metadata:", "    x", "  Duration: 00:00:01.00, bitrate: 1 kb/s", "  Duration: 00:10:00.00, bitrate: 1 kb/s", "  Stream #0:0: Audio: flac, 44100 Hz, stereo, s16");
    expect(judgeDump(forged, "flac")).toEqual({ ok: false, reason: "format" });
  });

  test("a stream list whose numbers are not 0 to n-1 in order is not a plain list, and is refused", () => {
    expect(judgeDump(dump("  Stream #0:0: Audio: mp3, 44100 Hz, stereo", "  Stream #0:0: Audio: mp3, 44100 Hz, stereo"), "mp3")).toEqual({ ok: false, reason: "format" });
    expect(judgeDump(dump("  Stream #0:1: Audio: mp3, 44100 Hz, stereo"), "mp3")).toEqual({ ok: false, reason: "format" });
  });

  test("a tag that prints a stream line of its own cannot make a second audio stream pass for the only one", () => {
    // A key with a newline in it: the dump carries a line that reads as a stream, and the real stream line follows.
    const forged = dump("  Metadata:", "    x", "  Stream #0:0: Audio: flac, 44100 Hz, stereo, s16", "  Stream #0:0: Audio: mp3, 44100 Hz, stereo, fltp, 48 kb/s");
    expect(judgeDump(forged, "mp3")).toEqual({ ok: false, reason: "format" });
  });
});

describe("judging the file the importer made", () => {
  const stored = dump(
    "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'out.m4a':",
    "  Metadata:",
    "    major_brand     : M4A ",
    "  Duration: 00:00:00.60, start: 0.000000, bitrate: 217 kb/s",
    "  Stream #0:0[0x1](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 198 kb/s (default)",
    "      handler_name    : SoundHandler",
  );

  test("passes AAC-LC, 48 kHz, stereo, one stream, and gives its header length", () => {
    expect(judgeStoredDump(stored)).toEqual({ ok: true, headerMs: 600 });
  });

  test.each([
    ["44100 Hz", stored.replace("48000 Hz", "44100 Hz")],
    ["mono", stored.replace("stereo", "mono")],
    ["5.1", stored.replace("stereo", "5.1")],
    ["HE-AAC", stored.replace("aac (LC)", "aac (HE-AAC)")],
    ["ALAC", stored.replace("aac (LC)", "alac")],
    ["mp3", stored.replace("aac (LC)", "mp3")],
  ])("refuses %s", (_label, text) => {
    expect(judgeStoredDump(text)).toEqual({ ok: false, empty: false });
  });

  test("refuses a second stream, even an attached picture: what is stored is audio and nothing else", () => {
    expect(judgeStoredDump(dump(stored, "  Stream #0:1: Video: mjpeg, none, 90k tbr, 90k tbn (attached pic)"))).toEqual({ ok: false, empty: false });
    expect(judgeStoredDump(dump(stored, "  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp"))).toEqual({ ok: false, empty: false });
  });

  test("a dump with no stream at all is an EMPTY result: the source had no audio that decodes, which is not our own output failing", () => {
    expect(judgeStoredDump(dump("Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'out.m4a':", "  Duration: N/A, bitrate: N/A"))).toEqual({ ok: false, empty: true });
    expect(judgeStoredDump("")).toEqual({ ok: false, empty: true });
  });

  test("refuses a dump with no duration: there is nothing to hold the decode to", () => {
    expect(judgeStoredDump(stored.replace("  Duration: 00:00:00.60,", "  Duration: N/A,"))).toEqual({ ok: false, empty: false });
  });
});
