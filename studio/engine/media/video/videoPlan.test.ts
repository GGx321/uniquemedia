import { describe, expect, test } from "bun:test";
import { MEDIA_BYTE_CAPS, type MediaUnsupportedReason } from "../../../shared/engine";
import { useNativeGlobals } from "../../../testing/nativeGlobals";
import { expectedFrames, judgeVideo, VIDEO_LIMITS, videoArgs, videoFilterGraph, type VideoPlan } from "./videoPlan";
import { buildMp4, MATRIX, trackBox, type ColrSpec, type Mp4Spec, type TrackSpec, type VideoEntrySpec } from "./testing/mp4VideoBuilder";
import { bytesSource, probeVideo } from "./videoProbe";
useNativeGlobals();

// 3f.3a: from what the walker read to what is refused and what ffmpeg is asked to do. All pure: no file and no ffmpeg here.

const entry = (over: Partial<VideoEntrySpec> = {}): VideoEntrySpec => ({ fourcc: "avc1", width: 1920, height: 1080, ...over });
const nclx = (primaries: number, transfer: number, matrix: number, fullRange = false): ColrSpec => ({ type: "nclx", primaries, transfer, matrix, fullRange });
const withVideo = (over: Partial<TrackSpec> = {}, mp4: Partial<Mp4Spec> = {}): Mp4Spec => ({ tracks: [{ handler: "vide", ...over }], ...mp4 });

async function judged(spec: Mp4Spec, bytes = 1_000_000): Promise<ReturnType<typeof judgeVideo>> {
  return judgeVideo(await probeVideo(bytesSource(buildMp4(spec))), bytes);
}

async function refusal(spec: Mp4Spec, bytes?: number): Promise<MediaUnsupportedReason> {
  const result = await judged(spec, bytes);
  if (result.ok) throw new Error("expected a refusal");
  return result.reason;
}

async function planOf(spec: Mp4Spec): Promise<VideoPlan> {
  const result = await judged(spec);
  if (!result.ok) throw new Error(`expected a plan, got ${result.reason}`);
  return result.plan;
}

