import { describe, expect, test } from "bun:test";
import { totalFrames } from "../../shared/montage";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { assertSafeFilterGraph } from "./filterString";
import { MUSIC_INPUT_ARGS, musicRenderFilters } from "./musicChain";
import { buildPass2 } from "./pass2";
import { CONTAINER_ARGS, FILTER_THREAD_ARGS, FINAL_AUDIO_ARGS, FINAL_VIDEO_ARGS, FRAME_TAGS, METADATA_ARGS } from "./profile";
import { RenderGraphError, type AudioSource, type OverlayInput, type Pass2Input } from "./types";
useNativeGlobals();

// Golden tests of pass 2's argv and graph with and without music (3c.5). The silent case is pinned whole: the audio chain must
// not change a byte of what a montage with no music produced before.

const CLIP_DIR = "/work/render-tmp/job-1";
const OUTPUT = "/export/Alice/.studio-part-job-1.mp4";
const TRACK = "/userdata/music/tracks/4199287736976977.m4a";

const CLIPS = [
  { clipId: "a", durationMs: 2000 },
  { clipId: "b", durationMs: 3100 },
  { clipId: "c", durationMs: 2900 },
]; // 8 s = 240 frames = 384 000 samples

const music = (over: Partial<Extract<AudioSource, { kind: "music" }>> = {}): AudioSource => ({ kind: "music", path: TRACK, startMs: 0, gainDb: 0, ...over });

const build = (over: Partial<Pass2Input> = {}) => buildPass2({ clips: CLIPS, clipDir: CLIP_DIR, output: OUTPUT, overlays: [], audio: { kind: "silent" }, ...over });

const flag = (argv: readonly string[], name: string): string | undefined => {
  const at = argv.indexOf(name);
  return at < 0 ? undefined : argv[at + 1];
};
const maps = (argv: readonly string[]): string[] => argv.flatMap((a, i) => (a === "-map" ? [argv[i + 1] ?? ""] : []));
const inputsOf = (argv: readonly string[]): string[] => argv.flatMap((a, i) => (a === "-i" ? [argv[i + 1] ?? ""] : []));

/** The layer pass's file, the only overlay pass 2 takes (3b.6): the whole frame over the whole timeline. */
const layerFile = (over: Partial<OverlayInput> = {}): OverlayInput => ({ path: "/work/render-tmp/job-1/layers-00.mkv", format: "layers", box: { x: 0, y: 0, w: 1080, h: 1920 }, resize: false, startFrame: 0, endFrame: totalFrames(CLIPS), ...over });

/** The flags in front of input number `n`'s `-i`, back to the previous input. */
function optionsBeforeInput(argv: readonly string[], n: number): string[] {
  const ins = argv.flatMap((a, i) => (a === "-i" ? [i] : []));
  const end = ins[n];
  if (end === undefined) throw new Error(`no input ${n}`);
  return argv.slice(n === 0 ? 0 : (ins[n - 1] ?? 0) + 2, end);
}

describe("buildPass2 with no music: today's argv, unchanged", () => {
  test("is exactly the argv it was before the audio chain existed", () => {
    expect(build().argv).toEqual([
      "-hide_banner", "-nostdin", "-y",
      ...FILTER_THREAD_ARGS,
      "-f", "concat", "-protocol_whitelist", "file", "-i", "list.txt",
      "-filter_complex", `[0:v]${FRAME_TAGS}[v];anullsrc=r=48000:cl=stereo,apad,atrim=end_sample=384000[a]`,
      "-map", "[v]", "-map", "[a]",
      ...FINAL_VIDEO_ARGS,
      ...FINAL_AUDIO_ARGS,
      ...CONTAINER_ARGS,
      ...METADATA_ARGS,
      OUTPUT,
    ]);
  });

  test("reads no audio file and sets no audio filter", () => {
    expect(inputsOf(build().argv)).toEqual(["list.txt"]);
    expect(build().argv).not.toContain("-af");
  });
});

describe("buildPass2 with music starting at 0", () => {
  const job = build({ audio: music({ gainDb: -4.5 }) });

  test("adds the track as the input after the concat list", () => {
    expect(inputsOf(job.argv)).toEqual(["list.txt", TRACK]);
  });

  test("reads the track under the store's hardening, all before its -i", () => {
    expect(optionsBeforeInput(job.argv, 1)).toEqual([...MUSIC_INPUT_ARGS]);
    expect(optionsBeforeInput(job.argv, 1)).toEqual(["-max_alloc", "67108864", "-protocol_whitelist", "file", "-f", "mov", "-c:a", "aac"]);
  });

  test("maps the video the graph builds and the track's first audio stream explicitly, and nothing else", () => {
    expect(maps(job.argv)).toEqual(["[v]", "1:a:0"]);
  });

  test("keeps the video graph free of audio, and the audio in a filter of its own", () => {
    expect(flag(job.argv, "-filter_complex")).toBe(`[0:v]${FRAME_TAGS}[v]`);
  });

  test("builds the audio as: the segment from sample 0, the gain, then pad and trim to exactly 384 000 samples", () => {
    expect(flag(job.argv, "-af")).toBe(
      "aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=start_sample=0:end_sample=384000,asetpts=PTS-STARTPTS,volume=-4.5dB,apad,atrim=end_sample=384000",
    );
  });

  test("still reports the exact audio length in samples", () => {
    expect(job.audioSamples).toBe(384_000);
    expect(job.totalFrames).toBe(240);
  });

  test("encodes with the same video profile, audio profile, faststart and metadata rule as a silent montage", () => {
    const silent = build().argv;
    const tail = (argv: readonly string[]): string[] => argv.slice(argv.indexOf("-c:v"));
    expect(tail(job.argv)).toEqual(tail(silent));
  });

  test("writes the temp file last and ends nothing by frames, time or shortest (invariant 20)", () => {
    expect(job.argv.at(-1)).toBe(OUTPUT);
    for (const bad of ["-frames:v", "-frames", "-to", "-shortest", "-t"]) expect(job.argv).not.toContain(bad);
  });

  test("copies no metadata from the track (invariant 14)", () => {
    expect(flag(job.argv, "-map_metadata")).toBe("-1");
    expect(flag(job.argv, "-map_chapters")).toBe("-1");
  });

  test("drops the track's own stream metadata (its handler name and tags), since -map_metadata -1 only clears the global kind", () => {
    expect(flag(job.argv, "-map_metadata:s:a:0")).toBe("-1");
  });

  test("has no fade anywhere", () => {
    expect(job.argv.join(" ")).not.toMatch(/fade/);
  });
});

