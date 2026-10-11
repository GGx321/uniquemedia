import type { MediaInfo, VideoColor } from "./types";

/**
 * Bringing a source to the one form a copy is written in: BT.709 matrix,
 * primaries and transfer, limited range, 8-bit 4:2:0 — and the encode states
 * exactly that. Every filter of the recipe works on those numbers, so they
 * have to be those numbers before the recipe starts.
 *
 * Measured with nothing in front of the recipe: iPhone HLG (and the HLG base
 * layer of its Dolby Vision 8.4) came out washed grey-green, white 240 -> 182
 * and dE00 15.5; PQ was worse, dE00 26; BT.601 SD tagged BT.709 shifted a
 * saturated green by dE00 7.3.
 */

/** Shown when an HDR source meets an ffmpeg that cannot tone-map it. */
export const HDR_WITHOUT_ZSCALE =
  "Это видео снято в HDR, а во встроенном ffmpeg нет фильтра zscale, чтобы перевести его в обычный цвет: " +
  "копии вышли бы блёклыми и серо-зелёными. Переведите ролик в SDR (обычный цвет) и попробуйте снова.";

const HDR_TRANSFERS = new Set(["arib-std-b67", "smpte2084"]);

/**
 * Tag values both zscale and the colorspace fallback accept under ffprobe's
 * own names. A value outside these sets is treated as no tag at all, so an
 * odd or new name falls back to the guess instead of failing the render.
 */
const MATRICES = new Set(["bt709", "bt470bg", "smpte170m", "smpte240m", "fcc", "bt2020nc"]);
const PRIMARIES = new Set([
  "bt709", "bt470m", "bt470bg", "smpte170m", "smpte240m", "film", "bt2020", "smpte428", "smpte431", "smpte432", "jedec-p22",
]);
const SDR_TRANSFERS = new Set([
  "bt709", "bt470m", "bt470bg", "smpte170m", "smpte240m", "linear", "iec61966-2-1", "iec61966-2-4", "bt2020-10", "bt2020-12",
]);
/** Transfers that are BT.709's curve under another name: no conversion needed. */
const SAME_AS_709 = new Set(["bt709", "smpte170m", "bt2020-10", "bt2020-12"]);

/*
 * No transfer function is ever handed a float that can be negative. zimg's
 * approximate gamma is not defined there, and on one CI runner's CPU it made
 * garbage of an out-of-gamut patch (47 codes off, measured in Studio) where
 * other CPUs clipped at zero. Two things make a negative, and each is clipped
 * by a step into 16-bit integers, which saturate the same way on every CPU
 * (the pattern of studio/engine/media/video/videoPlan.ts):
 *  - YUV outside the RGB cube is a negative R'G'B': a bare `zscale` into
 *    gbrp16le converts the matrix alone and clips to the cube BEFORE the
 *    source's transfer is undone;
 *  - a colour outside BT.709's gamut is negative light after the primaries
 *    conversion: linear light into gbrp16le clips it to 0..1 BEFORE the
 *    BT.709 gamma.
 */
const TO_RGB16 = "zscale,format=gbrp16le";
const BT709_FROM_LINEAR =
  "zscale=t=linear:p=bt709:m=bt709:r=pc,format=gbrp16le,zscale=t=bt709:m=bt709:r=tv:dither=ordered,format=yuv420p";

/** Reference white sits at 203 nits (ITU-R BT.2408) and HDR's nominal peak at
 *  1000, so the tone curve compresses 1000/203 of it into SDR. The same peak
 *  serves HLG, whose system is defined at 1000 nits, and PQ as phones and most
 *  HDR10 masters write it; measured on white, skin and green the round trip is
 *  within dE00 0.8 for both. */
const HDR_TO_BT709 =
  `${TO_RGB16},zscale=t=linear:npl=203,format=gbrpf32le,zscale=p=bt709,` +
  `tonemap=tonemap=mobius:param=0.8:peak=4.926:desat=0,${BT709_FROM_LINEAR}`;

/** Another gamut or another curve: through linear light, clipped both ways. */
const SDR_TO_BT709_VIA_LINEAR = `${TO_RGB16},${BT709_FROM_LINEAR}`;

