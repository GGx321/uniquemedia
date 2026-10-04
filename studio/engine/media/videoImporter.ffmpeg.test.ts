import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawn } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tempDirFor } from "../../testing/tempDir";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import type { FfmpegSpawner } from "../../node/runFfmpeg";
import { CHART, CHART_PATCHES, hlgToSdrBt709, rgbToYcbcr } from "./video/testing/chart";
import { chartMeans, contains, decodeFirstFrame, requestFor, stage, worstDistance, type Rig } from "./video/testing/importKit";
import { PNG_1X1 } from "../library/testing/sampleData";
import { withCoverArt, withEntryBox, withRotation, withTransfer } from "./video/testing/mp4Patch";
import { dolbyBox } from "./video/testing/mp4VideoBuilder";
import { FIXTURES } from "./video/testing/fixtures/index";
import { openFileSource } from "./video/fileSource";
import { probeVideo, type VideoInfo } from "./video/videoProbe";
import type { MediaImportOutcome } from "./imports";
import { createVideoImporter } from "./videoImporter";
useNativeGlobals();
setDefaultTimeout(60_000);

// 3f.3a on REAL ffmpeg, in the default suite: these are the only proof that the mezzanine is what the plan says, that the rotation goes the
// right way, that a variable-rate clip becomes a constant one, and that an HLG clip keeps its colours (invariant 36). The fixtures are a few
// frames of a 24-patch chart (`video/testing/fixtures/README.md`); the colour tests read the decoded planes with no conversion but the pixel
// format and compare each patch with a model (`hlgToSdrBt709`). The model's formulas are the standards' (BT.2100, BT.2087, Hable, BT.1886), but three of
// its constants (zimg's per-channel 10 x E^1.2, tonemap's default peak of 10, the plain 1/2.4 output power) were FITTED to ffmpeg 6.0's own output,
// stage by stage: so the test proves that the chain does what a model with those constants says, on every patch, and that the hue and the
// neutrals are right; it is not a proof from first principles that the constants themselves are the right look.

const tmp = tempDirFor({ beforeEach, afterEach }, "studio-video-import-");

/** Invariant 36: a patch mean within 2 code values of what it should be (Y, Cb and Cr). */
const TOLERANCE = 2;

type Ok = Extract<MediaImportOutcome, { ok: true }>;

async function importFixture(name: Parameters<typeof stage>[1], options: Parameters<typeof createVideoImporter>[0] = {}): Promise<{ outcome: MediaImportOutcome; rig: Rig }> {
  const rig = requestFor(tmp(), await stage(tmp(), name));
  return { outcome: await createVideoImporter(options)(rig.request), rig };
}

async function importedOk(name: Parameters<typeof stage>[1]): Promise<{ done: Ok; path: string; info: VideoInfo }> {
  const { outcome } = await importFixture(name);
  if (!outcome.ok) throw new Error(`the import was refused: ${outcome.reason}`);
  if (outcome.output === undefined) throw new Error("the importer made no file");
  return { done: outcome, path: outcome.output.file.path, info: await infoOf(outcome.output.file.path) };
}

async function infoOf(path: string): Promise<VideoInfo> {
  const opened = await openFileSource(path);
  try {
    const probe = await probeVideo(opened.source);
    if (!probe.ok) throw new Error(`the output is not a clip the walker reads: ${probe.reason}`);
    return probe.info;
  } finally {
    await opened.close();
  }
}

const sdrCodes = CHART_PATCHES.map((rgb) => rgbToYcbcr(rgb, "bt709", 8));
const hlgCodes = CHART_PATCHES.map((rgb) => hlgToSdrBt709(rgb));

