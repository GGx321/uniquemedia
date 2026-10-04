import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { FfmpegChild, FfmpegSpawner } from "../../node/runFfmpeg";
import { runFfmpegOk } from "../render/ffmpeg.testkit";

// Test support for the own-music importer (3f.4): WAV files with an exact number of samples, a long FLAC, a forged FLAC header, and spawners that
// watch the real ffmpeg or stand in for it. Test-only: never imported by production code.

const le32 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const le16 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff];
const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));

/**
 * A mono 8-bit PCM WAV of exactly `samples` samples at `rate` Hz: a quiet square wave, so the file is audio and not silence. `dataSize` forges
 * the `data` chunk's declared size (the default is the true one).
 */
export function wavOf(samples: number, rate = 8000, dataSize: number = samples): Uint8Array {
  const body = new Uint8Array(samples);
  for (let i = 0; i < samples; i++) body[i] = Math.floor(i / 20) % 2 === 0 ? 150 : 106;
  const header = [...ascii("RIFF"), ...le32(36 + dataSize), ...ascii("WAVE"), ...ascii("fmt "), ...le32(16), ...le16(1), ...le16(1), ...le32(rate), ...le32(rate), ...le16(1), ...le16(8), ...ascii("data"), ...le32(dataSize)];
  return Uint8Array.from([...header, ...body]);
}

/** The samples of a 1 AAC frame (1024 samples at 48 kHz) at `rate`, rounded up: the shortest excess a decoded length shows. */
export const oneAacFrame = (rate: number): number => Math.ceil((1024 * rate) / 48000);

/** `seconds` of a sine tone at 8 kHz as a mono FLAC, made by the bundled ffmpeg into `dir`. */
export async function flacOfSeconds(dir: string, seconds: number): Promise<Uint8Array> {
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `long-${seconds}.flac`);
  await runFfmpegOk(["-hide_banner", "-y", "-nostdin", "-v", "error", "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=8000:duration=${seconds}`, "-ac", "1", "-c:a", "flac", "-map_metadata", "-1", "-fflags", "+bitexact", out]);
  return new Uint8Array(await Bun.file(out).arrayBuffer());
}

/** A FLAC whose STREAMINFO says it holds `samples` samples, whatever its frames hold (a forged short header). */
export function flacClaiming(flac: Uint8Array, samples: number): Uint8Array {
  const forged = Uint8Array.from(flac);
  // "fLaC", the 4-byte block header, then STREAMINFO: the 36-bit sample count is the low nibble of byte 13 and bytes 14 to 17 of the file's STREAMINFO.
  const at = 8;
  forged[at + 13] = ((forged[at + 13] ?? 0) & 0xf0) | ((samples / 2 ** 32) & 0x0f);
  forged[at + 14] = (samples >>> 24) & 0xff;
  forged[at + 15] = (samples >>> 16) & 0xff;
  forged[at + 16] = (samples >>> 8) & 0xff;
  forged[at + 17] = samples & 0xff;
  return forged;
}

export interface Recorded {
  readonly spawner: FfmpegSpawner;
  /** Every argv ffmpeg was started with, in order. */
  readonly argvs: string[][];
  /** The pid of every child that was started. */
  readonly pids: number[];
  /** How each child ended, by the order it was started: the exit code and the signal that stopped it (null for none). */
  readonly exits: { code: number | null; signal: NodeJS.Signals | null }[];
}

/** Node's own `spawn`, watched: what the real ffmpeg is started with, and which processes. */
export function recordingSpawner(): Recorded {
  const argvs: string[][] = [];
  const pids: number[] = [];
  const exits: { code: number | null; signal: NodeJS.Signals | null }[] = [];
  const spawner: FfmpegSpawner = (command, args, options) => {
    argvs.push([...args]);
    const slot = exits.length;
    exits.push({ code: null, signal: null });
    const { env, ...rest } = options;
    const child = spawn(command, [...args], { ...rest, ...(env === undefined ? {} : { env }), stdio: [...options.stdio] });
    child.on("close", (code, signal) => {
      exits[slot] = { code, signal };
    });
    if (child.pid !== undefined) pids.push(child.pid);
    return child;
  };
  return { spawner, argvs, pids, exits };
}

/** Whether a process with this pid is alive now. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A child that prints `stderrText` and exits with `code` once it is asked to start. */
export function printingChild(code: number, stderrText: string): FfmpegChild {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const closers: ((code: number | null, signal: NodeJS.Signals | null) => void)[] = [];
  const child: FfmpegChild = {
    exitCode: null,
    stdout,
    stderr,
    kill: () => true,
    on: ((event: string, listener: (...args: never[]) => void) => {
      if (event === "close") {
        closers.push(listener as (code: number | null, signal: NodeJS.Signals | null) => void);
        setTimeout(() => {
          stderr.write(stderrText);
          stdout.end();
          stderr.end();
          closers.forEach((close) => close(code, null));
        }, 0);
      }
      return child;
    }) as FfmpegChild["on"],
  };
  return child;
}

/** A child that never ends until it is killed; `killed()` lists the signals it got. */
export function hangingChild(): { child: FfmpegChild; killed: () => string[] } {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const closers: ((code: number | null, signal: NodeJS.Signals | null) => void)[] = [];
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
      if (event === "close") closers.push(listener as (code: number | null, signal: NodeJS.Signals | null) => void);
      return child;
    }) as FfmpegChild["on"],
  };
  return { child, killed: () => kills };
}
