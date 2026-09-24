import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rename, rm } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { parseProgressFraction } from "../../src/node/ffmpegProgress";
import { ffmpegPath } from "./ffmpegBinary";

/** One ffmpeg input. `options` are flags that must precede this input's
 *  `-i`, e.g. `["-loop", "1", "-t", "8"]` to loop a still for 8 seconds. */
export interface FfmpegInput {
  path: string;
  options?: string[];
}

export interface RunFfmpegOptions {
  inputs: FfmpegInput[];
  /** Everything after the inputs — filters, codecs, maps. No `-y`, no output path. */
  args: string[];
  output: string;
  /** Expected output duration in seconds, used to turn `out_time_us` into a fraction. */
  durationSec: number;
  signal?: AbortSignal;
  /** Fraction 0..1, monotonically non-decreasing, with a final call of 1 on success. */
  onProgress?: (fraction: number) => void;
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
    ...opts.inputs.flatMap((input) => [...(input.options ?? []), "-i", input.path]),
    ...opts.args,
    "-progress", "pipe:1",
    "-nostats",
    tempOutput,
  ];
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

  const { signal } = opts;
  if (signal?.aborted) {
    throw signal.reason;
  }

  const temp = tempOutputPath(opts.output);
  const args = buildArgs(opts, temp);

  return new Promise<void>((resolve, reject) => {
    const child: ChildProcess = spawn(ffmpegPath(), args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderrTail = "";
    let stdoutBuffer = "";
    let lastProgress = 0;
    let settled = false;
    // Set by a mid-run onProgress throw or a spawn `error` — both kill the
    // child and record why, but leave the actual reject/cleanup to `close`
    // (below), since ffmpeg still owns the temp file until it has actually
    // exited: removing it any earlier would race a process that is still
    // dying. Bun/Node reliably emit `close` after `error` too (verified: a
    // missing binary gives `close(-2, undefined)`), so this never hangs.
    let pendingError: { value: unknown } | undefined;

    const cleanupTemp = () =>
      rm(temp, { force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});

    const onAbort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", onAbort, { once: true });

    // Runs the settle path exactly once, regardless of which event fires
    // first — `close` always follows `error`, and abort can race either.
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      fn();
    };

    // A dead-or-dying child never reports a real exit code for `kill()` to
    // race against; harmless (and a no-op) to call again if it already exited.
    const killIfAlive = () => {
      if (child.exitCode === null) child.kill("SIGKILL");
    };

    child.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_ROLLING_LIMIT);
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled || signal?.aborted || pendingError) return; // nothing left to report to

      stdoutBuffer += chunk.toString();
      const { reports, rest } = extractProgressReports(stdoutBuffer);
      stdoutBuffer = rest;

      for (const report of reports) {
        // Re-checked per report, not just once per chunk: onProgress itself
        // may call abort() (as a Stop button naturally would), and a batch
        // can carry several reports — later ones in the same batch must not
        // still be delivered once that happens.
        if (settled || signal?.aborted || pendingError) return;

        const fraction = parseProgressFraction(report, opts.durationSec);
        if (fraction === null) continue;
        const clamped = Math.max(0, Math.min(1, fraction));
        // The definitive "done" notification is reserved for after a
        // successful rename (below) — see the comment there for why.
        if (clamped >= 1) continue;
        if (clamped <= lastProgress) continue;

        lastProgress = clamped;
        const result = safeProgress(opts.onProgress, lastProgress);
        if (!result.ok) {
          pendingError = { value: result.error };
          killIfAlive();
          return; // `close` rejects and cleans up once the child actually exits
        }
      }
    });

    child.on("error", (err) => {
      if (pendingError) return;
      pendingError = { value: err };
      killIfAlive();
    });

    child.on("close", (code, closeSignal) => {
      finish(() => {
        if (pendingError) {
          cleanupTemp().finally(() => reject(pendingError!.value));
          return;
        }
        // An abort races the exit code (SIGKILL usually reports as a null
        // code, but that is an implementation detail) — the reason the
        // caller asked to stop always wins over whatever ffmpeg reported.
        if (signal?.aborted) {
          cleanupTemp().finally(() => reject(signal.reason));
          return;
        }
        if (code !== 0) {
          const description = code !== null ? `code ${code}` : `signal ${closeSignal ?? "unknown"}`;
          const tail = stderrTail.slice(-STDERR_ERROR_TAIL);
          cleanupTemp().finally(() =>
            reject(new FfmpegError(`ffmpeg exited with ${description}`, code, tail))
          );
          return;
        }
        rename(temp, opts.output)
          .then(() => {
            // The child already exited 0 and the file now sits at `output`.
            // An abort() arriving from here on — including during this very
            // rename — is too late to change that and is intentionally
            // ignored (open question raised in review: kept as-is). A
            // throwing onProgress(1) is likewise not treated as a failure:
            // the render already succeeded on disk, so a broken listener
            // (e.g. sending to a closed window) must not turn a finished
            // file into a rejection.
            safeProgress(opts.onProgress, 1);
            resolve();
          })
          .catch((err) => cleanupTemp().finally(() => reject(err)));
      });
    });
  });
}
