import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { ffmpegPath } from "../../node/ffmpegBinary";
import { tempDirFor } from "../../testing/tempDir";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { CHART, HLG_OUT_OF_CUBE_CODES, hlgOutOfCubeRgb, hlgOutOfCubeToSdrBt709, P3_OUT_OF_CUBE_CODES, P3_SDR_CODES, P3_SDR_PATCHES, p3LinearBt709, p3SdrToSdrBt709, rgbToYcbcr, ycbcrToRgb, type Codes } from "./video/testing/chart";
import { chartMeans, decodeFirstFrame, requestFor, stage, worstDistance } from "./video/testing/importKit";
import { FIXTURES, type VideoFixtureName } from "./video/testing/fixtures/index";
import { openFileSource } from "./video/fileSource";
import { judgeVideo, videoFilterGraph, type VideoPlan } from "./video/videoPlan";
import { probeVideo } from "./video/videoProbe";
// The committed clips are a few frames long, shorter than the shortest clip (3f.6): these tests are about what the importer does with the file, so they take any length.
import { createVideoImporterForShortClips as createVideoImporter } from "./video/testing/importKit";
useNativeGlobals();
setDefaultTimeout(60_000);

// 3f.3a follow-up, review round 4 (2): the float steps of the colour chain that feed a transfer function.
//
// zimg's approximate gamma (`agamma`: SIMD tables) is not defined on negative floats, and its answer depends on the CPU: ONE Windows runner made a
// 47-code miss of the HLG chart's cyan patch (round 3 fixed the output side by clipping the light as 16-bit integers before the BT.709 gamma). Two
// places remained where a negative float meets a transfer function inside one zimg graph:
//   (a) the HDR chain's first `zscale`: YUV outside the RGB cube is a negative R'G'B' that goes straight into the inverse HLG curve;
//   (b) the SDR chain for primaries that are not BT.709's: a colour outside BT.709's gamut is a negative linear channel that goes into the gamma.
// Both are split now at the point where the signal can go negative, through a 16-bit integer RGB frame (saturating, the same on every CPU).
//
// What these tests can and cannot show: a negative float is CPU-dependent, so one machine cannot show the BAD behaviour; it shows that the new chain
// matches a model in which the signal is clipped, on fixtures built to have the negatives. On the macOS arm64 ffmpeg 6.0 that made the committed
// fixtures zimg clamps a negative to zero in the first stage (measured: R' = -0.71 comes out 0.0), so the old chain's miss on the out-of-cube clip is
// the over-1 side of the cube (a channel up to 1.67 is extrapolated by the HLG curve instead of clipped). Windows ffmpeg 6.1.1 runs these in CI.

const tmp = tempDirFor({ beforeEach, afterEach }, "studio-video-colour-");

/** Invariant 36: a patch mean within 2 code values of what it should be (Y, Cb and Cr). */
const TOLERANCE = 2;

const HLG_TAG = "setparams=colorspace=bt2020nc:color_primaries=bt2020:color_trc=arib-std-b67:range=tv";
const P3_TAG = "setparams=colorspace=bt709:color_primaries=smpte432:color_trc=iec61966-2-1:range=tv";
const HLG_TAIL = "zscale=p=bt709,tonemap=tonemap=hable:desat=0";

/** The HDR chain as it was before round 3: float all the way into the BT.709 gamma. The reference of the dark ramp. */
const FLOAT_HLG_CHAIN = `fps=30,setsar=1,${HLG_TAG},zscale=t=linear:npl=100,format=gbrpf32le,${HLG_TAIL},zscale=t=bt709:m=bt709:r=tv,format=yuv420p`;
/** The HDR chain as it was after round 3: the output side clipped, the first zscale still one float graph from YUV into the inverse curve. */
const PRE_SPLIT_HLG_CHAIN = `fps=30,setsar=1,${HLG_TAG},zscale=t=linear:npl=100,format=gbrpf32le,${HLG_TAIL},zscale=t=linear:p=bt709:m=bt709:r=pc,format=gbrp16le,zscale=t=bt709:m=bt709:r=tv,format=yuv420p`;
/** The SDR conversion of non-BT.709 primaries as it was: one zscale graph. */
const ONE_ZSCALE_P3_CHAIN = `fps=30,setsar=1,${P3_TAG},zscale=p=bt709:t=bt709:m=bt709:r=tv,format=yuv420p`;

const fixturePath = (name: VideoFixtureName): string => FIXTURES[name].file;

async function planOf(name: VideoFixtureName): Promise<VideoPlan> {
  const opened = await openFileSource(fixturePath(name));
  try {
    const judged = judgeVideo(await probeVideo(opened.source), FIXTURES[name].bytes);
    if (!judged.ok) throw new Error(`${name} was refused: ${judged.reason}`);
    return judged.plan;
  } finally {
    await opened.close();
  }
}

