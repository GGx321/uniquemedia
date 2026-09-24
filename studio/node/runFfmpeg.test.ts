import { test, expect, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ffmpegPath, unpackAsarSegment, __setFfmpegPathOverrideForTests } from "./ffmpegBinary";
import { runFfmpeg, FfmpegError } from "./runFfmpeg";

let dir: string;
let redPng: string;
let bluePng: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "studio-ffmpeg-"));
  redPng = join(dir, "red.png");
  bluePng = join(dir, "blue.png");
  makeStill(redPng, "mandelbrot=size=640x480");
  makeStill(bluePng, "mandelbrot=size=640x480:start_x=0.3");
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function makeStill(path: string, lavfiSource: string): void {
  const r = spawnSync(ffmpegPath(), [
    "-y", "-f", "lavfi", "-i", lavfiSource, "-frames:v", "1", "-q:v", "2", path,
  ]);
  if (r.status !== 0) throw new Error(`makeStill failed: ${r.stderr.toString()}`);
}

function partFiles(): string[] {
  return readdirSync(dir).filter((f) => f.includes(".part-"));
}

function hasErrnoCode(err: unknown): err is { code: string } {
  return typeof err === "object" && err !== null && "code" in err;
}

test("renders two image inputs through hstack", async () => {
  const output = join(dir, "hstack.mp4");
  const seen: number[] = [];

  await runFfmpeg({
    inputs: [
      { path: redPng, options: ["-loop", "1", "-t", "1"] },
      { path: bluePng, options: ["-loop", "1", "-t", "1"] },
    ],
    args: [
      "-filter_complex", "[0:v][1:v]hstack=inputs=2",
      "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p",
    ],
    output,
    durationSec: 1,
    onProgress: (f) => seen.push(f),
  });

  expect(existsSync(output)).toBe(true);
  expect(partFiles()).toEqual([]);
  expect(seen.length).toBeGreaterThan(0);
  expect(seen[seen.length - 1]).toBe(1);
  for (let i = 1; i < seen.length; i++) {
    expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
  }
}, 30000);

test("reports a real intermediate progress value on a real-time render", async () => {
  // `-re` paces ffmpeg to read (and therefore report progress) at roughly
  // wall-clock speed, independent of how fast the encoder itself could go —
  // a plain small/fast render can finish between one stdout flush and the
  // next, making an in-between value a coin flip (this is what made the
  // hstack test above flaky when it tried to assert on progress values).
  // 3 real seconds is short enough to keep the suite fast and long enough to
  // reliably see more than one report before "progress=end".
  const output = join(dir, "realtime-progress.mp4");
  const seen: number[] = [];

  await runFfmpeg({
    inputs: [{ path: "testsrc2=duration=3:size=320x240:rate=25", options: ["-f", "lavfi", "-re"] }],
    args: ["-c:v", "libx264", "-pix_fmt", "yuv420p"],
    output,
    durationSec: 3,
    onProgress: (f) => seen.push(f),
  });

  expect(existsSync(output)).toBe(true);
  expect(seen.some((f) => f > 0 && f < 1)).toBe(true);
  expect(seen[seen.length - 1]).toBe(1);
  for (let i = 1; i < seen.length; i++) {
    expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
  }
}, 30000);

test("a throwing final onProgress does not turn a finished render into a rejection", async () => {
  const output = join(dir, "final-throw-ok.mp4");

  await runFfmpeg({
    inputs: [{ path: redPng, options: ["-loop", "1", "-t", "1"] }],
    args: ["-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p"],
    output,
    durationSec: 1,
    onProgress: (f) => {
      if (f === 1) throw new Error("boom from a closed window");
    },
  });

  expect(existsSync(output)).toBe(true);
  expect(partFiles()).toEqual([]);
});

