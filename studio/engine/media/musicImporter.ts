import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { MEDIA_BYTE_CAPS, type MediaUnsupportedReason } from "../../shared/engine";
import { FfmpegTimeoutError, runFfmpegArgv, type FfmpegSpawner } from "../../node/runFfmpeg";
import { decodeAudio, DecodeError } from "../music/decodeCheck";
import { demuxerOf, judgeDump, judgeStoredDump, ProbeError, probeDump, selectionHasNoExtraStreams, type AudioDemuxer } from "./audioProbe";
import type { MediaImporter, MediaImportRequest } from "./imports";

// The own-music importer (Stage 3, 3f.4). One staged file in, one M4A out: AAC-LC, 48 kHz, stereo, 256 kbit/s, with no tag, no cover art and no
// other stream, at most ten minutes long.
//
//   mp3, m4a/aac (LC and HE), wav (PCM), flac, alac, ogg (Vorbis), opus
//
// Every step that touches the untrusted bytes is a CHILD PROCESS of the bundled ffmpeg, never the engine's own thread:
//
//   1. the staged copy is hashed again (a stream, not a 100 MB buffer): it is still the bytes the staging judged;
//   2. PROBE: ffmpeg's own input dump, with the demuxer forced from the sniffed container and only the importer's decoders allowed, says what the
//      file holds (`audioProbe.ts`): exactly ONE audio stream, nothing else but attached pictures, a codec on the container's row. That is the verdict;
//   3. ENCODE: ffmpeg is PINNED to the verdict, so what is decoded is what was judged. The demuxer (`-f`), the decoder (`-c:a`) and the whitelist of
//      decoders (`-codec_whitelist`) come from it; `-map 0:a:0` takes the one audio stream, `-vn -sn -dn` leave out a cover picture and every other stream
//      (never mapped, never decoded), `-map_metadata -1` (global, stream and chapters) drops every tag; `-t` cuts the INPUT at the limit plus a margin,
//      so a header that claims a short length cannot turn a long file into unbounded work; the file protocol only, a capped allocation, no stdin,
//      one thread, and a time limit that follows the length the header states;
//   4. CHECK THE OUTPUT: ffmpeg's dump of what was made must be AAC-LC, 48 kHz, stereo, one stream; then it is DECODED (`decodeAudio`, which also gives the
//      waveform), and the length is the DECODED length. Over the limit is `too-long`; for a container whose header states its length exactly (wav, flac,
//      ogg, mov) a decode that disagrees with the header is a truncated or forged file.
//
// A cancel (`request.signal`) kills the child (`runFfmpegArgv` settles only once it is gone) and nothing is written afterwards: the signal is looked at
// before every phase, and each work file is a name the job gave us and removes itself. Nothing of ffmpeg's stderr leaves this module: a failure is a reason.

/** The longest track the library keeps: ten minutes, as DECODED. */
export const MAX_TRACK_MS = 600_000;
/** How far past the limit the decode is let run, so that a track a little over is told apart from one that is just at it. */
const CUT_MARGIN_MS = 2_000;
/** The most a stored file may take: ten minutes at 256 kbit/s is about 19 MB. */
export const MAX_STORED_BYTES = 40 * 1024 * 1024;
/** One allocation of ffmpeg may take at most this much: far above what a track needs and far below a container bomb. */
const MAX_ALLOC_BYTES = 64 * 1024 * 1024;

const ENCODE_FLOOR_MS = 30_000;
const ENCODE_CEILING_MS = 5 * 60_000;
/** The share of the stated length an encode may take, over the floor: the encoder runs about 30 times faster than real time on a slow machine, with room to spare. */
const ENCODE_MS_PER_MS = 0.5;

/**
 * The decoder's priming an mp3 may add to its length (3f.4 review L4). An mp3 with no Xing/LAME header carries no encoder delay, so a decoder emits about
 * 1105 samples (529 of the decoder's own and the encoder's 576) before the tone: 138 ms at 8 kHz, the lowest rate an mp3 has, 25 ms at 44.1 kHz. A track of
 * exactly the limit then decodes a little over it, and is allowed those milliseconds: for an mp3 only, since no other format has such a delay without saying so.
 * (An mp3 that is really up to 150 ms longer than the limit is stored: the limit is a length the owner cannot tell from the priming.)
 */
export const MP3_PRIMING_MS = 150;

/** How long an encode may run before it is killed: the floor, plus half the length the header states, never more than a few minutes (a header can lie). */
export function encodeTimeoutFor(headerMs: number | null): number {
  const stated = headerMs === null || !Number.isFinite(headerMs) || headerMs < 0 ? MAX_TRACK_MS : headerMs;
  return Math.min(ENCODE_CEILING_MS, ENCODE_FLOOR_MS + Math.round(stated * ENCODE_MS_PER_MS));
}

