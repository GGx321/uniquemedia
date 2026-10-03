import { describe, expect, test } from "bun:test";
import { MAX_LAYERS, MAX_STICKER_LAYERS, MAX_TEXT_LAYERS } from "../../shared/engine/montage";
import { FRAME_H, FRAME_W } from "../../shared/montage";
import { mulberry32, randInt } from "../../shared/montage/random.testkit";
import { join } from "node:path";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { assertSafeFilterGraph } from "./filterString";
import {
  LAYER_ANIMATED_BYTES,
  LAYER_CALL_BASE_BYTES,
  LAYER_CALL_BUDGET_BYTES,
  LAYER_CHAINED_INPUT_BYTES,
  LAYER_FILE_BYTES_PER_FRAME,
  LAYER_STILL_BYTES,
  buildLayerPass,
  layerCost,
  planLayerBatches,
} from "./layerPass";
import { ANIMATED_LOOP_MAX_FRAMES } from "./pass2";
import { FILTER_THREAD_ARGS, LAYER_VIDEO_ARGS, METADATA_ARGS, OVERLAY_COLOUR_CHAIN } from "./profile";
import type { OverlayInput } from "./types";
useNativeGlobals();

const CLIP_DIR = "/work/render-tmp/job-1";
const TOTAL = 90; // 3 s
const pad = (k: number): string => String(k).padStart(2, "0");

const text = (k: number, over: Partial<OverlayInput> = {}): OverlayInput => ({
  path: `${CLIP_DIR}/text-${pad(k)}.png`,
  format: "png",
  box: { x: 100, y: 300, w: 880, h: 200 },
  resize: false,
  startFrame: 30,
  endFrame: 60,
  ...over,
});

const sticker = (k: number, over: Partial<OverlayInput> = {}): OverlayInput => ({
  path: `${CLIP_DIR}/sticker-${pad(k)}.apng`,
  format: "apng",
  box: { x: 600, y: 200, w: 216, h: 216 },
  resize: true,
  startFrame: 0,
  endFrame: TOTAL,
  loopFrames: 24,
  sourceSize: { w: 320, h: 320 },
  ...over,
});

const plan = (layers: readonly OverlayInput[], totalFrames = TOTAL) => buildLayerPass({ layers, totalFrames, clipDir: CLIP_DIR });

function graphOf(argv: readonly string[]): string {
  const i = argv.indexOf("-filter_complex");
  const graph = argv[i + 1];
  if (i < 0 || graph === undefined) throw new Error("no -filter_complex in argv");
  return graph;
}

