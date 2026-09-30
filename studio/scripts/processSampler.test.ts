import { describe, expect, test } from "bun:test";
import { isFfmpegCommand, ownedRows, parsePosixPs, parseWindowsSamples, PeakTracker, type ProcSample } from "./processSampler";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// The packaged E2E measures how much memory each render's ffmpeg takes (plan 3a.9, SP1's open item on Windows). These are
// the pure parts: reading `ps` and the Windows sampler's lines, keeping only the ffmpegs that belong to the app under test
// (a developer's machine may run others), and turning a run of samples into a peak per render.

const MIB = 1024 * 1024;

describe("isFfmpegCommand", () => {
  test("recognises the bundled ffmpeg by its package folder, unpacked from the asar or not, on either OS's separators", () => {
    expect(isFfmpegCommand("/Users/a/Studio E2E.app/Contents/Resources/app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg -hide_banner -i x.jpg")).toBe(true);
    expect(isFfmpegCommand("C:\\run\\resources\\app.asar.unpacked\\node_modules\\ffmpeg-static\\ffmpeg.exe -hide_banner")).toBe(true);
    expect(isFfmpegCommand("/repo/node_modules/ffmpeg-static/ffmpeg")).toBe(true);
  });

  test("does not take ffprobe, the app itself or a shell that merely mentions ffmpeg", () => {
    expect(isFfmpegCommand("/repo/node_modules/ffprobe-static/bin/darwin/arm64/ffprobe -v error x.mp4")).toBe(false);
    expect(isFfmpegCommand("/Applications/Studio.app/Contents/MacOS/Studio --user-data-dir=/tmp/ffmpeg-static")).toBe(false);
    expect(isFfmpegCommand("/bin/zsh -c grep ffmpeg")).toBe(false);
  });
});

describe("parsePosixPs", () => {
  test("reads pid, parent and resident size (ps prints KiB) of the ffmpeg rows, and every process's parent", () => {
    const out = [
      "  101     1  2048 /bin/zsh -l",
      "  202   101 710000 /repo/node_modules/ffmpeg-static/ffmpeg -hide_banner -filter_complex a;b",
      "  303   202  4096 /repo/node_modules/ffprobe-static/bin/darwin/arm64/ffprobe x",
      "",
    ].join("\n");

    const sample = parsePosixPs(out);

    expect(sample.rows).toEqual([{ pid: 202, ppid: 101, rssBytes: 710_000 * 1024, peakBytes: null }]);
    expect([...sample.parents]).toEqual([[101, 1], [202, 101], [303, 202]]);
  });

  test("skips a line that is not a process row, instead of throwing", () => {
    expect(parsePosixPs("PID PPID RSS COMMAND\nnot a row\n")).toEqual({ rows: [], parents: new Map() });
  });
});

describe("parseWindowsSamples", () => {
  test("splits the sampler's output at its separator lines: an ffmpeg line has pid, parent, working set and peak, a `P` line is any process's parent", () => {
    const out = ["P 4 0", "11 4 1048576 2097152", "--", "P 4 0", "--", "12 4 3145728 5242880", "13 12 1000 2000", "P 12 4", "--"].join("\r\n");

    expect(parseWindowsSamples(out)).toEqual([
      { rows: [{ pid: 11, ppid: 4, rssBytes: 1 * MIB, peakBytes: 2 * MIB }], parents: new Map([[4, 0]]) },
      { rows: [], parents: new Map([[4, 0]]) },
      {
        rows: [
          { pid: 12, ppid: 4, rssBytes: 3 * MIB, peakBytes: 5 * MIB },
          { pid: 13, ppid: 12, rssBytes: 1000, peakBytes: 2000 },
        ],
        parents: new Map([[12, 4]]),
      },
    ]);
  });

  test("drops a last sample that was cut off before its separator, since it may hold half the processes", () => {
    expect(parseWindowsSamples("11 4 1 2\n--\n12 4 3 4\n")).toEqual([{ rows: [{ pid: 11, ppid: 4, rssBytes: 1, peakBytes: 2 }], parents: new Map() }]);
  });

  test("ignores a line that is not numbers (PowerShell's own noise), and reads a missing peak as none", () => {
    expect(parseWindowsSamples("WARNING: something\n11 4 1 \n--\n")).toEqual([{ rows: [{ pid: 11, ppid: 4, rssBytes: 1, peakBytes: null }], parents: new Map() }]);
  });
});

