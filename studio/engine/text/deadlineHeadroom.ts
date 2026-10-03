/**
 * How much room a measured legitimate render leaves under TEXT_RENDER_DEADLINE_MS, judged on robust statistics.
 *
 * The real-worker node tests time the template's worst caption on whatever runner they land on. A shared CI runner only ever
 * ADDS time to a render (scheduling, antivirus, a noisy neighbour), so the cheap end of the samples is the caption's real cost
 * and the tail is the runner's noise. Two bounds, each against the configured deadline (never against another measurement):
 *  - the lower quartile of the samples is the typical cost, and the deadline must be at least 5x that;
 *  - the second-slowest sample must leave 3x, so a plain slow render is still far from being cut.
 * The resilience against one stalled sample comes from taking 15 samples and reading the SECOND-slowest (one outlier is forgiven,
 * two are not), not from a looser multiplier: a regression that makes every other render several times slower, or a tail with two
 * slow renders, must fail. A slower runner raises both statistics together and fails them. The median is reported, not judged.
 */

/** Samples to take: with fewer, a quartile and a second-slowest are the same one or two renders. */
export const HEADROOM_SAMPLES = 15;

export interface HeadroomStats {
  lowerQuartile: number;
  median: number;
  secondSlowest: number;
}

export function headroomStats(times: readonly number[]): HeadroomStats {
  if (times.length < HEADROOM_SAMPLES) throw new Error(`headroom needs at least ${HEADROOM_SAMPLES} samples, got ${times.length}`);
  const sorted = [...times].sort((a, b) => a - b);
  return {
    lowerQuartile: sorted[Math.floor((sorted.length - 1) / 4)] ?? Number.NaN,
    median: sorted[Math.floor((sorted.length - 1) / 2)] ?? Number.NaN,
    secondSlowest: sorted[sorted.length - 2] ?? Number.NaN,
  };
}

/** The first bound the deadline fails to leave, or undefined when it has the headroom. Any non-finite sample (NaN, Infinity) fails. */
export function deadlineHeadroomProblem(times: readonly number[], deadlineMs: number): string | undefined {
  const { lowerQuartile, secondSlowest } = headroomStats(times);
  if (times.some((t) => !Number.isFinite(t))) return "a sample is not finite: the render was not timed";
  const round = (n: number): string => String(Math.round(n));
  if (!(lowerQuartile * 5 <= deadlineMs)) return `the typical cost (lower quartile) is ${round(lowerQuartile)} ms: the ${deadlineMs} ms deadline is under 5x that`;
  if (!(secondSlowest * 3 <= deadlineMs)) return `the second-slowest sample is ${round(secondSlowest)} ms: the ${deadlineMs} ms deadline is under 3x that`;
  return undefined;
}
