import { spawn } from "node:child_process";

/** 8-bit interleaved pixels in OpenCV's channel order (B, G, R), row-major, no padding. */
export interface BgrImage {
  width: number;
  height: number;
  data: Uint8Array;
}

/**
 * - "bgr24": ffmpeg decodes and converts to bgr24 itself (swscale). `-idct int` is FFmpeg's
 *   port of the IJG integer IDCT; bilinear chroma with accurate rounding is the closest swscale
 *   setting to libjpeg's upsampling. PNG decodes bit-exact.
 * - "libjpeg": for 4:2:0 JPEGs ffmpeg only returns the decoded Y/Cb/Cr planes, and the chroma
 *   upsampling and colour conversion are done here exactly as libjpeg-turbo does them for
 *   cv2.imread (fancy h2v2 upsampling, integer YCbCr->RGB tables). Other inputs use "bgr24".
 */
export type Decoder = "bgr24" | "libjpeg";

const SWS_ARGS = ["-sws_flags", "bilinear+accurate_rnd+full_chroma_int+bitexact"];
/** "Input #0 ... Stream #0:0: Video: mjpeg (Baseline), yuvj420p(pc, ...), 864x1152". */
const INPUT_PIX_FMT = /Input #0[\s\S]*?Video: [^,\n]+, ([a-z0-9_]+)/;
/** "Output #0 ... Stream #0:0: Video: rawvideo (...), bgr24(...), 864x1152 [SAR ...". */
const OUTPUT_SIZE = /Output #0[\s\S]*?Video: rawvideo[^\n]*?, (\d+)x(\d+)/;

interface Raw {
  width: number;
  height: number;
  inputPixFmt: string;
  data: Uint8Array;
}

function runFfmpeg(ffmpegPath: string, file: string, pixFmt: string, outputArgs: readonly string[]): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const args = [
      "-hide_banner", "-nostdin", "-v", "info",
      "-idct", "int", "-i", file,
      "-frames:v", "1", ...outputArgs,
      "-f", "rawvideo", "-pix_fmt", pixFmt, "pipe:1",
    ];
    const proc = spawn(ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let stderr = "";
    proc.stdout.on("data", (c: Buffer) => chunks.push(c));
    proc.stderr.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exited with ${code} for ${file}: ${stderr.slice(-400)}`));
        return;
      }
      const size = OUTPUT_SIZE.exec(stderr);
      const fmt = INPUT_PIX_FMT.exec(stderr);
      if (!size || !fmt) {
        reject(new Error(`ffmpeg: could not read the stream info for ${file}`));
        return;
      }
      const buf = Buffer.concat(chunks);
      resolve({
        width: Number(size[1]),
        height: Number(size[2]),
        inputPixFmt: fmt[1],
        data: new Uint8Array(buf.buffer, buf.byteOffset, buf.length),
      });
    });
  });
}

// libjpeg-turbo jdcolor.c build_ycc_rgb_table(): SCALEBITS 16, FIX(x) = x * 2^16 + 0.5.
const SCALEBITS = 16;
const ONE_HALF = 1 << (SCALEBITS - 1);
const fix = (x: number): number => Math.floor(x * (1 << SCALEBITS) + 0.5);
const CR_R = new Int32Array(256);
const CB_B = new Int32Array(256);
const CR_G = new Int32Array(256);
const CB_G = new Int32Array(256);
for (let i = 0; i < 256; i++) {
  const x = i - 128;
  CR_R[i] = (fix(1.402) * x + ONE_HALF) >> SCALEBITS;
  CB_B[i] = (fix(1.772) * x + ONE_HALF) >> SCALEBITS;
  CR_G[i] = -fix(0.71414) * x;
  CB_G[i] = -fix(0.34414) * x + ONE_HALF;
}

/**
 * libjpeg-turbo jdsample.c h2v2_fancy_upsample(): triangle filter, 3/4 nearer + 1/4 further
 * sample in each direction, rounding biases 8 and 7 alternating; the image's first and last
 * chroma rows and columns are replicated as context.
 */
function upsampleH2V2(plane: Uint8Array, cw: number, ch: number, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height);
  const colsum = new Int32Array(cw);
  for (let oy = 0; oy < height; oy++) {
    const iy = oy >> 1;
    const near = iy * cw;
    const far = (oy & 1 ? Math.min(iy + 1, ch - 1) : Math.max(iy - 1, 0)) * cw;
    for (let x = 0; x < cw; x++) colsum[x] = plane[near + x] * 3 + plane[far + x];
    const row = oy * width;
    for (let x = 0; x < cw; x++) {
      const t = colsum[x];
      const left = x === 0 ? (t * 4 + 8) >> 4 : (t * 3 + colsum[x - 1] + 8) >> 4;
      const right = x === cw - 1 ? (t * 4 + 7) >> 4 : (t * 3 + colsum[x + 1] + 7) >> 4;
      if (2 * x < width) out[row + 2 * x] = left;
      if (2 * x + 1 < width) out[row + 2 * x + 1] = right;
    }
  }
  return out;
}

function yuv420ToBgr(raw: Raw): BgrImage {
  const { width, height, data } = raw;
  const cw = (width + 1) >> 1;
  const ch = (height + 1) >> 1;
  if (data.length !== width * height + 2 * cw * ch) throw new Error(`ffmpeg: got ${data.length} bytes for ${width}x${height} yuvj420p`);
  const y = data.subarray(0, width * height);
  const cb = upsampleH2V2(data.subarray(width * height, width * height + cw * ch), cw, ch, width, height);
  const cr = upsampleH2V2(data.subarray(width * height + cw * ch), cw, ch, width, height);
  const out = new Uint8Array(width * height * 3);
  const clamp = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v);
  for (let i = 0; i < width * height; i++) {
    const l = y[i];
    out[i * 3] = clamp(l + CB_B[cb[i]]);
    out[i * 3 + 1] = clamp(l + ((CB_G[cb[i]] + CR_G[cr[i]]) >> SCALEBITS));
    out[i * 3 + 2] = clamp(l + CR_R[cr[i]]);
  }
  return { width, height, data: out };
}

/** Decodes the first frame of `file` with the bundled ffmpeg into BGR24 pixels. */
export async function decodeBgr(ffmpegPath: string, file: string, decoder: Decoder = "bgr24"): Promise<BgrImage> {
  if (decoder === "libjpeg" && /\.jpe?g$/i.test(file)) {
    const raw = await runFfmpeg(ffmpegPath, file, "yuvj420p", []);
    if (raw.inputPixFmt === "yuvj420p") return yuv420ToBgr(raw);
  }
  const raw = await runFfmpeg(ffmpegPath, file, "bgr24", SWS_ARGS);
  if (raw.data.length !== raw.width * raw.height * 3) {
    throw new Error(`ffmpeg: got ${raw.data.length} bytes for ${raw.width}x${raw.height} bgr24 from ${file}`);
  }
  return { width: raw.width, height: raw.height, data: raw.data };
}
