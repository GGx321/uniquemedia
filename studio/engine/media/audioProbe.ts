import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { ffmpegPath } from "../../node/ffmpegBinary";
import { configuredFfmpegEnv } from "../../node/ffmpegEnv";
import type { FfmpegSpawner } from "../../node/runFfmpeg";
import { parseStreamLine } from "../music/decodeCheck";
import type { MediaFormat } from "./sniff";

// What ffmpeg says a track is (Stage 3, 3f.4), read from its input dump: the streams the file holds, the codec of the audio one, and the length
// its header gives. Studio has no ffprobe, so the authority is the bundled ffmpeg itself (the very binary that then decodes the file), asked in a
// CHILD PROCESS with the same demuxer forced: the verdict is about the file ffmpeg will decode, not about a second parser's reading of it.
//
// The dump is TEXT THE FILE PARTLY WRITES: ffmpeg prints a tag, a key or a handler name as it finds it, newlines included. So the dump is not
// trusted as a plain list (the rules of `decodeCheck.inspectStreams`): it is cut at a cap (a longer one is refused, never read as if it were
// whole), the stream numbers must be exactly 0..n-1 in order (a line that a key printed shows up as a repeated or skipped number), and only a
// line that STARTS with `Stream #0:N` counts as a stream (a tag's line starts with its key's indent), only the line with exactly two spaces
// of indent before `Duration:` is the header's.
//
// The probe also carries `-codec_whitelist` with the decoders the importer takes, so ffmpeg never opens (never decodes) an attached picture's decoder
// while it looks at the file: cover art is told apart by its `(attached pic)` disposition and left alone.

/** The demuxers the importer forces with `-f`: one per container family; `mov` is the MP4 family. */
export type AudioDemuxer = "mp3" | "aac" | "wav" | "flac" | "ogg" | "mov";

/** The demuxer for a container the sniff named, or null when the container is not an audio one (a picture, a GIF). */
export function demuxerOf(format: MediaFormat): AudioDemuxer | null {
  switch (format) {
    case "mp3":
      return "mp3";
    case "aac":
      return "aac";
    case "wav":
      return "wav";
    case "flac":
      return "flac";
    case "ogg":
      return "ogg";
    case "m4a":
    case "mp4":
    case "mov":
      return "mov";
    default:
      return null;
  }
}

/** The decoders the importer reads, by the codec name ffmpeg prints, for each container: nothing else is decoded, and a codec that is not on its container's row is refused. */
const DECODERS: Readonly<Record<AudioDemuxer, Readonly<Record<string, string>>>> = {
  mp3: { mp3: "mp3float" },
  aac: { aac: "aac" },
  wav: { pcm_u8: "pcm_u8", pcm_s16le: "pcm_s16le", pcm_s24le: "pcm_s24le", pcm_s32le: "pcm_s32le", pcm_f32le: "pcm_f32le", pcm_f64le: "pcm_f64le" },
  flac: { flac: "flac" },
  ogg: { vorbis: "vorbis", opus: "opus" },
  mov: { aac: "aac", alac: "alac" },
};

/** Whether the header of this container states the length exactly (a sample count or a track's own table), as opposed to an estimate from a bit rate. */
const EXACT_LENGTH: Readonly<Record<AudioDemuxer, boolean>> = { mp3: false, aac: false, wav: true, flac: true, ogg: true, mov: true };

/** Every decoder the importer takes, for the probe's whitelist: nothing else is opened while the file is looked at. */
export const PROBE_CODEC_WHITELIST: string = [...new Set(Object.values(DECODERS).flatMap((row) => Object.values(row)))].join(",");

// The stream line's grammar is `parseStreamLine`'s (decodeCheck.ts: strict, because a language is text the file writes). What follows the kind is read here.
const CODEC_OF_REST = /^\s*([a-z0-9_]+)/;
/** `(attached pic)` marks a cover picture only at the END of a line (a few parenthesised words, such as `(default)`, may follow it). */
const ATTACHED_PICTURE_AT_END = /\(attached pic\)(?:\s*\([A-Za-z ]+\))*\s*$/;
const DURATION_LINE = /^ {2}Duration: (\d+):(\d{2}):(\d{2})\.(\d{2})(?:,|$)/;

