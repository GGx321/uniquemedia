import { makeRng } from "../core/rng";

/**
 * A UUID-v4-shaped id for the CapCut mark's `videoId`, derived from the copy's
 * creation time rather than drawn from `crypto.randomUUID()`.
 *
 * It is deterministic on purpose: the project pins rendered output in tests
 * and a seed must reproduce its run. It still differs per copy, because every
 * copy's profile has its own creation time. The version nibble is 4 and the
 * variant nibble 8/9/a/b so it reads like the ids CapCut generates.
 */
export function capcutVideoId(creationUtcMs: number): string {
  const rng = makeRng(creationUtcMs);
  const bytes = Array.from({ length: 16 }, () => Math.floor(rng() * 256));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The `com.apple.quicktime.artwork` payload of a CapCut-on-mac export, with
 * every AI/usage flag zeroed so it is a generic mark, not a claim about
 * features that were used.
 */
export function capcutArtworkJson(videoId: string): string {
  return JSON.stringify({
    data: {
      editType: "default",
      infoStickerId: "",
      is_ai_lyric: 0,
      is_aimusic_mv: 0,
      is_use_ai_image_generation: 0,
      is_use_ai_video_generation: 0,
      is_use_aimusic_bgm: 0,
      is_use_aimusic_vocal: 0,
      is_use_graph_chart: 0,
      is_use_jichuang_mode_in_ai_writer: 0,
      is_use_relight: 0,
      is_use_vc_sing_clone: 0,
      is_use_voice_clone: "0",
      is_use_voice_optimization: 0,
      motion_blur_cnt: 0,
      musicId: "",
      os: "mac",
      product: "vicut",
      stickerId: "",
      videoEffectId: "",
      videoId,
      videoParams: { be: 0, ef: 0, ft: 1, ma: 0, me: 0, mu: 0, re: 0, sp: 0, st: 0, te: 0, tx: 0, v: 0, vs: 0 },
    },
    source_platform: "desktop",
    source_type: "vicut",
  });
}