export interface MusicImporterDeps {
  /** Starts the child processes; Node's `spawn` when absent (a test injects a scripted one). */
  readonly spawner?: FfmpegSpawner | undefined;
  /** The longest track, in ms; `MAX_TRACK_MS` by default. A test knob: the boundary is the same at any size. */
  readonly maxDurationMs?: number | undefined;
  /** How long the probe may run; its own default (15 s) when absent. A test knob. */
  readonly probeTimeoutMs?: number | undefined;
  /** How long the encode may run; `encodeTimeoutFor` of the header's length when absent. A test knob. */
  readonly encodeTimeoutMs?: number | undefined;
  /** The most the stored file may take, in bytes; `MAX_STORED_BYTES` by default. A test knob. */
  readonly maxStoredBytes?: number | undefined;
}

/** A track the importer turns away, with the reason the owner is told. */
class Refused extends Error {
  readonly reason: MediaUnsupportedReason;

  constructor(reason: MediaUnsupportedReason) {
    super(`refused: ${reason}`);
    this.name = "Refused";
    this.reason = reason;
  }
}

/** The size and sha256 of a file, read as a stream under the signal: a 100 MB track is never held whole. */
async function hashOf(path: string, signal: AbortSignal): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path, { signal })) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    bytes += buffer.length;
    hash.update(buffer);
  }
  return { bytes, sha256: hash.digest("hex") };
}

/** Where the decode may differ from a header that states its length exactly: a few frames of priming and padding, and a rounding of the header's own. */
function exactTolerance(headerMs: number): number {
  return 150 + Math.round(headerMs * 0.005);
}

/**
 * The ENCODE's argv, up to the output path: pinned to the demuxer and decoder the probe judged.
 *
 * The work is bounded by what it WRITES, not by what the file says (3f.4 review M1): an input `-t` is a bound on TIMESTAMPS, and a mov's `stts` can put every
 * sample but the last at a timestamp near 0, so the cut never comes. `-frames:a` (the limit plus the margin, in AAC frames of 1024 samples at 48 kHz) and `-fs`
 * (one byte over the most a stored file may take, so a file that reaches it is seen as over) are OUTPUT options and count what is made. `asetpts` makes the output's
 * timestamps follow the samples, so a file that lies about when its samples play does not make the stored file lie.
 */
export function encodeArgv(input: { path: string; demuxer: AudioDemuxer; decoder: string; maxDurationMs: number; maxStoredBytes?: number }): string[] {
  const capSeconds = (input.maxDurationMs + CUT_MARGIN_MS) / 1000;
  const frames = Math.ceil((capSeconds * 48_000) / 1024);
  return [
    "-hide_banner", "-nostdin", "-y", "-v", "error", "-threads", "1",
    "-max_alloc", String(MAX_ALLOC_BYTES),
    "-protocol_whitelist", "file",
    "-codec_whitelist", input.decoder,
    "-t", String(capSeconds),
    "-f", input.demuxer,
    "-c:a", input.decoder,
    "-i", input.path,
    "-map", "0:a:0", "-vn", "-sn", "-dn",
    "-map_metadata", "-1", "-map_metadata:s:a:0", "-1", "-map_chapters", "-1",
    "-af", "aresample=48000,asetpts=N/SR/TB", "-ar", "48000", "-ac", "2",
    "-c:a", "aac", "-profile:a", "aac_low", "-b:a", "256k",
    "-frames:a", String(frames), "-fs", String((input.maxStoredBytes ?? MAX_STORED_BYTES) + 1),
    "-fflags", "+bitexact", "-flags:a", "+bitexact",
    "-movflags", "+faststart", "-f", "ipod",
  ];
}