export interface StreamLine {
  readonly index: number;
  readonly kind: string;
  /** What follows the kind and its colon (the codec and what is said of it). */
  readonly rest: string;
}

/** The stream lines of a dump, in the order printed. */
export function streamLinesOf(dump: string): StreamLine[] {
  const streams: StreamLine[] = [];
  for (const line of dump.split("\n")) {
    const parsed = parseStreamLine(line);
    if (parsed !== null) streams.push(parsed);
  }
  return streams;
}

/** How many lines of the dump read as the header's `Duration:` line: one for a real file, more when a key printed one of its own. */
function headerLengths(dump: string): number[] {
  const lengths: number[] = [];
  for (const line of dump.split("\n")) {
    const match = DURATION_LINE.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined && match[3] !== undefined && match[4] !== undefined) {
      lengths.push(((Number(match[1]) * 60 + Number(match[2])) * 60 + Number(match[3])) * 1000 + Number(match[4]) * 10);
    }
  }
  return lengths;
}

/**
 * The header's length in ms (10 ms resolution), or null when the file has none (`N/A`) or the dump has more than one such line: a key
 * can print a line that reads as the header's, and which one is the file's is then not known.
 */
export function durationMsOf(dump: string): number | null {
  const lengths = headerLengths(dump);
  return lengths.length === 1 ? (lengths[0] ?? null) : null;
}

/** True when the stream numbers are exactly 0..n-1 in order: anything else (a number twice, one skipped) means the dump is not a plain list. */
function numberedInOrder(streams: readonly StreamLine[]): boolean {
  return streams.every((stream, position) => stream.index === position);
}

const isAttachedPicture = (stream: StreamLine): boolean => stream.kind === "Video" && ATTACHED_PICTURE_AT_END.test(stream.rest);

export type SourceVerdict =
  | {
      ok: true;
      /** The codec ffmpeg names for the stream (`mp3`, `aac`, `pcm_s16le`...). */
      codec: string;
      /** The decoder the importer pins (`-c:a` and `-codec_whitelist`): `mp3float` for `mp3`, the codec's own name otherwise. */
      decoder: string;
      /** The length the header gives, in ms; null when it gives none. */
      headerMs: number | null;
      /** Whether this container's header length is exact, so a decode that disagrees with it is a damaged or forged file. */
      exactLength: boolean;
    }
  | { ok: false; reason: "format" | "codec" };

/**
 * Judges a source's dump: exactly ONE audio stream, nothing else but attached pictures (never decoded and never mapped), and a codec on this
 * container's row. A file with another number of audio streams, a real video, a subtitle or data stream, or a dump that is not a plain list is
 * `format`; a codec the importer does not take is `codec`.
 */
export function judgeDump(dump: string, demuxer: AudioDemuxer): SourceVerdict {
  const streams = streamLinesOf(dump);
  if (!numberedInOrder(streams) || headerLengths(dump).length > 1) return { ok: false, reason: "format" };
  const audio = streams.filter((stream) => stream.kind === "Audio");
  if (audio.length !== 1) return { ok: false, reason: "format" };
  if (streams.some((stream) => stream.kind !== "Audio" && !isAttachedPicture(stream))) return { ok: false, reason: "format" };
  const codec = CODEC_OF_REST.exec(audio[0]?.rest ?? "")?.[1];
  const decoder = codec === undefined ? undefined : Object.hasOwn(DECODERS[demuxer], codec) ? DECODERS[demuxer][codec] : undefined;
  if (codec === undefined || decoder === undefined) return { ok: false, reason: "codec" };
  return { ok: true, codec, decoder, headerMs: durationMsOf(dump), exactLength: EXACT_LENGTH[demuxer] };
}

