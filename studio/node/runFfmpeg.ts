import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rename, rm } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import type { Readable } from "node:stream";
import { parseProgressFraction } from "../../src/node/ffmpegProgress";
import { allowlistedEnv } from "./childEnv";
import { ffmpegPath } from "./ffmpegBinary";
import { configuredFfmpegEnv } from "./ffmpegEnv";

/** One ffmpeg input. `options` are flags that must precede this input's
 *  `-i`, e.g. `["-loop", "1", "-t", "8"]` to loop a still for 8 seconds. */
export interface FfmpegInput {
  path: string;
  options?: string[];
}

/**
 * The part of a child process the supervision uses. Node's `ChildProcess`
 * satisfies it; a test hands in a scripted one through `spawner`.
 */
export interface FfmpegChild {
  readonly exitCode: number | null;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
}

export interface FfmpegSpawnOptions {
  readonly cwd: string | undefined;
  /**
   * The allowlisted environment (S4), never `{}`. `undefined` only when the
   * process entry configured none (`ffmpegEnv.ts`: tests and tools), and then the
   * child inherits its parent's.
   */
  readonly env: Record<string, string> | undefined;
  readonly windowsHide: true;
  readonly stdio: ["ignore", "pipe", "pipe"];
}

export type FfmpegSpawner = (command: string, args: readonly string[], options: FfmpegSpawnOptions) => FfmpegChild;

const nodeSpawner: FfmpegSpawner = (command, args, options) => {
  const { env, ...rest } = options;
  return spawn(command, [...args], { ...rest, ...(env === undefined ? {} : { env }), stdio: [...options.stdio] });
};

/** The variables the supervision reads its child's environment from. */
type ParentEnv = Readonly<Record<string, string | undefined>>;

interface SupervisionOptions {
  signal?: AbortSignal;
  /** The child is killed (`SIGKILL`) and the call rejects with an `FfmpegTimeoutError` once this many ms have passed. */
  timeoutMs?: number;
  /** ffmpeg's working directory; the process's own when absent. */
  cwd?: string;
  /**
   * Where the child's environment is taken from, through the allowlist; else what
   * `configureFfmpegEnv` set at the process entry (the engine's start does).
   */
  env?: ParentEnv;
  /** Starts the child; Node's `spawn` when absent (a test injects a scripted one). */
  spawner?: FfmpegSpawner;
  /**
   * The frames ffmpeg has written so far, from its `-progress` reports:
   * strictly increasing, and at most once per report. A throw kills the child
   * and rejects the call with that error.
   */
  onFrames?: (frames: number) => void;
}

export interface RunFfmpegOptions extends SupervisionOptions {
  inputs: FfmpegInput[];
  /** Everything after the inputs — filters, codecs, maps. No `-y`, no output path. */
  args: string[];
  output: string;
  /** Expected output duration in seconds, used to turn `out_time_us` into a fraction. */
  durationSec: number;
  /** Fraction 0..1, monotonically non-decreasing, with a final call of 1 on success. */
  onProgress?: (fraction: number) => void;
}

export interface RunFfmpegArgvOptions extends SupervisionOptions {
  /**
   * Everything after the ffmpeg binary, with the output path LAST (the render
   * graph builder's arrays are shaped so). The progress pipe goes in front of
   * that last element. No temp file and no rename: ffmpeg writes to the path
   * the caller chose, and the caller cleans up after a failure.
   */
  argv: readonly string[];
}

export class FfmpegError extends Error {
  readonly exitCode: number | null;
  readonly stderrTail: string;

  constructor(message: string, exitCode: number | null, stderrTail: string) {
    super(message);
    this.name = "FfmpegError";
    this.exitCode = exitCode;
    this.stderrTail = stderrTail;
  }
}

/** The child ran past its `timeoutMs`, was killed, and has exited. */
export class FfmpegTimeoutError extends FfmpegError {
  readonly timeoutMs: number;

