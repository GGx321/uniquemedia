import { FRAGMENTS } from "./filters";
import { EXPORT_DIMS, type MediaInfo, type Recipe } from "./types";

function videoChain(recipe: Recipe, info: MediaInfo): string {
  const parts: string[] = [];
  let speed = 1;

  for (const op of recipe.video) {
    if (op.id === "speed") {
      speed = Number(op.params.speed);
      continue;
    }
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
  if (speed !== 1) parts.push(`setpts=PTS/${speed}`);

  return parts.join(",");
}

function audioChain(recipe: Recipe): string | null {
  const speed = Number(
    recipe.video.find((o) => o.id === "speed")?.params.speed ?? 1
  );
  const parts: string[] = [];
  if (speed !== 1) parts.push(`atempo=${speed}`);
  for (const op of recipe.audio) {
    if (op.id === "aeq") {
      const g = Number(op.params.gain);
      if (g !== 0) parts.push(`equalizer=f=3000:t=q:w=1:g=${g}`);
    }
  }
  return parts.length ? parts.join(",") : null;
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
  const args: string[] = ["-vf", videoChain(recipe, info)];

  if (info.hasAudio) {
    const af = audioChain(recipe);
    if (af) args.push("-af", af);
    args.push("-c:a", "aac", "-b:a", `${aBitrate}k`);
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
