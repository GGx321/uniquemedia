import { describe, expect, test } from "bun:test";
import { MIN_CLIP_MS, msToFrames, totalFrames } from "../../shared/montage";
import { mulberry32 } from "../../shared/montage/random.testkit";
import { randomSpec } from "../../shared/montage/specGen.testkit";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { assertSafeFilterGraph } from "./filterString";
import { buildPass2 } from "./pass2";
import { COLOUR_TAG_ARGS, CONTAINER_ARGS, FILTER_THREAD_ARGS, FINAL_AUDIO_ARGS, FINAL_VIDEO_ARGS, FRAME_TAGS, METADATA_ARGS, OVERLAY_COLOUR_CHAIN } from "./profile";
import { RenderGraphError, type OverlayInput, type Pass2Input } from "./types";
useNativeGlobals();

const CLIP_DIR = "/work/render-tmp/job-1";
const OUTPUT = "/export/Alice/.studio-part-job-1.mp4";

const CLIPS = [
  { clipId: "a", durationMs: 2000 },
  { clipId: "b", durationMs: 3100 },
  { clipId: "c", durationMs: 2900 },
]; // 8 s = 240 frames

function build(over: Partial<Pass2Input> = {}) {
  return buildPass2({ clips: CLIPS, clipDir: CLIP_DIR, output: OUTPUT, overlays: [], audio: { kind: "silent" }, ...over });
}

function graphOf(argv: readonly string[]): string {
  const i = argv.indexOf("-filter_complex");
  const graph = argv[i + 1];
  if (i < 0 || graph === undefined) throw new Error("no -filter_complex in argv");
  return graph;
}

const inputsOf = (argv: readonly string[]): string[] => argv.flatMap((a, i) => (a === "-i" ? [argv[i + 1] ?? ""] : []));

/** The flags between the previous input (or the start) and input number `n`'s `-i`. */
function optionsBeforeInput(argv: readonly string[], n: number): string[] {
  const ins = argv.flatMap((a, i) => (a === "-i" ? [i] : []));
  const end = ins[n];
  if (end === undefined) throw new Error(`no input ${n}`);
  const start = n === 0 ? 0 : (ins[n - 1] ?? 0) + 2;
  return argv.slice(start, end);
}

describe("buildPass2: the job", () => {
  test("runs in the job folder, with a list file named list.txt", () => {
    const job = build();
    expect(job.cwd).toBe(CLIP_DIR);
    expect(job.listFileName).toBe("list.txt");
  });

  test("lists the intermediates by their fixed relative names, one per clip, in order", () => {
    expect(build().listFileContents).toBe("file 'clip-00.mkv'\nfile 'clip-01.mkv'\nfile 'clip-02.mkv'\n");
  });

  test("reports the exact video length in frames: 3 per 100 ms", () => {
    expect(build().totalFrames).toBe(240);
    expect(build().totalFrames).toBe(totalFrames(CLIPS));
  });

  test("reports the exact audio length in samples: 48 per millisecond", () => {
    expect(build().audioSamples).toBe(8000 * 48);
  });

  test("returns the injected temp path as its output", () => {
    expect(build().output).toBe(OUTPUT);
  });

  test("is pure: the same input gives the same job", () => {
    expect(build()).toEqual(build());
  });
});

describe("buildPass2: argv", () => {
  const job = build();

  test("starts quiet and non-interactive and caps the filter threads", () => {
    expect(job.argv.slice(0, 3)).toEqual(["-hide_banner", "-nostdin", "-y"]);
    const at = job.argv.indexOf("-filter_threads");
    expect(job.argv.slice(at, at + 4)).toEqual([...FILTER_THREAD_ARGS]);
  });

  test("reads the list with the concat demuxer, allowing only the file protocol, set before the input", () => {
    const i = job.argv.indexOf("-i");
    expect(job.argv.slice(i - 4, i + 2)).toEqual(["-f", "concat", "-protocol_whitelist", "file", "-i", "list.txt"]);
  });

  test("reads only the list when there are no overlays", () => {
    expect(inputsOf(job.argv)).toEqual(["list.txt"]);
  });

  test("maps the video and the audio the graph builds", () => {
    const maps = job.argv.flatMap((a, i) => (a === "-map" ? [job.argv[i + 1]] : []));
    expect(maps).toEqual(["[v]", "[a]"]);
  });

  test("encodes with the final profile, tags, audio, faststart and the metadata rule", () => {
    const slice = (args: readonly string[]): string[] => {
      const at = job.argv.indexOf(args[0] ?? "");
      return job.argv.slice(at, at + args.length);
    };
    expect(slice(FINAL_VIDEO_ARGS)).toEqual([...FINAL_VIDEO_ARGS]);
    expect(slice(FINAL_AUDIO_ARGS)).toEqual([...FINAL_AUDIO_ARGS]);
    expect(slice(CONTAINER_ARGS)).toEqual([...CONTAINER_ARGS]);
    expect(slice(METADATA_ARGS)).toEqual([...METADATA_ARGS]);
    expect(slice(COLOUR_TAG_ARGS)).toEqual([...COLOUR_TAG_ARGS]);
  });

  test("writes the temp file on the export volume last", () => {
    expect(job.argv.at(-1)).toBe(OUTPUT);
  });

  test("never ends the output by frames, time or shortest (invariant 20)", () => {
    for (const bad of ["-frames:v", "-frames", "-to", "-shortest"]) expect(job.argv).not.toContain(bad);
    expect(job.argv).not.toContain("-t");
  });

  test("never asks for bitexact or a creation time", () => {
    expect(job.argv.join(" ")).not.toContain("bitexact");
    expect(job.argv.join(" ")).not.toContain("creation_time");
  });
});

