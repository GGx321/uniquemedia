import { assertAbsolutePath, assertSafeFilterGraph } from "./filterString";
import { RenderGraphError } from "./types";

// The audio chain of a montage with music (Stage 3 plan, 3c.5). Pure: it builds strings and reads one, and starts nothing.
//
//   decode the stored HE-AAC track -> aresample=48000 -> stereo -> the clip segment -> gain -> exactly N samples
//
// THE LEVEL. Music keeps its own level; the only change is an attenuation for peak safety (critique A5). Its size comes from
// a true-peak pass over the exact segment the render will use (`buildMusicMeasure`, ebur128 with `peak=true`), once per
// render and never cached: gain = min(0, -1.5 - TP) dB. It is never positive (invariant 21). ebur128 prints the peak to one
// decimal, so the gain is written to one decimal as well, rounded towards MORE attenuation.
//
// THE LENGTH is built in the graph (invariant 20): the segment is cut in samples at 48 kHz (`atrim=start_sample:end_sample`),
// and `apad,atrim=end_sample=N` makes the audio exactly N samples whatever the track holds, so a track that ends early is
// padded with silence rather than leaving the video longer than its sound. (`videos.render` refuses a track too short for
// `startMs` plus the montage up front, as `track-too-short`; this is the builder's own floor.) There is no `-t`, no `-shortest`.
//
// THE INPUT is untrusted media and takes the hardening of the store's decode (`music/decodeCheck.ts`), all BEFORE `-i`: the
// mov demuxer forced, only the file protocol, the AAC decoder forced, allocations capped. Of these, `-max_alloc` is a
// PROCESS-GLOBAL option, not a per-input one: wherever it stands it caps every allocation of the whole ffmpeg run, the video
// side of pass 2 included (measured fine at 1080x1920: no single buffer comes near 64 MiB). The render never lets ffmpeg pick
// a stream: the only audio it reads is `<i>:a:0`, named in a `-map`.

/** The true peak the music is brought under, in dBTP (plan, "Music": gain = min(0, -1.5 - TP)). */
export const MUSIC_TARGET_TRUE_PEAK_DB = -1.5;

/** One allocation may take at most 64 MiB (as in `decodeCheck.ts`): far above a real track's need, far below a container bomb. */
const MAX_ALLOC_BYTES = 64 * 1024 * 1024;

/**
 * The flags that go before the track's `-i`. `decodeCheck.ts` hardens its decode the same way (its stream inspection runs the whitelists but not the forced
 * `-c:a`, so that what the file names stays visible). `-protocol_whitelist`, `-codec_whitelist`, `-f` and `-c:a` are options of THIS input: no codec but AAC
 * may be opened for it, whatever the file says its stream is. `-max_alloc` is global to the process, so in pass 2 it caps the video side too.
 */
export const MUSIC_INPUT_ARGS: readonly string[] = ["-max_alloc", String(MAX_ALLOC_BYTES), "-protocol_whitelist", "file", "-codec_whitelist", "aac", "-f", "mov", "-c:a", "aac"];

/** 48 kHz: 48 samples per millisecond. */
const SAMPLES_PER_MS = 48;

const bad = (message: string): never => {
  throw new RenderGraphError("BAD_AUDIO", message);
};

/** The gain, in dB, that brings a segment whose true peak is `truePeakDb` to the target: `min(0, -1.5 - TP)`, never positive, in tenths of a dB. */
export function musicGainDb(truePeakDb: number): number {
  // Minus infinity is the peak of digital silence: nothing to attenuate. Anything else that is not a number is a failed measurement.
  if (Number.isNaN(truePeakDb) || truePeakDb === Number.POSITIVE_INFINITY) bad(`the measured true peak is not a number: ${truePeakDb}`);
  const gain = Math.min(0, MUSIC_TARGET_TRUE_PEAK_DB - truePeakDb);
  // Tenths, towards more attenuation; the epsilon only absorbs float noise on a value that is already a whole tenth.
  const tenths = Math.floor(gain * 10 + 1e-9);
  return tenths === 0 ? 0 : tenths / 10;
}

