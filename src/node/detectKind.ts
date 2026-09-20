import { spawn } from "node:child_process";
import { open } from "node:fs/promises";
import ffprobeStatic from "ffprobe-static";
import { longestDuration, parseFfprobeJson } from "./ffprobeJson";
import type { MediaKind } from "../core/types";

const FFPROBE = ffprobeStatic.path.replace("app.asar", "app.asar.unpacked");

/**
 * ISO-BMFF brands that mean "this is a HEIF still", as they appear in the
 * `ftyp` box. An iPhone capture is major brand `heic` with `mif1`/`miaf` among
 * the compatible brands; `avif` is the AV1-coded sibling and is equally
 * unreadable here. MP4 brands (`isom`, `mp42`, `qt  `) are deliberately absent:
 * a video carries an `ftyp` box too and must not trip this guard.
 */
const HEIF_BRANDS = new Set([
  "heic", "heix", "heim", "heis",
  "hevc", "hevx", "hevm", "hevs",
  "mif1", "msf1",
  "avif", "avis",
]);

/** Codecs that ffprobe reports for a still-image container. */
const IMAGE_CODECS = new Set(["mjpeg", "png", "webp", "bmp", "tiff", "jpeg2000"]);

/**
 * A still decoded by the image2 demuxer still reports a duration — one frame at
 * the demuxer's nominal 25fps, i.e. 0.04s. So "has a duration" cannot separate
 * a photo from a video; "has a duration long enough to be footage" can. Half a
 * second is two orders of magnitude above the still case and far below any real
 * clip, and it is what keeps an animated MJPEG/WebP on the video path.
 */
const STILL_MAX_DURATION_SEC = 0.5;

function runFfprobe(input: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFPROBE, [
      "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", input,
    ]);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(out).toString(),
        stderr: Buffer.concat(err).toString(),
      })
    );
  });
}

/** Reads the `ftyp` brands off the head of the file. Returns an empty list when
 *  the file does not start with an ISO-BMFF `ftyp` box (a JPEG, a PNG, ...). */
async function readFtypBrands(input: string): Promise<string[]> {
  const head = Buffer.alloc(64);
  let read = 0;
  const handle = await open(input, "r");
  try {
    ({ bytesRead: read } = await handle.read(head, 0, head.length, 0));
  } finally {
    await handle.close();
  }
  if (read < 12 || head.toString("latin1", 4, 8) !== "ftyp") return [];
  const boxSize = head.readUInt32BE(0);
  // Major brand at 8..12, minor version at 12..16, compatible brands after.
  const end = Math.min(read, boxSize > 0 ? boxSize : read);
  const brands = [head.toString("latin1", 8, 12)];
  for (let at = 16; at + 4 <= end; at += 4) brands.push(head.toString("latin1", at, at + 4));
  return brands;
}

/**
 * Decides whether `input` is a still or footage by what is actually inside it,
 * never by its extension — an extension lies, and a `.jpg` that is really an
 * MP4 would otherwise be run through the photo pipeline.
 *
 * Throws, rather than guessing, for HEIC/HEIF: the bundled ffmpeg has no HEIF
 * demuxer, so ffprobe answers such a file with `moov atom not found` — a dump
 * that tells the user nothing about what to do. This is checked before probing
 * so that the actionable message is what surfaces.
 */
export async function detectMediaKind(input: string): Promise<MediaKind> {
  let brands: string[];
  try {
    brands = await readFtypBrands(input);
  } catch (err) {
    throw new Error(
      `Cannot read ${input}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (brands.some((b) => HEIF_BRANDS.has(b))) {
    throw new Error(
      `${input} is a HEIC/HEIF image, which this build cannot open: the bundled ` +
        `ffmpeg has no HEIF demuxer. Convert it to JPEG or PNG and try again.`
    );
  }

  const { code, stdout, stderr } = await runFfprobe(input);
  if (code !== 0) {
    throw new Error(
      `Cannot identify ${input}: ffprobe could not read it. ${stderr.trim().slice(-300)}`.trim()
    );
  }

  const probe = parseFfprobeJson(stdout);
  const streams = probe.streams;
  const video = streams.find((s) => s.codecType === "video");
  if (!video) {
    if (streams.some((s) => s.codecType === "audio")) return "video";
    throw new Error(`Cannot identify ${input}: it contains no video or image stream.`);
  }
  if (streams.some((s) => s.codecType === "audio")) return "video";
  if (!IMAGE_CODECS.has(video.codecName)) return "video";
  return longestDuration(probe) > STILL_MAX_DURATION_SEC ? "video" : "photo";
}
