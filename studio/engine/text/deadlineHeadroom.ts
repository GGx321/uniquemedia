/**
 * How much room a measured legitimate render leaves under TEXT_RENDER_DEADLINE_MS, judged on robust statistics.
 *
 * The real-worker node tests time the template's worst caption on whatever runner they land on. A shared CI runner only ever
 * ADDS time to a render (scheduling, antivirus, a noisy neighbour), so the cheap end of the samples is the caption's real cost
 * and the tail is the runner's noise. Three bounds, each against the configured deadline (never against another measurement):
 *  - the lower quartile of the samples is the typical cost, and the deadline must be at least 5x that;
 *  - the median must leave 3x;
 *  - the second-slowest sample must leave 1.5x, so a plain slow render on a slow runner is still far from being cut.
 * A slower runner raises all three together and fails them; one stalled sample moves only the tail, which has the loosest bound.
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

/** The first bound the deadline fails to leave, or undefined when it has the headroom. NaN samples fail. */
export function deadlineHeadroomProblem(times: readonly number[], deadlineMs: number): string | undefined {
  const { lowerQuartile, median, secondSlowest } = headroomStats(times);
  const round = (n: number): string => (Number.isFinite(n) ? String(Math.round(n)) : "NaN");
  if (!(lowerQuartile * 5 <= deadlineMs)) return `the typical cost (lower quartile) is ${round(lowerQuartile)} ms: the ${deadlineMs} ms deadline is under 5x that`;
  if (!(median * 3 <= deadlineMs)) return `the median is ${round(median)} ms: the ${deadlineMs} ms deadline is under 3x that`;
  if (!(secondSlowest * 1.5 <= deadlineMs)) return `the second-slowest sample is ${round(secondSlowest)} ms: the ${deadlineMs} ms deadline is under 1.5x that`;
  return undefined;
}
