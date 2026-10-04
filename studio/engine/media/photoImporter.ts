import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { MEDIA_BYTE_CAPS, type MediaUnsupportedReason } from "../../shared/engine";
import { DecodeWorkerError } from "../decode/decodeGate";
import { runFfmpegArgv, type FfmpegSpawner } from "../../node/runFfmpeg";
import type { FaceGateImage } from "../face";
import { imageSize } from "../library/media";
import { readOrientation, type ExifContainer } from "./exif";
import type { MediaImporter, MediaImportRequest } from "./imports";
import { orientedRgb } from "./orient";
import type { MediaFormat } from "./sniff";
import { webpInfo } from "./webp";

// The own-photo importer (Stage 3, 3f.2). One staged file in, one JPEG out: upright, at most 4096 px on a side, with no metadata at all.
//
//   JPEG, PNG   the engine's WASM decoders (the same ones the face gate uses, sha256-pinned, no native code)
//   WebP        ffmpeg, in a CHILD PROCESS, decodes the still to a PNG; untrusted bytes are never parsed in the engine process by it.
//               An animated WebP is refused from its header before anything is spawned.
//   HEIC        never gets here: the boundary refuses it (`heic`, «сохраните как JPEG») from its first bytes
//
// The orientation is read from the ORIGINAL bytes (`exif.ts`: jsquash and ffmpeg ignore it for a still) and applied after decode
// (`orient.ts`), where the alpha is also flattened onto black. The result is encoded by ffmpeg from raw RGB, resized when its longer side
// is over `MAX_PHOTO_SIDE`, as a baseline JPEG with `-bitexact` (no JFIF, no comment, no encoder string) and `-map_metadata -1`. The
// colour is the library's convention for a photo: full-range BT.601, which the render's colour chain converts (3a.5).
//
// Every ffmpeg call is hardened as the music chain's is (`render/musicChain.ts`): the file protocol only, the demuxer named outright,
// allocations capped, no stdin, a time limit, and one thread. Its stderr never leaves this module: a failure is the refusal `failed`.
// A cancel (`request.signal`) kills the child (`runFfmpegArgv` settles only once it is gone) and nothing is written afterwards: the
// signal is looked at before every phase, and each work file is a name the job gave us and removes itself.

/** The longest side the library keeps. A source with more is scaled down to it, keeping its aspect. */
export const MAX_PHOTO_SIDE = 4096;
/** The smallest side a photo may have: `coverCrop` cannot make a 1 px side even (3a.3). */
export const MIN_PHOTO_SIDE = 2;

/** One allocation of ffmpeg may take at most this much: above the largest frame (50 megapixels, RGBA is 200 MB), far below a container bomb. */
const MAX_ALLOC_BYTES = 512 * 1024 * 1024;

/** The most pixels a source may have, judged from its header before any decode: 8000 x 6000 is a 48 megapixel camera picture; memory (the decoded RGBA, the upright RGB) is about 350 MB at the cap. */
export const MAX_PHOTO_PIXELS = 50_000_000;

/** The most a PNG of a WebP may take on disk: 4 bytes a pixel at the cap, with headroom for a filter byte a row and the chunks (a PNG of noise is about that large). */
export const MAX_DECODED_PNG_BYTES = MAX_PHOTO_PIXELS * 4 + 16 * 1024 * 1024;
const DEFAULT_FFMPEG_TIMEOUT_MS = 90_000;

export interface PhotoImporterDeps {
  /** The WASM JPEG and PNG decoder (`createWasmImageDecoder`); build it with `maxPixels: MAX_PHOTO_PIXELS`. */
  readonly decode: (bytes: Uint8Array, signal: AbortSignal) => Promise<FaceGateImage>;
  /** Starts the child processes; Node's `spawn` when absent (a test injects a scripted one). */
  readonly spawner?: FfmpegSpawner | undefined;
  /** How long one ffmpeg call may run before it is killed; 90 s by default. */
  readonly ffmpegTimeoutMs?: number | undefined;
  /** The most bytes the PNG ffmpeg makes of a WebP may have before it is read; `MAX_DECODED_PNG_BYTES` by default. A test knob. */
  readonly maxDecodedPngBytes?: number | undefined;
}

/** A photo the importer turns away, with the reason the owner is told. */
class Refused extends Error {
  readonly reason: MediaUnsupportedReason;

  constructor(reason: MediaUnsupportedReason) {
    super(`refused: ${reason}`);
    this.name = "Refused";
    this.reason = reason;
  }
}

const HARDENED_HEAD: readonly string[] = ["-hide_banner", "-nostdin", "-y", "-v", "error", "-threads", "1", "-max_alloc", String(MAX_ALLOC_BYTES), "-protocol_whitelist", "file"];

function containerOf(format: MediaFormat): ExifContainer {
  if (format === "jpeg" || format === "png" || format === "webp") return format;
  // An APNG and a GIF animate, and every other container is not a picture: the bytes are not what a photo is.
  throw new Refused("format");
}

/** A size that is a picture: both sides at least `MIN_PHOTO_SIDE`, and no more pixels than the decoder takes. Judged from a header, before any decode. */
function judgeSize(size: { width: number; height: number } | null): { width: number; height: number } {
  if (size === null) throw new Refused("format");
  if (size.width < MIN_PHOTO_SIDE || size.height < MIN_PHOTO_SIDE) throw new Refused("too-small");
  if (size.width * size.height > MAX_PHOTO_PIXELS) throw new Refused("dimensions");
  return size;
}