  constructor(timeoutMs: number, stderrTail: string) {
    super(`ffmpeg timed out after ${timeoutMs} ms and was killed`, null, stderrTail);
    this.name = "FfmpegTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Caps the threads a filter graph may use, so an ffmpeg's memory stops
 * depending on the machine's core count (plan, "Render pipeline"). The same
 * four tokens the graph builder writes (`render/profile.ts`, checked equal by
 * a test); here so that EVERY call carries them, whoever built its argv.
 */
export const FILTER_THREAD_ARGS: readonly string[] = ["-filter_threads", "2", "-filter_complex_threads", "2"];

// Bounds memory for a long render's stderr instead of buffering all of it;
// FfmpegError.stderrTail then takes the last ~2000 chars of this, which is
// plenty to show what ffmpeg complained about.
const STDERR_ROLLING_LIMIT = 4096;
const STDERR_ERROR_TAIL = 2000;

// One `-progress` report is a run of `key=value` lines ending in
// `progress=continue` or `progress=end`. ffmpeg can flush several of these
// in one write, and `parseProgressFraction` treats `progress=end` anywhere
// in the text it is given as "done" (see src/node/ffmpegProgress.ts) — so
// feeding it a blob containing an early report *and* the final one would
// report 100% and silently discard the real intermediate value. Splitting
// stdout into individual reports before parsing keeps every value visible,
// and leftover text (a report ffmpeg has not finished writing yet) stays
// buffered for the next chunk.
const PROGRESS_REPORT_END = /progress=(?:continue|end)\r?\n/;

function extractProgressReports(buffer: string): { reports: string[]; rest: string } {
  const reports: string[] = [];
  let rest = buffer;
  for (;;) {
    const match = PROGRESS_REPORT_END.exec(rest);
    if (!match) break;
    const end = match.index + match[0].length;
    reports.push(rest.slice(0, end));
    rest = rest.slice(end);
  }
  return { reports, rest };
}

/** The `frame=` of a report, or null when it has none. */
function parseProgressFrames(report: string): number | null {
  const matches = [...report.matchAll(/^frame=(\d+)\s*$/gm)];
  const last = matches.at(-1)?.[1];
  return last === undefined ? null : Number(last);
}

/** Invokes onProgress, converting a thrown error into a tagged result instead
 *  of letting it escape a stdout/close event handler — where it would
 *  otherwise become an unhandled exception, leaving the returned promise
 *  never settling while ffmpeg keeps running in the background. */
function safeProgress(
  onProgress: ((fraction: number) => void) | undefined,
  fraction: number
): { ok: true } | { ok: false; error: unknown } {
  if (!onProgress) return { ok: true };
  try {
    onProgress(fraction);
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

function validateSupervision(opts: SupervisionOptions): void {
  if (opts.timeoutMs !== undefined && !(opts.timeoutMs > 0)) {
    throw new TypeError("runFfmpeg: timeoutMs must be greater than 0.");
  }
}

function validate(opts: RunFfmpegOptions): void {
  if (opts.inputs.length === 0) {
    throw new TypeError("runFfmpeg: at least one input is required.");
  }
  if (!(opts.durationSec > 0)) {
    throw new TypeError("runFfmpeg: durationSec must be greater than 0.");
  }
  if (extname(opts.output) === "") {
    throw new TypeError("runFfmpeg: output must have a file extension.");
  }
  validateSupervision(opts);
}

// A sibling of `output`, same directory and extension, so the final `rename`
// is same-volume (atomic) and a run that dies mid-encode never leaves a
// half-written file at the path callers actually look at.
function tempOutputPath(output: string): string {
  const ext = extname(output);
  const stem = basename(output, ext);
  return join(dirname(output), `${stem}.part-${randomUUID()}${ext}`);
}

function buildArgs(opts: RunFfmpegOptions, tempOutput: string): string[] {
  return [
    "-hide_banner",
    "-nostdin",
    "-y",
    ...FILTER_THREAD_ARGS,
    ...opts.inputs.flatMap((input) => [...(input.options ?? []), "-i", input.path]),
    ...opts.args,
    "-progress", "pipe:1",
    "-nostats",
    tempOutput,
  ];
}

function buildArgvArgs(argv: readonly string[]): string[] {
  const output = argv.at(-1);
  if (output === undefined) throw new TypeError("runFfmpegArgv: argv must end with the output path.");
  const body = argv.slice(0, -1);
  const caps = body.includes("-filter_threads") ? [] : [...FILTER_THREAD_ARGS];
  return [...caps, ...body, "-progress", "pipe:1", "-nostats", output];
}

function envFor(given: ParentEnv | undefined): Record<string, string> | undefined {
  if (given !== undefined) return allowlistedEnv(given);
  return configuredFfmpegEnv();
}

interface Supervised extends SupervisionOptions {
  args: string[];
  /** Sees each whole `-progress` report while the run is live; a throw kills the child and rejects the call with it. */
  onReport: (report: string) => void;
  /** After ffmpeg exited 0: the run's own last step (the rename). A rejection rejects the call. */
  onExitOk: () => Promise<void>;
  /** After ffmpeg is gone and the call is about to reject: removes what the run left behind. */
  onFailure: () => Promise<void>;
}

/**
 * Starts one child and settles once it has really exited. A cancel, a timeout,
 * a listener that throws and a spawn error all kill the child first and
 * reject after `close`: the promise never settles while the process may still
 * be alive, so a caller that cleans up after it never races an ffmpeg that
 * still owns a file.
 */
function supervise(run: Supervised): Promise<void> {
  const { signal } = run;
  if (signal?.aborted) {
    return Promise.reject(signal.reason);
  }
  const spawner = run.spawner ?? nodeSpawner;

  return new Promise<void>((resolve, reject) => {
    const child = spawner(ffmpegPath(), run.args, {
      cwd: run.cwd,
      env: envFor(run.env),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderrTail = "";
    let stdoutBuffer = "";
    let settled = false;
    let timedOut = false;
    // Set by a mid-run listener throw or a spawn `error` — both kill the
    // child and record why, but leave the actual reject/cleanup to `close`
    // (below), since ffmpeg still owns its files until it has actually
    // exited: removing them any earlier would race a process that is still
    // dying. Bun/Node reliably emit `close` after `error` too (verified: a
    // missing binary gives `close(-2, undefined)`), so this never hangs.
    let pendingError: { value: unknown } | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    // A dead-or-dying child never reports a real exit code for `kill()` to
    // race against; harmless (and a no-op) to call again if it already exited.
    const killIfAlive = () => {
      if (child.exitCode === null) child.kill("SIGKILL");
    };

    const onAbort = () => {
      clearTimeout(timer);
      killIfAlive();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    if (run.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        // An abort that already asked to stop keeps the reason it gave.
        if (settled || signal?.aborted || pendingError) return;
        timedOut = true;
        killIfAlive();
      }, run.timeoutMs);
    }

    // Runs the settle path exactly once, regardless of which event fires
    // first — `close` always follows `error`, and abort can race either.
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };

    child.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_ROLLING_LIMIT);
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled || signal?.aborted || pendingError || timedOut) return; // nothing left to report to

      stdoutBuffer += chunk.toString();
      const { reports, rest } = extractProgressReports(stdoutBuffer);
      stdoutBuffer = rest;

      for (const report of reports) {
        // Re-checked per report, not just once per chunk: a listener may
        // itself call abort() (as a Stop button naturally would), and a batch
        // can carry several reports — later ones in the same batch must not
        // still be delivered once that happens.
        if (settled || signal?.aborted || pendingError || timedOut) return;
        try {
          run.onReport(report);
        } catch (error) {
          pendingError = { value: error };
          killIfAlive();
          return; // `close` rejects and cleans up once the child actually exits
        }
      }
    });

    child.on("error", (err) => {
      if (pendingError) return;
      pendingError = { value: err };
      clearTimeout(timer);
      killIfAlive();
    });

    child.on("close", (code, closeSignal) => {
      finish(() => {
        const fail = (error: unknown) => run.onFailure().finally(() => reject(error));
        if (pendingError) {
          fail(pendingError.value);
          return;
        }
        if (timedOut && run.timeoutMs !== undefined) {
          fail(new FfmpegTimeoutError(run.timeoutMs, stderrTail.slice(-STDERR_ERROR_TAIL)));
          return;
        }
        // An abort races the exit code (SIGKILL usually reports as a null
        // code, but that is an implementation detail) — the reason the
        // caller asked to stop always wins over whatever ffmpeg reported.
        if (signal?.aborted && code !== 0) {
          fail(signal.reason);
          return;
        }
        if (code !== 0) {
          const description = code !== null ? `code ${code}` : `signal ${closeSignal ?? "unknown"}`;
          fail(new FfmpegError(`ffmpeg exited with ${description}`, code, stderrTail.slice(-STDERR_ERROR_TAIL)));
          return;
        }
        // The child already exited 0. An abort() arriving from here on —
        // including during the last step — is too late to change that and
        // is intentionally ignored: the work is done on disk.
        run.onExitOk().then(resolve, fail);
      });
    });
  });
}