describe("HEVC HLG, BT.2020, 10-bit: what an iPhone records", () => {
  test("becomes SDR whose every chart patch is within invariant 36's tolerance of a model of the chain (constants fitted to ffmpeg)", async () => {
    const { path, info } = await importedOk("hevc-hlg-chart.mp4");
    const measured = chartMeans(decodeFirstFrame(path), info.video.width, info.video.height);
    const worst = worstDistance(measured, hlgCodes);
    expect(worst.distance, `patch ${worst.patch}, plane ${worst.plane}`).toBeLessThanOrEqual(TOLERANCE);
  });

  test("keeps every grey grey: no colour cast (Cb and Cr within a code of 128)", async () => {
    const { path, info } = await importedOk("hevc-hlg-chart.mp4");
    const greys = chartMeans(decodeFirstFrame(path), info.video.width, info.video.height).slice(0, 12);
    for (const [, cb, cr] of greys) {
      expect(Math.abs(cb - 128)).toBeLessThanOrEqual(1);
      expect(Math.abs(cr - 128)).toBeLessThanOrEqual(1);
    }
  });

  test("keeps the brightness in order: each grey is lighter than the one before it", async () => {
    const { path, info } = await importedOk("hevc-hlg-chart.mp4");
    const ys = chartMeans(decodeFirstFrame(path), info.video.width, info.video.height).slice(0, 12).map((means) => means[0]);
    for (let i = 1; i < ys.length; i++) expect(ys[i] ?? 0).toBeGreaterThan(ys[i - 1] ?? 0);
  });

  test("is stored as an H.264 mezzanine tagged BT.709 limited range at a constant 30 fps, with no audio", async () => {
    const { info } = await importedOk("hevc-hlg-chart.mp4");
    expect(info.video.codec).toBe("h264");
    expect(info.video.colour).toEqual({ tagged: true, primaries: 1, transfer: 1, matrix: 1, fullRange: false });
    expect(info.video.dynamicRange).toBe("sdr");
    expect(info.video.variableFrameRate).toBe(false);
    expect(info.video.sourceFps).toBeCloseTo(30, 1);
    expect(info.audioTracks).toBe(0);
    expect(info.video.rotation).toBe(0);
  });

  test("answers the record's facts: the stored size, its length in 30 fps frames, the source's own rate, and that it was tone-mapped", async () => {
    const { done, info } = await importedOk("hevc-hlg-chart.mp4");
    expect(done.facts).toEqual({ width: CHART.width, height: CHART.height, durationMs: Math.round((info.video.samples * 1000) / 30), sourceFps: 30, hdrToSdr: true, loopFrames: null, delayFrames: null });
    expect(info.video.samples).toBe(3);
    expect(done.output?.format).toBe("mp4");
  });
});

describe("the other HDR spellings", () => {
  async function importBytes(bytes: Uint8Array): Promise<{ outcome: MediaImportOutcome; rig: Rig }> {
    const rig = requestFor(tmp(), await stage(tmp(), bytes));
    return { outcome: await createVideoImporter()(rig.request), rig };
  }

  test.each(["dvcC", "dvvC"] as const)("Dolby Vision 8.4 (a %s box) is read as its HLG base, and comes out with the same colours as the plain HLG clip", async (boxName) => {
    const plain = new Uint8Array(await readFile(FIXTURES["hevc-hlg-chart.mp4"].file));
    const { outcome } = await importBytes(withEntryBox(plain, dolbyBox({ box: boxName, profile: 8, compatibilityId: 4 })));
    if (!outcome.ok || outcome.output === undefined) throw new Error("the import was refused");
    expect(outcome.facts.hdrToSdr).toBe(true);
    const measured = chartMeans(decodeFirstFrame(outcome.output.file.path), CHART.width, CHART.height);
    expect(worstDistance(measured, hlgCodes).distance).toBeLessThanOrEqual(TOLERANCE);
  });

  test("a clip that says PQ is tone-mapped too, and comes out as the same kind of mezzanine", async () => {
    const plain = new Uint8Array(await readFile(FIXTURES["hevc-hlg-chart.mp4"].file));
    const { outcome } = await importBytes(withTransfer(plain, 16));
    if (!outcome.ok || outcome.output === undefined) throw new Error("the import was refused");
    expect(outcome.facts.hdrToSdr).toBe(true);
    const info = await infoOf(outcome.output.file.path);
    expect([info.video.codec, info.video.dynamicRange, info.video.colour.transfer]).toEqual(["h264", "sdr", 1]);
  });

  test("Dolby Vision profile 5 is refused as a codec, before ffmpeg is started", async () => {
    const plain = new Uint8Array(await readFile(FIXTURES["hevc-hlg-chart.mp4"].file));
    const { outcome, rig } = await importBytes(withEntryBox(plain, dolbyBox({ box: "dvvC", profile: 5, compatibilityId: 0 })));
    expect(outcome).toEqual({ ok: false, reason: "codec" });
    expect(rig.workFiles).toEqual([]);
  });
});

describe("a file with cover art ahead of its video track", () => {
  test("is the clip, not the picture: ffmpeg's attached picture is a video stream too, and is not the one mapped", async () => {
    const plain = new Uint8Array(await readFile(FIXTURES["h264-sdr-chart.mp4"].file));
    const withCover = withCoverArt(plain, PNG_1X1);
    const rig = requestFor(tmp(), await stage(tmp(), withCover));
    const outcome = await createVideoImporter()(rig.request);
    if (!outcome.ok || outcome.output === undefined) throw new Error("the import was refused");
    const info = await infoOf(outcome.output.file.path);
    expect([info.video.width, info.video.height, info.video.samples]).toEqual([CHART.width, CHART.height, 5]);
    expect(worstDistance(chartMeans(decodeFirstFrame(outcome.output.file.path), CHART.width, CHART.height), sdrCodes).distance).toBeLessThanOrEqual(TOLERANCE);
  });
});

