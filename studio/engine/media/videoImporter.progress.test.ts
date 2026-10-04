import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import type { runFfmpegArgv } from "../../node/runFfmpeg";
import { tempDirFor } from "../../testing/tempDir";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import type { MediaImportRequest } from "./imports";
import { requestFor, stage } from "./video/testing/importKit";
import { buildMp4, type ColrSpec } from "./video/testing/mp4VideoBuilder";
import { createVideoImporter } from "./videoImporter";
useNativeGlobals();

// 3f.6: the video importer tells the job how far its ffmpeg has got: the planned frames as the total (from the walker's own reading, `expectedFrames`),
// what the probe judged, and ffmpeg's `-progress` frames as the steps. ffmpeg is a fake here that reports the frames a test says; the real one is in
// videoImporter.short.ffmpeg.test.ts.

const tmp = tempDirFor({ beforeEach, afterEach }, "studio-video-progress-");

type Run = typeof runFfmpegArgv;

const BT709: ColrSpec = { type: "nclx", primaries: 1, transfer: 1, matrix: 1 };
const HLG: ColrSpec = { type: "nclx", primaries: 9, transfer: 18, matrix: 9 };

/** A source of `frames` samples of `ticks` of 30000 each (1000 is 30 fps), 192 x 96. */
const source = (frames: number, ticks: number, colr: ColrSpec = BT709, fourcc = "avc1"): Uint8Array =>
  buildMp4({ tracks: [{ handler: "vide", entry: { fourcc, width: 192, height: 96, colr }, mdhdTimescale: 30000, stts: [[frames, ticks]] }] });

/** What the plan asks of the mezzanine of a 192 x 96 source: the same size, BT.709 limited, 30 fps. */
const mezzanine = (frames: number): Uint8Array => source(frames, 1000);

/** Every call of the importer's reporter and of the fake ffmpeg, in the order they happened. */
interface Log {
  readonly lines: string[];
  readonly begins: { total: number; judged: unknown }[];
  readonly reports: number[];
}

function reporterLog(): { log: Log; prepare: NonNullable<MediaImportRequest["prepare"]> } {
  const log: Log = { lines: [], begins: [], reports: [] };
  return {
    log,
    prepare: {
      begin: (total, judged) => {
        log.lines.push("begin");
        log.begins.push({ total, judged });
      },
      report: (done) => {
        log.lines.push(`report ${done}`);
        log.reports.push(done);
      },
    },
  };
}

/** A fake ffmpeg that reports `frames` through `onFrames`, then writes `made` as the file it made. */
function fakeRun(log: Log, frames: number[], made: Uint8Array): Run {
  return async (options) => {
    log.lines.push("ffmpeg starts");
    for (const n of frames) options.onFrames?.(n);
    await writeFile(options.output, made);
  };
}

async function importWith(input: Uint8Array, run: Run, prepare: MediaImportRequest["prepare"]) {
  const rig = requestFor(tmp(), await stage(tmp(), input));
  return createVideoImporter({ run })({ ...rig.request, prepare });
}

describe("what the video importer says of its work", () => {
  test("begins with the frames the walker planned, once, BEFORE ffmpeg starts", async () => {
    const { log, prepare } = reporterLog();
    // 60 samples at 30 fps: the walker's range is two frames either way, and the plan's total is its middle.
    await importWith(source(60, 1000), fakeRun(log, [], mezzanine(60)), prepare);
    expect(log.begins).toHaveLength(1);
    expect(log.begins[0]?.total).toBe(60);
    expect(log.lines.indexOf("begin")).toBeLessThan(log.lines.indexOf("ffmpeg starts"));
  });

  test("plans the output's frames at 30 fps, not the source's: a 2 s clip at 60 fps is 60 output frames, not 120", async () => {
    const { log, prepare } = reporterLog();
    await importWith(source(120, 500), fakeRun(log, [], mezzanine(60)), prepare);
    expect(log.begins[0]?.total).toBe(60);
  });

  test("says what the probe judged: a clip at 30 fps in SDR has nothing to convert", async () => {
    const { log, prepare } = reporterLog();
    await importWith(source(60, 1000), fakeRun(log, [], mezzanine(60)), prepare);
    expect(log.begins[0]?.judged).toEqual({ hdrToSdr: false, fromFps: null });
  });

  test("says what the probe judged: an HDR clip at another rate is tone-mapped and converted from its own rate", async () => {
    const { log, prepare } = reporterLog();
    await importWith(source(60, 1500, HLG, "hvc1"), fakeRun(log, [], mezzanine(90)), prepare);
    expect(log.begins[0]?.judged).toEqual({ hdrToSdr: true, fromFps: 20 });
  });

  test("passes ffmpeg's frames on, in order, as they come", async () => {
    const { log, prepare } = reporterLog();
    await importWith(source(60, 1000), fakeRun(log, [10, 25, 59], mezzanine(60)), prepare);
    expect(log.reports).toEqual([10, 25, 59]);
    // The steps are between the begin and the end of ffmpeg's run.
    expect(log.lines.slice(0, 2)).toEqual(["begin", "ffmpeg starts"]);
  });

  test("works with no reporter at all: the job of a caller that has none", async () => {
    const log: Log = { lines: [], begins: [], reports: [] };
    const outcome = await importWith(source(60, 1000), fakeRun(log, [5], mezzanine(60)), undefined);
    expect(outcome.ok).toBe(true);
  });

  test("a reporter that throws does not fail the import or kill ffmpeg", async () => {
    const log: Log = { lines: [], begins: [], reports: [] };
    const throwing: NonNullable<MediaImportRequest["prepare"]> = {
      begin: () => {
        throw new Error("begin broke");
      },
      report: () => {
        throw new Error("report broke");
      },
    };
    const outcome = await importWith(source(60, 1000), fakeRun(log, [5, 9], mezzanine(60)), throwing);
    expect(outcome.ok).toBe(true);
    expect(log.lines).toEqual(["ffmpeg starts"]);
  });

  test("a file the walker refuses never begins a stage: nothing was planned", async () => {
    const { log, prepare } = reporterLog();
    const twoTracks = buildMp4({
      tracks: [
        { handler: "vide", entry: { fourcc: "avc1", width: 192, height: 96, colr: BT709 }, mdhdTimescale: 30000, stts: [[60, 1000]] },
        { handler: "vide", entry: { fourcc: "avc1", width: 192, height: 96, colr: BT709 }, mdhdTimescale: 30000, stts: [[60, 1000]] },
      ],
    });
    const outcome = await importWith(twoTracks, fakeRun(log, [], mezzanine(60)), prepare);
    expect(outcome.ok).toBe(false);
    expect(log.lines).toEqual([]);
  });
});