describe("buildPass2: the silent audio (invariant 20)", () => {
  test("is a stereo 48 kHz source padded and trimmed to the exact sample count", () => {
    expect(graphOf(build().argv)).toContain("anullsrc=r=48000:cl=stereo,apad,atrim=end_sample=384000[a]");
  });

  test("scales the sample count with the timeline", () => {
    const job = build({ clips: [{ clipId: "a", durationMs: 500 }] });
    expect(graphOf(job.argv)).toContain("atrim=end_sample=24000[a]");
    expect(job.audioSamples).toBe(24000);
  });

  test("tags the video as BT.709 limited range inside the graph", () => {
    expect(graphOf(build().argv)).toContain(`[0:v]${FRAME_TAGS}[v]`);
  });
});

describe("buildPass2: only the layer pass's file may be overlaid", () => {
  // Pass 2's memory grows by a constant per overlay input (ten default stickers: 816 MiB against the 768 MiB budget, measured), so the
  // layers are composited before it and it takes one stream. A text PNG, an APNG or a GIF handed to it directly is a bug, never a feature.
  test.each(["png", "apng", "gif"] as const)("refuses a %s overlay", (format) => {
    expect(() => build({ overlays: [{ path: "/work/overlays/a.x", format, box: { x: 100, y: 300, w: 880, h: 200 }, resize: false, startFrame: 30, endFrame: 90 }] })).toThrow(expect.objectContaining({ code: "BAD_OVERLAY" }));
  });

  test("refuses the layer file together with a direct overlay", () => {
    const file: OverlayInput = { path: `${CLIP_DIR}/layers-00.mkv`, format: "layers", box: { x: 0, y: 0, w: 1080, h: 1920 }, resize: false, startFrame: 0, endFrame: 240 };
    const png: OverlayInput = { ...file, path: "/o/a.png", format: "png" };
    expect(() => build({ overlays: [file, png] })).toThrow(expect.objectContaining({ code: "BAD_OVERLAY" }));
  });

  test("the refusal names no path (the message reaches the UI)", () => {
    expect(() => build({ overlays: [{ path: "/Users/Mia Secret/a.png", format: "png", box: { x: 0, y: 0, w: 10, h: 10 }, resize: false, startFrame: 0, endFrame: 3 }] })).toThrow(expect.objectContaining({ message: expect.not.stringContaining("Mia Secret") }));
  });
});

describe("buildPass2: with no layers the graph is exactly what it was before 3b.6", () => {
  test("tags the main input and builds the silence, and nothing else", () => {
    expect(graphOf(build().argv)).toBe(`[0:v]${FRAME_TAGS}[v];anullsrc=r=48000:cl=stereo,apad,atrim=end_sample=384000[a]`);
  });
});

