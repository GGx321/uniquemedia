import { createHash } from "node:crypto";
import { lstat, readFile, stat, writeFile } from "node:fs/promises";
import { MEDIA_BYTE_CAPS, type MediaUnsupportedReason } from "../../shared/engine";
import { FfmpegError, FfmpegTimeoutError, runFfmpegArgv, type FfmpegSpawner } from "../../node/runFfmpeg";
import { inspectApng, inspectApngRaw, STICKER_FPS, STICKER_LIMITS, type ApngRejectCode } from "../../shared/stickers/apng";
import { inspectGif, type GifRejectCode } from "../../shared/stickers/gif";
import { quantiseByAccumulatedTime, type FrameDuration } from "../../shared/stickers/quantise";
import { MAX_ANIMATION_LOOP_PIXELS } from "../render/layerPass";
import { EncodeTooLargeError } from "../stickers/encodeErrors";
import type { StickerEncodeJob } from "../stickers/encodeGate";
import type { MediaImporter, MediaImportRequest } from "./imports";

// The own-sticker importer (Stage 3, 3f.5). One staged GIF or APNG in, one APNG out: the canvas of the source, every frame a full RGBA picture, every
// delay a whole number of 30 fps frames, the loop at most 300 of them, and nothing else (no colour chunk, no palette, no text).
//
//   1. JUDGE. The staged copy is read once (its size and sha256 checked again), and a bounded PURE reader judges it (`inspectGif`, `inspectApngRaw`:
//      every block and chunk, the caps, a GIF's LZW streams to the pixel). Nothing here decodes a picture. What it keeps is the canvas and each
//      frame's raw delay. A still PNG, a file of one frame and an APNG whose default image is not a frame (`DEFAULT_IMAGE_NOT_A_FRAME`, a poster
//      before the first fcTL) are refused here. The poster is refused, not skipped, so that every platform gives ONE answer: measured, the macOS ffmpeg 6.0 skips
//      it as the browsers do, but a decoder that draws it as a frame would play another loop than the preview, and the Windows build is another ffmpeg.
//   2. QUANTISE. The delays go onto the 30 fps grid by ACCUMULATED time (`quantise.ts`); a frame too short for any slot drops out of the loop. The loop
//      is judged in 30 fps frames: over 300 is refused, and so is a loop whose frames times its canvas is over what the render's layer pass can hold
//      (`MAX_ANIMATION_LOOP_PIXELS`, the memory rule of 3b.6), as `dimensions`.
//   3. CROSS-CHECK. ffmpeg, in a CHILD PROCESS, decodes the staged copy once to count what comes out of `fps=30` (`-xerror`, `-f null`): the count must be
//      the loop the quantiser promised, which holds the decoder to the rule the importer used for the delays. What was judged is what is decoded: the
//      decoder is named from the verdict (`-f`, `-codec_whitelist`, `-c:v`), the protocol is `file` only, and allocations and pixels are capped.
//   4. DECODE. A second ffmpeg call writes one rgba frame per SOURCE frame (`-fps_mode passthrough`) to a raw work file. Its size must be exactly the
//      frames the reader counted, at the canvas the reader saw. The file is made with `-n` and only after an `lstat` found no entry at its name.
//   5. ENCODE, off the engine's event loop. The frames that last at least one slot are read from the raw file and written with Studio's own APNG writer
//      (shared/stickers/apngWriter.ts, deterministic) in a worker thread that a cancel ends. The importer writes the bytes it is given, with `wx`, and
//      only after the signal was looked at; what it wrote is inspected again with the strict reader and must be the loop that was judged.
//
// Every ffmpeg call: the container named, `-protocol_whitelist file`, `-max_alloc`, `-max_pixels`, `-nostdin`, one thread, a time limit, and the kill of
// `runFfmpegArgv` on a cancel (it settles only once the child is gone). Nothing of stderr leaves this module: a failure is a reason.

/** One allocation of ffmpeg may take at most this much: far above a 720 x 720 frame (2 MB), far below a container bomb. */
const MAX_ALLOC_BYTES = 256 * 1024 * 1024;
const DEFAULT_FFMPEG_TIMEOUT_MS = 90_000;
const MAX_PIXELS = STICKER_LIMITS.maxSide * STICKER_LIMITS.maxSide;
const MIN_SIDE = 2;

