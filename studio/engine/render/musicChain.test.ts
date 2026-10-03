import { describe, expect, test } from "bun:test";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { assertSafeFilterGraph } from "./filterString";
import {
  buildMusicMeasure,
  MUSIC_INPUT_ARGS,
  MUSIC_TARGET_TRUE_PEAK_DB,
  musicGainDb,
  musicInputArgs,
  musicSegmentFilters,
  parseTruePeak,
} from "./musicChain";
import { RenderGraphError } from "./types";
useNativeGlobals();

// The pure half of the audio chain (3c.5): the gain rule of invariant 21, the segment's filters, the measuring call and the
// reading of its answer. The builder of pass 2 uses the same pieces (pass2.music.test.ts), so the measurement and the render
// cut and convert the very same samples.

const TRACK = "/userdata/music/tracks/4199287736976977.m4a";

describe("musicGainDb: min(0, -1.5 - TP)", () => {
  test("is -4.5 dB for the hot fixture's +3.0 dBTP", () => {
    expect(musicGainDb(3.0)).toBe(-4.5);
  });

  test("is 0 for a peak just under the target: -1.6 dBTP is not raised", () => {
    expect(musicGainDb(-1.6)).toBe(0);
  });

  test("is 0 for a quiet track: -5.7 dBTP is not raised", () => {
    expect(musicGainDb(-5.7)).toBe(0);
  });

  test("is 0, never negative zero, when the peak is exactly the target", () => {
    expect(Object.is(musicGainDb(MUSIC_TARGET_TRUE_PEAK_DB), 0)).toBe(true);
  });

  test("is 0 for digital silence, whose peak is minus infinity", () => {
    expect(musicGainDb(Number.NEGATIVE_INFINITY)).toBe(0);
  });

  test("never rounds towards less attenuation: -1.45 dBTP needs -0.05, which is written as -0.1", () => {
    expect(musicGainDb(-1.45)).toBe(-0.1);
    expect(musicGainDb(-1.4)).toBe(-0.1);
    expect(musicGainDb(-1.35)).toBe(-0.2);
  });

  test("is never positive for any peak", () => {
    for (let tp = -40; tp <= 12; tp += 0.1) expect(musicGainDb(tp)).toBeLessThanOrEqual(0);
  });

  test("refuses a peak that is not a number", () => {
    expect(() => musicGainDb(Number.NaN)).toThrow(RenderGraphError);
    expect(() => musicGainDb(Number.POSITIVE_INFINITY)).toThrow(RenderGraphError);
  });
});

describe("parseTruePeak", () => {
  const summary = (peak: string): string =>
    ["[Parsed_ebur128_4 @ 0x6000017d8840] Summary:", "", "  Integrated loudness:", "    I:         -13.6 LUFS", "    Threshold: -23.6 LUFS", "", "  True peak:", `    Peak:        ${peak} dBFS`, ""].join("\n");

  test("reads a positive peak", () => {
    expect(parseTruePeak(summary("3.0"))).toBe(3.0);
  });

  test("reads a negative peak", () => {
    expect(parseTruePeak(summary("-5.7"))).toBe(-5.7);
  });

  test("reads minus infinity as the peak of silence", () => {
    expect(parseTruePeak(summary("-inf"))).toBe(Number.NEGATIVE_INFINITY);
  });

  test("reads inf and +inf as plus infinity, which the gain rule then refuses", () => {
    expect(parseTruePeak(summary("inf"))).toBe(Number.POSITIVE_INFINITY);
    expect(parseTruePeak(summary("+inf"))).toBe(Number.POSITIVE_INFINITY);
    expect(() => musicGainDb(parseTruePeak(summary("inf")))).toThrow(RenderGraphError);
  });

  test("reads a summary that ends its lines with CR LF, as on Windows", () => {
    expect(parseTruePeak(summary("-1.6").replaceAll("\n", "\r\n"))).toBe(-1.6);
  });

  test("takes the last summary when ffmpeg printed the line more than once", () => {
    expect(parseTruePeak(`${summary("9.9")}\n${summary("-2.0")}`)).toBe(-2.0);
  });

  test("refuses text with no true peak, as BAD_AUDIO", () => {
    expect(() => parseTruePeak("Summary:\n  Integrated loudness:\n    I: -13.6 LUFS\n")).toThrow(RenderGraphError);
    try {
      parseTruePeak("");
    } catch (error) {
      expect(error).toBeInstanceOf(RenderGraphError);
      if (error instanceof RenderGraphError) expect(error.code).toBe("BAD_AUDIO");
    }
  });
});

