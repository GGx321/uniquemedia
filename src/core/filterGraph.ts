import { FRAGMENTS } from "./filters";
import { EXPORT_DIMS, type MediaInfo, type Recipe } from "./types";

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

/** Video graph: spatial -> split -> per-segment trim+setpts -> concat -> [outv]. */
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
  const tail = recipe.blackFirstFrame ? blackFirstFrame(fps) : "";
  lines.push(`${splitLabels("s", n)}concat=n=${n}:v=1:a=0${tail}[outv]`);
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
  const args: string[] = ["-filter_complex", complex, "-map", "[outv]"];

  if (info.hasAudio) {
    args.push("-map", "[outa]", "-c:a", "aac", "-b:a", `${aBitrate}k`);
  } else {
    args.push("-an");
  }

  args.push("-c:v", "libx264", "-preset", preset);

  if (recipe.spoof) {
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

  if (recipe.spoof) {
    args.push("-metadata:s:v", "handler_name=Core Media Video");
    if (info.hasAudio) {
      args.push("-metadata:s:a", "handler_name=Core Media Audio");
    }
    args.push("-f", "mov");
  }

  return args;
}