/** The size the stored file gets: the source's, or scaled so the longer side is `MAX_PHOTO_SIDE` (never a side under 2). */
export function storedSize(width: number, height: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= MAX_PHOTO_SIDE) return { width, height };
  const scale = MAX_PHOTO_SIDE / longest;
  return {
    width: width === longest ? MAX_PHOTO_SIDE : Math.max(MIN_PHOTO_SIDE, Math.round(width * scale)),
    height: height === longest ? MAX_PHOTO_SIDE : Math.max(MIN_PHOTO_SIDE, Math.round(height * scale)),
  };
}

export function createPhotoImporter(deps: PhotoImporterDeps): MediaImporter {
  const timeoutMs = deps.ffmpegTimeoutMs ?? DEFAULT_FFMPEG_TIMEOUT_MS;

  async function ffmpeg(argv: readonly string[], output: string, signal: AbortSignal): Promise<void> {
    await runFfmpegArgv({ argv: [...argv, output], output, signal, timeoutMs, ...(deps.spawner === undefined ? {} : { spawner: deps.spawner }) });
  }

  async function run(request: MediaImportRequest): Promise<ReturnType<MediaImporter>> {
    const { staged, signal } = request;
    signal.throwIfAborted();
    const container = containerOf(staged.format);

    // The staged copy is the library's own, but it is read once, whole, and judged again: its size and hash are the staging's.
    const bytes = new Uint8Array(await readFile(staged.path, { signal }));
    if (bytes.length !== staged.bytes || createHash("sha256").update(bytes).digest("hex") !== staged.sha256) throw new Refused("failed");
    signal.throwIfAborted();
    if (bytes.length === 0) throw new Refused("format");
    // The orientation is the ORIGINAL file's: ffmpeg's PNG of a WebP carries none.
    const orientation = readOrientation(bytes, container);

    let pictureBytes = bytes;
    if (container === "webp") {
      const info = webpInfo(bytes);
      if (info === null) throw new Refused("format");
      if (info.animated) throw new Refused("animated-webp");
      judgeSize(info);
      const png = await request.workFile();
      signal.throwIfAborted();
      await ffmpeg(
        [...HARDENED_HEAD, "-f", "webp_pipe", "-c:v", "webp", "-noautorotate", "-i", staged.path, "-map", "0:v:0", "-frames:v", "1", "-an", "-sn", "-dn", "-map_metadata", "-1", "-c:v", "png", "-f", "image2pipe"],
        png.path,
        signal,
      );
      // What ffmpeg made is looked at before it is read whole: a header that lied about its size cannot make the engine read a bomb.
      const made = await stat(png.path);
      if (made.size > (deps.maxDecodedPngBytes ?? MAX_DECODED_PNG_BYTES)) throw new Refused("dimensions");
      pictureBytes = new Uint8Array(await readFile(png.path, { signal }));
    }

    // The header says what the decoder will be asked for, and `decode` checks it against what it decoded.
    const header = judgeSize(imageSize(pictureBytes));
    let decoded: FaceGateImage;
    try {
      decoded = await deps.decode(pictureBytes, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      // The worker itself failed or ran out of time: the picture is not to blame.
      if (error instanceof DecodeWorkerError) throw new Refused("failed");
      // A file the decoder cannot read (cut off, damaged, not the format its start says) is not a picture.
      throw new Refused("format");
    }
    signal.throwIfAborted();
    if (decoded.width !== header.width || decoded.height !== header.height) throw new Refused("format");

    const upright = orientedRgb(decoded.data, decoded.width, decoded.height, orientation);
    const raw = await request.workFile();
    signal.throwIfAborted();
    // `wx`: the name is the job's own and new; a file or a link already at it is refused, never written through.
    await writeFile(raw.path, upright.rgb, { flag: "wx", signal });
    const target = storedSize(upright.width, upright.height);

    const out = await request.workFile();
    signal.throwIfAborted();
    const resize = target.width === upright.width && target.height === upright.height ? [] : ["-vf", `scale=${target.width}:${target.height}:flags=lanczos`];
    await ffmpeg(
      [
        ...HARDENED_HEAD,
        "-f", "rawvideo", "-pixel_format", "rgb24", "-video_size", `${upright.width}x${upright.height}`, "-i", raw.path,
        ...resize,
        "-frames:v", "1", "-map_metadata", "-1", "-fflags", "+bitexact", "-flags:v", "+bitexact",
        "-c:v", "mjpeg", "-q:v", "2", "-pix_fmt", "yuvj420p", "-f", "mjpeg",
      ],
      out.path,
      signal,
    );
    signal.throwIfAborted();

    // What was written is judged again: its size on disk, and the size its own header gives.
    const written = await stat(out.path);
    if (written.size === 0) throw new Refused("failed");
    if (written.size > MEDIA_BYTE_CAPS.photo) throw new Refused("too-large");
    const stored = new Uint8Array(await readFile(out.path, { signal }));
    const storedHeader = imageSize(stored);
    if (storedHeader === null || storedHeader.width !== target.width || storedHeader.height !== target.height) throw new Refused("failed");
    return {
      ok: true,
      facts: { width: target.width, height: target.height, durationMs: null, sourceFps: null, hdrToSdr: false, loopFrames: null, delayFrames: null },
      output: { file: out, format: "jpeg" },
    };
  }

  return async (request) => {
    try {
      return await run(request);
    } catch (error) {
      // A cancel wins over whatever the stop produced (a killed child, a read that was aborted).
      if (request.signal.aborted) return { ok: false, reason: "cancelled" };
      // Only the reason travels: an ffmpeg's stderr and an fs error's message may name a path.
      return { ok: false, reason: error instanceof Refused ? error.reason : "failed" };
    }
  };
}
