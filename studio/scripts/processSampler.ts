import { spawn, spawnSync, type ChildProcess } from "node:child_process";

// How much memory the ffmpegs of a render take, for the packaged E2E (plan 3a.9: SP1's Windows run records the peak per job,
// and `PEAK_RSS_BYTES` is raised if a job goes over it). The parsing and the peak arithmetic are pure and tested; the live
// sampler at the bottom only runs a process and feeds them.

export interface ProcRow {
  readonly pid: number;
  readonly ppid: number;
  /** The resident size (working set on Windows) when sampled. */
  readonly rssBytes: number;
  /** The process's own recorded peak so far (Windows' `PeakWorkingSet64`), when the OS keeps one. */
  readonly peakBytes: number | null;
}

/** One look at the machine: its ffmpegs, and every process's parent (to tell whose ffmpeg each is). */
export interface ProcSample {
  readonly rows: readonly ProcRow[];
  readonly parents: ReadonlyMap<number, number>;
}

/** Whether a command line is the bundled ffmpeg (the package folder, in or out of the asar, either separator). Not ffprobe, not a process that only names it. */
export function isFfmpegCommand(command: string): boolean {
  return /[\\/]ffmpeg-static[\\/]ffmpeg(?:\.exe)?(?:\s|$)/i.test(command);
}

/** `ps -Ao pid=,ppid=,rss=,command=` (rss in KiB): the ffmpeg rows, and every process's parent. A line that is not a row is skipped. */
export function parsePosixPs(output: string): ProcSample {
  const rows: ProcRow[] = [];
  const parents = new Map<number, number>();
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match === null) continue;
    const [, pid = "", ppid = "", rssKiB = "", command = ""] = match;
    parents.set(Number(pid), Number(ppid));
    if (isFfmpegCommand(command)) rows.push({ pid: Number(pid), ppid: Number(ppid), rssBytes: Number(rssKiB) * 1024, peakBytes: null });
  }
  return { rows, parents };
}

/**
 * The Windows sampler's output, one sample per `--` line: an ffmpeg is `<pid> <parent> <WorkingSetSize> <PeakWorkingSet64>` and any
 * process's parent is `P <pid> <parent>`. A last sample with no separator after it was cut off (it may hold half the processes) and
 * is dropped, as is any line that is neither.
 */
export function parseWindowsSamples(output: string): ProcSample[] {
  const samples: ProcSample[] = [];
  let rows: ProcRow[] = [];
  let parents = new Map<number, number>();
  for (const line of output.split(/\r?\n/)) {
    if (line.trim() === "--") {
      samples.push({ rows, parents });
      rows = [];
      parents = new Map();
      continue;
    }
    const parent = /^\s*P\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (parent !== null) {
      parents.set(Number(parent[1]), Number(parent[2]));
      continue;
    }
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)(?:\s+(\d+))?\s*$/.exec(line);
    if (match !== null) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), rssBytes: Number(match[3]), peakBytes: match[4] === undefined ? null : Number(match[4]) });
  }
  return samples;
}

/** The ffmpegs of a sample that descend from `rootPid` (the app under test), through however many parents. Somebody else's ffmpeg, and an orphan whose parent is gone, are not owned. */
export function ownedRows(sample: ProcSample, rootPid: number): ProcRow[] {
  return sample.rows.filter((row) => {
    const seen = new Set<number>([row.pid]);
    for (let at: number | undefined = row.ppid; at !== undefined && !seen.has(at); at = sample.parents.get(at)) {
      if (at === rootPid) return true;
      seen.add(at);
    }
    return false;
  });
}

export interface Peak {
  /** The largest any one ffmpeg got. */
  readonly peakSingleBytes: number;
  /** The most the ffmpegs held at one moment, together. */
  readonly peakConcurrentBytes: number;
  readonly samples: number;
}

/** Samples over time, asked for by window: one render's start and end. */
export class PeakTracker {
  readonly #samples: { at: number; single: number; sum: number }[] = [];

  record(atMs: number, rows: readonly ProcRow[]): void {
    let single = 0;
    let sum = 0;
    for (const row of rows) {
      sum += row.rssBytes;
      single = Math.max(single, row.rssBytes, row.peakBytes ?? 0);
    }
    this.#samples.push({ at: atMs, single, sum });
  }