describe("the limits, to the edge", () => {
  test("they are three minutes, 2 GiB, 4096 x 2160, two pixels, and a 1080 x 1920 box at 30 fps", () => {
    expect(VIDEO_LIMITS).toEqual({ maxSeconds: 180, maxLongSide: 4096, maxShortSide: 2160, minSide: 2, fitWidth: 1080, fitHeight: 1920, fps: 30 });
    expect(MEDIA_BYTE_CAPS.video).toBe(2 * 1024 * 1024 * 1024);
  });

  test("exactly three minutes is taken", async () => {
    expect((await judged(withVideo({ mdhdTimescale: 30000, stts: [[5400, 1000]] }, { mvhdTimescale: 30000, mvhdDuration: 5_400_000 }))).ok).toBe(true);
  });

  test("three minutes and one frame (30 fps) is too long", async () => {
    expect(await refusal(withVideo({ mdhdTimescale: 30000, stts: [[5401, 1000]] }, { mvhdTimescale: 30000, mvhdDuration: 5_401_000 }))).toBe("too-long");
  });

  test("three minutes and one tick of the track's own clock is too long, whatever mvhd says", async () => {
    expect(await refusal(withVideo({ mdhdTimescale: 90000, stts: [[1, 16_200_001]] }, { mvhdTimescale: 1000, mvhdDuration: 1000 }))).toBe("too-long");
    expect((await judged(withVideo({ mdhdTimescale: 90000, stts: [[1, 16_200_000]] }, { mvhdTimescale: 1000, mvhdDuration: 1000 }))).ok).toBe(true);
  });

  test("the movie's own length (mvhd) no longer decides: ffmpeg decodes the video track, and only its length counts", async () => {
    expect((await judged(withVideo({}, { mvhdTimescale: 1000, mvhdDuration: 600_000 }))).ok).toBe(true);
  });

  test("a clip whose edit list shows 3 minutes of long media is taken, and one whose edit shows 3 minutes and a tick is too long", async () => {
    const long = { mdhdTimescale: 1000, stts: [[600, 1000]] } as const;
    expect((await judged(withVideo({ ...long, edits: [{ duration: 180_000, mediaTime: 0 }] }))).ok).toBe(true);
    expect(await refusal(withVideo({ ...long, edits: [{ duration: 180_001, mediaTime: 0 }] }))).toBe("too-long");
  });

  test("media that is long and cut short by its edit (a trim that keeps all the samples) is a clip of the edit's length", async () => {
    expect((await judged(withVideo({ mdhdTimescale: 1000, stts: [[10_800, 1000]], edits: [{ duration: 3000, mediaTime: 0 }] }))).ok).toBe(true);
  });

  test("a clip with no edit list is too long by its samples", async () => {
    expect(await refusal(withVideo({ mdhdTimescale: 1000, stts: [[181, 1000]] }))).toBe("too-long");
  });

  test("a file of exactly 2 GiB is taken, and one byte more is too large (the claim, not a real file)", async () => {
    expect((await judged(withVideo(), 2 * 1024 * 1024 * 1024)).ok).toBe(true);
    expect(await refusal(withVideo(), 2 * 1024 * 1024 * 1024 + 1)).toBe("too-large");
  });

  test("4096 x 2160 and 3840 x 2160 are taken, in either orientation", async () => {
    for (const [width, height] of [[4096, 2160], [3840, 2160], [2160, 4096], [2160, 3840]] as const) {
      expect((await judged(withVideo({ entry: entry({ width, height }) }))).ok).toBe(true);
    }
  });

  test("4097 x 2160 and 4096 x 2161 are past 4K", async () => {
    expect(await refusal(withVideo({ entry: entry({ width: 4097, height: 2160 }) }))).toBe("dimensions");
    expect(await refusal(withVideo({ entry: entry({ width: 4096, height: 2161 }) }))).toBe("dimensions");
    expect(await refusal(withVideo({ entry: entry({ width: 2161, height: 4096 }) }))).toBe("dimensions");
    expect(await refusal(withVideo({ entry: entry({ width: 3000, height: 3000 }) }))).toBe("dimensions");
  });

  test("a side of 2 pixels is taken and a side of 1 is too small", async () => {
    expect((await judged(withVideo({ entry: entry({ width: 2, height: 2 }) }))).ok).toBe(true);
    expect(await refusal(withVideo({ entry: entry({ width: 1, height: 2 }) }))).toBe("too-small");
    expect(await refusal(withVideo({ entry: entry({ width: 2, height: 1 }) }))).toBe("too-small");
    expect(await refusal(withVideo({ entry: entry({ width: 1, height: 1 }) }))).toBe("too-small");
  });
});

describe("what the walker refused becomes a reason", () => {
  test.each(["vp09", "av01", "mp4v", "dvh1"])("%s is a codec the importer does not take", async (fourcc) => {
    expect(await refusal(withVideo({ entry: entry({ fourcc }) }))).toBe("codec");
  });

  test("Dolby Vision profile 5 is a codec it does not take", async () => {
    expect(await refusal(withVideo({ entry: entry({ fourcc: "hvc1", dolby: { profile: 5, compatibilityId: 0 } }) }))).toBe("codec");
  });

  test.each([
    ["a file with no moov", { layout: "no-moov" } as Mp4Spec],
    ["a moov with no video track", { tracks: [{ handler: "soun" }] } as Mp4Spec],
  ])("%s is not a clip: a format the importer does not take", async (_name, spec) => {
    expect(await refusal(spec)).toBe("format");
  });

  test.each([
    ["a matrix that is not a quarter turn", withVideo({ matrix: [0, 1, 1, 0] })],
    ["an odd colour tag", withVideo({ entry: entry({ colr: nclx(1, 8, 1) }) })],
    ["non-square pixels", withVideo({ entry: entry({ pasp: [4, 3] }) })],
    ["a fragmented file", { topExtra: [new Uint8Array([0, 0, 0, 8, 0x6d, 0x6f, 0x6f, 0x66])] } as Mp4Spec],
    ["two video tracks", { tracks: [{ handler: "vide" }, { handler: "vide" }] } as Mp4Spec],
    ["a track outside moov", { topExtra: [trackBox({ handler: "vide" })] } as Mp4Spec],
    ["a repeated box", withVideo({ duplicate: "stts" })],
    ["a data reference to another file", withVideo({ drefFlags: [0] })],
    ["a sample count that two tables disagree on", withVideo({ stszCount: 99 })],
  ])("%s is a structure the importer does not take, and is told so (not as a format: a MOV owner would not understand that)", async (_name, spec) => {
    expect(await refusal(spec)).toBe("structure");
  });

  test("the size of the file is judged first: a file over the cap is too large whatever its boxes say", async () => {
    expect(await refusal({ layout: "no-moov" }, 3 * 1024 * 1024 * 1024)).toBe("too-large");
  });
});

