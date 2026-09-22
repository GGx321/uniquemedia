import { FRAGMENTS } from "./filters";
import { photoChain } from "./photo/filterGraph";
import { EXPORT_DIMS, type FirstFrame, type MediaInfo, type Recipe } from "./types";

/** Spatial filter chain (everything except per-segment speed). Applied once to
 *  the source before it is split into time segments. */
function spatialChain(recipe: Recipe, info: MediaInfo): string {
  const parts: string[] = [];
  for (const op of recipe.video) {
    if (op.id === "encode") continue;
    const frag = FRAGMENTS[op.id]?.(op.params, info);
    if (frag) parts.push(frag);
  }
  if (recipe.exportFormat !== "original") {
    const { w, h } = EXPORT_DIMS[recipe.exportFormat];
    parts.push(`scale=${w}:${h}:force_original_aspect_ratio=increase`);
    parts.push(`crop=${w}:${h}`);
  } else {
    // Keep native size but force even dimensions — libx264 (yuv420p) requires
    // width/height divisible by 2, and a source can be odd (e.g. 1081x1351).
    parts.push("crop=trunc(iw/2)*2:trunc(ih/2)*2");
  }
  parts.push("setsar=1");
  return parts.join(",");
}

/** Cumulative segment boundaries in seconds: [0, t1, ..., duration]. */
function boundaries(recipe: Recipe, info: MediaInfo): number[] {
  const bounds = [0];
  let acc = 0;
  for (const seg of recipe.segments) {
    acc += seg.fraction;
    bounds.push(acc * info.durationSec);
  }
  bounds[bounds.length - 1] = info.durationSec; // guard float drift on the tail
  return bounds;
}

const splitLabels = (prefix: string, n: number): string =>
  Array.from({ length: n }, (_, i) => `[${prefix}${i}]`).join("");

/**
 * Paints the first output frame black. Goes on the concat OUTPUT so it is the
 * first frame of the file whatever speed the first segment runs at; `n` is the
 * frame index within this filter and restarts at 0 after the concat.
 *
 * The `fps=` in front of it is not optional. The encode applies `-r <fps>
 * -fps_mode cfr` after the graph, and on a source slower than the target that
 * duplicates frames to reach CFR — a black frame among them would be duplicated
 * into two or three. Converting to the target rate inside the graph makes `n`
 * count output frames, and leaves the `-r` that follows nothing to duplicate.
 */
const blackFirstFrame = (fps: number): string =>
  `,fps=${fps},drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill:enable='eq(n,0)'`;

/**
 * Fits the cover to the video: the smallest same-aspect frame that covers the
 * video's, so the overlay's centring crops the excess off two opposite edges
 * and never leaves a bar. Zero crop when the aspects already match.
 *
 * `scale2ref` rather than a `scale=W:H` with a number computed here, because
 * the video's size is not always a number this module knows. `reels`/`feed`/
 * `square` are EXPORT_DIMS, but `original` is whatever `rotate`'s `ow=rotw`
 * left after the even-crop — measured 1082x1920 from a 1080x1920 source at
 * 0.05°, the top of the baseline draw — and a cover fitted to 1080 would leave
 * a sliver of footage down one side of frame 0. Reading the size off the
 * stream is the one way to reuse the spatial chain's answer without
 * re-deriving ffmpeg's rounding.
 *
 * Mind scale2ref's naming: `iw`/`ih` are the REFERENCE (the video) and
 * `main_w`/`main_h` the input being scaled (the cover). The products are exact
 * integers, so a same-aspect cover comes out at the video's size exactly.
 */
const COVER_FIT =
  "scale2ref=w='max(iw,ceil(ih*main_w/main_h))':h='max(ih,ceil(iw*main_h/main_w))'";

/**
 * Lays the fitted cover over frame 0 and nothing else. Centred, so a cover
 * larger than the frame (the fit's excess) is cropped evenly. `eof_action=
 * repeat` keeps a one-frame input alive for the whole clip; `enable` decides
 * where it shows, and `n` is the main input's frame index — the concat output
 * at the target rate, which is what the `fps=` in front is for.
 */