  between(fromMs: number, toMs: number): Peak {
    const inside = this.#samples.filter((s) => s.at >= fromMs && s.at <= toMs);
    return {
      peakSingleBytes: Math.max(0, ...inside.map((s) => s.single)),
      peakConcurrentBytes: Math.max(0, ...inside.map((s) => s.sum)),
      samples: inside.length,
    };
  }
}

/** The sampler could not do its job: the run says so as a harness fault, never as a finding about the app (a memory figure of zero is not a pass either). */
export class SamplerHarnessError extends Error {
  constructor(message: string) {
    super(`harness error: ${message}`);
    this.name = "SamplerHarnessError";
  }
}

/**
 * A peak that has at least one sample behind it, and an ffmpeg in at least one of them. An empty window means nothing measured it, and samples that
 * never saw an ffmpeg measured nothing of it either (a peak of 0 passes any memory bound); both are the harness's fault, not the render's.
 */
export function requireSamples(peak: Peak, what: string): Peak {
  if (peak.samples === 0) throw new SamplerHarnessError(`the process sampler took no sample during ${what}, so its memory was not measured`);
  if (peak.peakConcurrentBytes === 0) throw new SamplerHarnessError(`the process sampler saw no ffmpeg during ${what} in ${peak.samples} samples, so its memory was not measured`);
  return peak;
}

/** Opens at the sampler's first sample (or fails when the sampler dies before one), so a caller can wait for the sampler to be running before it measures anything. */
export class SampleLatch {
  #marked = false;
  #failure: string | null = null;
  readonly #waiting = new Set<{ resolve: () => void; reject: (error: SamplerHarnessError) => void }>();

