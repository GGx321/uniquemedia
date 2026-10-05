import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { copyFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { FfmpegError, type runFfmpegArgv } from "../../node/runFfmpeg";
import { tempDirFor } from "../../testing/tempDir";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { FIXTURES } from "./video/testing/fixtures/index";
import { createVideoImporterForShortClips as createVideoImporter, requestFor, stage } from "./video/testing/importKit";
useNativeGlobals();

// M1 of the Stage 3 whole-slice review: the copy was checked for room, the mezzanine the importer writes was not. The importer asks for the worst
// output the encode's own `-fs` allows (the cap plus the muxer's slack) and a margin BEFORE it makes a work file, and a failed encode on a disk with
// no margin left is a full disk, not a wrong file.

const tmp = tempDirFor({ beforeEach, afterEach }, "studio-video-importer-space-");

type Run = typeof runFfmpegArgv;
const CAP = 1_000;
const SLACK = 100;
const MARGIN = 50;
const FLOOR = 100;
const FULL_LIMIT = CAP + SLACK;
const WORST_CASE = FULL_LIMIT + MARGIN;
const GIB = 1024 ** 3;

const options = (freeBytes: (dir: string) => Promise<number | null>, run: Run) => ({ run, freeBytes, maxStoredBytes: CAP, stopSlackBytes: SLACK, freeMarginBytes: MARGIN, minEncodeBytes: FLOOR });
const fsLimitOf = (call: Parameters<Run>[0] | undefined): number => Number(call?.argv[(call?.argv.indexOf("-fs") ?? 0) + 1]);
const chart = async (): ReturnType<typeof stage> => stage(tmp(), "h264-sdr-chart.mp4");
const copiesChart: Run = async (call) => void (await copyFile(FIXTURES["h264-sdr-chart.mp4"].file, call.output));

describe("room for what the importer writes", () => {
  test("a disk with less than the floor of an encode beyond the margin is refused no-space, before ffmpeg runs or a work file is made", async () => {
    let runs = 0;
    const run: Run = async (call) => {
      runs++;
      await copiesChart(call);
    };
    const rig = requestFor(tmp(), await chart());
    const outcome = await createVideoImporter(options(async () => MARGIN + FLOOR - 1, run))(rig.request);
    expect(outcome).toEqual({ ok: false, reason: "no-space" });
    expect(runs).toBe(0);
    expect(rig.workFiles).toHaveLength(0);
  });

  test("exactly the floor beyond the margin is enough: the encode runs, bounded by what is free", async () => {
    const calls: Parameters<Run>[0][] = [];
    const run: Run = async (call) => {
      calls.push(call);
      await copiesChart(call);
    };
    const rig = requestFor(tmp(), await chart());
    await createVideoImporter(options(async () => MARGIN + FLOOR, run))(rig.request);
    expect(calls).toHaveLength(1);
    expect(fsLimitOf(calls[0])).toBe(FLOOR);
  });

  test("a disk with room for the worst case is not bounded below it: -fs is the cap plus the muxer's slack", async () => {
    const calls: Parameters<Run>[0][] = [];
    const run: Run = async (call) => {
      calls.push(call);
      await copiesChart(call);
    };
    await createVideoImporter(options(async () => WORST_CASE * 10, run))(requestFor(tmp(), await chart()).request);
    expect(fsLimitOf(calls[0])).toBe(FULL_LIMIT);
  });

  test("a disk with less than the worst case but room for the clip bounds -fs by what is free beyond the margin", async () => {
    const calls: Parameters<Run>[0][] = [];
    const run: Run = async (call) => {
      calls.push(call);
      await copiesChart(call);
    };
    await createVideoImporter(options(async () => 600, run))(requestFor(tmp(), await chart()).request);
    expect(fsLimitOf(calls[0])).toBe(600 - MARGIN);
  });

  test("a small clip on a disk with 1 GiB free is imported: the room asked for is not the worst case of a 2 GiB clip", async () => {
    const calls: Parameters<Run>[0][] = [];
    const run: Run = async (call) => {
      calls.push(call);
      await copiesChart(call);
    };
    const outcome = await createVideoImporter({ run, freeBytes: async () => GIB })(requestFor(tmp(), await chart()).request);
    // The fixture is a few frames, not a montage clip: what matters is that the encode ran, and was not turned away for room.
    expect(outcome).not.toEqual({ ok: false, reason: "no-space" });
    expect(calls).toHaveLength(1);
    expect(fsLimitOf(calls[0])).toBe(GIB - 64 * 1024 * 1024);
  });

  test("an encode the space limit stopped below the cap is no-space, and its work file is released", async () => {
    const run: Run = async (call) => {
      await writeFile(call.output, new Uint8Array(550));
      throw new FfmpegError("ffmpeg exited 187", 187, "Error muxing a packet");
    };
    const rig = requestFor(tmp(), await chart());
    const outcome = await createVideoImporter(options(async () => 600, run))(rig.request);
    expect(outcome).toEqual({ ok: false, reason: "no-space" });
    expect(rig.released).toHaveLength(1);
  });

  test("an encode the cap stopped is too-large, not no-space, on a disk with room", async () => {
    const run: Run = async (call) => {
      await writeFile(call.output, new Uint8Array(FULL_LIMIT));
      throw new FfmpegError("ffmpeg exited 187", 187, "Error muxing a packet");
    };
    const outcome = await createVideoImporter(options(async () => WORST_CASE * 10, run))(requestFor(tmp(), await chart()).request);
    expect(outcome).toEqual({ ok: false, reason: "too-large" });
  });

  test("a disk that cannot say how much is free does not stop the encode", async () => {
    let runs = 0;
    const run: Run = async (call) => {
      runs++;
      await copiesChart(call);
    };
    const rig = requestFor(tmp(), await chart());
    await createVideoImporter(options(async () => null, run))(rig.request);
    expect(runs).toBe(1);
  });

  test("the volume asked is the staging folder's: where the work file is made", async () => {
    const asked: string[] = [];
    const staged = await chart();
    const rig = requestFor(tmp(), staged);
    await createVideoImporter(options(async (dir) => (asked.push(dir), null), copiesChart))(rig.request);
    expect(asked[0]).toBe(dirname(staged.path));
  });

  test("an encode that fails on a disk left with less than the margin is no-space, and its work file is released", async () => {
    const answers = [WORST_CASE, 0];
    const run: Run = async (call) => {
      await writeFile(call.output, new Uint8Array(10));
      throw new FfmpegError("ffmpeg exited 1", 1, "No space left on device");
    };
    const rig = requestFor(tmp(), await chart());
    const outcome = await createVideoImporter(options(async () => answers.shift() ?? 0, run))(rig.request);
    expect(outcome).toEqual({ ok: false, reason: "no-space" });
    expect(rig.released).toHaveLength(1);
  });

  test("an encode that fails with the margin still free is a plain failure: the disk is not to blame", async () => {
    const run: Run = async () => {
      throw new FfmpegError("ffmpeg exited 1", 1, "boom");
    };
    const rig = requestFor(tmp(), await chart());
    const outcome = await createVideoImporter(options(async () => WORST_CASE * 10, run))(rig.request);
    expect(outcome).toEqual({ ok: false, reason: "failed" });
  });

  test("a work file at the cap after a failed exit is still too-large, even on a disk that is now full", async () => {
    const answers = [WORST_CASE, 0];
    const run: Run = async (call) => {
      await writeFile(call.output, new Uint8Array(CAP));
      throw new FfmpegError("ffmpeg exited 187", 187, "Error muxing a packet");
    };
    const rig = requestFor(tmp(), await chart());
    const outcome = await createVideoImporter(options(async () => answers.shift() ?? 0, run))(rig.request);
    expect(outcome).toEqual({ ok: false, reason: "too-large" });
  });

  test("an ffmpeg that exits 0 having written exactly the space limit is no-space: the file is cut short, and a cut file is never stored", async () => {
    const run: Run = async (call) => void (await writeFile(call.output, new Uint8Array(600 - MARGIN)));
    const rig = requestFor(tmp(), await chart());
    expect(await createVideoImporter(options(async () => 600, run))(rig.request)).toEqual({ ok: false, reason: "no-space" });
    expect(rig.released).toHaveLength(1);
  });

  test("a space limit between the cap and the cap plus its slack that stops the encode is too-large: the file already is over the cap", async () => {
    // free - margin = 1050: above the cap (1000), below cap + slack (1100).
    const run: Run = async (call) => {
      await writeFile(call.output, new Uint8Array(1050));
      throw new FfmpegError("ffmpeg exited 187", 187, "Error muxing a packet");
    };
    const outcome = await createVideoImporter(options(async () => 1050 + MARGIN, run))(requestFor(tmp(), await chart()).request);
    expect(outcome).toEqual({ ok: false, reason: "too-large" });
  });

  test("ffmpeg's own «No space left on device» is no-space even on a disk that still says it has room, and its text goes nowhere", async () => {
    const run: Run = async (call) => {
      await writeFile(call.output, new Uint8Array(10));
      throw new FfmpegError("ffmpeg exited 1", 1, "av_interleaved_write_frame(): No space left on device");
    };
    const rig = requestFor(tmp(), await chart());
    const outcome = await createVideoImporter(options(async () => WORST_CASE * 10, run))(rig.request);
    expect(outcome).toEqual({ ok: false, reason: "no-space" });
    expect(JSON.stringify(outcome)).not.toContain("av_interleaved");
  });
});