describe("the size of the mezzanine: fitted inside 1080 x 1920, never upscaled, always even", () => {
  const sizeOf = async (width: number, height: number, matrix?: TrackSpec["matrix"]): Promise<[number, number]> => {
    const plan = await planOf(withVideo({ entry: entry({ width, height }), ...(matrix === undefined ? {} : { matrix }) }));
    return [plan.outWidth, plan.outHeight];
  };

  test("a portrait 1080 x 1920 stays as it is", async () => {
    expect(await sizeOf(1080, 1920)).toEqual([1080, 1920]);
  });

  test("a landscape 1920 x 1080 is fitted to the box's width", async () => {
    expect(await sizeOf(1920, 1080)).toEqual([1080, 608]);
  });

  test("a 4K landscape is fitted the same way", async () => {
    expect(await sizeOf(3840, 2160)).toEqual([1080, 608]);
  });

  test("a 4K clip stored landscape and turned a quarter is fitted as the portrait it shows", async () => {
    expect(await sizeOf(3840, 2160, MATRIX.r90)).toEqual([1080, 1920]);
    expect(await sizeOf(3840, 2160, MATRIX.r270)).toEqual([1080, 1920]);
  });

  test("a half turn keeps the orientation", async () => {
    expect(await sizeOf(1920, 1080, MATRIX.r180)).toEqual([1080, 608]);
  });

  test("a small picture is not made bigger", async () => {
    expect(await sizeOf(640, 360)).toEqual([640, 360]);
  });

  test("an odd size is made even, downwards, when nothing is scaled", async () => {
    expect(await sizeOf(641, 361)).toEqual([640, 360]);
  });

  test("a side that scales to an odd number is made even and stays inside the box", async () => {
    const [w, h] = await sizeOf(1081, 1919);
    expect(w % 2).toBe(0);
    expect(h % 2).toBe(0);
    expect(w).toBeLessThanOrEqual(1080);
    expect(h).toBeLessThanOrEqual(1920);
  });

  test("a very thin picture keeps at least two pixels", async () => {
    expect(await sizeOf(2, 2000)).toEqual([2, 1920]);
    expect(await sizeOf(4096, 2)).toEqual([1080, 2]);
  });

  test("the aspect ratio holds to within one even step", async () => {
    for (const [width, height] of [[1920, 1080], [1280, 720], [3840, 2160], [1440, 1080], [1000, 1500], [4096, 2160], [720, 1280]] as const) {
      const [w, h] = await sizeOf(width, height);
      expect(Math.abs(w / h - width / height)).toBeLessThan(2 / Math.min(w, h) + 0.002);
    }
  });
});