/** The input group of a stored track: the hardened flags, then `-i <path>`. The path is absolute (never an option, never `cwd`-relative). */
export function musicInputArgs(path: string): string[] {
  try {
    assertAbsolutePath(path, "the track's path");
  } catch (error) {
    if (error instanceof RenderGraphError) bad(error.message);
    throw error;
  }
  return [...MUSIC_INPUT_ARGS, "-i", path];
}

function assertWhole(value: number, what: string, min: number): void {
  if (!Number.isSafeInteger(value) || value < min) bad(`${what} must be a whole number of at least ${min}, got ${value}`);
}

/**
 * Decode side of the chain: 48 kHz, planar float, stereo, then the clip segment of `samples` samples that starts `startMs`
 * into the track, renumbered from zero. The measurement and the render both use this exact string, so they see the same samples.
 */
export function musicSegmentFilters(startMs: number, samples: number): string {
  assertWhole(startMs, "the music start", 0);
  assertWhole(samples, "the segment length in samples", 1);
  const start = startMs * SAMPLES_PER_MS;
  return `aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=start_sample=${start}:end_sample=${start + samples},asetpts=PTS-STARTPTS`;
}

/**
 * The simple filter graph of pass 2's audio output (`-af`), fed by `-map <i>:a:0`: the segment, the gain (none when it is 0,
 * so a track that needs no attenuation passes through bit for bit), and the exact length.
 */
export function musicRenderFilters(startMs: number, gainDb: number, samples: number): string {
  if (!Number.isFinite(gainDb) || gainDb > 0) bad(`the music gain must be a number not above 0 dB, got ${gainDb}`);
  if (gainDb < -60) bad(`the music gain must not be below -60 dB, got ${gainDb}`);
  const gain = gainDb === 0 ? "" : `volume=${gainDb.toFixed(1)}dB,`;
  const chain = `${musicSegmentFilters(startMs, samples)},${gain}apad,atrim=end_sample=${samples}`;
  assertSafeFilterGraph(chain);
  return chain;
}

export interface MusicMeasureInput {
  readonly path: string;
  readonly startMs: number;
  /** The montage's length: the segment measured is this long. */
  readonly durationMs: number;
}

export interface MusicMeasureJob {
  /** Everything after the ffmpeg binary. There is no output file: the answer is on stderr. */
  readonly argv: readonly string[];
}

/** The true-peak pass over the clip segment: the same decode and cut as the render, ebur128 with `peak=true`, to a null output. */
export function buildMusicMeasure(input: MusicMeasureInput): MusicMeasureJob {
  assertWhole(input.durationMs, "the montage length", 1);
  const filters = `${musicSegmentFilters(input.startMs, input.durationMs * SAMPLES_PER_MS)},ebur128=peak=true:framelog=quiet`;
  assertSafeFilterGraph(filters);
  return {
    argv: ["-hide_banner", "-nostdin", "-nostats", ...musicInputArgs(input.path), "-map", "0:a:0", "-af", filters, "-vn", "-sn", "-dn", "-f", "null", "-"],
  };
}

const TRUE_PEAK = /True peak:\s*\r?\n\s*Peak:\s*([+-]?(?:\d+(?:\.\d+)?|inf))\s*dBFS/g;

/** The true peak, in dBTP, from the summary ebur128 prints on stderr (the last one); `-inf` for silence. Refuses text with none. */
export function parseTruePeak(stderr: string): number {
  let last: string | undefined;
  for (const match of stderr.matchAll(TRUE_PEAK)) last = match[1];
  if (last === undefined) return bad("ffmpeg's loudness summary holds no true peak");
  // `-inf` is the peak of silence; `inf` or `+inf` is a failed measurement, which `musicGainDb` refuses.
  if (last.endsWith("inf")) return last.startsWith("-") ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  return Number(last);
}
