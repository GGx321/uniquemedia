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

export interface FfmpegSampler {
  readonly tracker: PeakTracker;
  /** Counts only the ffmpegs that descend from this process (the app under test); the app is relaunched, so it can change. */
  follow(pid: number): void;
  /** The pids of the app's ffmpegs in the newest sample. */
  latestPids(): number[];
  stop(): void;
}

const POSIX_INTERVAL_MS = 100;
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

/** Starts sampling the machine's ffmpegs; only those of the followed app are kept (a developer's machine may run others of its own). */
export function startFfmpegSampler(platform: NodeJS.Platform = process.platform): FfmpegSampler {
  const tracker = new PeakTracker();
  let owner = -1;
  let latest: ProcRow[] = [];
  const take = (sample: ProcSample, at: number): void => {
    latest = ownedRows(sample, owner);
    tracker.record(at, latest);
  };
  const follow = (pid: number): void => {
    owner = pid;
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
      follow,
      latestPids: () => latest.map((row) => row.pid),
      stop: () => {
        child.kill();
        spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"]);
      },
    };
  }

  const timer = setInterval(() => {
    const ps = spawnSync("ps", ["-Ao", "pid=,ppid=,rss=,command="], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    if (ps.status === 0) take(parsePosixPs(ps.stdout), Date.now());
  }, POSIX_INTERVAL_MS);
  return { tracker, follow, latestPids: () => latest.map((row) => row.pid), stop: () => clearInterval(timer) };
}
