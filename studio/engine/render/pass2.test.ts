import { describe, expect, test } from "bun:test";
import { msToFrames, totalFrames } from "../../shared/montage";
import { mulberry32, randInt } from "../../shared/montage/random.testkit";
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

const still = (over: Partial<OverlayInput> = {}): OverlayInput => ({
  path: "/work/overlays/text-1.png",
  animated: false,
  box: { x: 100, y: 300, w: 880, h: 200 },
  resize: false,
  startFrame: 30,
  endFrame: 90,
  ...over,
});

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
    expect(build({ overlays: [still()] })).toEqual(build({ overlays: [still()] }));
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

describe("buildPass2: overlays", () => {
  test("adds one looped still input per overlay, longer than the timeline by one second", () => {
    const job = build({ overlays: [still()] });
    expect(inputsOf(job.argv)).toEqual(["list.txt", "/work/overlays/text-1.png"]);
    expect(optionsBeforeInput(job.argv, 1)).toEqual(["-loop", "1", "-framerate", "30", "-t", "9"]);
  });

  test("loops an animated overlay by stream_loop and gives it the same over-long length", () => {
    const job = build({ overlays: [still({ path: "/work/overlays/sticker.apng", animated: true })] });
    expect(optionsBeforeInput(job.argv, 1)).toEqual(["-stream_loop", "-1", "-t", "9"]);
  });

  test("keeps overlay inputs in z-order after the list", () => {
    const job = build({ overlays: [still({ path: "/o/one.png" }), still({ path: "/o/two.png" }), still({ path: "/o/three.png" })] });
    expect(inputsOf(job.argv)).toEqual(["list.txt", "/o/one.png", "/o/two.png", "/o/three.png"]);
  });

  test("converts each overlay with the explicit BT.709 chain, never the auto scaler", () => {
    const graph = graphOf(build({ overlays: [still()] }).argv);
    expect(graph).toContain(`${OVERLAY_COLOUR_CHAIN}[s0]`);
    // no bare `format=yuva420p` left for the auto scaler to fill in
    expect(graph.split("format=yuva420p").length - 1).toBe(1);
    expect(graph.split("out_color_matrix=bt709").length - 1).toBe(1);
  });

  test("shifts the overlay to its start frame with settb and an integer setpts", () => {
    const graph = graphOf(build({ overlays: [still({ startFrame: 30 })] }).argv);
    expect(graph).toContain("[1:v]settb=1/30,setpts=N+30,format=rgba,");
  });

  test("resamples an animated overlay to 30 fps before shifting it, so its loop phase starts on the layer's first frame", () => {
    const graph = graphOf(build({ overlays: [still({ animated: true, startFrame: 30 })] }).argv);
    expect(graph).toContain("[1:v]fps=30,settb=1/30,setpts=N+30,format=rgba,");
  });

  test("overlays at the box's top-left, ending with the main input and visible for exactly [start, end)", () => {
    const graph = graphOf(build({ overlays: [still({ box: { x: 100, y: 300, w: 880, h: 200 }, startFrame: 30, endFrame: 90 })] }).argv);
    expect(graph).toContain("[b0][s0]overlay=x=100:y=300:eof_action=endall:format=yuv420:enable='between(n,30,89)'[v]");
  });

  test("does not scale a text PNG, which is already the size of its box", () => {
    expect(graphOf(build({ overlays: [still({ resize: false })] }).argv)).not.toContain("flags=lanczos");
  });

  test("scales a sticker to its box before the colour conversion", () => {
    const graph = graphOf(build({ overlays: [still({ resize: true, box: { x: 10, y: 20, w: 216, h: 216 } })] }).argv);
    expect(graph).toContain(`format=rgba,scale=216:216:flags=lanczos,${OVERLAY_COLOUR_CHAIN}`);
  });

  test("chains overlays in z-order, each on the result of the last, the last one labelled v", () => {
    const graph = graphOf(build({ overlays: [still({ path: "/o/one.png" }), still({ path: "/o/two.png" }), still({ path: "/o/three.png" })] }).argv);
    expect(graph).toContain("[0:v]" + FRAME_TAGS + "[b0]");
    expect(graph).toContain("[b0][s0]overlay=");
    expect(graph).toContain("[b1][s1]overlay=");
    expect(graph).toContain("[b2][s2]overlay=");
    expect(graph.indexOf("[b0][s0]")).toBeLessThan(graph.indexOf("[b1][s1]"));
    expect(graph.indexOf("[b1][s1]")).toBeLessThan(graph.indexOf("[b2][s2]"));
    expect(graph).toContain("[v];anullsrc");
  });

  test("a layer that spans the whole timeline is visible on every frame", () => {
    const graph = graphOf(build({ overlays: [still({ startFrame: 0, endFrame: 240 })] }).argv);
    expect(graph).toContain("enable='between(n,0,239)'");
  });

  test("still asks for no -t after the inputs and no -shortest with overlays present", () => {
    const argv = build({ overlays: [still(), still({ animated: true })] }).argv;
    const afterInputs = argv.slice(argv.indexOf("-filter_complex"));
    expect(afterInputs).not.toContain("-t");
    expect(afterInputs).not.toContain("-shortest");
    expect(afterInputs).not.toContain("-frames:v");
  });

  test.each([
    ["ends before it starts", { startFrame: 60, endFrame: 60 }],
    ["starts below zero", { startFrame: -3, endFrame: 30 }],
    ["ends past the timeline", { startFrame: 30, endFrame: 241 }],
    ["has a fractional frame", { startFrame: 1.5, endFrame: 30 }],
    ["has a box with an odd x", { box: { x: 101, y: 300, w: 880, h: 200 } }],
    ["has a box that leaves the frame", { box: { x: 400, y: 300, w: 880, h: 200 } }],
    ["has an empty box", { box: { x: 100, y: 300, w: 0, h: 200 } }],
  ] as const)("refuses an overlay that %s", (_name, over) => {
    expect(() => build({ overlays: [still(over)] })).toThrow(expect.objectContaining({ code: "BAD_OVERLAY" }));
  });

  test("refuses a relative overlay path", () => {
    expect(() => build({ overlays: [still({ path: "overlays/a.png" })] })).toThrow(expect.objectContaining({ code: "PATH_NOT_ABSOLUTE" }));
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

  test("refuses a duration that is not a whole number of frames, rather than rounding it", () => {
    expect(() => build({ clips: [{ clipId: "a", durationMs: 2050 }] })).toThrow(RangeError);
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

  test("keeps every path out of the graph and the graph inside the strict charset, for 200 random timelines", () => {
    const rand = mulberry32(99);
    for (let i = 0; i < 200; i++) {
      const spec = randomSpec(rand);
      const total = totalFrames(spec.clips);
      const overlays: OverlayInput[] = Array.from({ length: randInt(rand, 0, 6) }, (_, k) => {
        const start = randInt(rand, 0, total - 3);
        const end = randInt(rand, start + 1, total);
        return {
          path: `${NASTY[k % NASTY.length]}.${k}.png`,
          animated: rand() < 0.5,
          box: { x: 2 * randInt(rand, 0, 200), y: 2 * randInt(rand, 0, 400), w: 2 * randInt(rand, 1, 200), h: 2 * randInt(rand, 1, 200) },
          resize: rand() < 0.5,
          startFrame: start,
          endFrame: end,
        };
      });
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