describe("the frames a normalised clip must have", () => {
  const expected = async (spec: Mp4Spec): Promise<[number, number]> => {
    const { min, max } = expectedFrames((await planOf(spec)).info);
    return [min, max];
  };
  const samples = (seconds: number): Partial<TrackSpec> => ({ mdhdTimescale: 30000, stts: [[seconds * 30, 1000]] });

  test("with no edit list: the samples' length at 30 fps, two frames either way", async () => {
    expect(await expected(withVideo(samples(2)))).toEqual([58, 62]);
  });

  test("a trim without re-encoding: 3.5 s of samples, an edit of 3 s from 0.5 s in: 90 frames, not 105", async () => {
    // What ffmpeg makes of the real fixture (measured): 90.
    const [min, max] = await expected(withVideo({ ...samples(3.5), edits: [{ duration: 3000, mediaTime: 15000 }] }));
    expect(min).toBeLessThanOrEqual(90);
    expect(max).toBeGreaterThanOrEqual(90);
    expect(max).toBeLessThan(95);
  });

  test("B-frames: an edit that starts a little into the samples and is as long as they are keeps the frame count within the range", async () => {
    // 60 samples, edit of 2.000 s from media time 1024 of 15360 (x264's): ffmpeg makes 60.
    const [min, max] = await expected(withVideo({ mdhdTimescale: 15360, stts: [[60, 512]], edits: [{ duration: 2000, mediaTime: 1024 }] }));
    expect(min).toBeLessThanOrEqual(60);
    expect(max).toBeGreaterThanOrEqual(60);
  });

  test("an empty edit before the segment adds nothing", async () => {
    const plain = await expected(withVideo({ ...samples(3), edits: [{ duration: 3000, mediaTime: 0 }] }));
    expect(await expected(withVideo({ ...samples(3), edits: [{ duration: 2000, mediaTime: -1 }, { duration: 3000, mediaTime: 0 }] }))).toEqual(plain);
  });

  test("an edit longer than the samples raises the upper bound to the edit's length (a held last frame whose time lives in ctts is longer than stts says)", async () => {
    // Changed deliberately in round 3: the upper bound was the shorter of the edit and the samples, and a VFR clip with a long-held last frame,
    // re-encoded with B-frames, makes ffmpeg play the hold (91 frames against an expected 32). The lower bound is unchanged.
    const [min, max] = await expected(withVideo({ ...samples(2), edits: [{ duration: 3000, mediaTime: 0 }] }));
    expect(max).toBe(92);
    expect(min).toBe(58);
  });

  test("an edit that claims a short span of long samples is the short span", async () => {
    const [min, max] = await expected(withVideo({ ...samples(100), edits: [{ duration: 1000, mediaTime: 0 }] }));
    expect([min, max]).toEqual([28, 32]);
  });

  test("an edit that starts near the end of the samples leaves only what remains", async () => {
    // 4 s of samples, a 3 s edit from 3 s in: one second remains.
    const [min, max] = await expected(withVideo({ ...samples(4), edits: [{ duration: 3000, mediaTime: 90_000 }] }));
    expect(min).toBeLessThanOrEqual(30);
    expect(max).toBeGreaterThanOrEqual(30);
  });
});

describe("the plan carries what the importer needs", () => {
  test("HDR (PQ and HLG) is tone-mapped, SDR is not", async () => {
    expect((await planOf(withVideo({ entry: entry({ fourcc: "hvc1", colr: nclx(9, 16, 9) }) }))).hdrToSdr).toBe(true);
    expect((await planOf(withVideo({ entry: entry({ fourcc: "hvc1", colr: nclx(9, 18, 9) }) }))).hdrToSdr).toBe(true);
    expect((await planOf(withVideo({ entry: entry({ colr: nclx(1, 1, 1) }) }))).hdrToSdr).toBe(false);
  });

  test("the wall-clock limit follows the edit's length, not the samples': a forged short edit on long media cannot buy ffmpeg a long time", async () => {
    const forged = await planOf(withVideo({ mdhdTimescale: 1000, stts: [[10_800, 1000]], edits: [{ duration: 1000, mediaTime: 0 }] }));
    expect(forged.timeoutMs).toBe(60_000 + 1000 * 10);
  });

  test("the wall-clock limit grows with the length and has a floor", async () => {
    const short = await planOf(withVideo({ stts: [[30, 1000]] }));
    const long = await planOf(withVideo({ mdhdTimescale: 1000, stts: [[180, 1000]] }, { mvhdDuration: 180_000 }));
    expect(short.timeoutMs).toBeGreaterThanOrEqual(60_000);
    expect(long.timeoutMs).toBeGreaterThan(short.timeoutMs);
    expect(long.timeoutMs).toBe(60_000 + 180_000 * 10);
  });
});

