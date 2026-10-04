import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { copyFile, writeFile } from "node:fs/promises";
import { buildMp4, MATRIX, type ColrSpec, type TrackSpec, type VideoEntrySpec } from "./video/testing/mp4VideoBuilder";
import { FfmpegError, type runFfmpegArgv } from "../../node/runFfmpeg";
import { tempDirFor } from "../../testing/tempDir";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { requestFor, stage } from "./video/testing/importKit";
import { FIXTURES } from "./video/testing/fixtures/index";
import { createVideoImporter } from "./videoImporter";
useNativeGlobals();

// 3f.3a: the importer's own decisions, with ffmpeg replaced by a fake that writes what a test says. What it checks of the file ffmpeg wrote,
// what it asks ffmpeg for, and what it lets out when ffmpeg fails.

const tmp = tempDirFor({ beforeEach, afterEach }, "studio-video-importer-");

type Run = typeof runFfmpegArgv;
type RunOptions = Parameters<Run>[0];

describe("what it asks ffmpeg for", () => {
  test("the staged copy as the one input, the work file as the one output, the plan's own limit and the job's signal", async () => {
    const calls: RunOptions[] = [];
    const run: Run = async (options) => {
      calls.push(options);
      await copyFile(FIXTURES["h264-sdr-chart.mp4"].file, options.output);
    };
    const staged = await stage(tmp(), "h264-sdr-chart.mp4");
    const rig = requestFor(tmp(), staged);
    await createVideoImporter({ run })(rig.request);
    const call = calls[0];
    if (call === undefined) throw new Error("ffmpeg was never asked");
    expect(call.argv.at(-1)).toBe(call.output);
    expect(call.output).toBe(rig.workFiles[0]?.path);
    expect(call.argv[call.argv.indexOf("-i") + 1]).toBe(staged.path);
    expect(call.signal).toBe(rig.controller.signal);
    expect(call.timeoutMs).toBeGreaterThanOrEqual(60_000);
    expect(call.argv).toContain("-protocol_whitelist");
    expect(rig.workFiles).toHaveLength(1);
  });

  test("a wall-clock limit given to the importer replaces the plan's", async () => {
    const calls: RunOptions[] = [];
    const run: Run = async (options) => void calls.push(options);
    const rig = requestFor(tmp(), await stage(tmp(), "h264-sdr-chart.mp4"));
    await createVideoImporter({ run, timeoutMs: 1234 })(rig.request);
    expect(calls[0]?.timeoutMs).toBe(1234);
  });
});

describe("what it checks of the file ffmpeg wrote", () => {
  async function outcomeWhenFfmpegWrites(fixture: keyof typeof FIXTURES | null) {
    const run: Run = async (options) => {
      if (fixture !== null) await copyFile(FIXTURES[fixture].file, options.output);
    };
    const rig = requestFor(tmp(), await stage(tmp(), "h264-sdr-chart.mp4"));
    return { outcome: await createVideoImporter({ run })(rig.request), rig };
  }

  test("a file with the sound track still in it is a failed import, and its work file is released", async () => {
    // The SDR fixture is 192 x 96 H.264 BT.709 and so passes every check but this one: it has an audio track.
    const { outcome, rig } = await outcomeWhenFfmpegWrites("h264-sdr-chart.mp4");
    expect(outcome).toEqual({ ok: false, reason: "failed" });
    expect(rig.released).toEqual([rig.workFiles[0]?.path ?? ""]);
  });

  test("a file of another size than the plan's is a failed import", async () => {
    const { outcome } = await outcomeWhenFfmpegWrites("h264-vfr.mp4");
    expect(outcome).toEqual({ ok: false, reason: "failed" });
  });

  test("a file that is not tagged BT.709 limited range (an HEVC HLG clip passed through) is a failed import", async () => {
    const { outcome } = await outcomeWhenFfmpegWrites("hevc-hlg-chart.mp4");
    expect(outcome).toEqual({ ok: false, reason: "failed" });
  });

  test("a variable-rate file is a failed import", async () => {
    const { outcome } = await outcomeWhenFfmpegWrites("hevc-hlg-rotated-vfr.mov");
    expect(outcome).toEqual({ ok: false, reason: "failed" });
  });

  test("no file at all is a failed import", async () => {
    const { outcome, rig } = await outcomeWhenFfmpegWrites(null);
    expect(outcome).toEqual({ ok: false, reason: "failed" });
    expect(rig.released).toHaveLength(1);
  });
});