/** The first frame of the fixture through the importer, as raw 4:2:0 planes, and the patches' means. */
async function importedMeans(name: VideoFixtureName): Promise<[number, number, number][]> {
  const rig = requestFor(tmp(), await stage(tmp(), name));
  const outcome = await createVideoImporter()(rig.request);
  if (!outcome.ok || outcome.output === undefined) throw new Error(`the import was refused: ${JSON.stringify(outcome)}`);
  return chartMeans(decodeFirstFrame(outcome.output.file.path), CHART.width, CHART.height);
}

/** The first frame of the fixture through an explicit chain (the reference chains), as the patches' means. */
function chainMeans(name: VideoFixtureName, chain: string): [number, number, number][] {
  const run = spawnSync(ffmpegPath(), ["-hide_banner", "-v", "error", "-nostdin", "-f", "mov", "-i", fixturePath(name), "-frames:v", "1", "-vf", chain, "-f", "rawvideo", "-pix_fmt", "yuv420p", "pipe:1"], { maxBuffer: 1 << 26 });
  if (run.status !== 0) throw new Error(`ffmpeg failed: ${run.stderr.toString()}`);
  return chartMeans(new Uint8Array(run.stdout), CHART.width, CHART.height);
}

const deltas = (measured: readonly (readonly number[])[], want: readonly (readonly number[])[]): string => measured.map((means, i) => `${i}: ${means.map((v, k) => (v - (want[i]?.[k] ?? 0)).toFixed(1)).join(" ")}`).join(" | ");

describe("(a) HLG whose Y'CbCr is outside the RGB cube", () => {
  const want = HLG_OUT_OF_CUBE_CODES.map(hlgOutOfCubeToSdrBt709);

  test("the fixture has the negatives: every patch has a channel outside the cube, and some are far below zero and far above one", () => {
    const rgb = HLG_OUT_OF_CUBE_CODES.map(hlgOutOfCubeRgb);
    for (const [r, g, b] of rgb) expect(Math.min(r, g, b) < -0.04 || Math.max(r, g, b) > 1.04).toBe(true);
    expect(Math.min(...rgb.flat())).toBeLessThan(-0.5);
    expect(Math.max(...rgb.flat())).toBeGreaterThan(1.5);
  });

  test("every patch comes out within invariant 36's tolerance of the HLG model of the CLIPPED signal", async () => {
    const measured = await importedMeans("hevc-hlg-out-of-cube.mp4");
    const worst = worstDistance(measured, want);
    expect(worst.distance, `patch ${worst.patch}, plane ${worst.plane}; deltas ${deltas(measured, want)}`).toBeLessThanOrEqual(TOLERANCE);
  });

  test("the chain as it was (one float graph from YUV into the inverse curve) is far from that model on the same clip: the fixture tells the two apart", () => {
    const worst = worstDistance(chainMeans("hevc-hlg-out-of-cube.mp4", PRE_SPLIT_HLG_CHAIN), want);
    expect(worst.distance).toBeGreaterThan(10 * TOLERANCE);
  });
});

describe("(b) Display P3 SDR with colours outside BT.709's gamut, and with Y'CbCr outside the RGB cube", () => {
  const codes = P3_SDR_CODES;
  const want = codes.map(p3SdrToSdrBt709);

  test("the fixture has the negatives: BT.709 linear light under zero in the saturated P3 patches' channels", () => {
    const light = P3_SDR_PATCHES.map((rgb) => p3LinearBt709(rgbToYcbcr(rgb, "bt709", 8)));
    expect(Math.min(...light.flat())).toBeLessThan(-0.15);
    expect(light.filter((rgb) => Math.min(...rgb) < -0.03).length).toBeGreaterThanOrEqual(5);
  });

  test("the last six patches are outside the RGB cube: a channel under zero or over one", () => {
    for (const out of P3_OUT_OF_CUBE_CODES) {
      const [r, g, b] = ycbcrToRgb(out, "bt709", 8);
      expect(Math.min(r, g, b) < -0.04 || Math.max(r, g, b) > 1.04).toBe(true);
    }
    expect(codes.slice(-6)).toEqual([...P3_OUT_OF_CUBE_CODES]);
  });

  test("the chain as it was (one zscale graph) is far from the model on the same clip: the fixture tells the two apart", () => {
    const worst = worstDistance(chainMeans("h264-p3-saturated.mp4", ONE_ZSCALE_P3_CHAIN), want);
    expect(worst.distance).toBeGreaterThan(10 * TOLERANCE);
  });

  test("every patch comes out within invariant 36's tolerance of the model: greys and saturated P3 colours alike", async () => {
    const measured = await importedMeans("h264-p3-saturated.mp4");
    const worst = worstDistance(measured, want);
    expect(worst.distance, `patch ${worst.patch}, plane ${worst.plane}; deltas ${deltas(measured, want)}`).toBeLessThanOrEqual(TOLERANCE);
  });

  test("keeps every grey grey: no colour cast (Cb and Cr within a code of 128)", async () => {
    for (const [, cb, cr] of (await importedMeans("h264-p3-saturated.mp4")).slice(0, 12)) {
      expect(Math.abs(cb - 128)).toBeLessThanOrEqual(1);
      expect(Math.abs(cr - 128)).toBeLessThanOrEqual(1);
    }
  });
});

