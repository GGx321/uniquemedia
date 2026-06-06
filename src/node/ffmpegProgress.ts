/**
 * Parse a chunk of FFmpeg `-progress` output into a 0..1 fraction.
 * FFmpeg emits repeating key=value blocks ending in `progress=continue|end`.
 * Returns null if no usable `out_time_us` is present or duration is non-positive.
 */
export function parseProgressFraction(chunk: string, durationSec: number): number | null {
  if (durationSec <= 0) return null;
  if (/\bprogress=end\b/.test(chunk)) return 1;
  const matches = [...chunk.matchAll(/out_time_us=(\d+)/g)];
  const last = matches.at(-1);
  if (!last) return null;
  const us = Number(last[1]);
  return Math.min(1, us / (durationSec * 1e6));
}
