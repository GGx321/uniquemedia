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

/** Video graph: spatial -> split -> per-segment trim+setpts -> concat -> [outv]. */
function videoComplex(recipe: Recipe, info: MediaInfo): string {
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
  lines.push(`${splitLabels("s", n)}concat=n=${n}:v=1:a=0[outv]`);
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

export function buildArgs(recipe: Recipe, info: MediaInfo): string[] {
  const enc = recipe.video.find((o) => o.id === "encode")?.params ?? {};
  const crf = String(enc.crf ?? 21);
  const preset = String(enc.preset ?? "faster");
  const fps = Number(enc.fps ?? 30);
  const gop = Number(enc.gop ?? 60);
  const keyintMin = Number(enc.keyintMin ?? 30);
  const aBitrate = Number(enc.audioKbps ?? 128);

  // Bitrate ceiling derived from duration: total bits for ~46 MB (8% safety
  // margin) minus the audio track, capped per second. CRF still rules for short
  // clips (the cap only kicks in when content would blow past 50 MB).
  const audioKbps = info.hasAudio ? aBitrate : 0;
  const capKbps = Math.max(
    600,
    Math.floor((MAX_FILE_MB * 1024 * 8 * 0.92) / Math.max(1, info.durationSec)) - audioKbps
  );

  const complex = info.hasAudio
    ? `${videoComplex(recipe, info)};${audioComplex(recipe, info)}`
    : videoComplex(recipe, info);
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
    "-bufsize", `${capKbps * 2}k`,
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
