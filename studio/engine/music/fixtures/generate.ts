// Makes the music TRACK fixtures with the BUNDLED ffmpeg and macOS's `afconvert`, from synthetic tones, noise and short bursts: no third-party audio, nothing
// downloaded. The repository is public, so no commercial recording may be committed here. Run it with `bun studio/engine/music/fixtures/generate.ts`.
//
// WHY afconvert: the fixtures must be HE-AAC (`mp4a.40.5`, AAC-LC plus spectral band replication), the profile flashapi delivers. ffmpeg's own AAC encoder
// writes AAC-LC only, and ffmpeg-static has no libfdk_aac, so Apple's encoder makes the HE-AAC and ffmpeg only re-wraps it (`-c copy`, no metadata, the way
// the originals were cut). The committed files are what the tests read, so no CI machine needs afconvert; it is needed only to regenerate them.
//
// WHAT EACH FILE MATCHES. The tests read four things from a track: the profile and the sample rate (HE-AAC stereo, 44.1 kHz and one at 48 kHz), the length
// (6 to 8 seconds), the TRUE PEAK of the decoded excerpt (invariant 21: +3.0, -1.6, -5.7 and -5.5 dBTP, so the gain is -4.5 dB, exactly 0, and 0), and a
// loudness under -12 LUFS. A peak and a loudness are independent here by design: the signal is a quiet bed (tones and pink noise, about -22 LUFS) with a
// 5 ms burst every two seconds, and the burst's level is searched until the DECODED file measures the target peak. The search is part of the script, so the
// peak is a property of the committed bytes and not of a guess.
//
// The output is deterministic for one macOS and one ffmpeg build: `index.ts` pins each file's size and sha256 (`fixtures.test.ts` checks them). A new
// encoder build may change a byte: regenerate, read the diff in `index.ts`, and say why in the commit.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ffmpegPath } from "../../../node/ffmpegBinary";

const here = dirname(fileURLToPath(import.meta.url));
const COMMON = ["-hide_banner", "-y", "-v", "error", "-nostdin"];
const BITEXACT = ["-map_metadata", "-1", "-fflags", "+bitexact", "-flags:a", "+bitexact"];

interface Spec {
  readonly file: string;
  readonly sampleRate: 44100 | 48000;
  readonly seconds: number;
  /** The true peak of the decoded file, dBTP: the value the tests pin. */
  readonly truePeakDbtp: number;
  /** Partials of the bed, in Hz. */
  readonly bed: readonly number[];
  /** The bed's level (the first partial's amplitude); the bed's own peak is about twice this. */
  readonly bedLevel: number;
  /**
   * The level of a 3 ms 2 kHz tick every 150 ms, or 0 for none. The render test "keeps no fade" needs the hot track to be audible (above -12 dB after its
   * -4.5 dB gain) in every 200 ms window, while its loudness stays under -12 LUFS: ticks are a high crest, so they raise the window peak and not the loudness.
   */
  readonly tickLevel: number;
  readonly seed: number;
  /** HE-AAC stereo bit rate. */
  readonly bitsPerSecond: number;
}

export const SPECS: readonly Spec[] = [
  { file: "hot.mp4", sampleRate: 44100, seconds: 7.951, truePeakDbtp: 3.0, bed: [110, 330, 1760, 5200], bedLevel: 0.1, tickLevel: 0.55, seed: 11, bitsPerSecond: 64000 },
  { file: "threshold.mp4", sampleRate: 44100, seconds: 7.961, truePeakDbtp: -1.6, bed: [98, 294, 1568, 4700], bedLevel: 0.1, tickLevel: 0, seed: 23, bitsPerSecond: 64000 },
  { file: "quiet.mp4", sampleRate: 44100, seconds: 7.93, truePeakDbtp: -5.7, bed: [131, 392, 2093, 6000], bedLevel: 0.1, tickLevel: 0, seed: 37, bitsPerSecond: 64000 },
  { file: "he-aac-48k.mp4", sampleRate: 48000, seconds: 5.92, truePeakDbtp: -5.5, bed: [123, 370, 1975, 5600], bedLevel: 0.1, tickLevel: 0, seed: 41, bitsPerSecond: 64000 },
];