describe("ownedRows", () => {
  const sample = (rows: ProcSample["rows"], parents: [number, number][]): ProcSample => ({ rows, parents: new Map(parents) });
  const ffmpeg = (pid: number, ppid: number) => ({ pid, ppid, rssBytes: 100, peakBytes: null });

  test("keeps an ffmpeg that descends from the app through the engine, and drops one that does not", () => {
    // app 10 -> engine 20 -> ffmpeg 30; somebody else's shell 50 -> ffmpeg 60
    const s = sample([ffmpeg(30, 20), ffmpeg(60, 50)], [[20, 10], [30, 20], [50, 1], [60, 50]]);

    expect(ownedRows(s, 10).map((r) => r.pid)).toEqual([30]);
  });

  test("takes an ffmpeg whose parent is the app itself", () => {
    expect(ownedRows(sample([ffmpeg(30, 10)], []), 10).map((r) => r.pid)).toEqual([30]);
  });

  test("does not loop forever on a parent chain that cycles", () => {
    expect(ownedRows(sample([ffmpeg(30, 40)], [[40, 30]]), 10)).toEqual([]);
  });

  test("an orphan whose parent is gone belongs to nobody, so a survivor of a killed engine is not counted here (the smoke follows its pid instead)", () => {
    expect(ownedRows(sample([ffmpeg(30, 20)], []), 10)).toEqual([]);
  });
});

describe("PeakTracker", () => {
  test("reports, for a time window, the largest single process and the most the ffmpegs held together", () => {
    const tracker = new PeakTracker();
    tracker.record(100, [{ pid: 1, ppid: 0, rssBytes: 300 * MIB, peakBytes: null }]);
    tracker.record(200, [
      { pid: 1, ppid: 0, rssBytes: 400 * MIB, peakBytes: null },
      { pid: 2, ppid: 0, rssBytes: 200 * MIB, peakBytes: null },
    ]);
    tracker.record(300, [{ pid: 2, ppid: 0, rssBytes: 100 * MIB, peakBytes: null }]);

    expect(tracker.between(0, 1000)).toEqual({ peakSingleBytes: 400 * MIB, peakConcurrentBytes: 600 * MIB, samples: 3 });
  });

  test("keeps samples outside the window out of it", () => {
    const tracker = new PeakTracker();
    tracker.record(100, [{ pid: 1, ppid: 0, rssBytes: 900 * MIB, peakBytes: null }]);
    tracker.record(500, [{ pid: 2, ppid: 0, rssBytes: 100 * MIB, peakBytes: null }]);

    expect(tracker.between(400, 600)).toEqual({ peakSingleBytes: 100 * MIB, peakConcurrentBytes: 100 * MIB, samples: 1 });
  });

  test("reads a process's own recorded peak when it is higher than what the sample caught", () => {
    const tracker = new PeakTracker();
    tracker.record(100, [{ pid: 1, ppid: 0, rssBytes: 100 * MIB, peakBytes: 700 * MIB }]);

    expect(tracker.between(0, 1000)).toEqual({ peakSingleBytes: 700 * MIB, peakConcurrentBytes: 100 * MIB, samples: 1 });
  });

  test("a window with no sample is zero samples, not a made-up number", () => {
    expect(new PeakTracker().between(0, 1000)).toEqual({ peakSingleBytes: 0, peakConcurrentBytes: 0, samples: 0 });
  });

  test("counts a sample with no ffmpeg as a sample of zero, so a render that spawned none shows as zero and not as unmeasured", () => {
    const tracker = new PeakTracker();
    tracker.record(100, []);

    expect(tracker.between(0, 1000)).toEqual({ peakSingleBytes: 0, peakConcurrentBytes: 0, samples: 1 });
  });
});