  mark(): void {
    if (this.#marked) return;
    this.#marked = true;
    for (const waiter of this.#waiting) waiter.resolve();
    this.#waiting.clear();
  }

  /** The sampler is gone. Ignored once a sample has come: what it measured stays measured. */
  fail(reason: string): void {
    if (this.#marked || this.#failure !== null) return;
    this.#failure = reason;
    for (const waiter of this.#waiting) waiter.reject(new SamplerHarnessError(`the process sampler stopped before its first sample (${reason})`));
    this.#waiting.clear();
  }

  wait(timeoutMs: number): Promise<void> {
    if (this.#marked) return Promise.resolve();
    if (this.#failure !== null) return Promise.reject(new SamplerHarnessError(`the process sampler stopped before its first sample (${this.#failure})`));
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiting.delete(waiter);
        reject(new SamplerHarnessError(`the process sampler took no sample within ${timeoutMs} ms of starting`));
      }, timeoutMs);
      const waiter = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error: SamplerHarnessError) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      this.#waiting.add(waiter);
    });
  }
}

export interface FfmpegSampler {
  readonly tracker: PeakTracker;
  /** Resolves once the sampler has taken its first sample; rejects with a `SamplerHarnessError` if it dies first or takes none in `timeoutMs`. Measure nothing before it. */
  ready(timeoutMs: number): Promise<void>;
  /** Counts only the ffmpegs that descend from this process (the app under test); the app is relaunched, so it can change. */
  follow(pid: number): void;
  /** The pids of the app's ffmpegs in the newest sample. */
  latestPids(): number[];
  /**
   * Which of `pids` are an ffmpeg in the newest sample, whoever's parent it has now (a killed engine's ffmpeg is an orphan). Judged by
   * the sample's own command line, so a pid the OS has handed to another process since is not counted as alive.
   */
  runningAmong(pids: readonly number[]): number[];
  stop(): void;
}

const POSIX_INTERVAL_MS = 100;
/** A `ps` that fails this many times in a row, before it has ever worked, is not coming: one failure alone could be a busy machine. */
const POSIX_FAILURES_BEFORE_GIVING_UP = 3;

/** Why a `spawnSync` of `ps` gave no table, or null when it did. */
export function psFailure(result: { status: number | null; error?: Error | undefined; signal?: NodeJS.Signals | null | undefined; stderr?: string | null | undefined }): string | null {
  if (result.error !== undefined) return `could not run ps: ${result.error.message}`;
  if (result.status === 0) return null;
  if (result.status === null) return `ps was ended by ${String(result.signal ?? "a signal")}`;
  const said = (result.stderr ?? "").split("\n")[0]?.trim() ?? "";
  return `ps exited with code ${result.status}${said === "" ? "" : `: ${said}`}`;
}
/**
 * One sample per loop: every process's parent (`P`), and each ffmpeg's own line with its peak working set (`Get-Process` knows the
 * peak, CIM knows the parent). CIM over all processes costs a few hundred ms on a runner, so the rate is the loop's own.
 */
const WINDOWS_SCRIPT = [
  "$ErrorActionPreference='SilentlyContinue'",
  "while ($true) {",
  "  $peaks = @{}; Get-Process -Name ffmpeg | ForEach-Object { $peaks[[int]$_.Id] = $_.PeakWorkingSet64 }",
  "  Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,WorkingSetSize | ForEach-Object {",
  "    if ($_.Name -eq 'ffmpeg.exe') { '{0} {1} {2} {3}' -f $_.ProcessId, $_.ParentProcessId, $_.WorkingSetSize, $peaks[[int]$_.ProcessId] }",
  "    else { 'P {0} {1}' -f $_.ProcessId, $_.ParentProcessId }",
  "  }",
  "  '--'",
  "}",
].join("\n");

/** Starts sampling the machine's ffmpegs; only those of the followed app count toward a peak (a developer's machine may run others of its own). */
export function startFfmpegSampler(platform: NodeJS.Platform = process.platform): FfmpegSampler {
  const tracker = new PeakTracker();
  const firstSample = new SampleLatch();
  let owner = -1;
  let latest: ProcRow[] = [];
  let latestAll: readonly ProcRow[] = [];
  const take = (sample: ProcSample, at: number): void => {
    latestAll = sample.rows;
    latest = ownedRows(sample, owner);
    tracker.record(at, latest);
    firstSample.mark();
  };
  const follow = (pid: number): void => {
    owner = pid;
  };

  if (platform === "win32") {
    const child: ChildProcess = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_SCRIPT], { stdio: ["ignore", "pipe", "ignore"] });
    child.on("error", (error: Error) => firstSample.fail(`could not start powershell: ${error.message}`));
    child.on("exit", (code, signal) => firstSample.fail(`powershell exited with ${code === null ? `signal ${String(signal)}` : `code ${code}`}`));
    let pending = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      pending += chunk;
      const end = pending.lastIndexOf("--");
      if (end === -1) return;
      // Whole samples only: what follows the last separator is the start of the next one.
      const whole = pending.slice(0, end + 2);
      pending = pending.slice(end + 2);
      const at = Date.now();
      for (const sample of parseWindowsSamples(whole)) take(sample, at);
    });
    return {
      tracker,
      ready: (timeoutMs) => firstSample.wait(timeoutMs),
      follow,
      latestPids: () => latest.map((row) => row.pid),
      runningAmong: (pids) => latestAll.filter((row) => pids.includes(row.pid)).map((row) => row.pid),
      stop: () => {
        child.kill();
        spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"]);
      },
    };
  }

  let failedInARow = 0;
  const timer = setInterval(() => {
    const ps = spawnSync("ps", ["-Ao", "pid=,ppid=,rss=,command="], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    const failure = psFailure(ps);
    if (failure === null) {
      failedInARow = 0;
      take(parsePosixPs(ps.stdout), Date.now());
    } else if (++failedInARow >= POSIX_FAILURES_BEFORE_GIVING_UP) {
      // A ps that never works must not leave `ready()` waiting out its whole bound; once a sample has come, this changes nothing.
      firstSample.fail(failure);
    }
  }, POSIX_INTERVAL_MS);
  return {
    tracker,
    ready: (timeoutMs) => firstSample.wait(timeoutMs),
    follow,
    latestPids: () => latest.map((row) => row.pid),
    runningAmong: (pids) => latestAll.filter((row) => pids.includes(row.pid)).map((row) => row.pid),
    stop: () => clearInterval(timer),
  };
}