/**
 * Judges the dump of the file the importer MADE: one stream, audio, AAC-LC, 48 kHz, stereo, and a header length to hold the decode to. Nothing
 * else is allowed there, not even an attached picture: what is stored is audio and nothing else. `empty` says there was no stream at all, which is
 * what an encode of a source with no audio that decodes leaves (ffmpeg writes no track); any other failure is our own output not being what was asked.
 */
export function judgeStoredDump(dump: string): { ok: true; headerMs: number } | { ok: false; empty: boolean } {
  const streams = streamLinesOf(dump);
  if (streams.length === 0) return { ok: false, empty: true };
  const only = streams[0];
  if (streams.length !== 1 || only === undefined || only.index !== 0 || only.kind !== "Audio") return { ok: false, empty: false };
  const line = only.rest;
  if (CODEC_OF_REST.exec(line)?.[1] !== "aac" || !/^\s*aac \(LC\)/.test(line)) return { ok: false, empty: false };
  if (!/, 48000 Hz, stereo,/.test(line)) return { ok: false, empty: false };
  const headerMs = durationMsOf(dump);
  return headerMs === null ? { ok: false, empty: false } : { ok: true, headerMs };
}

// ---------- asking ffmpeg ----------

/** The most of ffmpeg's dump that is read: a few KiB for a real file, and a bound for a hostile one. */
const MAX_DUMP_BYTES = 256 * 1024;
const PROBE_TIMEOUT_MS = 15_000;
/** One allocation may take at most this much: far above what a real track needs and far below a container bomb. */
const MAX_ALLOC_BYTES = 64 * 1024 * 1024;

export type ProbeFailureKind = "spawn" | "timeout" | "aborted" | "dump-too-large";

/** The probe could not give a dump. `message` names the kind, never a path or ffmpeg's own text. */
export class ProbeError extends Error {
  readonly kind: ProbeFailureKind;
  constructor(kind: ProbeFailureKind) {
    super(kind);
    this.name = "ProbeError";
    this.kind = kind;
  }
}

export interface ProbeOptions {
  /** Absolute path of the file to look at. */
  path: string;
  demuxer: AudioDemuxer;
  /** The decoders ffmpeg may open while it looks (`-codec_whitelist`); `PROBE_CODEC_WHITELIST` by default. */
  whitelist?: string;
  signal: AbortSignal;
  timeoutMs?: number;
  /** Starts ffmpeg; Node's `spawn` by default (a test injects a scripted one). */
  spawner?: FfmpegSpawner;
}

const nodeSpawner: FfmpegSpawner = (command, args, options) => {
  const { env, ...rest } = options;
  return spawn(command, [...args], { ...rest, ...(env === undefined ? {} : { env }), stdio: [...options.stdio] });
};

/**
 * The argv of the probe: the demuxer forced, only the file protocol, a capped allocation, no stdin, and only the whitelisted decoders. With no
 * output, ffmpeg prints the input's dump and ends with an error that is ignored (its exit code says nothing: the dump does).
 */
export function probeArgv(options: Pick<ProbeOptions, "path" | "demuxer" | "whitelist">): string[] {
  return ["-nostdin", "-hide_banner", "-max_alloc", String(MAX_ALLOC_BYTES), "-protocol_whitelist", "file", "-codec_whitelist", options.whitelist ?? PROBE_CODEC_WHITELIST, "-f", options.demuxer, "-i", options.path];
}

/** What a child of ffmpeg printed on stderr (cut at the dump's bound) and how it exited. */
interface Captured {
  readonly stderr: string;
  readonly code: number | null;
}

/**
 * ffmpeg's input dump for a file, from a child process that is killed (and waited for) on a cancel or a time-out. Rejects with a
 * `ProbeError`; a file that ffmpeg cannot read is simply a dump with no streams.
 */