describe("buildPass2 with a gain of 0", () => {
  test("has no volume filter at all, so the track passes through bit for bit", () => {
    const af = flag(build({ audio: music({ gainDb: 0 }) }).argv, "-af") ?? "";
    expect(af).not.toContain("volume");
    expect(af).toBe("aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=start_sample=0:end_sample=384000,asetpts=PTS-STARTPTS,apad,atrim=end_sample=384000");
  });
});

describe("buildPass2 with music that starts late", () => {
  test("cuts the segment startMs x 48 samples into the track and takes exactly the montage's samples", () => {
    const af = flag(build({ audio: music({ startMs: 1_500, gainDb: -1.2 }) }).argv, "-af") ?? "";
    expect(af).toContain("atrim=start_sample=72000:end_sample=456000");
  });

  test("near the end of a track that is shorter than startMs plus the montage, still ends on exactly the montage's samples: the silence is padded in, never left short", () => {
    const af = flag(build({ audio: music({ startMs: 599_000 }) }).argv, "-af") ?? "";
    expect(af).toContain("atrim=start_sample=28752000:end_sample=29136000");
    expect(af.endsWith(",apad,atrim=end_sample=384000")).toBe(true);
  });

  test("trims to the exact length: the sample count scales with the timeline", () => {
    const job = build({ clips: [{ clipId: "a", durationMs: 500 }], audio: music({ startMs: 250 }) });
    expect(flag(job.argv, "-af")).toContain("atrim=start_sample=12000:end_sample=36000");
    expect(flag(job.argv, "-af")?.endsWith(",apad,atrim=end_sample=24000")).toBe(true);
    expect(job.audioSamples).toBe(24_000);
  });
});

describe("buildPass2 with music and the layer file: the audio input follows the layer file's index", () => {
  test("is input 2 after the layer file, and is the one mapped", () => {
    const job = build({ overlays: [layerFile()], audio: music() });
    expect(inputsOf(job.argv)).toEqual(["list.txt", "/work/render-tmp/job-1/layers-00.mkv", TRACK]);
    expect(maps(job.argv)).toEqual(["[v]", "2:a:0"]);
    expect(optionsBeforeInput(job.argv, 2)).toEqual([...MUSIC_INPUT_ARGS]);
  });

  test("is input 1 with no layer file", () => {
    expect(maps(build({ audio: music() }).argv)).toEqual(["[v]", "1:a:0"]);
  });

  test("leaves the layer file's own input flags alone", () => {
    const job = build({ overlays: [layerFile()], audio: music() });
    expect(optionsBeforeInput(job.argv, 1)).toEqual(["-protocol_whitelist", "file", "-f", "matroska", "-threads", "4"]);
  });

  test("overlays the layer file in both builds' graph: the music one's video graph is the silent one's", () => {
    const silent = build({ overlays: [layerFile()] }).argv;
    const withMusic = build({ overlays: [layerFile()], audio: music() }).argv;
    const graph = (argv: readonly string[]): string => argv[argv.indexOf("-filter_complex") + 1] ?? "";
    expect(graph(withMusic)).toContain(graph(silent).split(";anullsrc")[0] ?? "never");
  });
});

describe("buildPass2 refuses what the audio chain must never carry", () => {
  const codeOf = (fn: () => unknown): string | undefined => {
    try {
      fn();
    } catch (error) {
      return error instanceof RenderGraphError ? error.code : "other";
    }
    return undefined;
  };

  test("a positive gain (invariant 21: the gain is never above 0 dB)", () => {
    expect(codeOf(() => build({ audio: music({ gainDb: 0.1 }) }))).toBe("BAD_AUDIO");
  });

  test("a gain that is not a number", () => {
    expect(codeOf(() => build({ audio: music({ gainDb: Number.NaN }) }))).toBe("BAD_AUDIO");
  });

  test("a negative start", () => {
    expect(codeOf(() => build({ audio: music({ startMs: -1 }) }))).toBe("BAD_AUDIO");
  });

  test("a track path that is not absolute", () => {
    expect(codeOf(() => build({ audio: music({ path: "tracks/1.m4a" }) }))).toBe("BAD_AUDIO");
  });

  test("a track path that reads as an option", () => {
    expect(codeOf(() => build({ audio: music({ path: "-f" }) }))).toBe("BAD_AUDIO");
  });
});

describe("the music chain's graph strings", () => {
  test("pass the filter allowlist and the strict charset for every gain the rule can produce", () => {
    for (let gain = 0; gain >= -12; gain -= 0.1) {
      expect(() => assertSafeFilterGraph(musicRenderFilters(1_500, Math.round(gain * 10) / 10, 288_000))).not.toThrow();
    }
  });

  test("put no track path in a filter string (invariant 16)", () => {
    const af = flag(build({ audio: music({ gainDb: -4.5 }) }).argv, "-af") ?? "";
    expect(af).not.toContain(TRACK);
    expect(af).not.toContain("/");
  });
});