describe("the dark ramp: what the 16-bit steps cost in the shadows", () => {
  // A grey ramp in 10 bits, one code per column: Y = 64 (black) + column, 64 to 255 across the 192-pixel chart width, chroma neutral, as 4:2:0
  // planes. The 16-bit LINEAR step quantises near black (one 16-bit step of linear light is about 2.5 codes of an 8-bit BT.709 gamma at the bottom),
  // which is the price of a clip that is the same on every CPU. The reviewer measured it: up to 2 codes at 10-bit Y 66 to 70. The bound is 2, exactly.
  const { width, height } = CHART;
  const ramp = (): Uint8Array => {
    const raw = new Uint8Array(width * height * 3);
    const view = new DataView(raw.buffer);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) view.setUint16((y * width + x) * 2, 64 + x, true);
    for (let i = 0; i < (width * height) / 2; i++) view.setUint16((width * height + i) * 2, 512, true);
    return raw;
  };

  /** The first row of Y of a chain's output for the ramp. */
  function rampRow(chain: string): number[] {
    const run = spawnSync(ffmpegPath(), ["-hide_banner", "-v", "error", "-nostdin", "-f", "rawvideo", "-pix_fmt", "yuv420p10le", "-s", `${width}x${height}`, "-i", "pipe:0", "-frames:v", "1", "-vf", chain, "-f", "rawvideo", "-pix_fmt", "yuv420p", "pipe:1"], { input: ramp(), maxBuffer: 1 << 26 });
    if (run.status !== 0) throw new Error(`ffmpeg failed: ${run.stderr.toString()}`);
    return Array.from(run.stdout.subarray(0, width));
  }

  const worstMove = (row: readonly number[], reference: readonly number[], from = 0, to = width - 1): { move: number; at: number } => {
    let worst = { move: 0, at: -1 };
    for (let x = from; x <= to; x++) {
      const move = Math.abs((row[x] ?? 0) - (reference[x] ?? 0));
      if (move > worst.move) worst = { move, at: x };
    }
    return worst;
  };

  test("HLG: the importer's chain moves no shadow by more than 2 codes from the all-float chain, over 10-bit Y 64 to 255", async () => {
    const worst = worstMove(rampRow(videoFilterGraph(await planOf("hevc-hlg-chart.mp4"))), rampRow(FLOAT_HLG_CHAIN));
    expect(worst.move, `at 10-bit Y ${64 + worst.at}`).toBeLessThanOrEqual(2);
  });

  test("HLG: and exactly where the reviewer measured the clip's cost, 10-bit Y 66 to 70, the bound holds", async () => {
    const worst = worstMove(rampRow(videoFilterGraph(await planOf("hevc-hlg-chart.mp4"))), rampRow(FLOAT_HLG_CHAIN), 66 - 64, 70 - 64);
    expect(worst.move, `at 10-bit Y ${64 + worst.at}`).toBeLessThanOrEqual(2);
  });

  test("HLG: the split of the first stage adds nothing to what the output-side clip cost: the two chains agree to a code on the whole ramp", async () => {
    const worst = worstMove(rampRow(videoFilterGraph(await planOf("hevc-hlg-chart.mp4"))), rampRow(PRE_SPLIT_HLG_CHAIN));
    expect(worst.move, `at 10-bit Y ${64 + worst.at}`).toBeLessThanOrEqual(1);
  });

  test("P3 SDR: the split chain moves no shadow by more than 2 codes from the one-zscale chain, over the same ramp", async () => {
    const worst = worstMove(rampRow(videoFilterGraph(await planOf("h264-p3-saturated.mp4"))), rampRow(ONE_ZSCALE_P3_CHAIN));
    expect(worst.move, `at 10-bit Y ${64 + worst.at}`).toBeLessThanOrEqual(2);
  });

  test("the ramp is a ramp: the output rises from black to a light grey, never going back", async () => {
    const row = rampRow(videoFilterGraph(await planOf("hevc-hlg-chart.mp4")));
    expect(row[0]).toBe(16);
    for (let x = 1; x < row.length; x++) expect(row[x] ?? 0).toBeGreaterThanOrEqual(row[x - 1] ?? 0);
    expect(row[width - 1] ?? 0).toBeGreaterThan(40);
  });
});

/** Documents the shape the fixtures' codes must have (a legal 10-bit code), so a typo in the list cannot become an illegal clip. */
describe("the out-of-cube codes are legal limited-range 10-bit codes", () => {
  test.each(HLG_OUT_OF_CUBE_CODES.map((codes, i) => [i, codes] as [number, Codes]))("patch %i", (_, [y, cb, cr]) => {
    expect(y).toBeGreaterThanOrEqual(64);
    expect(y).toBeLessThanOrEqual(940);
    for (const c of [cb, cr]) {
      expect(c).toBeGreaterThanOrEqual(64);
      expect(c).toBeLessThanOrEqual(960);
    }
  });
});
