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
const WORST_CASE = CAP + SLACK + MARGIN;

const options = (freeBytes: (dir: string) => Promise<number | null>, run: Run) => ({ run, freeBytes, maxStoredBytes: CAP, stopSlackBytes: SLACK, freeMarginBytes: MARGIN });
const chart = async (): ReturnType<typeof stage> => stage(tmp(), "h264-sdr-chart.mp4");
const copiesChart: Run = async (call) => void (await copyFile(FIXTURES["h264-sdr-chart.mp4"].file, call.output));

describe("room for what the importer writes", () => {
  test("a disk with less than the worst-case mezzanine and the margin free is refused no-space, before ffmpeg runs or a work file is made", async () => {
    let runs = 0;
    const run: Run = async (call) => {
      runs++;
      await copiesChart(call);
    };
    const rig = requestFor(tmp(), await chart());
    const outcome = await createVideoImporter(options(async () => WORST_CASE - 1, run))(rig.request);
    expect(outcome).toEqual({ ok: false, reason: "no-space" });
    expect(runs).toBe(0);
    expect(rig.workFiles).toHaveLength(0);
  });

  test("exactly the worst case and the margin free is enough: the encode runs", async () => {
    let runs = 0;
    const run: Run = async (call) => {
      runs++;
      await copiesChart(call);
    };
    const rig = requestFor(tmp(), await chart());
    await createVideoImporter(options(async () => WORST_CASE, run))(rig.request);
    expect(runs).toBe(1);
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
});