describe("the filter graph", () => {
  const graphOf = async (spec: Mp4Spec): Promise<string> => videoFilterGraph(await planOf(spec));
  const hlg = withVideo({ entry: entry({ fourcc: "hvc1", width: 1920, height: 1080, colr: nclx(9, 18, 9) }) });

  test("is a single chain that begins by dropping to 30 fps (so a frame that will not survive is not tone-mapped)", async () => {
    const graph = await graphOf(withVideo());
    expect(graph.startsWith("fps=30,")).toBe(true);
    expect(graph).not.toContain(";");
    expect(graph).not.toContain("[");
  });

  test("a clip that is already BT.709 SDR in limited range is only tagged and put in 4:2:0", async () => {
    const graph = await graphOf(withVideo({ entry: entry({ width: 1080, height: 1920, colr: nclx(1, 1, 1) }) }));
    expect(graph).toBe("fps=30,setsar=1,setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv,format=yuv420p");
  });

  /** The steps of the chain from the tag on (what the colour part is made of), one filter each. */
  const colourSteps = (graph: string): string[] => {
    const steps = graph.split(",");
    return steps.slice(steps.findIndex((step) => step.startsWith("setparams=")));
  };
  /**
   * The zscale steps that apply a TRANSFER function (they carry a `t=`), each with the step before it. The one right after the tone map is not
   * one: it takes linear light to linear light (it only converts to RGB for the 16-bit step), so no curve is applied there.
   */
  const transferSteps = (graph: string): { step: string; before: string | undefined }[] => {
    const steps = graph.split(",");
    return steps.flatMap((step, at) => (/^zscale=([^,]*:)?t=/.test(step) && steps[at - 1] !== "tonemap=tonemap=hable:desat=0" ? [{ step, before: steps[at - 1] }] : []));
  };

  test("HLG is tagged BEFORE zscale (SP3: zscale fails on untagged frames), then made RGB, linearised, converted, tone-mapped and encoded as BT.709", async () => {
    expect(colourSteps(await graphOf(hlg))).toEqual([
      "setparams=colorspace=bt2020nc:color_primaries=bt2020:color_trc=arib-std-b67:range=tv",
      // YUV to RGB with the transfer untouched, as 16-bit integers: a colour outside the RGB cube is clipped HERE, in the signal, where no transfer
      // function has been applied yet (3f.3a follow-up, round 4 (a)).
      "zscale",
      "format=gbrp16le",
      "zscale=t=linear:npl=100",
      "format=gbrpf32le",
      "zscale=p=bt709",
      "tonemap=tonemap=hable:desat=0",
      // Light outside BT.709's gamut is NEGATIVE linear light after the primaries conversion; the gamma step must never see it (below).
      "zscale=t=linear:p=bt709:m=bt709:r=pc",
      "format=gbrp16le",
      "zscale=t=bt709:m=bt709:r=tv",
      "format=yuv420p",
    ]);
  });

  test("the HDR chain clamps linear light to 16-bit integers (so no negative value reaches the gamma step) between the tone map and the gamma", async () => {
    // A colour outside BT.709's gamut is negative in one channel after the primaries conversion. zimg's gamma step on a negative float is not
    // defined, and ONE Windows runner's CPU made garbage of it (a chart patch 47 codes off) where others did not. An integer in between clips at zero.
    const graph = await graphOf(hlg);
    expect(graph.lastIndexOf("format=gbrp16le")).toBeGreaterThan(graph.indexOf("tonemap="));
    expect(graph.lastIndexOf("format=gbrp16le")).toBeLessThan(graph.lastIndexOf("zscale=t=bt709"));
  });

  test("the HDR chain's first transfer function (the inverse HLG curve) is fed 16-bit integers, not the float of a YUV to RGB conversion", async () => {
    // With real footage YUV outside the RGB cube gives negative R'G'B', which zimg's approximate inverse curve takes (CPU-dependent on negatives).
    const graph = await graphOf(hlg);
    expect(graph.indexOf("format=gbrp16le")).toBeLessThan(graph.indexOf("zscale=t=linear:npl=100"));
    expect(graph.split(",")[graph.split(",").indexOf("zscale=t=linear:npl=100") - 1]).toBe("format=gbrp16le");
  });

  test("every transfer function of the HDR chain is applied to a 16-bit integer frame: the inverse curve and the BT.709 gamma", async () => {
    const steps = transferSteps(await graphOf(hlg));
    expect(steps.map((s) => s.step)).toEqual(["zscale=t=linear:npl=100", "zscale=t=bt709:m=bt709:r=tv"]);
    expect(steps.map((s) => s.before)).toEqual(["format=gbrp16le", "format=gbrp16le"]);
  });

  test("PQ is tagged as PQ", async () => {
    const graph = await graphOf(withVideo({ entry: entry({ fourcc: "hvc1", colr: nclx(9, 16, 9) }) }));
    expect(graph).toContain("color_trc=smpte2084");
    expect(graph).toContain("tonemap=tonemap=hable");
  });

  test("Dolby Vision 8.4 goes through the HLG path", async () => {
    const graph = await graphOf(withVideo({ entry: entry({ fourcc: "hvc1", colr: nclx(9, 18, 9), dolby: { profile: 8, compatibilityId: 4 } }) }));
    expect(graph).toContain("color_trc=arib-std-b67");
  });

  test("the full-range bit is carried into the tag and the output is brought to limited range", async () => {
    const graph = await graphOf(withVideo({ entry: entry({ width: 1080, height: 1920, colr: nclx(1, 1, 1, true) }) }));
    expect(graph).toContain("range=pc");
    expect(graph).toContain("zscale=p=bt709:t=bt709:m=bt709:r=tv");
  });

  /** The conversion of an SDR clip whose primaries are not BT.709's: linear light can go negative (a colour outside BT.709's gamut), so it is split. */
  const SDR_PRIMARIES_CONVERSION = ["zscale", "format=gbrp16le", "zscale=t=linear:p=bt709:m=bt709:r=pc", "format=gbrp16le", "zscale=t=bt709:m=bt709:r=tv", "format=yuv420p"];

  test("a BT.601 clip is converted to BT.709 in the split chain (its primaries are not BT.709's)", async () => {
    const graph = await graphOf(withVideo({ entry: entry({ width: 720, height: 576, colr: nclx(5, 1, 5) }) }));
    expect(graph).toContain("colorspace=bt470bg:color_primaries=bt470bg:color_trc=bt709");
    expect(colourSteps(graph).slice(1)).toEqual(SDR_PRIMARIES_CONVERSION);
  });

  test("Display P3 primaries are named and converted in the split chain, never in one zscale (3f.3a follow-up, round 4 (b))", async () => {
    const graph = await graphOf(withVideo({ entry: entry({ width: 1080, height: 1920, colr: nclx(12, 1, 1) }) }));
    expect(graph).toContain("color_primaries=smpte432");
    expect(colourSteps(graph).slice(1)).toEqual(SDR_PRIMARIES_CONVERSION);
    expect(graph).not.toContain("zscale=p=bt709:t=bt709");
  });

  test("BT.2020 SDR is converted in the split chain too", async () => {
    const graph = await graphOf(withVideo({ entry: entry({ fourcc: "hvc1", width: 1080, height: 1920, colr: nclx(9, 1, 9) }) }));
    expect(colourSteps(graph).slice(1)).toEqual(SDR_PRIMARIES_CONVERSION);
  });

  test("in the split SDR chain each transfer function is applied to a 16-bit integer frame: the inverse curve and the BT.709 gamma", async () => {
    const steps = transferSteps(await graphOf(withVideo({ entry: entry({ width: 1080, height: 1920, colr: nclx(12, 13, 1) }) })));
    expect(steps.map((s) => s.step)).toEqual(["zscale=t=linear:p=bt709:m=bt709:r=pc", "zscale=t=bt709:m=bt709:r=tv"]);
    expect(steps.map((s) => s.before)).toEqual(["format=gbrp16le", "format=gbrp16le"]);
  });

  test("a clip whose primaries ARE BT.709's is never put through the 16-bit linear step: it keeps the single zscale (no negative light can come of the primaries)", async () => {
    for (const colr of [nclx(1, 13, 1), nclx(1, 1, 5), nclx(1, 1, 1, true)]) {
      const graph = await graphOf(withVideo({ entry: entry({ width: 1080, height: 1920, colr }) }));
      expect(graph).not.toContain("gbrp16le");
      expect(graph).toContain("zscale=p=bt709:t=bt709:m=bt709:r=tv");
    }
  });

  test("an sRGB transfer is converted to the BT.709 one", async () => {
    const graph = await graphOf(withVideo({ entry: entry({ width: 1080, height: 1920, colr: nclx(1, 13, 1) }) }));
    expect(graph).toContain("color_trc=iec61966-2-1");
    expect(graph).toContain("zscale=p=bt709:t=bt709:m=bt709:r=tv");
  });

  test("a clip that must shrink is scaled once, with the accurate rounding SP1 measured", async () => {
    const graph = await graphOf(withVideo({ entry: entry({ width: 3840, height: 2160 }) }));
    expect(graph.match(/(^|,)scale=/g)?.length).toBe(1);
    expect(graph).toContain("scale=1080:608:flags=bicubic+accurate_rnd+full_chroma_int");
  });

  test("a clip that fits is not scaled", async () => {
    expect(await graphOf(withVideo({ entry: entry({ width: 640, height: 360 }) }))).not.toMatch(/(^|,)scale=/);
  });

  test.each([
    [0, ""],
    [90, "transpose=1"],
    [180, "hflip,vflip"],
    [270, "transpose=2"],
  ] as const)("a rotation of %i degrees is %s", async (degrees, filter) => {
    const matrix = { 0: MATRIX.r0, 90: MATRIX.r90, 180: MATRIX.r180, 270: MATRIX.r270 }[degrees];
    const graph = await graphOf(withVideo({ entry: entry({ width: 640, height: 360 }), matrix }));
    if (filter === "") expect(graph).not.toMatch(/transpose|flip/);
    else expect(graph).toContain(`,${filter},`);
  });

  test("a turned clip is scaled in its stored orientation and turned after, so the scale is the smaller job", async () => {
    const graph = await graphOf(withVideo({ entry: entry({ width: 3840, height: 2160 }), matrix: MATRIX.r90 }));
    // The shown picture is 1080 x 1920; the stored one is 1920 x 1080 before the quarter turn.
    expect(graph.indexOf("scale=1920:1080")).toBeGreaterThan(-1);
    expect(graph.indexOf("scale=")).toBeLessThan(graph.indexOf("transpose=1"));
    expect(graph.indexOf("transpose=1")).toBeLessThan(graph.indexOf("setparams="));
  });

  test("only characters of the fixed vocabulary can be in the graph (nothing of the file's own is)", async () => {
    for (const spec of [hlg, withVideo(), withVideo({ entry: entry({ width: 3840, height: 2160 }), matrix: MATRIX.r270 })]) {
      expect(await graphOf(spec)).toMatch(/^[a-z0-9_=:,.+\-]+$/);
    }
  });
});