describe("what it checks of the file ffmpeg wrote, one property at a time", () => {
  // A file that has every property the plan asks of the mezzanine of the SDR fixture (192 x 96), built box by box; each test spoils one.
  const colour = { type: "nclx", primaries: 1, transfer: 1, matrix: 1 } as const;
  const good = (over: Partial<TrackSpec> = {}, entry: Partial<VideoEntrySpec> = {}, extraTracks: TrackSpec[] = []): Uint8Array =>
    buildMp4({ tracks: [{ handler: "vide", entry: { fourcc: "avc1", width: 192, height: 96, colr: colour, ...entry }, mdhdTimescale: 30000, stts: [[5, 1000]], ...over }, ...extraTracks] });

  async function outcomeOf(bytes: Uint8Array) {
    const run: Run = async (options) => writeFile(options.output, bytes);
    const rig = requestFor(tmp(), await stage(tmp(), "h264-sdr-chart.mp4"));
    return createVideoImporter({ run })(rig.request);
  }

  test("the file with every property is taken (so each refusal below is its one spoiled property)", async () => {
    const outcome = await outcomeOf(good());
    expect(outcome.ok).toBe(true);
  });

  test("a turned file is refused: a clip turned here and marked turned would be turned twice", async () => {
    expect(await outcomeOf(good({ matrix: MATRIX.r90 }))).toEqual({ ok: false, reason: "failed" });
  });

  test("a file in another codec is refused", async () => {
    expect(await outcomeOf(good({}, { fourcc: "hvc1" }))).toEqual({ ok: false, reason: "failed" });
  });

  test("a file with an HDR transfer is refused", async () => {
    expect(await outcomeOf(good({}, { fourcc: "avc1", colr: { type: "nclx", primaries: 9, transfer: 18, matrix: 9 } }))).toEqual({ ok: false, reason: "failed" });
  });

  test("a file in full range is refused", async () => {
    expect(await outcomeOf(good({}, { colr: { ...colour, fullRange: true } }))).toEqual({ ok: false, reason: "failed" });
  });

  test("a file with no colour tags is refused", async () => {
    expect(await outcomeOf(good({}, { colr: [] }))).toEqual({ ok: false, reason: "failed" });
  });

  test("a file at another constant rate is refused", async () => {
    expect(await outcomeOf(good({ stts: [[5, 1200]] }))).toEqual({ ok: false, reason: "failed" });
  });

  test("a file of more frames than three minutes holds is refused", async () => {
    expect(await outcomeOf(good({ stts: [[5402, 1000]] }))).toEqual({ ok: false, reason: "failed" });
  });

  test("a file that is only the wrong width is refused (everything else as planned)", async () => {
    expect(await outcomeOf(good({}, { width: 194 }))).toEqual({ ok: false, reason: "failed" });
  });

  test("a file that is only the wrong height is refused", async () => {
    expect(await outcomeOf(good({}, { height: 98 }))).toEqual({ ok: false, reason: "failed" });
  });

  test("a file at the right constant average rate that is not constant is refused", async () => {
    // 5 samples averaging 1000 ticks of 30000: 30.0 fps by the average, but the lengths swing between 500 and 1500.
    const stts: [number, number][] = [[1, 1500], [1, 500], [1, 1500], [1, 500], [1, 1000]];
    expect(await outcomeOf(good({ stts }))).toEqual({ ok: false, reason: "failed" });
  });

  test("a picture of 1280 or more on its long side with no colour tags is refused (the walker's default for it is BT.709, and only `tagged` says it was not written)", async () => {
    // The input is 1080 x 1920, so the plan is 1080 x 1920 and every property of the fake output is as planned, bar its tags.
    const input = buildMp4({ tracks: [{ handler: "vide", entry: { fourcc: "avc1", width: 1080, height: 1920, colr: colour }, mdhdTimescale: 30000, stts: [[5, 1000]] }] });
    const output = (colourBoxes: ColrSpec[]): Uint8Array => buildMp4({ tracks: [{ handler: "vide", entry: { fourcc: "avc1", width: 1080, height: 1920, colr: colourBoxes }, mdhdTimescale: 30000, stts: [[5, 1000]] }] });
    const run = (bytes: Uint8Array): Run => async (options) => writeFile(options.output, bytes);
    const outcomeFor = async (bytes: Uint8Array) => createVideoImporter({ run: run(bytes) })(requestFor(tmp(), await stage(tmp(), input)).request);
    expect((await outcomeFor(output([colour]))).ok).toBe(true);
    expect(await outcomeFor(output([]))).toEqual({ ok: false, reason: "failed" });
  });

  test("the frame count must be the plan's length at 30 fps, within two frames: a decode of another stream than the one judged is caught here", async () => {
    // The plan is 5 samples over 5/30 s: 5 frames expected.
    expect((await outcomeOf(good({ stts: [[7, 1000]] }))).ok).toBe(true);
    expect((await outcomeOf(good({ stts: [[3, 1000]] }))).ok).toBe(true);
    expect(await outcomeOf(good({ stts: [[8, 1000]] }))).toEqual({ ok: false, reason: "failed" });
    expect(await outcomeOf(good({ stts: [[2, 1000]] }))).toEqual({ ok: false, reason: "failed" });
  });

  test("a file with a sound track is refused", async () => {
    expect(await outcomeOf(good({}, {}, [{ handler: "soun" }]))).toEqual({ ok: false, reason: "failed" });
  });
});

describe("what it lets out when ffmpeg fails", () => {
  test("only a reason: nothing of ffmpeg's own words or of a path reaches the answer", async () => {
    const run: Run = async () => {
      throw new FfmpegError("ffmpeg exited with code 1", 1, "/Users/owner/Secret Folder/holiday.mov: Invalid data found when processing input");
    };
    const rig = requestFor(tmp(), await stage(tmp(), "h264-sdr-chart.mp4"));
    const outcome = await createVideoImporter({ run })(rig.request);
    expect(outcome).toEqual({ ok: false, reason: "failed" });
    expect(JSON.stringify(outcome)).not.toContain("Secret");
    expect(rig.released).toHaveLength(1);
  });

  test("a cancel that ffmpeg reports as its own failure is still a cancel", async () => {
    const rig = requestFor(tmp(), await stage(tmp(), "h264-sdr-chart.mp4"));
    const run: Run = async () => {
      rig.controller.abort();
      throw new Error("killed");
    };
    expect(await createVideoImporter({ run })(rig.request)).toEqual({ ok: false, reason: "cancelled" });
    expect(rig.released).toHaveLength(1);
  });

  test("a cancel that lands as ffmpeg finishes throws the finished file away", async () => {
    const rig = requestFor(tmp(), await stage(tmp(), "h264-sdr-chart.mp4"));
    const run: Run = async (options) => {
      await copyFile(FIXTURES["h264-sdr-chart.mp4"].file, options.output);
      rig.controller.abort();
    };
    expect(await createVideoImporter({ run })(rig.request)).toEqual({ ok: false, reason: "cancelled" });
    expect(rig.released).toHaveLength(1);
  });
});