const COVER_OVERLAY = "overlay=x=(W-w)/2:y=(H-h)/2:eof_action=repeat:enable='eq(n,0)'";

/**
 * The cover branch: the concat output is rated (the same duplication trap as
 * the black frame), the cover goes through the photo chain at its own size on
 * `[1:v]`, is fitted against the rated stream and laid over its first frame.
 */
function coverFirstFrame(
  cover: Extract<FirstFrame, { mode: "photo" }>,
  fps: number
): { tail: string; lines: string[] } {
  return {
    tail: `,fps=${fps}[vc]`,
    lines: [
      `[1:v]${photoChain(cover.recipe, cover.info)}[c0]`,
      `[c0][vc]${COVER_FIT}[cover][vref]`,
      `[vref][cover]${COVER_OVERLAY}[outv]`,
    ],
  };
}

/** Video graph: spatial -> split -> per-segment trim+setpts -> concat -> [outv],
 *  with the first-frame branch, if any, on the concat output. */
function videoComplex(recipe: Recipe, info: MediaInfo, fps: number): string {
  const n = recipe.segments.length;
  const b = boundaries(recipe, info);
  const spatial = spatialChain(recipe, info);
  const lines = [`[0:v]${spatial ? spatial + "," : ""}split=${n}${splitLabels("v", n)}`];
  recipe.segments.forEach((seg, i) => {
    lines.push(
      `[v${i}]trim=start=${b[i].toFixed(3)}:end=${b[i + 1].toFixed(3)},` +
        `setpts=(PTS-STARTPTS)/${seg.speed}[s${i}]`
    );
  });
  const ff = recipe.firstFrame;
  const concat = `${splitLabels("s", n)}concat=n=${n}:v=1:a=0`;
  if (ff.mode === "photo") {
    const { tail, lines: cover } = coverFirstFrame(ff, fps);
    lines.push(`${concat}${tail}`, ...cover);
  } else {
    lines.push(`${concat}${ff.mode === "black" ? blackFirstFrame(fps) : ""}[outv]`);
  }
  return lines.join(";");
}

/** Audio graph: optional EQ -> asplit -> per-segment atrim+atempo -> concat -> [outa].
 *  Same boundaries as video so A/V stays in sync. */
function audioComplex(recipe: Recipe, info: MediaInfo): string {
  const n = recipe.segments.length;
  const b = boundaries(recipe, info);
  const eq = recipe.audio.find((o) => o.id === "aeq");
  const gain = eq ? Number(eq.params.gain) : 0;
  const pre = gain !== 0 ? `equalizer=f=3000:t=q:w=1:g=${gain},` : "";
  const lines = [`[0:a]${pre}asplit=${n}${splitLabels("a", n)}`];
  recipe.segments.forEach((seg, i) => {
    lines.push(
      `[a${i}]atrim=start=${b[i].toFixed(3)}:end=${b[i + 1].toFixed(3)},` +
        `asetpts=PTS-STARTPTS,atempo=${seg.speed}[b${i}]`
    );
  });
  lines.push(`${splitLabels("b", n)}concat=n=${n}:v=0:a=1[outa]`);
  return lines.join(";");
}

/** Instagram rejects video files over 50 MB — cap the bitrate so the encode can't exceed it. */
const MAX_FILE_MB = 50;

/**
 * Instagram re-encodes every upload to roughly 2–3.5 Mbit/s, so bits spent
 * above that band are thrown away on ingest. The encode stops at its top:
 * constrained CRF, so a static scene still gets only what it needs, and the
 * ceiling catches motion.
 */
const MAX_VIDEO_KBPS = 3500;

/** VBV window in seconds: `-bufsize` is `-maxrate` times this. */
const VBV_WINDOW_SEC = 2;

