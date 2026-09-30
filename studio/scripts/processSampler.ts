import { spawn, spawnSync, type ChildProcess } from "node:child_process";

// How much memory the ffmpegs of a render take, for the packaged E2E (plan 3a.9: SP1's Windows run records the peak per job,
// and `PEAK_RSS_BYTES` is raised if a job goes over it). The parsing and the peak arithmetic are pure and tested; the live
// sampler at the bottom only runs a process and feeds them.

export interface ProcRow {
  readonly pid: number;
  /** The resident size (working set on Windows) when sampled. */
  readonly rssBytes: number;
  /** The process's own recorded peak so far (Windows' `PeakWorkingSet64`), when the OS keeps one. */
  readonly peakBytes: number | null;
}

/** Whether a command line is the bundled ffmpeg (the package folder, in or out of the asar, either separator). Not ffprobe, not a process that only names it. */
export function isFfmpegCommand(command: string): boolean {
  return /[\\/]ffmpeg-static[\\/]ffmpeg(?:\.exe)?(?:\s|$)/i.test(command);
}

/** `ps -Ao pid=,rss=,command=` (rss in KiB), keeping the ffmpeg rows. A line that is not a row is skipped. */
export function parsePosixPs(output: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match === null) continue;
    const [, pid = "", rssKiB = "", command = ""] = match;
    if (isFfmpegCommand(command)) rows.push({ pid: Number(pid), rssBytes: Number(rssKiB) * 1024, peakBytes: null });
  }
  return rows;
}

/**
 * The Windows sampler's output: one `<pid> <WorkingSet64> <PeakWorkingSet64>` line per ffmpeg, and a `--` line after each
 * sample. A last sample with no separator after it was cut off (it may hold half the processes) and is dropped, as is any line
 * that is not three numbers.
 */
export function parseWindowsSamples(output: string): ProcRow[][] {
  const samples: ProcRow[][] = [];
  let current: ProcRow[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (line.trim() === "--") {
      samples.push(current);
      current = [];
      continue;
    }
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (match !== null) current.push({ pid: Number(match[1]), rssBytes: Number(match[2]), peakBytes: Number(match[3]) });
  }
  return samples;
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

export interface FfmpegSampler {
  readonly tracker: PeakTracker;
  /** The pids of the ffmpegs in the newest sample. */
  latestPids(): number[];
  stop(): void;
}

const POSIX_INTERVAL_MS = 100;
/** Get-Process is cheap; the loop's own sleep sets the rate. `--` ends a sample. */
const WINDOWS_SCRIPT = "$ErrorActionPreference='SilentlyContinue'; while ($true) { Get-Process -Name ffmpeg | ForEach-Object { '{0} {1} {2}' -f $_.Id, $_.WorkingSet64, $_.PeakWorkingSet64 }; '--'; Start-Sleep -Milliseconds 100 }";

/** Starts sampling the ffmpegs of the machine (the smoke's own ffmpeg calls are not running while a render is measured). */
export function startFfmpegSampler(platform: NodeJS.Platform = process.platform): FfmpegSampler {
  const tracker = new PeakTracker();
  let latest: ProcRow[] = [];
  const take = (rows: ProcRow[], at: number): void => {
    latest = rows;
    tracker.record(at, rows);
  };

  if (platform === "win32") {
    const child: ChildProcess = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_SCRIPT], { stdio: ["ignore", "pipe", "ignore"] });
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
      latestPids: () => latest.map((row) => row.pid),
      stop: () => {
        child.kill();
        spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"]);
      },
    };
  }

  const timer = setInterval(() => {
    const ps = spawnSync("ps", ["-Ao", "pid=,rss=,command="], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    if (ps.status === 0) take(parsePosixPs(ps.stdout), Date.now());
  }, POSIX_INTERVAL_MS);
  return { tracker, latestPids: () => latest.map((row) => row.pid), stop: () => clearInterval(timer) };
}
