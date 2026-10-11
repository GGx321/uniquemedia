export function round(n: number, digits = 4): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** Longest input video the tool takes; keeps the 50 MB Instagram cap reachable. */
export const MAX_INPUT_VIDEO_SEC = 10 * 60;

/** Throws before any work starts when `info` is a video longer than the limit. */
export function assertDurationAllowed(info: { kind: string; durationSec: number }): void {
  if (info.kind === "video" && info.durationSec > MAX_INPUT_VIDEO_SEC) {
    // User-facing UI string: the app's UI is Russian.
    throw new Error("Видео длиннее 10 минут — такие не обрабатываем.");
  }
}