describe("buildPass2: the layer pass's file (3b.6)", () => {
  const layers = (over: Partial<OverlayInput> = {}): OverlayInput => ({
    path: `${CLIP_DIR}/layers-00.mkv`,
    format: "layers",
    box: { x: 0, y: 0, w: 1080, h: 1920 },
    resize: false,
    startFrame: 0,
    endFrame: 240,
    ...over,
  });

  test("is one more input, read by the matroska demuxer with only the file protocol", () => {
    const job = build({ overlays: [layers()] });
    expect(inputsOf(job.argv)).toEqual(["list.txt", `${CLIP_DIR}/layers-00.mkv`]);
    expect(optionsBeforeInput(job.argv, 1).slice(0, 4)).toEqual(["-protocol_whitelist", "file", "-f", "matroska"]);
  });

  test("is decoded on 4 threads: measured at the largest layer set, the decoder's default (one thread per core) cost pass 2 about 100 MiB more, and 1 or 2 threads made it twice as slow", () => {
    expect(optionsBeforeInput(build({ overlays: [layers()] }).argv, 1).slice(-2)).toEqual(["-threads", "4"]);
  });

  test("is overlaid whole at the frame's origin and lets the main input carry the output's length, in the graph below", () => {
    // The file is FINITE (exactly the timeline's frames). With `endall`, the end of that finite stream ends the output one
    // frame early (measured: 89 of 90), so the main input decides the length and the layers just run out with it.
    expect(graphOf(build({ overlays: [layers()] }).argv)).toBe(
      [
        `[0:v]${FRAME_TAGS}[b0]`,
        "[1:v]settb=1/30,setpts=N[s0]",
        "[b0][s0]overlay=x=0:y=0:eof_action=pass:format=yuv420[v]",
        "anullsrc=r=48000:cl=stereo,apad,atrim=end_sample=384000[a]",
      ].join(";"),
    );
  });

  test("is not converted, looped or cut again: it is already BT.709 yuva420p with exactly the timeline's frames", () => {
    const graph = graphOf(build({ overlays: [layers()] }).argv);
    expect(graph).not.toContain(OVERLAY_COLOUR_CHAIN);
    expect(graph).not.toContain("loop=");
    expect(graph).not.toContain("trim=end_frame");
    expect(graph).not.toContain("fps=");
  });

  test.each([
    ["a box that is not the whole frame", { box: { x: 0, y: 0, w: 1080, h: 1918 } }],
    ["a start after frame 0", { startFrame: 3 }],
    ["an end before the timeline's", { endFrame: 239 }],
    ["a resize", { resize: true }],
  ] as const)("refuses a layers stream with %s", (_name, over) => {
    expect(() => build({ overlays: [layers(over)] })).toThrow(expect.objectContaining({ code: "BAD_OVERLAY" }));
  });
});

describe("buildPass2: refusals", () => {
  test("refuses an empty clip list", () => {
    expect(() => build({ clips: [] })).toThrow(expect.objectContaining({ code: "NO_CLIPS" }));
  });

  test("refuses a relative output path", () => {
    expect(() => build({ output: "out.mp4" })).toThrow(expect.objectContaining({ code: "PATH_NOT_ABSOLUTE" }));
  });

  test("refuses a relative job folder, which would make the list depend on the process cwd", () => {
    expect(() => build({ clipDir: "render-tmp/job-1" })).toThrow(expect.objectContaining({ code: "PATH_NOT_ABSOLUTE" }));
  });

  test("refuses a duration that is not a whole number of frames as BAD_DURATION, rather than rounding it or leaking a RangeError", () => {
    expect(() => build({ clips: [{ clipId: "a", durationMs: 2050 }] })).toThrow(expect.objectContaining({ code: "BAD_DURATION" }));
  });

  test.each([0, 100, MIN_CLIP_MS - 100])("refuses a clip of %d ms, below the 500 ms minimum", (ms) => {
    expect(() => build({ clips: [{ clipId: "a", durationMs: ms }] })).toThrow(expect.objectContaining({ code: "BAD_DURATION" }));
  });

  test("accepts a clip of exactly the minimum, 500 ms", () => {
    expect(build({ clips: [{ clipId: "a", durationMs: MIN_CLIP_MS }] }).totalFrames).toBe(15);
  });

  test("names the code of a refusal", () => {
    try {
      build({ clips: [] });
      throw new Error("expected a throw");
    } catch (e) {
      expect(e).toBeInstanceOf(RenderGraphError);
    }
  });
});

describe("buildPass2: invariant 16, no text or path in -filter_complex", () => {
  const NASTY = ["/tmp/we ird/na'me;rm -rf", "/tmp/[x]:y,z=1\\", "/tmp/$(id)`id`", "/tmp/%{localtime}", "/tmp/фото é"];

  test("keeps every path out of the graph and the graph inside the strict charset, for 100 random timelines", () => {
    const rand = mulberry32(99);
    for (let i = 0; i < 100; i++) {
      const spec = randomSpec(rand);
      const total = totalFrames(spec.clips);
      const overlays: OverlayInput[] = rand() < 0.5 ? [] : [{ path: `${NASTY[i % NASTY.length]}.mkv`, format: "layers", box: { x: 0, y: 0, w: 1080, h: 1920 }, resize: false, startFrame: 0, endFrame: total }];
      const job = buildPass2({ clips: spec.clips, clipDir: CLIP_DIR, output: OUTPUT, overlays, audio: { kind: "silent" } });
      const graph = graphOf(job.argv);
      assertSafeFilterGraph(graph);
      for (const o of overlays) expect(graph).not.toContain(o.path);
      expect(graph).not.toContain(CLIP_DIR);
      expect(graph).not.toContain(OUTPUT);
      expect(job.totalFrames).toBe(spec.clips.reduce((n, c) => n + msToFrames(c.durationMs), 0));
    }
  });
});