describe("H.264 SDR with a sound track and a phone's metadata", () => {
  test("keeps the colours: every chart patch within 2 code values of what went in", async () => {
    const { path, info } = await importedOk("h264-sdr-chart.mp4");
    expect(worstDistance(chartMeans(decodeFirstFrame(path), info.video.width, info.video.height), sdrCodes).distance).toBeLessThanOrEqual(TOLERANCE);
  });

  test("drops the sound track", async () => {
    const source = await infoOf(FIXTURES["h264-sdr-chart.mp4"].file);
    expect(source.audioTracks).toBe(1);
    const { info } = await importedOk("h264-sdr-chart.mp4");
    expect(info.audioTracks).toBe(0);
  });

  test.each(["SecretTitle", "SecretHandler", "50.4501", "Lavf"])("drops the metadata string %s", async (needle) => {
    expect(contains(new Uint8Array(await readFile(FIXTURES["h264-sdr-chart.mp4"].file)), needle)).toBe(true);
    const { path } = await importedOk("h264-sdr-chart.mp4");
    expect(contains(new Uint8Array(await readFile(path)), needle)).toBe(false);
  });

  test("drops the creation time", async () => {
    const creationOf = async (path: string): Promise<number> => {
      const bytes = await readFile(path);
      return bytes.readUInt32BE(bytes.indexOf("mvhd") + 8);
    };
    expect(await creationOf(FIXTURES["h264-sdr-chart.mp4"].file)).toBeGreaterThan(0);
    const { path } = await importedOk("h264-sdr-chart.mp4");
    expect(await creationOf(path)).toBe(0);
  });

  test("the output's metadata list is empty: no keys box, and an ilst that is only its own 8-byte header", async () => {
    const { path } = await importedOk("h264-sdr-chart.mp4");
    const bytes = await readFile(path);
    for (const box of ["keys", "mdta", "covr", "data"]) expect(contains(bytes, box)).toBe(false);
    // ffmpeg's muxer writes an empty udta, meta and ilst; what matters is that nothing is in the list.
    const at = bytes.indexOf("ilst");
    if (at !== -1) expect(bytes.readUInt32BE(at - 4)).toBe(8);
  });
});

describe("ProRes 422 HQ in a QuickTime file", () => {
  test("is normalised, and every chart patch is within 2 code values of what went in", async () => {
    const { path, info, done } = await importedOk("prores-hq-chart.mov");
    expect(info.video.codec).toBe("h264");
    expect(done.facts.hdrToSdr).toBe(false);
    expect(worstDistance(chartMeans(decodeFirstFrame(path), info.video.width, info.video.height), sdrCodes).distance).toBeLessThanOrEqual(TOLERANCE);
  });
});

describe("a variable-rate clip", () => {
  test("becomes a constant 30 fps one that is as long as the source", async () => {
    const source = await infoOf(FIXTURES["h264-vfr.mp4"].file);
    expect(source.video.variableFrameRate).toBe(true);
    const { done, info } = await importedOk("h264-vfr.mp4");
    expect(info.video.variableFrameRate).toBe(false);
    expect(info.video.sourceFps).toBeCloseTo(30, 1);
    // 14 frames over 0.733 s: 22 frames at 30 fps, give or take the rounding of its last one.
    expect(Math.abs(info.video.samples - Math.round((source.durationMs / 1000) * 30))).toBeLessThanOrEqual(1);
    expect(done.facts.sourceFps).toBe(source.video.sourceFps);
    expect(done.facts.durationMs).toBe(Math.round((info.video.samples * 1000) / 30));
  });
});