test("a throwing mid-run onProgress kills the child promptly, cleans up, and rejects", async () => {
  const output = join(dir, "mid-throw.mp4");
  const boom = new Error("boom mid-run");

  // `-re`: a 60 s source that is NOT real-time finishes in a couple of
  // seconds regardless of what runFfmpeg does, which would let this test
  // pass even if the kill on a throw were missing entirely (the child would
  // just exit 0 on its own and `close` would fire quickly either way). With
  // `-re` the source only finishes early if something actually kills it.
  const start = Date.now();
  let error: unknown;
  try {
    await runFfmpeg({
      inputs: [{ path: "testsrc2=duration=60:size=320x240:rate=25", options: ["-f", "lavfi", "-re"] }],
      args: ["-c:v", "libx264", "-pix_fmt", "yuv420p"],
      output,
      durationSec: 60,
      onProgress: () => {
        throw boom;
      },
    });
  } catch (err) {
    error = err;
  }
  const elapsedMs = Date.now() - start;

  expect(error).toBe(boom);
  expect(elapsedMs).toBeLessThan(10000);
  expect(existsSync(output)).toBe(false);
  expect(partFiles()).toEqual([]);
}, 30000);

test("aborting mid-run rejects with the exact abort reason well before the source would finish, and leaves nothing behind", async () => {
  const output = join(dir, "abort.mp4");
  const controller = new AbortController();
  const abortReason = new Error("user pressed Stop");
  const start = Date.now();

  const run = runFfmpeg({
    // `-re`: without it this 60 s source finishes on its own in a couple of
    // real seconds, so aborting it around the first progress tick would
    // "succeed" whether or not the SIGKILL actually did anything — a global
    // kill-all would pass this test too. With `-re` the source only stops
    // early because something killed it.
    inputs: [{ path: "testsrc2=duration=60:size=320x240:rate=25", options: ["-f", "lavfi", "-re"] }],
    args: ["-c:v", "libx264", "-pix_fmt", "yuv420p"],
    output,
    durationSec: 60,
    signal: controller.signal,
    onProgress: () => {
      if (!controller.signal.aborted) controller.abort(abortReason);
    },
  });

  let error: unknown;
  try {
    await run;
  } catch (err) {
    error = err;
  }
  const elapsedMs = Date.now() - start;

  expect(error).toBe(abortReason);
  // A 60 s real-time source has no way to finish on its own in a few
  // seconds; a generous bound proves the abort — not a natural finish — is
  // what ended this run.
  expect(elapsedMs).toBeLessThan(10000);
  expect(existsSync(output)).toBe(false);
  expect(partFiles()).toEqual([]);
}, 30000);

test("aborting one concurrent run does not affect the other, which keeps progressing and completes", async () => {
  const abortedOutput = join(dir, "concurrent-abort.mp4");
  const okOutput = join(dir, "concurrent-ok.mp4");
  const controller = new AbortController();

  const aborted = runFfmpeg({
    // Real-time for the same reason as the abort test above: a synthetic
    // source that finishes on its own in a couple of seconds can't tell
    // "killed early" apart from "finished naturally around the same time".
    inputs: [{ path: "testsrc2=duration=60:size=320x240:rate=25", options: ["-f", "lavfi", "-re"] }],
    args: ["-c:v", "libx264", "-pix_fmt", "yuv420p"],
    output: abortedOutput,
    durationSec: 60,
    signal: controller.signal,
  });

  let abortTriggered = false;
  let progressAfterAbort = 0;

  const ok = runFfmpeg({
    inputs: [{ path: "testsrc2=duration=10:size=1280x720:rate=30", options: ["-f", "lavfi"] }],
    args: ["-preset", "veryslow", "-c:v", "libx264", "-pix_fmt", "yuv420p"],
    output: okOutput,
    durationSec: 10,
    onProgress: () => {
      if (!abortTriggered) {
        abortTriggered = true;
        controller.abort();
      } else {
        progressAfterAbort++;
      }
    },
  });

  const [abortedResult, okResult] = await Promise.allSettled([aborted, ok]);

  expect(abortedResult.status).toBe("rejected");
  expect(okResult.status).toBe("fulfilled");
  expect(abortTriggered).toBe(true);
  expect(progressAfterAbort).toBeGreaterThan(0);
  expect(existsSync(okOutput)).toBe(true);
  expect(existsSync(abortedOutput)).toBe(false);
}, 30000);