describe("the ffmpeg arguments", () => {
  const INPUT = "/library/media/.staging/in-0001.media";
  const OUTPUT = "/library/media/.staging/out-0001.media";
  const argsOf = async (spec: Mp4Spec = withVideo()): Promise<string[]> => videoArgs(INPUT, await planOf(spec), OUTPUT);
  const valueAfter = (args: readonly string[], flag: string): string | undefined => args[args.indexOf(flag) + 1];

  test("the output path is last", async () => {
    expect((await argsOf()).at(-1)).toBe(OUTPUT);
  });

  test("the input is hardened before its -i: only the file protocol, the mov demuxer forced, no autorotate, a pixel and allocation cap", async () => {
    const args = await argsOf();
    const i = args.indexOf("-i");
    expect(args[i + 1]).toBe(INPUT);
    for (const flag of ["-protocol_whitelist", "-f", "-noautorotate", "-max_pixels", "-max_alloc"]) expect(args.indexOf(flag)).toBeGreaterThan(-1);
    expect(valueAfter(args, "-protocol_whitelist")).toBe("file");
    expect(args.indexOf("-protocol_whitelist")).toBeLessThan(i);
    expect(args.indexOf("-f")).toBeLessThan(i);
    expect(args[args.indexOf("-f") + 1]).toBe("mov");
    expect(args.indexOf("-noautorotate")).toBeLessThan(i);
    expect(Number(valueAfter(args, "-max_pixels"))).toBe(VIDEO_LIMITS.maxLongSide * VIDEO_LIMITS.maxShortSide);
    expect(Number(valueAfter(args, "-max_alloc"))).toBeGreaterThanOrEqual(64 * 1024 * 1024);
    expect(Number(valueAfter(args, "-max_alloc"))).toBeLessThanOrEqual(512 * 1024 * 1024);
  });

  test.each([
    ["avc1", "h264"],
    ["hvc1", "hevc"],
    ["apch", "prores"],
  ])("the decoder is pinned from the walker's verdict (%s is %s): only it is allowed, and only it is used, before the input", async (fourcc, decoder) => {
    const args = videoArgs(INPUT, await planOf(withVideo({ entry: entry({ fourcc }) })), OUTPUT);
    const i = args.indexOf("-i");
    expect(valueAfter(args, "-codec_whitelist")).toBe(decoder);
    expect(args.indexOf("-codec_whitelist")).toBeLessThan(i);
    expect(valueAfter(args, "-c:v")).toBe(decoder);
    expect(args.indexOf("-c:v")).toBeLessThan(i);
    expect(args.filter((a) => a === "-c:v")).toHaveLength(2);
  });

  test("the input's display matrix is not carried to the output (the clip is turned here, so it must not be marked turned again)", async () => {
    const args = await argsOf();
    expect(valueAfter(args, "-display_rotation")).toBe("0");
    expect(args.indexOf("-display_rotation")).toBeLessThan(args.indexOf("-i"));
  });

  test("the pixels are made square after any scale", async () => {
    const graph = videoFilterGraph(await planOf(withVideo({ entry: entry({ width: 4096, height: 2160 }) })));
    expect(graph.indexOf("setsar=1")).toBeGreaterThan(graph.indexOf("scale="));
  });

  test("it reads no other input and no URL", async () => {
    const args = await argsOf();
    expect(args.filter((a) => a === "-i")).toHaveLength(1);
    expect(args.some((a) => /^[a-z]+:\/\//i.test(a))).toBe(false);
  });

  test("only the first video stream is mapped; no audio, subtitles, data, chapters or metadata", async () => {
    const args = await argsOf();
    expect(args.filter((a) => a === "-map")).toHaveLength(1);
    expect(valueAfter(args, "-map")).toBe("0:V:0");
    expect(valueAfter(args, "-map_metadata")).toBe("-1");
    expect(valueAfter(args, "-map_metadata:s:v:0")).toBe("-1");
    expect(valueAfter(args, "-map_chapters")).toBe("-1");
    for (const flag of ["-an", "-sn", "-dn"]) expect(args).toContain(flag);
    expect(args).not.toContain("-c:a");
  });

  test("the encode is H.264 at CRF 16 in 4:2:0 at a constant 30 fps, tagged BT.709, capped at three minutes", async () => {
    const args = await argsOf();
    expect(args[args.lastIndexOf("-c:v") + 1]).toBe("libx264");
    expect(valueAfter(args, "-crf")).toBe("16");
    expect(valueAfter(args, "-pix_fmt")).toBe("yuv420p");
    expect(valueAfter(args, "-fps_mode")).toBe("cfr");
    expect(valueAfter(args, "-t")).toBe("180");
    for (const [flag, value] of [["-colorspace", "bt709"], ["-color_primaries", "bt709"], ["-color_trc", "bt709"], ["-color_range", "tv"]] as const) expect(valueAfter(args, flag)).toBe(value);
  });

  test("the container is MP4 with no tool name written, and is made streamable", async () => {
    const args = await argsOf();
    expect(valueAfter(args, "-f" /* the first -f is the input's */)).toBe("mov");
    const outputFormat = args[args.lastIndexOf("-f") + 1];
    expect(outputFormat).toBe("mp4");
    expect(valueAfter(args, "-fflags")).toBe("+bitexact");
    expect(valueAfter(args, "-movflags")).toBe("+faststart");
  });

  test("the graph is passed once, as -vf", async () => {
    const args = await argsOf();
    expect(args.filter((a) => a === "-vf")).toHaveLength(1);
    expect(valueAfter(args, "-vf")).toBe(videoFilterGraph(await planOf(withVideo())));
  });

  test("a relative path, or one that could be read as an option, is refused", async () => {
    const plan = await planOf(withVideo());
    expect(() => videoArgs("relative/in.media", plan, OUTPUT)).toThrow();
    expect(() => videoArgs(INPUT, plan, "out.media")).toThrow();
    expect(() => videoArgs("-i", plan, OUTPUT)).toThrow();
  });
});