describe("the input flags of a stored track (the hardening of decodeCheck.ts)", () => {
  test("force the mov demuxer, allow only the file protocol, force the AAC decoder and cap allocations, all before -i", () => {
    const args = musicInputArgs(TRACK);
    expect(args.slice(-2)).toEqual(["-i", TRACK]);
    expect(args.slice(0, -2)).toEqual(["-max_alloc", "67108864", "-protocol_whitelist", "file", "-f", "mov", "-c:a", "aac"]);
    expect(args.slice(0, -2)).toEqual([...MUSIC_INPUT_ARGS]);
  });

  test("refuse a path that is not absolute", () => {
    expect(() => musicInputArgs("tracks/1.m4a")).toThrow(RenderGraphError);
    expect(() => musicInputArgs("-i")).toThrow(RenderGraphError);
  });
});

describe("musicSegmentFilters: decode, 48 kHz stereo, the clip segment, and nothing else", () => {
  test("resamples and converts to stereo first, then cuts the segment in samples at 48 kHz", () => {
    expect(musicSegmentFilters(0, 384_000)).toBe("aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=start_sample=0:end_sample=384000,asetpts=PTS-STARTPTS");
  });

  test("starts at startMs x 48 samples and ends N samples later", () => {
    expect(musicSegmentFilters(1_500, 288_000)).toBe("aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=start_sample=72000:end_sample=360000,asetpts=PTS-STARTPTS");
  });

  test("has no fade (the owner: no fades)", () => {
    expect(musicSegmentFilters(1_500, 288_000)).not.toMatch(/fade|afade/);
  });

  test("refuses a start that is not a whole non-negative number of milliseconds", () => {
    for (const startMs of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => musicSegmentFilters(startMs, 48_000)).toThrow(RenderGraphError);
  });

  test("refuses a length that is not a positive whole number of samples", () => {
    for (const samples of [0, -48, 1.5]) expect(() => musicSegmentFilters(0, samples)).toThrow(RenderGraphError);
  });

  test("passes the graph check", () => {
    expect(() => assertSafeFilterGraph(musicSegmentFilters(1_500, 288_000))).not.toThrow();
  });
});

describe("buildMusicMeasure: the ebur128 true-peak pass over the clip segment", () => {
  const job = buildMusicMeasure({ path: TRACK, startMs: 1_500, durationMs: 6_000 });

  test("is the whole call: quiet, no stdin, the hardened input, an explicit stream, the segment, ebur128 with the peak, and no output file", () => {
    expect(job.argv).toEqual([
      "-hide_banner",
      "-nostdin",
      "-nostats",
      "-max_alloc",
      "67108864",
      "-protocol_whitelist",
      "file",
      "-f",
      "mov",
      "-c:a",
      "aac",
      "-i",
      TRACK,
      "-map",
      "0:a:0",
      "-af",
      "aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=start_sample=72000:end_sample=360000,asetpts=PTS-STARTPTS,ebur128=peak=true:framelog=quiet",
      "-vn",
      "-sn",
      "-dn",
      "-f",
      "null",
      "-",
    ]);
  });

  test("measures the same segment the render uses", () => {
    expect(job.argv.join(" ")).toContain(musicSegmentFilters(1_500, 6_000 * 48));
  });

  test("passes the graph check", () => {
    const at = job.argv.indexOf("-af");
    expect(() => assertSafeFilterGraph(job.argv[at + 1] ?? "")).not.toThrow();
  });

  test("never lets ffmpeg pick a stream: the only map is the first audio stream of the track", () => {
    const maps = job.argv.flatMap((a, i) => (a === "-map" ? [job.argv[i + 1]] : []));
    expect(maps).toEqual(["0:a:0"]);
  });
});