export interface StickerImporterDeps {
  /** Encodes the frames of a raw file as an APNG, off the engine's event loop (`createStickerEncodeGate(...).encode`); a test passes its own. */
  readonly encode: (job: StickerEncodeJob, signal: AbortSignal) => Promise<Uint8Array>;
  /** Starts the child processes; Node's `spawn` when absent (a test injects a scripted one). */
  readonly spawner?: FfmpegSpawner | undefined;
  /** How long one ffmpeg call may run before it is killed; 90 s by default. */
  readonly ffmpegTimeoutMs?: number | undefined;
}

/** A sticker the importer turns away, with the reason the owner is told. */
class Refused extends Error {
  readonly reason: MediaUnsupportedReason;

  constructor(reason: MediaUnsupportedReason) {
    super(`refused: ${reason}`);
    this.name = "Refused";
    this.reason = reason;
  }
}

const HARDENED_HEAD: readonly string[] = ["-hide_banner", "-nostdin", "-v", "error", "-threads", "1", "-max_alloc", String(MAX_ALLOC_BYTES), "-protocol_whitelist", "file"];

/** What the reader kept of a source: its canvas and each frame's duration, whatever the container. */
interface Source {
  readonly container: "gif" | "apng";
  readonly width: number;
  readonly height: number;
  readonly durations: readonly FrameDuration[];
}

function reasonOfCode(code: GifRejectCode | ApngRejectCode): MediaUnsupportedReason {
  switch (code) {
    case "TOO_LARGE_FILE":
      return "too-large";
    case "SIDE_TOO_LARGE":
      return "dimensions";
    case "TOO_MANY_FRAMES":
      return "loop-too-long";
    case "NOT_ANIMATED":
      return "not-animated";
    default:
      // Everything else is a file that is not a well-formed GIF or APNG, or one the decoders would read differently (a default image that is not a frame).
      return "format";
  }
}

/** Judges the bytes with the bounded reader of their container. Never decodes a picture. */
function judge(bytes: Uint8Array, format: string): Source {
  if (format === "png") throw new Refused("not-animated");
  if (format === "gif") {
    const result = inspectGif(bytes);
    if (!result.ok) throw new Refused(reasonOfCode(result.code));
    const { info } = result;
    return { container: "gif", width: info.width, height: info.height, durations: info.frames.map((frame) => ({ num: frame.playedCs, den: 100 })) };
  }
  if (format === "apng") {
    const result = inspectApngRaw(bytes);
    if (!result.ok) throw new Refused(reasonOfCode(result.code));
    const { info } = result;
    return { container: "apng", width: info.width, height: info.height, durations: info.frames.map((frame) => ({ num: frame.delayNum, den: frame.delayDen })) };
  }
  throw new Refused("format");
}

