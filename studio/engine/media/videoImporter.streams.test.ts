import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import type { runFfmpegArgv } from "../../node/runFfmpeg";
import { tempDirFor } from "../../testing/tempDir";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import type { MediaImportRequest } from "./imports";
import { requestFor, stage } from "./video/testing/importKit";
import { buildMp4, type ColrSpec } from "./video/testing/mp4VideoBuilder";
import { ProbeError } from "./audioProbe";
import type { VideoStreamsVerdict } from "./video/videoStreams";
import { createVideoImporter, type VideoImporterOptions } from "./videoImporter";
useNativeGlobals();

// 3f.6 review, H1 (round 2), layer 2 in the importer: before it encodes, the importer asks ffmpeg (`checkVideoStreams`) whether the file has exactly the one video stream the
// walker judged. A verdict of several is `structure` (the owner's file has more than one video), a mismatch is `failed`, and nothing is made or announced for either.

const tmp = tempDirFor({ beforeEach, afterEach }, "studio-video-streams-importer-");
type Run = typeof runFfmpegArgv;
type Check = NonNullable<VideoImporterOptions["streamCheck"]>;

const BT709: ColrSpec = { type: "nclx", primaries: 1, transfer: 1, matrix: 1 };
const source = (frames = 60): Uint8Array => buildMp4({ tracks: [{ handler: "vide", entry: { fourcc: "avc1", width: 192, height: 96, colr: BT709 }, mdhdTimescale: 30000, stts: [[frames, 1000]] }] });

async function importWith(check: Check) {
  const calls: { path: string; expected: unknown }[] = [];
  let asked = 0;
  let begins = 0;
  const run: Run = async (o) => {
    asked++;
    await writeFile(o.output, source());
  };
  const rig = requestFor(tmp(), await stage(tmp(), source()));
  const prepare: MediaImportRequest["prepare"] = { begin: () => void begins++, report: () => undefined };
  const outcome = await createVideoImporter({
    run,
    streamCheck: async (options) => {
      calls.push({ path: options.path, expected: options.expected });
      return check(options);
    },
  })({ ...rig.request, prepare });
  return { outcome, calls, asked: () => asked, begins: () => begins, rig };
}

const says = (verdict: VideoStreamsVerdict): Check => async () => verdict;

describe("the importer asks ffmpeg before it encodes", () => {
  test("it asks about the STAGED copy and the clip the walker judged: its codec and its size", async () => {
    const done = await importWith(says("ok"));
    expect(done.calls).toHaveLength(1);
    expect(done.calls[0]?.path).toBe(done.rig.request.staged.path);
    expect(done.calls[0]?.expected).toEqual({ codec: "h264", width: 192, height: 96 });
  });

  test("ok: it goes on and imports", async () => {
    const done = await importWith(says("ok"));
    expect(done.outcome.ok).toBe(true);
    expect(done.asked()).toBe(1);
  });

  test("several: refused as structure, nothing encoded, nothing announced, no work file made", async () => {
    const done = await importWith(says("several"));
    expect(done.outcome).toEqual({ ok: false, reason: "structure" });
    expect(done.asked()).toBe(0);
    expect(done.begins()).toBe(0);
    expect(done.rig.workFiles).toEqual([]);
  });

  test("mismatch: refused as failed, nothing encoded", async () => {
    const done = await importWith(says("mismatch"));
    expect(done.outcome).toEqual({ ok: false, reason: "failed" });
    expect(done.asked()).toBe(0);
    expect(done.rig.workFiles).toEqual([]);
  });

  test("a probe that cannot run is a plain failure, never a pass", async () => {
    const done = await importWith(async () => {
      throw new ProbeError("spawn");
    });
    expect(done.outcome).toEqual({ ok: false, reason: "failed" });
    expect(done.asked()).toBe(0);
  });

  test("a cancel that lands during the check is a cancel", async () => {
    const rig = requestFor(tmp(), await stage(tmp(), source()));
    const outcome = await createVideoImporter({
      run: async () => undefined,
      streamCheck: async () => {
        rig.controller.abort(new Error("stopped"));
        throw new ProbeError("aborted");
      },
    })(rig.request);
    expect(outcome).toEqual({ ok: false, reason: "cancelled" });
  });

  test("a file the walker refuses is not asked about: nothing was judged", async () => {
    let asked = 0;
    const rig = requestFor(tmp(), await stage(tmp(), new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])));
    const outcome = await createVideoImporter({
      run: async () => undefined,
      streamCheck: async () => {
        asked++;
        return "ok";
      },
    })(rig.request);
    expect(outcome.ok).toBe(false);
    expect(asked).toBe(0);
  });

  test("a clip too short for any montage is refused before the check, as before", async () => {
    let asked = 0;
    const rig = requestFor(tmp(), await stage(tmp(), source(5)));
    const outcome = await createVideoImporter({
      run: async () => undefined,
      streamCheck: async () => {
        asked++;
        return "ok";
      },
    })(rig.request);
    expect(outcome).toEqual({ ok: false, reason: "too-short" });
    expect(asked).toBe(0);
  });
});