export function probeDump(options: ProbeOptions): Promise<string> {
  if (!isAbsolute(options.path)) return Promise.reject(new TypeError("probeDump: the path must be absolute"));
  return capture(probeArgv(options), options).then((captured) => captured.stderr);
}

/** The selectors that must match NOTHING in a file the importer takes: a second audio stream, a real video (an attached picture is not one), a subtitle, a data and an attachment stream. */
export const EXTRA_STREAM_SELECTORS: readonly string[] = ["0:a:1", "0:V", "0:s", "0:d", "0:t"];

/**
 * The check that parses NO TEXT: ffmpeg's own stream selection is the authority on whether the file holds more than the one audio stream the encode maps
 * (`-map 0:a:0`). Each of `EXTRA_STREAM_SELECTORS` is asked in a process of its own, and must FAIL with `Stream map '<selector>' matches no streams`. Anything
 * else (ffmpeg went on and exited 0; it failed for another reason, such as a decoder that is not allowed for a stream that IS there; it named another
 * selector) means a stream is there, or that it cannot be proven there is none: false. Stops at the first selector that is not proven empty.
 */
export async function selectionHasNoExtraStreams(options: ProbeOptions): Promise<boolean> {
  if (!isAbsolute(options.path)) throw new TypeError("selectionHasNoExtraStreams: the path must be absolute");
  for (const selector of EXTRA_STREAM_SELECTORS) {
    const argv = [...probeArgv(options), "-v", "error", "-map", selector, "-t", "0.05", "-f", "null", "-"];
    const { stderr, code } = await capture(argv, options);
    if (code === 0 || !stderr.includes(`Stream map '${selector}' matches no streams.`)) {
      console.error("DIAG-MUSIC select", selector, String(code), JSON.stringify(stderr));
      return false;
    }
  }
  return true;
}

/**
 * Runs ffmpeg with `argv` and captures its stderr, from a child process that is killed (and waited for) on a cancel or a time-out. Rejects with a `ProbeError`
 * (`dump-too-large` when it prints more than a real file's dump); the exit code is told, never judged here.
 */
function capture(argv: readonly string[], options: Pick<ProbeOptions, "signal" | "timeoutMs" | "spawner">): Promise<Captured> {
  if (options.signal.aborted) return Promise.reject(new ProbeError("aborted"));
  const timeoutMs = Math.min(options.timeoutMs ?? PROBE_TIMEOUT_MS, PROBE_TIMEOUT_MS);
  const spawner = options.spawner ?? nodeSpawner;
  return new Promise<Captured>((resolve, reject) => {
    let child: ReturnType<FfmpegSpawner>;
    try {
      child = spawner(ffmpegPath(), argv, { cwd: undefined, env: configuredFfmpegEnv(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      return reject(new ProbeError("spawn"));
    }
    let failure: ProbeError | null = null;
    const stop = (error: ProbeError): void => {
      failure ??= error;
      if (child.exitCode === null) child.kill("SIGKILL");
    };
    const timer = setTimeout(() => stop(new ProbeError("timeout")), timeoutMs);
    const onAbort = (): void => stop(new ProbeError("aborted"));
    options.signal.addEventListener("abort", onAbort, { once: true });
    let dump = "";
    let read = 0;
    child.stderr?.on("data", (chunk: Uint8Array) => {
      if (read >= MAX_DUMP_BYTES) return stop(new ProbeError("dump-too-large"));
      const room = MAX_DUMP_BYTES - read;
      read += Math.min(chunk.byteLength, room);
      dump += Buffer.from(chunk.subarray(0, room)).toString("latin1");
      if (chunk.byteLength > room) stop(new ProbeError("dump-too-large"));
    });
    child.stdout?.on("data", () => undefined);
    child.on("error", () => stop(new ProbeError("spawn")));
    child.on("close", (code) => {
      clearTimeout(timer);
      options.signal.removeEventListener("abort", onAbort);
      if (failure !== null) return reject(failure);
      resolve({ stderr: dump, code });
    });
  });
}