export function createStickerImporter(deps: StickerImporterDeps): MediaImporter {
  const timeoutMs = deps.ffmpegTimeoutMs ?? DEFAULT_FFMPEG_TIMEOUT_MS;

  /** The decoder named from the verdict: the container, the codec whitelist and the codec, all before `-i`, so nothing is probed. */
  const inputOf = (container: Source["container"], path: string): string[] => [
    "-xerror",
    "-f", container,
    "-codec_whitelist", container,
    "-max_pixels", String(MAX_PIXELS),
    "-c:v", container,
    "-i", path,
    "-map", "0:v:0", "-an", "-sn", "-dn",
  ];

  async function ffmpeg(argv: readonly string[], output: string, signal: AbortSignal, onFrames?: (frames: number) => void): Promise<void> {
    try {
      await runFfmpegArgv({
        argv: [...HARDENED_HEAD, ...argv, output],
        output,
        signal,
        timeoutMs,
        ...(onFrames === undefined ? {} : { onFrames }),
        ...(deps.spawner === undefined ? {} : { spawner: deps.spawner }),
      });
    } catch (error) {
      if (signal.aborted) throw error;
      // The time limit and a child that could not be run are the machine's; a decode that failed under `-xerror` is the file's.
      if (error instanceof FfmpegTimeoutError) throw new Refused("failed");
      if (error instanceof FfmpegError) throw new Refused("format");
      throw new Refused("failed");
    }
  }

  async function run(request: MediaImportRequest): Promise<ReturnType<MediaImporter>> {
    const { staged, signal } = request;
    signal.throwIfAborted();
    if (staged.format === "png") throw new Refused("not-animated");
    if (staged.format !== "gif" && staged.format !== "apng") throw new Refused("format");
    if (staged.bytes > MEDIA_BYTE_CAPS.sticker) throw new Refused("too-large");

    // 1. JUDGE. The staged copy is the library's own, but it is read once, whole, and judged again: its size and hash are the staging's.
    const bytes = new Uint8Array(await readFile(staged.path, { signal }));
    if (bytes.length !== staged.bytes || createHash("sha256").update(bytes).digest("hex") !== staged.sha256) throw new Refused("failed");
    signal.throwIfAborted();
    const source = judge(bytes, staged.format);
    if (source.width < MIN_SIDE || source.height < MIN_SIDE) throw new Refused("too-small");

    // 2. QUANTISE.
    const { slots, loopFrames } = quantiseByAccumulatedTime(source.durations);
    if (loopFrames > STICKER_LIMITS.maxLoopFrames) throw new Refused("loop-too-long");
    // The memory rule of 3b.6: the render prices a sticker at its loop cache, one frame of its own size per SLOT of the loop, and refuses a layer that fits
    // no call. A loop the render could never use is refused here, where the owner can still choose another file.
    if (loopFrames * source.width * source.height > MAX_ANIMATION_LOOP_PIXELS) throw new Refused("dimensions");
    const keptSlots = slots.filter((n) => n > 0);
    if (keptSlots.length < 2) throw new Refused("not-animated");

    // 3. CROSS-CHECK: what ffmpeg makes of the file at 30 fps is the loop the quantiser promised.
    let counted = 0;
    await ffmpeg([...inputOf(source.container, staged.path), "-vf", `fps=${STICKER_FPS}`, "-f", "null"], "-", signal, (frames) => (counted = Math.max(counted, frames)));
    signal.throwIfAborted();
    if (counted !== loopFrames) throw new Refused("format");

    // 4. DECODE every source frame to a raw rgba work file, made new: nothing may be at its name, and `-n` never overwrites.
    const raw = await request.workFile();
    signal.throwIfAborted();
    const taken = await lstat(raw.path).then(
      () => true,
      () => false,
    );
    if (taken) throw new Refused("failed");
    await ffmpeg([...inputOf(source.container, staged.path), "-fps_mode", "passthrough", "-pix_fmt", "rgba", "-n", "-f", "rawvideo"], raw.path, signal);
    signal.throwIfAborted();
    // What was decoded is exactly the frames the reader counted, at the canvas it saw.
    const frameBytes = source.width * source.height * 4;
    const decoded = await stat(raw.path);
    if (decoded.size !== frameBytes * source.durations.length) throw new Refused("format");

    // 5. ENCODE off the engine's loop, then write what came back.
    let apng: Uint8Array;
    try {
      apng = await deps.encode({ rawPath: raw.path, width: source.width, height: source.height, slots, maxBytes: MEDIA_BYTE_CAPS.sticker }, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      if (error instanceof EncodeTooLargeError) throw new Refused("too-large");
      throw new Refused("failed");
    }
    signal.throwIfAborted();
    const written = inspectApng(apng);
    if (!written.ok) throw new Refused(written.code === "TOO_LARGE_FILE" ? "too-large" : "failed");
    const { info } = written;
    // The canvas, and every frame's delay in order (so the number of frames and the loop's length with them), are the ones that were judged.
    const delays = info.frames.map((frame) => frame.delayFrames);
    if (info.width !== source.width || info.height !== source.height || delays.length !== keptSlots.length || delays.some((delay, i) => delay !== keptSlots[i])) {
      throw new Refused("failed");
    }
    const out = await request.workFile();
    signal.throwIfAborted();
    // `wx`: the name is the job's own and new; a file or a link already at it is refused, never written through.
    await writeFile(out.path, apng, { flag: "wx", signal });
    if ((await stat(out.path)).size !== apng.length) throw new Refused("failed");
    return {
      ok: true,
      facts: { width: source.width, height: source.height, durationMs: null, sourceFps: null, hdrToSdr: false, loopFrames, delayFrames: keptSlots },
      output: { file: out, format: "apng" },
    };
  }

  return async (request) => {
    try {
      return await run(request);
    } catch (error) {
      // A cancel wins over whatever the stop produced (a killed child, a read that was aborted, an ended worker).
      if (request.signal.aborted) return { ok: false, reason: "cancelled" };
      // Only the reason travels: an ffmpeg's stderr and an fs error's message may name a path.
      return { ok: false, reason: error instanceof Refused ? error.reason : "failed" };
    }
  };
}
