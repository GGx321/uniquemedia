import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import type { FfmpegChild, FfmpegSpawner } from "../../node/runFfmpeg";

// Test support: scripted ffmpeg child processes for the importers' tests (3f.5; the photo importer's test has its own copies from 3f.2).

type Closer = (code: number | null, signal: NodeJS.Signals | null) => void;

/** A child that never finishes by itself: it ends only when it is killed. */
export function hangingChild(): { child: FfmpegChild; killed: () => string[] } {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const closers: Closer[] = [];
  const kills: string[] = [];
  const self: { exitCode: number | null } = { exitCode: null };
  const child: FfmpegChild = {
    get exitCode() {
      return self.exitCode;
    },
    stdout,
    stderr,
    kill: (signal) => {
      kills.push(String(signal));
      self.exitCode = 137;
      queueMicrotask(() => closers.forEach((close) => close(null, "SIGKILL")));
      return true;
    },
    on: ((event: string, listener: (...args: never[]) => void) => {
      if (event === "close") closers.push(listener as Closer);
      return child;
    }) as FfmpegChild["on"],
  };
  return { child, killed: () => kills };
}

/** A child that exits with `code` at once, having written `stderrText` and `stdoutText` (the `-progress` pipe). */
export function exitingChild(code: number, options: { stderrText?: string; stdoutText?: string } = {}): FfmpegChild {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const closers: Closer[] = [];
  const child: FfmpegChild = {
    exitCode: null,
    stdout,
    stderr,
    kill: () => true,
    on: ((event: string, listener: (...args: never[]) => void) => {
      if (event === "close") {
        closers.push(listener as Closer);
        setTimeout(() => {
          if (options.stdoutText !== undefined) stdout.write(options.stdoutText);
          if (options.stderrText !== undefined) stderr.write(options.stderrText);
          setTimeout(() => closers.forEach((close) => close(code, null)), 0);
        }, 0);
      }
      return child;
    }) as FfmpegChild["on"],
  };
  return child;
}

/** A child that reports `frames` output frames on the progress pipe and exits 0. */
export const progressChild = (frames: number): FfmpegChild => exitingChild(0, { stdoutText: `frame=${frames}\nprogress=end\n` });

/** Runs the real ffmpeg, recording every argv it was given. `edit` may change the argv of a call first. */
export function recordingSpawner(calls: string[][], edit: (argv: string[]) => string[] = (argv) => argv): FfmpegSpawner {
  return (command, args, options) => {
    const argv = edit([...args]);
    calls.push([...argv]);
    const { env, ...rest } = options;
    return spawn(command, argv, { ...rest, ...(env === undefined ? {} : { env }), stdio: [...options.stdio] });
  };
}
