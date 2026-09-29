import { FPS } from "./constants";
import { totalFrames } from "./timeline";

// A size estimate for disk checks (invariant 35: free space >= 2 x the
// estimate). SP1 measured a busy final at 3.0 to 3.3 Mbit/s (5.76 MiB for
// 15 s at `medium`), capped by the encoder at 3500 kbit/s. The estimate takes
// the busy end, 3300, so it covers what is measured, plus the 192 kbit/s AAC
// track. `MAX_VIDEO_KBPS` is the encoder's own cap, the true upper bound.

/** The video bitrate the estimate assumes: the top of SP1's measured 3.0 to 3.3 Mbit/s. */
export const ESTIMATE_VIDEO_KBPS = 3300;
/** The AAC track: 192 kbit/s. */
export const ESTIMATE_AUDIO_KBPS = 192;
/** The encoder's `-maxrate`: no render averages above this. */
export const MAX_VIDEO_KBPS = 3500;

/** A fixed allowance for the MP4's own boxes (`moov`, `+faststart`, free space): 64 KiB. */
export const CONTAINER_ALLOWANCE_BYTES = 65_536;

/**
 * An upper bound for the finished MP4, for the disk check (invariant 35): the
 * encoder's own cap over the whole length (3500 kbit/s video plus the audio)
 * plus the container allowance. No render averages above it. `ceil` of exact
 * integer maths; 0 for no clips.
 */
export function estimateBytesUpper(clips: readonly { readonly durationMs: number }[]): number {
  const frames = totalFrames(clips);
  if (frames === 0) return 0;
  return Math.ceil((frames * (MAX_VIDEO_KBPS + ESTIMATE_AUDIO_KBPS) * 1000) / 8 / FPS) + CONTAINER_ALLOWANCE_BYTES;
}

/**
 * The expected size of the finished MP4 in bytes. Exact integer maths per
 * frame: (3300 + 192) kbit/s = 436,500 bytes/s = 14,550 bytes per frame at
 * 30 fps, so no rounding happens. 0 for no clips.
 */
export function estimateBytes(clips: readonly { readonly durationMs: number }[]): number {
  const bytesPerFrame = ((ESTIMATE_VIDEO_KBPS + ESTIMATE_AUDIO_KBPS) * 1000) / 8 / FPS;
  return totalFrames(clips) * bytesPerFrame;
}