describe("rotation", () => {
  const sdr = FIXTURES["h264-sdr-chart.mp4"].file;
  const turns: (0 | 90 | 180 | 270)[] = [0, 90, 180, 270];

  test.each(turns)("a clip stored with a matrix of %i degrees is turned upright: the size, and where every patch of the chart lands", async (degrees) => {
    const bytes = withRotation(new Uint8Array(await readFile(sdr)), degrees);
    const { outcome } = await importStaged(bytes);
    if (!outcome.ok || outcome.output === undefined) throw new Error("the import was refused");
    const info = await infoOf(outcome.output.file.path);
    const turned = degrees === 90 || degrees === 270;
    expect([info.video.width, info.video.height]).toEqual(turned ? [CHART.height, CHART.width] : [CHART.width, CHART.height]);
    expect([outcome.facts.width, outcome.facts.height]).toEqual([info.video.width, info.video.height]);
    expect(info.video.rotation).toBe(0);
    const measured = chartMeans(decodeFirstFrame(outcome.output.file.path), info.video.width, info.video.height, degrees);
    expect(worstDistance(measured, sdrCodes).distance).toBeLessThanOrEqual(TOLERANCE);
  });

  test.each(turns)("a %i degree clip comes out as ffmpeg's own player-side autorotate would show it", async (degrees) => {
    const bytes = withRotation(new Uint8Array(await readFile(sdr)), degrees);
    const { outcome } = await importStaged(bytes);
    if (!outcome.ok || outcome.output === undefined) throw new Error("the import was refused");
    const patched = join(tmp(), "patched.mp4");
    await writeFile(patched, bytes);
    const info = await infoOf(outcome.output.file.path);
    // The oracle: ffmpeg decoding the same file with its default (autorotate on), as a player shows it.
    const oracle = chartMeans(decodeFirstFrame(patched), info.video.width, info.video.height, degrees);
    const ours = chartMeans(decodeFirstFrame(outcome.output.file.path), info.video.width, info.video.height, degrees);
    expect(worstDistance(ours, oracle).distance).toBeLessThanOrEqual(TOLERANCE);
  });

  async function importStaged(bytes: Uint8Array): Promise<{ outcome: MediaImportOutcome; rig: Rig }> {
    const rig = requestFor(tmp(), await stage(tmp(), bytes));
    return { outcome: await createVideoImporter()(rig.request), rig };
  }
});

describe("an iPhone held upright: HEVC HLG, variable rate, turned a quarter, in a QuickTime file", () => {
  test("comes out upright, constant, tone-mapped, and with its colours", async () => {
    const source = await infoOf(FIXTURES["hevc-hlg-rotated-vfr.mov"].file);
    expect([source.video.rotation, source.video.dynamicRange, source.video.variableFrameRate, source.video.codec]).toEqual([90, "hlg", true, "hevc"]);
    const { path, info, done } = await importedOk("hevc-hlg-rotated-vfr.mov");
    expect([info.video.width, info.video.height]).toEqual([CHART.height, CHART.width]);
    expect(info.video.variableFrameRate).toBe(false);
    expect(done.facts.hdrToSdr).toBe(true);
    const measured = chartMeans(decodeFirstFrame(path), info.video.width, info.video.height, 90);
    expect(worstDistance(measured, hlgCodes).distance).toBeLessThanOrEqual(TOLERANCE);
  });
});

describe("4096 x 2160", () => {
  test("a real 4K HEVC HLG clip decodes under the allocation and pixel caps and is fitted to 1080 wide", async () => {
    const { info, done } = await importedOk("hevc-hlg-flat-4k.mp4");
    expect(info.video.width).toBe(1080);
    expect(info.video.height).toBeLessThanOrEqual(1920);
    expect(info.video.height % 2).toBe(0);
    expect(Math.abs(info.video.width / info.video.height - 4096 / 2160)).toBeLessThan(0.01);
    expect(done.facts.hdrToSdr).toBe(true);
  });
});

describe("what is refused is refused before ffmpeg is started", () => {
  async function refusedWithoutFfmpeg(source: Parameters<typeof stage>[1], bytes?: number): Promise<string> {
    const started: string[] = [];
    const spawner: FfmpegSpawner = () => {
      started.push("spawn");
      throw new Error("ffmpeg must not be started");
    };
    const staged = await stage(tmp(), source);
    const rig = requestFor(tmp(), bytes === undefined ? staged : { ...staged, bytes });
    const outcome = await createVideoImporter({ spawner })(rig.request);
    expect(started).toEqual([]);
    expect(rig.workFiles).toEqual([]);
    if (outcome.ok) throw new Error("expected a refusal");
    return outcome.reason;
  }

  test("a truncated file is a format it does not take", async () => {
    const bytes = new Uint8Array(await readFile(FIXTURES["h264-sdr-chart.mp4"].file));
    expect(await refusedWithoutFfmpeg(bytes.subarray(0, bytes.byteLength - 100))).toBe("format");
  });

  test("a WebM that says it is an MP4 is a format it does not take", async () => {
    const webm = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, ...new Array(64).fill(0)]);
    expect(await refusedWithoutFfmpeg(webm)).toBe("format");
  });

  test("a file of 2 GiB and a byte is too large, by the claim (nothing is read)", async () => {
    expect(await refusedWithoutFfmpeg("h264-sdr-chart.mp4", 2 * 1024 * 1024 * 1024 + 1)).toBe("too-large");
  });

  test("a staged copy whose container is not MP4 or MOV is a format it does not take", async () => {
    const staged = await stage(tmp(), "h264-sdr-chart.mp4");
    const rig = requestFor(tmp(), { ...staged, format: "m4a" });
    expect(await createVideoImporter()(rig.request)).toEqual({ ok: false, reason: "format" });
  });

  test("a staged copy that is not the size the job copied is refused as failed", async () => {
    const staged = await stage(tmp(), "h264-sdr-chart.mp4");
    const rig = requestFor(tmp(), { ...staged, bytes: staged.bytes + 1 });
    expect(await createVideoImporter()(rig.request)).toEqual({ ok: false, reason: "failed" });
  });
});