export function createMusicImporter(deps: MusicImporterDeps = {}): MediaImporter {
  const maxMs = deps.maxDurationMs ?? MAX_TRACK_MS;
  const maxStored = deps.maxStoredBytes ?? MAX_STORED_BYTES;
  const spawnerOption = deps.spawner === undefined ? {} : { spawner: deps.spawner };

  async function run(request: MediaImportRequest): ReturnType<MediaImporter> {
    const { staged, signal } = request;
    signal.throwIfAborted();
    const demuxer = demuxerOf(staged.format);
    if (demuxer === null) throw new Refused("format");
    // The boundary refused an oversize file by its size before a byte was copied; this is a second line behind it.
    if (staged.bytes > MEDIA_BYTE_CAPS.audio) throw new Refused("too-large");

    // 1. The staged copy is the library's own, but it is judged again: its size and hash are the staging's.
    const staging = await hashOf(staged.path, signal);
    if (staging.bytes !== staged.bytes || staging.sha256 !== staged.sha256) throw new Refused("failed");
    signal.throwIfAborted();
    if (staged.bytes === 0) throw new Refused("format");

    // 2. The verdict: what ffmpeg says the file holds.
    let dump: string;
    try {
      dump = await probeDump({ path: staged.path, demuxer, signal, ...spawnerOption, ...(deps.probeTimeoutMs === undefined ? {} : { timeoutMs: deps.probeTimeoutMs }) });
    } catch (error) {
      if (signal.aborted) throw error;
      // A dump that is longer than a real file's can only be made by the file itself; a probe that could not run or ran out of time is no verdict on it.
      throw new Refused(error instanceof ProbeError && error.kind === "dump-too-large" ? "format" : "failed");
    }
    const verdict = judgeDump(dump, demuxer);
    if (!verdict.ok) throw new Refused(verdict.reason);
    signal.throwIfAborted();
    // The verdict above is read from TEXT the file partly writes. ffmpeg's own stream selection says the same without parsing any: no second audio stream, no
    // real video, subtitle, data or attachment stream (an attached picture is none of them), or the file is refused (3f.4 review H1).
    let clean: boolean;
    try {
      clean = await selectionHasNoExtraStreams({ path: staged.path, demuxer, signal, ...spawnerOption, ...(deps.probeTimeoutMs === undefined ? {} : { timeoutMs: deps.probeTimeoutMs }) });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new Refused(error instanceof ProbeError && error.kind === "dump-too-large" ? "format" : "failed");
    }
    if (!clean) throw new Refused("format");
    signal.throwIfAborted();

    // 3. The encode, pinned to the verdict.
    const out = await request.workFile();
    signal.throwIfAborted();
    const argv = [...encodeArgv({ path: staged.path, demuxer, decoder: verdict.decoder, maxDurationMs: maxMs, maxStoredBytes: maxStored }), out.path];
    try {
      await runFfmpegArgv({ argv, output: out.path, signal, timeoutMs: deps.encodeTimeoutMs ?? encodeTimeoutFor(verdict.headerMs), ...spawnerOption });
    } catch (error) {
      if (signal.aborted) throw error;
      // A time-out is a machine that is too slow or a file that is too heavy, not a verdict on the format; any other failure is a stream ffmpeg cannot decode.
      throw new Refused(error instanceof FfmpegTimeoutError ? "failed" : "format");
    }
    signal.throwIfAborted();

    // 4. What was made is judged again: its size, its own dump, then its DECODED length.
    const written = await stat(out.path);
    if (written.size === 0) throw new Refused("failed");
    // `-fs` stops the write one byte past the ceiling, so a file over it is a track that would not fit: told as a size, never stored.
    if (written.size > maxStored) throw new Refused("too-large");
    let outDump: string;
    try {
      outDump = await probeDump({ path: out.path, demuxer: "mov", whitelist: "aac", signal, ...spawnerOption, ...(deps.probeTimeoutMs === undefined ? {} : { timeoutMs: deps.probeTimeoutMs }) });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new Refused("failed");
    }
    const stored = judgeStoredDump(outDump);
    // No stream at all: the source had no audio that decodes (a WAV of no samples). Anything else is our own output not being what was asked for.
    if (!stored.ok) throw new Refused(stored.empty ? "format" : "failed");
    signal.throwIfAborted();
    let decoded;
    try {
      decoded = await decodeAudio({ path: out.path, expectedMs: stored.headerMs, signal, streams: async () => ["Audio"], ...spawnerOption });
    } catch (error) {
      if (signal.aborted) throw error;
      // Nothing decoded: the source had no audio that decodes. Anything else is our own output failing its check.
      throw new Refused(error instanceof DecodeError && error.kind === "no-audio" ? "format" : "failed");
    }
    signal.throwIfAborted();
    const decodedMs = Math.round(decoded.decodedMs);
    if (decodedMs <= 0) throw new Refused("format");
    // An mp3 is allowed its decoder's priming over the limit (`MP3_PRIMING_MS`), and no other format is.
    if (decodedMs > maxMs + (demuxer === "mp3" ? MP3_PRIMING_MS : 0)) throw new Refused("too-long");
    // A container that states its length exactly says how much there should be: a cut file has less, and a forged short header has more.
    if (verdict.exactLength && verdict.headerMs !== null && Math.abs(decodedMs - verdict.headerMs) > exactTolerance(verdict.headerMs)) throw new Refused("format");

    return {
      ok: true,
      facts: { width: null, height: null, durationMs: decodedMs, sourceFps: null, hdrToSdr: false, loopFrames: null, delayFrames: null },
      output: { file: out, format: "m4a" },
      waveform: decoded.peaks,
    };
  }

  return async (request) => {
    try {
      return await run(request);
    } catch (error) {
      // A cancel wins over whatever the stop produced (a killed child, a read that was aborted).
      if (request.signal.aborted) return { ok: false, reason: "cancelled" };
      // Only the reason travels: ffmpeg's stderr and an fs error's message may name a path.
      return { ok: false, reason: error instanceof Refused ? error.reason : "failed" };
    }
  };
}