export function buildArgs(recipe: Recipe, info: MediaInfo): string[] {
  const enc = recipe.video.find((o) => o.id === "encode")?.params ?? {};
  const crf = String(enc.crf ?? 21);
  const preset = String(enc.preset ?? "medium");
  const fps = Number(enc.fps ?? 30);
  const gop = Number(enc.gop ?? 60);
  const keyintMin = Number(enc.keyintMin ?? 30);
  const aBitrate = Number(enc.audioKbps ?? 128);

  // Two ceilings, the lower one wins. The 50 MB bound: total bits for ~46 MB
  // (8% safety margin) minus the audio track, per second — it only binds on a
  // clip long enough for 3500k to overflow the file cap (from roughly 105 s).
  const audioKbps = info.hasAudio ? aBitrate : 0;
  const fileCapKbps = Math.max(
    600,
    Math.floor((MAX_FILE_MB * 1024 * 8 * 0.92) / Math.max(1, info.durationSec)) - audioKbps
  );
  const capKbps = Math.min(MAX_VIDEO_KBPS, fileCapKbps);

  const complex = info.hasAudio
    ? `${videoComplex(recipe, info, fps)};${audioComplex(recipe, info)}`
    : videoComplex(recipe, info, fps);
  // The cover is the graph's second input, named here so the executor's
  // `-i <source>` is followed by `-i <cover>` and `[1:v]` means the still.
  const inputs = recipe.firstFrame.mode === "photo" ? ["-i", recipe.firstFrame.path] : [];
  const args: string[] = [...inputs, "-filter_complex", complex, "-map", "[outv]"];

  if (info.hasAudio) {
    args.push("-map", "[outa]", "-c:a", "aac", "-b:a", `${aBitrate}k`);
  } else {
    args.push("-an");
  }

  args.push("-c:v", "libx264", "-preset", preset);

  if (recipe.identity === "iphone") {
    args.push(
      "-profile:v", "high",
      "-colorspace", "bt709",
      "-color_primaries", "bt709",
      "-color_trc", "bt709",
    );
  }

  args.push(
    "-crf", crf,
    "-maxrate", `${capKbps}k`,
    "-bufsize", `${capKbps * VBV_WINDOW_SEC}k`,
    "-pix_fmt", "yuv420p",
    "-r", String(fps),
    "-fps_mode", "cfr",
    "-g", String(gop),
    "-keyint_min", String(keyintMin),
    "-movflags", "+faststart",
    "-map_metadata", "-1"
  );

  if (recipe.identity !== "engine") {
    // `-map_metadata -1` above strips what the SOURCE carried; ffmpeg's own
    // signature goes in after that and has to be turned off at each place it
    // is written — for `iphone` and `clean` alike:
    //  - muxer `bitexact`: no `encoder=Lavf<ver>` on the container;
    //  - video-encoder `bitexact`: the stream compressor name loses its
    //    version (`Lavc libx264`); the iphone branch's `encoder=H.264` tag
    //    replaces it, since in MOV the compressor name IS the track's
    //    `encoder` tag, and H.264 is what an iPhone writes there. `clean`
    //    writes nothing there, so the muxer's `Lavc libx264` is blanked after
    //    the render instead, in the executor's identity pass;
    //  - audio-encoder `bitexact`: the native AAC encoder otherwise embeds
    //    `Lavc<ver>` as a FIL element in the first frame — inside the coded
    //    audio, where no metadata flag reaches;
    //  - `filter_units`: x264 writes its full option string (crf, vbv, ...) as
    //    an SEI NAL (type 6) inside the H.264 stream. With no HRD signalling
    //    that is the only SEI x264 emits, so dropping the type loses nothing
    //    a decoder needs.
    // Measured on libx264: bitexact leaves the coded video byte-identical.
    // The `ftyp` minor version (0x200) and, in MOV mode, the `avc1` vendor
    // (`FFMP`) are hardcoded by the muxer and are patched after the render.
    args.push("-fflags", "+bitexact", "-flags:v", "+bitexact");
    if (info.hasAudio) args.push("-flags:a", "+bitexact");
    args.push("-bsf:v", "filter_units=remove_types=6");
  }

  if (recipe.identity === "iphone") {
    // What the file says instead: Apple's handler names and compressor name,
    // in the QuickTime container an iPhone writes. `clean` says nothing and
    // stays in the MP4 the output extension asks for.
    args.push(
      "-metadata:s:v", "handler_name=Core Media Video",
      "-metadata:s:v", "encoder=H.264",
    );
    if (info.hasAudio) {
      args.push("-metadata:s:a", "handler_name=Core Media Audio");
    }
    args.push("-f", "mov");
  }

  return args;
}
