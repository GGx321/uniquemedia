import { describe, expect, test } from "bun:test";
import { isFfmpegCommand, parsePosixPs, parseWindowsSamples, PeakTracker } from "./processSampler";

// The packaged E2E measures how much memory each render's ffmpeg takes (plan 3a.9, SP1's open item on Windows). These are
// the pure parts: reading `ps` and the Windows sampler's lines, and turning a run of samples into a peak per render.

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
  test("reads pid and resident size (ps prints KiB) of the ffmpeg rows only", () => {
    const out = [
      "  101  2048 /bin/zsh -l",
      "  202 710000 /repo/node_modules/ffmpeg-static/ffmpeg -hide_banner -filter_complex a;b",
      "  303  4096 /repo/node_modules/ffprobe-static/bin/darwin/arm64/ffprobe x",
      "",
    ].join("\n");

    expect(parsePosixPs(out)).toEqual([{ pid: 202, rssBytes: 710_000 * 1024, peakBytes: null }]);
  });

  test("skips a line that is not a process row, instead of throwing", () => {
    expect(parsePosixPs("PID RSS COMMAND\nnot a row\n")).toEqual([]);
  });
});

describe("parseWindowsSamples", () => {
  test("splits the sampler's output at its separator lines, reading working set and peak working set per ffmpeg", () => {
    const out = ["11 1048576 2097152", "--", "--", "12 3145728 5242880", "13 1000 2000", "--"].join("\r\n");

    expect(parseWindowsSamples(out)).toEqual([
      [{ pid: 11, rssBytes: 1 * MIB, peakBytes: 2 * MIB }],
      [],
      [
        { pid: 12, rssBytes: 3 * MIB, peakBytes: 5 * MIB },
        { pid: 13, rssBytes: 1000, peakBytes: 2000 },
      ],
    ]);
  });

  test("drops a last sample that was cut off before its separator, since it may hold half the processes", () => {
    expect(parseWindowsSamples("11 1 2\n--\n12 3 4\n")).toEqual([[{ pid: 11, rssBytes: 1, peakBytes: 2 }]]);
  });

  test("ignores a line that is not numbers (PowerShell's own noise)", () => {
    expect(parseWindowsSamples("WARNING: something\n11 1 2\n--\n")).toEqual([[{ pid: 11, rssBytes: 1, peakBytes: 2 }]]);
  });
});

describe("PeakTracker", () => {
  test("reports, for a time window, the largest single process and the most the ffmpegs held together", () => {
    const tracker = new PeakTracker();
    tracker.record(100, [{ pid: 1, rssBytes: 300 * MIB, peakBytes: null }]);
    tracker.record(200, [
      { pid: 1, rssBytes: 400 * MIB, peakBytes: null },
      { pid: 2, rssBytes: 200 * MIB, peakBytes: null },
    ]);
    tracker.record(300, [{ pid: 2, rssBytes: 100 * MIB, peakBytes: null }]);

    expect(tracker.between(0, 1000)).toEqual({ peakSingleBytes: 400 * MIB, peakConcurrentBytes: 600 * MIB, samples: 3 });
  });

  test("keeps samples outside the window out of it", () => {
    const tracker = new PeakTracker();
    tracker.record(100, [{ pid: 1, rssBytes: 900 * MIB, peakBytes: null }]);
    tracker.record(500, [{ pid: 2, rssBytes: 100 * MIB, peakBytes: null }]);

    expect(tracker.between(400, 600)).toEqual({ peakSingleBytes: 100 * MIB, peakConcurrentBytes: 100 * MIB, samples: 1 });
  });

  test("reads a process's own recorded peak when it is higher than what the sample caught", () => {
    const tracker = new PeakTracker();
    tracker.record(100, [{ pid: 1, rssBytes: 100 * MIB, peakBytes: 700 * MIB }]);

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