test("an invalid filter rejects with an FfmpegError naming the filter, with stderr well over 4 KB and a bounded tail", async () => {
  const output = join(dir, "invalid.mp4");
  let error: unknown;

  // Six inputs plus `-loglevel debug` push ffmpeg's own startup logging
  // (codec/format probing per input) past 4 KB before it ever reaches the
  // filter-graph error — deterministically, since it comes from a fixed
  // number of inputs rather than from timing or frame count.
  try {
    await runFfmpeg({
      inputs: Array.from({ length: 6 }, () => ({ path: redPng, options: ["-loop", "1", "-t", "1"] })),
      args: ["-loglevel", "debug", "-vf", "definitelyNotARealFilter"],
      output,
      durationSec: 1,
    });
  } catch (err) {
    error = err;
  }

  if (!(error instanceof FfmpegError)) throw new Error("expected an FfmpegError");
  expect(error.exitCode).not.toBeNull();
  expect(error.stderrTail).toContain("definitelyNotARealFilter");
  expect(error.stderrTail.length).toBeLessThanOrEqual(2000);
  expect(existsSync(output)).toBe(false);
  expect(partFiles()).toEqual([]);
}, 30000);

test("a spawn failure (missing binary) rejects with ENOENT and cleans up", async () => {
  const output = join(dir, "spawn-fail.mp4");
  __setFfmpegPathOverrideForTests(join(dir, "no-such-ffmpeg-binary"));

  try {
    let error: unknown;
    try {
      await runFfmpeg({
        inputs: [{ path: redPng }],
        args: [],
        output,
        durationSec: 1,
      });
    } catch (err) {
      error = err;
    }

    if (!hasErrnoCode(error)) throw new Error("expected an errno-coded error");
    expect(error.code).toBe("ENOENT");
    expect(existsSync(output)).toBe(false);
    expect(partFiles()).toEqual([]);
  } finally {
    __setFfmpegPathOverrideForTests(undefined);
  }
});

test("a rename failure (output path is an existing directory) rejects and cleans the temp file", async () => {
  const output = join(dir, "rename-fail.mp4");
  mkdirSync(output);

  let error: unknown;
  try {
    await runFfmpeg({
      inputs: [{ path: redPng, options: ["-loop", "1", "-t", "1"] }],
      args: ["-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p"],
      output,
      durationSec: 1,
    });
  } catch (err) {
    error = err;
  }

  expect(error).toBeInstanceOf(Error);
  expect(statSync(output).isDirectory()).toBe(true);
  expect(partFiles()).toEqual([]);
});

test("a pre-aborted signal rejects without creating any file", async () => {
  const output = join(dir, "never.mp4");
  const controller = new AbortController();
  controller.abort();

  let error: unknown;
  try {
    await runFfmpeg({
      inputs: [{ path: redPng }],
      args: [],
      output,
      durationSec: 1,
      signal: controller.signal,
    });
  } catch (err) {
    error = err;
  }

  expect(error).toBe(controller.signal.reason);
  expect(existsSync(output)).toBe(false);
  expect(partFiles()).toEqual([]);
});

test("validates inputs before spawning anything", async () => {
  await expect(
    runFfmpeg({ inputs: [], args: [], output: join(dir, "x.mp4"), durationSec: 1 })
  ).rejects.toBeInstanceOf(TypeError);

  await expect(
    runFfmpeg({ inputs: [{ path: redPng }], args: [], output: join(dir, "x.mp4"), durationSec: 0 })
  ).rejects.toBeInstanceOf(TypeError);

  await expect(
    runFfmpeg({ inputs: [{ path: redPng }], args: [], output: join(dir, "no-extension"), durationSec: 1 })
  ).rejects.toBeInstanceOf(TypeError);
});

test("unpackAsarSegment rewrites only a whole app.asar path segment", () => {
  expect(
    unpackAsarSegment("/Applications/Studio.app/Contents/Resources/app.asar/node_modules/ffmpeg-static/ffmpeg")
  ).toBe("/Applications/Studio.app/Contents/Resources/app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg");

  expect(
    unpackAsarSegment("C:\\Program Files\\Studio\\resources\\app.asar\\node_modules\\ffmpeg-static\\ffmpeg.exe")
  ).toBe("C:\\Program Files\\Studio\\resources\\app.asar.unpacked\\node_modules\\ffmpeg-static\\ffmpeg.exe");

  // "app.asar" as a substring of a longer segment name — on either side —
  // must not be rewritten.
  expect(unpackAsarSegment("/opt/myapp.asarchive/ffmpeg")).toBe("/opt/myapp.asarchive/ffmpeg");
  expect(unpackAsarSegment("/opt/app.asarchive/ffmpeg")).toBe("/opt/app.asarchive/ffmpeg");

  expect(unpackAsarSegment("/usr/local/bin/ffmpeg")).toBe("/usr/local/bin/ffmpeg");
});