function run(command: string, args: readonly string[]): { stdout: string; stderr: string } {
  const result = spawnSync(command, [...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr}`);
  return { stdout: result.stdout, stderr: result.stderr };
}

/** The bed plus one 5 ms 1 kHz burst every two seconds of amplitude `burst`, as 32-bit float PCM (a burst above 1.0 is meant: the codec's overshoot is the point). */
function writeSource(spec: Spec, burst: number, out: string): void {
  const bed = spec.bed.map((hz, k) => `${(spec.bedLevel / (k + 1)).toFixed(4)}*sin(2*PI*${hz}*t)`).join("+");
  const burstExpr = `${burst.toFixed(5)}*sin(2*PI*1000*t)*lt(mod(t-1\\,2)\\,0.005)*gt(t\\,2.5)`;
  const tickExpr = spec.tickLevel === 0 ? "0" : `${spec.tickLevel}*sin(2*PI*2000*t)*lt(mod(t\\,0.15)\\,0.003)`;
  run(ffmpegPath(), [
    ...COMMON,
    ...["-f", "lavfi", "-i", `aevalsrc=${bed}+${burstExpr}+${tickExpr}:s=${spec.sampleRate}:d=${spec.seconds}`],
    ...["-f", "lavfi", "-i", `anoisesrc=d=${spec.seconds}:r=${spec.sampleRate}:c=pink:a=0.02:seed=${spec.seed}`],
    ...["-filter_complex", "[0][1]amix=inputs=2:normalize=0,pan=stereo|c0=c0|c1=0.92*c0"],
    ...["-c:a", "pcm_f32le", out],
  ]);
}

function encode(spec: Spec, wav: string, scratch: string, out: string): void {
  const m4a = join(scratch, "he.m4a");
  run("afconvert", [wav, m4a, "-f", "m4af", "-d", "aach", "-b", String(spec.bitsPerSecond)]);
  run(ffmpegPath(), [...COMMON, "-i", m4a, ...BITEXACT, "-c", "copy", "-movflags", "+faststart", out]);
}

/** True peak (dBTP) of the decoded file, from ffmpeg's ebur128 summary: the same measurement `fixtures.test.ts` repeats. */
function truePeakOf(file: string): number {
  const { stderr } = run(ffmpegPath(), ["-nostats", "-hide_banner", "-i", file, "-af", "ebur128=peak=true", "-f", "null", "-"]);
  const peak = /Peak:\s*(-?[\d.]+) dBFS/.exec(stderr.slice(stderr.lastIndexOf("Summary:")))?.[1];
  if (peak === undefined) throw new Error(`no ebur128 summary for ${file}`);
  return Number(peak);
}

/**
 * Finds the burst level at which the decoded file's true peak, as ffmpeg prints it (to 0.1 dB, the figure the tests compare), is the target. The peak is not a
 * smooth function of the level (the codec's quantisation moves it in steps of 0.1 to 0.2 dB), so a bisection narrows the level down and a scan around it finds
 * a level that lands exactly on the target.
 */
function make(spec: Spec, out: string): { burst: number; truePeak: number } {
  const scratch = mkdtempSync(join(tmpdir(), "music-fixture-"));
  try {
    const wav = join(scratch, "source.wav");
    const attempt = (burst: number): number => {
      writeSource(spec, burst, wav);
      encode(spec, wav, scratch, out);
      const truePeak = truePeakOf(out);
      if (process.env.GEN_TRACE) console.error(spec.file, burst.toFixed(5), truePeak);
      return truePeak;
    };
    const hit = (truePeak: number): boolean => Math.abs(truePeak - spec.truePeakDbtp) < 0.001;
    let low = 0.05;
    let high = 4;
    for (let step = 0; step < 18; step++) {
      const burst = (low + high) / 2;
      const truePeak = attempt(burst);
      if (hit(truePeak)) return { burst, truePeak };
      if (truePeak < spec.truePeakDbtp) low = burst;
      else high = burst;
    }
    const centre = (low + high) / 2;
    for (let k = 1; k <= 200; k++) {
      for (const sign of [1, -1]) {
        const burst = centre * (1 + sign * k * 0.0005);
        const truePeak = attempt(burst);
        if (hit(truePeak)) return { burst, truePeak };
      }
    }
    throw new Error(`${spec.file}: no burst level lands on ${spec.truePeakDbtp} dBTP`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  if (process.platform !== "darwin") throw new Error("generate.ts needs macOS's afconvert (HE-AAC); the committed files are what the tests read");
  for (const spec of SPECS) {
    const out = join(here, "tracks", spec.file);
    const { burst, truePeak } = make(spec, out);
    const bytes = readFileSync(out);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    // The line to paste into index.ts.
    writeFileSync(1, `${spec.file}: bytes ${bytes.byteLength}, sha256 ${sha256}, burst ${burst.toFixed(4)}, true peak ${truePeak} dBTP\n`);
  }
}