/** An ffmpeg that is slowed to real time on a clip that loops, so a test can stop it in the middle of an encode. */
function slowSpawner(pids: number[]): FfmpegSpawner {
  return (command, args, options) => {
    const at = args.indexOf("-i");
    const slowed = [...args.slice(0, at), "-re", "-stream_loop", "1000", ...args.slice(at)];
    const { env, ...rest } = options;
    const child = spawn(command, slowed, { ...rest, ...(env === undefined ? {} : { env }), stdio: [...options.stdio] });
    if (child.pid !== undefined) pids.push(child.pid);
    return child;
  };
}

const gone = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};

const sizeOf = (path: string): Promise<number> => stat(path).then((info) => info.size, () => -1);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 600; i++) {
    if (await condition()) return;
    await sleep(50);
  }
  throw new Error("the condition never came true");
}

describe("cancel and time (the 3f.1b review's requirement)", () => {
  test("an abort in the middle of an encode kills ffmpeg, and nothing is written after", async () => {
    const pids: number[] = [];
    const staged = await stage(tmp(), "h264-vfr.mp4");
    const rig = requestFor(tmp(), staged);
    const running = createVideoImporter({ spawner: slowSpawner(pids) })(rig.request);
    const output = join(tmp(), "work-1.media");
    // The encode is under way once the file has grown past its first bytes.
    await until(async () => (await sizeOf(output)) > 0);
    const first = await sizeOf(output);
    await until(async () => (await sizeOf(output)) > first);
    rig.controller.abort();
    expect(await running).toEqual({ ok: false, reason: "cancelled" });
    expect(pids).toHaveLength(1);
    expect(gone(pids[0] ?? 0)).toBe(true);
    const after = await sizeOf(output);
    await sleep(300);
    expect(await sizeOf(output)).toBe(after);
    expect(rig.released).toContain(output);
  });

  test("an abort before the importer starts spawns nothing and asks for no work file", async () => {
    const pids: number[] = [];
    const staged = await stage(tmp(), "h264-sdr-chart.mp4");
    const rig = requestFor(tmp(), staged);
    rig.controller.abort();
    expect(await createVideoImporter({ spawner: slowSpawner(pids) })(rig.request)).toEqual({ ok: false, reason: "cancelled" });
    expect(pids).toEqual([]);
    expect(rig.workFiles).toEqual([]);
  });

  test("an encode that runs past its wall-clock limit is killed, and is a failed import", async () => {
    const pids: number[] = [];
    const staged = await stage(tmp(), "h264-vfr.mp4");
    const rig = requestFor(tmp(), staged);
    const outcome = await createVideoImporter({ spawner: slowSpawner(pids), timeoutMs: 400 })(rig.request);
    expect(outcome).toEqual({ ok: false, reason: "failed" });
    expect(pids).toHaveLength(1);
    expect(gone(pids[0] ?? 0)).toBe(true);
    expect(rig.released).toContain(join(tmp(), "work-1.media"));
  });
});

describe("what ffmpeg does with a file that walks clean and is not a clip", () => {
  test("a header with no samples behind it is a failed import with nothing left, and says nothing of ffmpeg's own words", async () => {
    const { buildMp4 } = await import("./video/testing/mp4VideoBuilder");
    const { outcome, rig } = await importFixture(buildMp4({ tracks: [{ handler: "vide", entry: { fourcc: "avc1", width: 64, height: 64 }, stts: [[30, 1000]] }] }));
    expect(outcome).toEqual({ ok: false, reason: "failed" });
    expect(rig.released).toEqual(rig.workFiles.map((file) => file.path));
  });
});
