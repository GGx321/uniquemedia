import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { FfmpegChild, FfmpegSpawner, FfmpegSpawnOptions } from "./runFfmpeg";

// Test support for suites that run `runFfmpeg` or the render runner without a
// real ffmpeg: a scripted child process and a spawner that hands them out.
// Test-only (`.testkit.ts`): production code never imports it.

/** One `-progress pipe:1` report, as ffmpeg prints it. */
export function progressReport(frame: number, end = false): string {
  return `frame=${frame}\nfps=30.0\nout_time_us=${Math.round((frame / 30) * 1e6)}\nprogress=${end ? "end" : "continue"}\n`;
}

/** A child process the test drives by hand. */
export class FakeFfmpegChild extends EventEmitter implements FfmpegChild {
  exitCode: number | null = null;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  /** Every signal `kill` received, in order. */
  readonly killedWith: NodeJS.Signals[] = [];
  /** True once it has emitted `close`. */
  closed = false;

  /** `killExits: false` plays a child that ignores the kill, so a test can pick the moment it dies. */
  constructor(private readonly killExits = true) {
    super();
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killedWith.push(signal);
    if (this.killExits) setImmediate(() => this.exit(null, signal));
    return true;
  }

  /** Prints reports to stdout. */
  report(frame: number, end = false): void {
    this.stdout.write(progressReport(frame, end));
  }

  /** Prints raw text to stderr. */
  complain(text: string): void {
    this.stderr.write(text);
  }

  /** Ends the streams, then emits `close`, in the order a real child does. */
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.closed) return;
    this.closed = true;
    this.exitCode = code;
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => this.emit("close", code, signal));
  }
}

export interface SpawnCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: FfmpegSpawnOptions;
  readonly child: FakeFfmpegChild;
}

/** A spawner that builds each child with `script`, and remembers every call. */
export function fakeSpawner(script: (call: SpawnCall, index: number) => void, killExits = true): { spawner: FfmpegSpawner; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const spawner: FfmpegSpawner = (command, args, options) => {
    const child = new FakeFfmpegChild(killExits);
    const call: SpawnCall = { command, args, options, child };
    calls.push(call);
    setImmediate(() => script(call, calls.length - 1));
    return child;
  };
  return { spawner, calls };
}

/** The last element of an argv: where ffmpeg writes. */
export function outputOf(args: readonly string[]): string {
  const last = args.at(-1);
  if (last === undefined) throw new Error("empty argv");
  return last;
}