/** BT.709's primaries and curve already: matrix, range and depth only, with no
 *  linear light and so no negative light to clip. */
const SDR_TO_BT709 = "zscale=m=709:t=709:p=709:r=tv:dither=ordered,format=yuv420p";

/** Bit depth from the pixel format's name: `yuv420p10le` is 10; a name with
 *  no depth suffix (`yuv420p`, `nv12`, `yuvj420p`) is 8. */
function bitDepth(pixFmt: string): number {
  const m = /(\d+)(?:le|be)$/.exec(pixFmt);
  return m ? Number(m[1]) : 8;
}

const isRgb = (pixFmt: string): boolean => /rgb|bgr|gbr|pal8/.test(pixFmt);

interface Reading {
  matrix: string;
  transfer: string;
  primaries: string;
  range: "tv" | "pc";
}

/**
 * How the source's numbers are to be read, with each gap filled. An untagged
 * matrix is guessed the way players guess it: BT.709 from 720 lines up,
 * BT.601 (smpte170m) below. Untagged primaries are taken as BT.709 — the
 * gamut is only converted when the file states one, because a guessed SMPTE-C
 * gamut moved a saturated green by dE00 1.7 against what the clip was made
 * from, while the matrix guess is what removes a 7-unit error.
 */
function readingOf(color: VideoColor, height: number, hdr: boolean): Reading {
  const known = (set: Set<string>, value: string, fallback: string) => (set.has(value) ? value : fallback);
  const full = color.range === "pc" || (color.range !== "tv" && color.pixFmt.startsWith("yuvj")) || isRgb(color.pixFmt);
  return {
    matrix: known(MATRICES, color.space, hdr ? "bt2020nc" : height >= 720 ? "bt709" : "smpte170m"),
    transfer: hdr ? color.transfer : known(SDR_TRANSFERS, color.transfer, "bt709"),
    primaries: known(PRIMARIES, color.primaries, hdr ? "bt2020" : "bt709"),
    range: full ? "pc" : "tv",
  };
}

/**
 * The filters that bring `[0:v]` to BT.709 SDR limited 8-bit, or null when it
 * already is — a BT.709 source keeps exactly the graph it always had.
 *
 * `zscale` says whether the running ffmpeg has the zscale filter. Without it
 * an SDR source falls back to the `colorspace` filter, and an HDR source
 * cannot be converted at all, so it fails here, before a copy is started,
 * rather than shipping washed-out copies in silence.
 */
export function sourceToBt709(info: MediaInfo, zscale: boolean): string | null {
  const color = info.color;
  if (!color) return null;
  const hdr = HDR_TRANSFERS.has(color.transfer);
  const r = readingOf(color, info.height, hdr);
  // The reading goes onto the frames rather than into one filter's input
  // options: every zscale and the colorspace filter after it take what they
  // are not told from the frame, and a first zscale told its input primaries
  // but not its output ones read the output from an untagged frame and failed
  // ("no path between colorspaces").
  const tags = (transfer: string) =>
    `setparams=colorspace=${r.matrix}:color_primaries=${r.primaries}:color_trc=${transfer}:range=${r.range}`;

  if (hdr) {
    if (!zscale) throw new Error(HDR_WITHOUT_ZSCALE);
    return `${tags(r.transfer)},${HDR_TO_BT709}`;
  }

  const curve709 = SAME_AS_709.has(r.transfer);
  const already =
    r.matrix === "bt709" &&
    r.primaries === "bt709" &&
    curve709 &&
    r.range === "tv" &&
    bitDepth(color.pixFmt) <= 8 &&
    !isRgb(color.pixFmt);
  if (already) return null;

  if (!zscale) return `${tags(r.transfer)},colorspace=all=bt709:range=tv:format=yuv420p`;
  if (r.primaries !== "bt709" || !curve709) return `${tags(r.transfer)},${SDR_TO_BT709_VIA_LINEAR}`;
  // BT.709's curve under whatever name the file gave it is stated as BT.709,
  // so zscale does not go through linear light to swap a curve for itself.
  return `${tags("bt709")},${SDR_TO_BT709}`;
}
