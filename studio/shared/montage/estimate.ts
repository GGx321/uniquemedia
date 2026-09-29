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

/**
 * The expected size of the finished MP4 in bytes. Exact integer maths per
 * frame: (3300 + 192) kbit/s = 436,500 bytes/s = 14,550 bytes per frame at
 * 30 fps, so no rounding happens. 0 for no clips.
 */
export function estimateBytes(clips: readonly { readonly durationMs: number }[]): number {
  const bytesPerFrame = ((ESTIMATE_VIDEO_KBPS + ESTIMATE_AUDIO_KBPS) * 1000) / 8 / FPS;
  return totalFrames(clips) * bytesPerFrame;
}