/**
 * Runs one ffmpeg render to completion. Unlike the uniquifier's
 * `FfmpegExecutor.render` — built for a single `-i` and a process-wide
 * `cancel()` that kills every render at once — this spawns and tracks exactly
 * one child per call, so aborting it via `signal` never touches any other
 * render in flight (Studio runs several compositions in parallel).
 */
export async function runFfmpeg(opts: RunFfmpegOptions): Promise<void> {
  validate(opts);

  const temp = tempOutputPath(opts.output);
  let lastProgress = 0;
  let lastFrames = -1;

  const cleanupTemp = () => rm(temp, { force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});

  return supervise({
    ...opts,
    args: buildArgs(opts, temp),
    onReport: (report) => {
      const fraction = parseProgressFraction(report, opts.durationSec);
      const clamped = fraction === null ? null : Math.max(0, Math.min(1, fraction));
      // The definitive "done" notification is reserved for after a
      // successful rename (below) — see the comment there for why.
      if (clamped !== null && clamped < 1 && clamped > lastProgress) {
        lastProgress = clamped;
        const result = safeProgress(opts.onProgress, lastProgress);
        if (!result.ok) throw result.error;
      }
      const frames = parseProgressFrames(report);
      if (frames !== null && frames > lastFrames) {
        lastFrames = frames;
        opts.onFrames?.(frames);
      }
    },
    onFailure: cleanupTemp,
    onExitOk: async () => {
      try {
        await rename(temp, opts.output);
      } catch (error) {
        await cleanupTemp();
        throw error;
      }
      // The file now sits at `output`. A throwing onProgress(1) is not
      // treated as a failure: the render already succeeded on disk, so a
      // broken listener (e.g. sending to a closed window) must not turn a
      // finished file into a rejection.
      safeProgress(opts.onProgress, 1);
    },
  });
}

/**
 * Runs an ffmpeg argv the caller built whole (the render graph builder's
 * output), under the same supervision as `runFfmpeg`: an allowlisted
 * environment, an optional `cwd`, a timeout, a kill on cancel that settles only
 * once the child is gone, the filter thread caps and `-progress pipe:1`
 * (reported in frames, not seconds).
 */
export async function runFfmpegArgv(opts: RunFfmpegArgvOptions): Promise<void> {
  validateSupervision(opts);
  const args = buildArgvArgs(opts.argv);
  let lastFrames = -1;

  return supervise({
    ...opts,
    args,
    onReport: (report) => {
      const frames = parseProgressFrames(report);
      if (frames === null || frames <= lastFrames) return;
      lastFrames = frames;
      opts.onFrames?.(frames);
    },
    onFailure: () => Promise.resolve(),
    onExitOk: () => Promise.resolve(),
  });
}