/** The graph of the plan's only call. */
function onlyGraph(layers: readonly OverlayInput[], totalFrames = TOTAL): string {
  const { jobs } = plan(layers, totalFrames);
  expect(jobs).toHaveLength(1);
  return graphOf(jobs[0]?.argv ?? []);
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

const STILL_CHAIN = `format=rgba,scale=in_range=full:out_range=tv:out_color_matrix=bt709,format=yuva420p`;
const BASE = `color=c=0x00000000:s=1080x1920:r=30,format=yuva420p,trim=end_frame=${TOTAL},settb=1/30,setpts=N[b0]`;

describe("buildLayerPass: no layers", () => {
  test("plans no call and nothing for pass 2 to overlay", () => {
    expect(plan([])).toEqual({ jobs: [], final: null, peakDiskBytes: 0 });
  });
});

describe("buildLayerPass: the disk its files can take at their peak", () => {
  // Measured with real «Без фона» captions (emoji, scale 1.6, the whole timeline) and ten 648 px stickers, a 15 s file is 300 MiB (0.66 MiB per
  // frame); a call deletes nothing, but the runner removes `layers-(n-1)` once call n has written its own, so at most TWO files exist at once.
  test("one call writes one file: the frames times the per-frame bound", () => {
    expect(plan([text(0)]).peakDiskBytes).toBe(TOTAL * LAYER_FILE_BYTES_PER_FRAME);
  });

  test("several calls hold two files at once, never more: the earlier one goes when the next has been written", () => {
    const heavy = [0, 1, 2, 3].map((k) => sticker(k, { loopFrames: 300, sourceSize: { w: 360, h: 360 }, box: { x: 10 * k, y: 100, w: 648, h: 648 } }));
    const { jobs, peakDiskBytes } = plan(heavy);
    expect(jobs.length).toBeGreaterThan(2);
    expect(peakDiskBytes).toBe(2 * TOTAL * LAYER_FILE_BYTES_PER_FRAME);
  });

  test("the per-frame bound is above the measured 0.66 MiB, so a render that needs it still fits", () => {
    expect(LAYER_FILE_BYTES_PER_FRAME).toBeGreaterThanOrEqual(0.7 * 1024 * 1024);
  });

  test("scales with the timeline", () => {
    expect(plan([text(0, { startFrame: 0, endFrame: 30 })], 30).peakDiskBytes).toBe(30 * LAYER_FILE_BYTES_PER_FRAME);
  });
});

describe("buildLayerPass: one text layer", () => {
  const { jobs, final } = plan([text(0)]);
  const job = jobs[0];

  test("is a single call", () => {
    expect(jobs).toHaveLength(1);
    expect(job?.index).toBe(0);
    expect(job?.layerCount).toBe(1);
    expect(job?.frames).toBe(TOTAL);
  });

  test("composites the PNG onto a transparent full-frame base, in the graph below, and nothing else", () => {
    expect(graphOf(job?.argv ?? [])).toBe(
      [
        BASE,
        `[0:v]${STILL_CHAIN},loop=loop=-1:size=1,trim=end_frame=30,settb=1/30,setpts=N+30[s0]`,
        "[b0][s0]overlay=x=100:y=300:eof_action=pass:format=yuv420[v]",
      ].join(";"),
    );
  });

  test("is the whole argv: quiet, -xerror, capped filter threads, the PNG by the still demuxer with only the file protocol, one lossless output", () => {
    expect(job?.argv).toEqual([
      "-hide_banner", "-nostdin", "-y", "-xerror",
      ...FILTER_THREAD_ARGS,
      "-protocol_whitelist", "file", "-f", "image2", "-pattern_type", "none", "-threads", "1", "-i", `${CLIP_DIR}/text-00.png`,
      "-filter_complex", graphOf(job?.argv ?? []),
      "-map", "[v]",
      ...LAYER_VIDEO_ARGS,
      ...METADATA_ARGS,
      join(CLIP_DIR, "layers-00.mkv"),
    ]);
  });

  test("names its file layers-00.mkv in the job folder, and hands that file to pass 2 as a full-frame stream over the whole timeline", () => {
    expect(job?.fileName).toBe("layers-00.mkv");
    expect(job?.output).toBe(join(CLIP_DIR, "layers-00.mkv"));
    expect(final).toEqual({ path: join(CLIP_DIR, "layers-00.mkv"), format: "layers", box: { x: 0, y: 0, w: FRAME_W, h: FRAME_H }, resize: false, startFrame: 0, endFrame: TOTAL });
  });
});

describe("buildLayerPass: one sticker", () => {
  test("reads the APNG once with the apng demuxer", () => {
    const job = plan([sticker(0)]).jobs[0];
    expect(optionsBeforeInput(job?.argv ?? [], 0)).toEqual(["-hide_banner", "-nostdin", "-y", "-xerror", ...FILTER_THREAD_ARGS, "-protocol_whitelist", "file", "-f", "apng", "-threads", "1"]);
  });

  test("converts the colour once, loops the converted frames at the STORED period, and only then scales them to the box", () => {
    expect(onlyGraph([sticker(0)])).toBe(
      [
        BASE,
        `[0:v]fps=30,${OVERLAY_COLOUR_CHAIN},loop=loop=-1:size=24,scale=216:216:flags=lanczos,settb=1/30,setpts=N+0[s0]`,
        "[b0][s0]overlay=x=600:y=200:eof_action=endall:format=yuv420[v]",
      ].join(";"),
    );
  });

  test("a GIF is read with the gif demuxer", () => {
    const job = plan([sticker(0, { format: "gif", path: `${CLIP_DIR}/sticker-00.gif` })]).jobs[0];
    expect(optionsBeforeInput(job?.argv ?? [], 0).slice(-4)).toEqual(["-f", "gif", "-threads", "1"]);
  });

  test("a still scaled to its box is scaled once, before the colour conversion and the loop", () => {
    const graph = onlyGraph([text(0, { resize: true, box: { x: 10, y: 20, w: 216, h: 216 } })]);
    expect(graph).toContain(`[0:v]format=rgba,scale=216:216:flags=lanczos,${OVERLAY_COLOUR_CHAIN},loop=loop=-1:size=1,`);
  });
});

describe("buildLayerPass: the loop period is the stored one, never the file's", () => {
  test.each([1, 24, 48, ANIMATED_LOOP_MAX_FRAMES])("uses a cache of exactly %d frames", (loopFrames) => {
    const graph = onlyGraph([sticker(0, { loopFrames })]);
    expect(graph).toContain(`loop=loop=-1:size=${loopFrames},`);
    expect(graph).not.toContain(`size=${ANIMATED_LOOP_MAX_FRAMES + 1}`);
  });

  test("a loop shorter than its window repeats inside the window: the window is cut AFTER the loop", () => {
    const graph = onlyGraph([sticker(0, { loopFrames: 24, startFrame: 30, endFrame: 90 })]);
    expect(graph).toContain("loop=loop=-1:size=24,scale=216:216:flags=lanczos,trim=end_frame=60,settb=1/30,setpts=N+30[s0]");
  });

  test("a loop longer than its window is cut short, and still loops at its own period", () => {
    const graph = onlyGraph([sticker(0, { loopFrames: 48, startFrame: 30, endFrame: 45 })]);
    expect(graph).toContain("loop=loop=-1:size=48,scale=216:216:flags=lanczos,trim=end_frame=15,settb=1/30,setpts=N+30[s0]");
  });

  test.each([
    ["no stored period", { loopFrames: undefined }],
    ["a zero period", { loopFrames: 0 }],
    ["a fractional period", { loopFrames: 24.5 }],
    ["a period past the cache (300)", { loopFrames: ANIMATED_LOOP_MAX_FRAMES + 1 }],
    ["a negative period", { loopFrames: -24 }],
  ] as const)("refuses an animation with %s", (_name, over) => {
    expect(() => plan([{ ...sticker(0), ...over }])).toThrow(expect.objectContaining({ code: "BAD_OVERLAY" }));
  });

  test("refuses an animation with no source size, which the memory model cannot price", () => {
    expect(() => plan([{ ...sticker(0), sourceSize: undefined }])).toThrow(expect.objectContaining({ code: "BAD_OVERLAY" }));
  });
});

describe("buildLayerPass: z-order", () => {
  const layers = [text(0), sticker(1), text(2, { box: { x: 100, y: 1500, w: 880, h: 200 }, startFrame: 60, endFrame: TOTAL })];

  test("lists the inputs in z-order", () => {
    expect(inputsOf(plan(layers).jobs[0]?.argv ?? [])).toEqual([`${CLIP_DIR}/text-00.png`, `${CLIP_DIR}/sticker-01.apng`, `${CLIP_DIR}/text-02.png`]);
  });

  test("overlays each layer on the result of the one below it, the last labelled v", () => {
    expect(onlyGraph(layers)).toBe(
      [
        BASE,
        `[0:v]${STILL_CHAIN},loop=loop=-1:size=1,trim=end_frame=30,settb=1/30,setpts=N+30[s0]`,
        "[b0][s0]overlay=x=100:y=300:eof_action=pass:format=yuv420[b1]",
        `[1:v]fps=30,${OVERLAY_COLOUR_CHAIN},loop=loop=-1:size=24,scale=216:216:flags=lanczos,settb=1/30,setpts=N+0[s1]`,
        "[b1][s1]overlay=x=600:y=200:eof_action=endall:format=yuv420[b2]",
        `[2:v]${STILL_CHAIN},loop=loop=-1:size=1,trim=end_frame=30,settb=1/30,setpts=N+60[s2]`,
        "[b2][s2]overlay=x=100:y=1500:eof_action=pass:format=yuv420[v]",
      ].join(";"),
    );
  });
});

describe("buildLayerPass: time ranges", () => {
  test("a window inside the timeline is cut to its length, shifted to its start, and lets the output go on", () => {
    const graph = onlyGraph([text(0, { startFrame: 30, endFrame: 60 })]);
    expect(graph).toContain("trim=end_frame=30,settb=1/30,setpts=N+30[s0]");
    expect(graph).toContain("eof_action=pass");
  });

  test("a window that starts at frame 0 but ends early is cut and lets the output go on", () => {
    const graph = onlyGraph([text(0, { startFrame: 0, endFrame: 30 })]);
    expect(graph).toContain("trim=end_frame=30,settb=1/30,setpts=N+0[s0]");
    expect(graph).toContain("eof_action=pass");
  });

  test("a window that starts late and runs to the last frame is cut and lets the output go on, it never ends it", () => {
    const graph = onlyGraph([text(0, { startFrame: 60, endFrame: TOTAL })]);
    expect(graph).toContain("trim=end_frame=30,settb=1/30,setpts=N+60[s0]");
    expect(graph).toContain("eof_action=pass");
  });

  test("a layer that touches frame 0 and the last frame is not cut and ends the output with the base", () => {
    const graph = onlyGraph([text(0, { startFrame: 0, endFrame: TOTAL })]);
    expect(graph).toContain("loop=loop=-1:size=1,settb=1/30,setpts=N+0[s0]");
    expect(graph).toContain("eof_action=endall");
    expect(graph.match(/trim=/g)).toHaveLength(1); // only the base's
  });

  test("a window of one frame is accepted", () => {
    expect(onlyGraph([text(0, { startFrame: 10, endFrame: 11 })])).toContain("trim=end_frame=1,settb=1/30,setpts=N+10[s0]");
  });

  test("never uses a timeline enable, which was measured to drop a frame", () => {
    for (const [startFrame, endFrame] of [[30, 60], [0, TOTAL], [60, TOTAL], [0, 30]] as const) {
      expect(onlyGraph([text(0, { startFrame, endFrame })])).not.toContain("enable");
    }
  });

  test("cuts every window to exactly end - start frames, for 300 random windows", () => {
    const rand = mulberry32(11);
    for (let i = 0; i < 300; i++) {
      const total = 3 * randInt(rand, 5, 150);
      const start = randInt(rand, 0, total - 1);
      const end = randInt(rand, start + 1, total);
      const spans = start === 0 && end === total;
      const graph = onlyGraph([text(0, { startFrame: start, endFrame: end, box: { x: 0, y: 0, w: 10, h: 10 } })], total);
      expect(graph).toContain(`color=c=0x00000000:s=1080x1920:r=30,format=yuva420p,trim=end_frame=${total},`);
      if (spans) expect(graph).toContain(`loop=loop=-1:size=1,settb=1/30,setpts=N+0[s0]`);
      else expect(graph).toContain(`trim=end_frame=${end - start},settb=1/30,setpts=N+${start}[s0]`);
    }
  });
});

describe("buildLayerPass: refusals at the boundaries", () => {
  test.each([
    ["has a zero-length window", { startFrame: 30, endFrame: 30 }],
    ["ends before it starts", { startFrame: 60, endFrame: 30 }],
    ["starts below zero", { startFrame: -3, endFrame: 30 }],
    ["extends one frame past the montage end, which is refused and never clamped", { startFrame: 30, endFrame: TOTAL + 1 }],
    ["extends far past the montage end", { startFrame: 30, endFrame: TOTAL * 2 }],
    ["has a fractional frame", { startFrame: 1.5, endFrame: 30 }],
    ["has a box with an odd x", { box: { x: 101, y: 300, w: 880, h: 200 } }],
    ["has a box with an odd y", { box: { x: 100, y: 301, w: 880, h: 200 } }],
    ["has a box with a negative offset", { box: { x: -2, y: 300, w: 880, h: 200 } }],
    ["has an empty box", { box: { x: 100, y: 300, w: 0, h: 200 } }],
    ["has a box one pixel past the right edge", { box: { x: 202, y: 300, w: 880, h: 200 } }],
    ["has a box one pixel past the bottom edge", { box: { x: 100, y: 1722, w: 880, h: 200 } }],
  ] as const)("refuses a layer that %s", (_name, over) => {
    expect(() => plan([text(0, over)])).toThrow(expect.objectContaining({ code: "BAD_OVERLAY" }));
  });

  test("the refusal for a layer past the end names the bound it broke and no path", () => {
    expect(() => plan([text(0, { path: "/Users/Mia Secret/text.png", endFrame: TOTAL + 3 })])).toThrow(
      expect.objectContaining({ message: expect.stringContaining(`<= ${TOTAL}`) }),
    );
    expect(() => plan([text(0, { path: "/Users/Mia Secret/text.png", endFrame: TOTAL + 3 })])).toThrow(expect.objectContaining({ message: expect.not.stringContaining("Mia Secret") }));
  });

  test("refuses a relative layer path", () => {
    expect(() => plan([text(0, { path: "text-00.png" })])).toThrow(expect.objectContaining({ code: "PATH_NOT_ABSOLUTE" }));
  });

  test("refuses a relative job folder", () => {
    expect(() => buildLayerPass({ layers: [text(0)], totalFrames: TOTAL, clipDir: "render-tmp/job-1" })).toThrow(expect.objectContaining({ code: "PATH_NOT_ABSOLUTE" }));
  });

  test.each([0, -3, 1.5, Number.NaN])("refuses a timeline of %d frames", (totalFrames) => {
    expect(() => plan([text(0, { startFrame: 0, endFrame: 1 })], totalFrames)).toThrow(expect.objectContaining({ code: "BAD_DURATION" }));
  });

  test("refuses a layer that is already the layer pass's own output", () => {
    expect(() => plan([{ ...text(0), format: "layers" }])).toThrow(expect.objectContaining({ code: "BAD_OVERLAY" }));
  });
});

describe("buildLayerPass: boxes at the frame edges", () => {
  test("accepts a box that fills the frame", () => {
    expect(onlyGraph([text(0, { box: { x: 0, y: 0, w: FRAME_W, h: FRAME_H }, startFrame: 0, endFrame: TOTAL })])).toContain("overlay=x=0:y=0:eof_action=endall");
  });

  test("accepts a box in the bottom-right corner, touching both edges", () => {
    expect(onlyGraph([text(0, { box: { x: FRAME_W - 200, y: FRAME_H - 100, w: 200, h: 100 } })])).toContain(`overlay=x=${FRAME_W - 200}:y=${FRAME_H - 100}:`);
  });

  test("accepts an odd-sized box at an even offset, as a text raster may be", () => {
    expect(onlyGraph([text(0, { box: { x: 100, y: 300, w: 881, h: 201 } })])).toContain("overlay=x=100:y=300:");
  });
});

describe("buildLayerPass: the layer cap", () => {
  const manyText = (n: number): OverlayInput[] => Array.from({ length: n }, (_, k) => text(k, { box: { x: 0, y: 4 * k, w: 100, h: 4 } }));
  const manyStickers = (n: number, from: number): OverlayInput[] => Array.from({ length: n }, (_, k) => sticker(from + k, { box: { x: 2 * k, y: 1000, w: 100, h: 100 } }));

  test("accepts the contract's maximum, 10 text and 10 stickers", () => {
    expect(MAX_LAYERS).toBe(MAX_TEXT_LAYERS + MAX_STICKER_LAYERS);
    const { jobs } = plan([...manyText(MAX_TEXT_LAYERS), ...manyStickers(MAX_STICKER_LAYERS, MAX_TEXT_LAYERS)]);
    expect(jobs.reduce((n, j) => n + j.layerCount, 0)).toBe(MAX_LAYERS);
  });

  test("refuses one layer past the contract's maximum", () => {
    expect(() => plan([...manyText(MAX_TEXT_LAYERS), ...manyStickers(MAX_STICKER_LAYERS + 1, MAX_TEXT_LAYERS)])).toThrow(expect.objectContaining({ code: "BAD_OVERLAY" }));
  });
});

describe("planLayerBatches: splitting the layers into calls that fit the memory budget", () => {
  const FIRST = LAYER_CALL_BUDGET_BYTES - LAYER_CALL_BASE_BYTES;
  const CHAINED = LAYER_CALL_BUDGET_BYTES - LAYER_CALL_BASE_BYTES - LAYER_CHAINED_INPUT_BYTES;

  test("no layers need no call", () => {
    expect(planLayerBatches([])).toEqual([]);
  });

  test("layers that fit together are one call", () => {
    expect(planLayerBatches([FIRST / 4, FIRST / 4, FIRST / 4])).toEqual([[0, 1, 2]]);
  });

  test("layers that exactly fill the first call still fit it", () => {
    expect(planLayerBatches([FIRST / 2, FIRST / 2])).toEqual([[0, 1]]);
  });

  test("a layer one byte over the first call's room starts the next call, in order", () => {
    expect(planLayerBatches([FIRST / 2, FIRST / 2 + 1])).toEqual([[0], [1]]);
  });

  test("the second call has less room than the first: it also reads the first call's file", () => {
    expect(CHAINED).toBeLessThan(FIRST);
    expect(planLayerBatches([FIRST, CHAINED, CHAINED])).toEqual([[0], [1], [2]]);
    expect(planLayerBatches([FIRST, CHAINED / 2, CHAINED / 2])).toEqual([[0], [1, 2]]);
  });

  test("keeps the z-order: every call holds a run of consecutive layers and together they hold each layer once", () => {
    const rand = mulberry32(3);
    for (let i = 0; i < 200; i++) {
      const costs = Array.from({ length: randInt(rand, 0, 20) }, () => randInt(rand, 1, Math.floor(CHAINED)));
      const batches = planLayerBatches(costs);
      expect(batches.flat()).toEqual(costs.map((_, k) => k));
      batches.forEach((batch, b) => {
        const room = b === 0 ? FIRST : CHAINED;
        expect(batch.reduce((n, k) => n + (costs[k] ?? 0), 0)).toBeLessThanOrEqual(room);
      });
    }
  });

  test("refuses a layer that cannot fit even the first call, which has the most room", () => {
    expect(planLayerBatches([FIRST])).toEqual([[0]]);
    expect(() => planLayerBatches([FIRST + 1])).toThrow(expect.objectContaining({ code: "BAD_OVERLAY" }));
  });

  test("refuses a later layer that cannot fit a chained call, because layers cannot be reordered to make it fit", () => {
    expect(planLayerBatches([FIRST, CHAINED])).toEqual([[0], [1]]);
    expect(() => planLayerBatches([FIRST, CHAINED + 1])).toThrow(expect.objectContaining({ code: "BAD_OVERLAY" }));
  });

  test("a layer that only the first call has room for is accepted there", () => {
    expect(planLayerBatches([CHAINED + 1])).toEqual([[0]]);
  });
});

describe("layerCost", () => {
  test("a still costs its constant", () => {
    expect(layerCost(text(0))).toBe(LAYER_STILL_BYTES);
  });

  test("an animation costs its constant plus its loop cache: frames x w x h x 2.5 bytes", () => {
    expect(layerCost(sticker(0, { loopFrames: 48, sourceSize: { w: 320, h: 320 } }))).toBe(LAYER_ANIMATED_BYTES + 48 * 320 * 320 * 2.5);
  });
});

describe("buildLayerPass: several calls", () => {
  // Heavy stickers (a 648 px source, 48 frames: 80 MiB of cache each) so that only a few fit one call.
  const heavy = (k: number): OverlayInput => sticker(k, { loopFrames: 48, sourceSize: { w: 648, h: 648 }, box: { x: 10 * k, y: 100, w: 648, h: 648 } });
  const layers = [0, 1, 2, 3, 4, 5].map(heavy);
  const { jobs, final } = plan(layers);

  test("splits the layers into calls in z-order, each within the budget the model allows", () => {
    expect(jobs.length).toBeGreaterThan(1);
    expect(jobs.flatMap((j) => inputsOf(j.argv).filter((p) => p.endsWith(".apng")))).toEqual(layers.map((l) => l.path));
    for (const j of jobs) expect(j.modelledBytes).toBeLessThanOrEqual(LAYER_CALL_BUDGET_BYTES);
  });

  test("the first call starts from a transparent base and the later ones from the file before", () => {
    expect(graphOf(jobs[0]?.argv ?? [])).toStartWith("color=c=0x00000000:");
    const second = jobs[1];
    expect(second?.fileName).toBe("layers-01.mkv");
    expect(inputsOf(second?.argv ?? [])[0]).toBe(join(CLIP_DIR, "layers-00.mkv"));
  });

  test("reads the earlier file by the matroska demuxer with only the file protocol, and re-times it on the 30 fps grid before overlaying", () => {
    const second = jobs[1];
    const options = optionsBeforeInput(second?.argv ?? [], 0);
    expect(options.slice(-6)).toEqual(["-protocol_whitelist", "file", "-f", "matroska", "-threads", "4"]);
    expect(graphOf(second?.argv ?? [])).toStartWith("[0:v]settb=1/30,setpts=N[b0];[1:v]");
  });

  test("numbers the overlay inputs of a later call after the earlier file", () => {
    const second = jobs[1];
    const graph = graphOf(second?.argv ?? []);
    expect(graph).toContain("[1:v]fps=30,");
    expect(graph).not.toContain("[0:v]fps=30,");
  });

  test("hands pass 2 the LAST call's file", () => {
    const last = jobs.at(-1);
    expect(final?.path).toBe(last?.output);
    expect(final?.format).toBe("layers");
  });

  test("gives the calls consecutive file names", () => {
    expect(jobs.map((j) => j.fileName)).toEqual(jobs.map((_, i) => `layers-${pad(i)}.mkv`));
  });

  test("the maximum layer set, text and stickers at the default size, fits calls of at most the budget", () => {
    const max = [
      ...Array.from({ length: MAX_TEXT_LAYERS }, (_, k) => text(k, { box: { x: 0, y: 4 * k, w: 100, h: 4 } })),
      ...Array.from({ length: MAX_STICKER_LAYERS }, (_, k) => sticker(MAX_TEXT_LAYERS + k, { loopFrames: 48, box: { x: 2 * k, y: 1000, w: 220, h: 220 } })),
    ];
    const p = plan(max);
    for (const j of p.jobs) expect(j.modelledBytes).toBeLessThanOrEqual(LAYER_CALL_BUDGET_BYTES);
    expect(p.jobs.reduce((n, j) => n + j.layerCount, 0)).toBe(MAX_LAYERS);
  });
});

describe("buildLayerPass: invariants 15, 16 and the metadata rule", () => {
  const NASTY = ["/tmp/we ird/na'me;rm -rf", "/tmp/[x]:y,z=1\\", "/tmp/$(id)`id`", "/tmp/%{localtime}", "/tmp/фото é"];

  test("keeps every path out of every graph and every graph inside the strict charset, for 100 random layer sets", () => {
    const rand = mulberry32(21);
    for (let i = 0; i < 100; i++) {
      const total = 3 * randInt(rand, 10, 150);
      const layers: OverlayInput[] = Array.from({ length: randInt(rand, 1, 20) }, (_, k) => {
        const start = randInt(rand, 0, total - 3);
        const end = randInt(rand, start + 1, total);
        const animated = rand() < 0.5;
        return {
          path: `${NASTY[k % NASTY.length]}.${k}.png`,
          format: animated ? (rand() < 0.5 ? "apng" : "gif") : "png",
          box: { x: 2 * randInt(rand, 0, 200), y: 2 * randInt(rand, 0, 400), w: 2 * randInt(rand, 1, 200), h: 2 * randInt(rand, 1, 200) },
          resize: rand() < 0.5,
          startFrame: start,
          endFrame: end,
          ...(animated ? { loopFrames: randInt(rand, 1, 48), sourceSize: { w: 64, h: 64 } } : {}),
        };
      });
      const { jobs } = buildLayerPass({ layers, totalFrames: total, clipDir: CLIP_DIR });
      for (const job of jobs) {
        const graph = graphOf(job.argv);
        assertSafeFilterGraph(graph);
        for (const l of layers) expect(graph).not.toContain(l.path);
        expect(graph).not.toContain(CLIP_DIR);
      }
    }
  });

  test("puts -protocol_whitelist file before every input", () => {
    const argv = plan([text(0), sticker(1), sticker(2, { format: "gif" })]).jobs[0]?.argv ?? [];
    for (let i = 0; i < inputsOf(argv).length; i++) {
      const options = optionsBeforeInput(argv, i);
      const at = options.indexOf("-protocol_whitelist");
      expect(options.slice(at, at + 2)).toEqual(["-protocol_whitelist", "file"]);
    }
  });

  test("stops on the first broken frame instead of silently shortening a loop", () => {
    expect(plan([sticker(0)]).jobs[0]?.argv).toContain("-xerror");
  });

  test("never uses -stream_loop, -ignore_loop, -loop or an output length flag", () => {
    const argv = plan([text(0), sticker(1)]).jobs[0]?.argv ?? [];
    for (const bad of ["-stream_loop", "-ignore_loop", "-loop", "-frames:v", "-frames", "-t", "-to", "-shortest"]) expect(argv).not.toContain(bad);
  });

  test("copies no metadata and no chapters, asks for no bitexact and no creation time", () => {
    const argv = plan([text(0)]).jobs[0]?.argv ?? [];
    const at = argv.indexOf("-map_metadata");
    expect(argv.slice(at, at + 4)).toEqual([...METADATA_ARGS]);
    expect(argv.join(" ")).not.toContain("bitexact");
    expect(argv.join(" ")).not.toContain("creation_time");
  });

  test("converts every layer through the explicit BT.709 chain and never leaves it to the auto scaler", () => {
    const graph = onlyGraph([text(0), sticker(1), text(2)]);
    expect(graph.split("out_color_matrix=bt709").length - 1).toBe(3);
  });

  test("writes its file last, lossless with alpha, on 30 fps", () => {
    const argv = plan([text(0)]).jobs[0]?.argv ?? [];
    expect(argv.at(-1)).toBe(join(CLIP_DIR, "layers-00.mkv"));
    expect(LAYER_VIDEO_ARGS).toEqual(expect.arrayContaining(["-c:v", "ffv1", "-pix_fmt", "yuva420p", "-r", "30", "-fps_mode", "cfr"]));
  });

  test("is pure: the same input gives the same plan", () => {
    expect(plan([text(0), sticker(1)])).toEqual(plan([text(0), sticker(1)]));
  });
});
