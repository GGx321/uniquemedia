/**
 * How long preparing the master as a reference (an ffmpeg downscale), or the
 * gates' `prepare()` on it, may take before a run fails, or a start is
 * refused, for free. Its own tiny module so `control.ts` (which main imports
 * for the command deadlines) can size `runs.start`'s deadline from it
 * without pulling in the run job.
 */
export const REFERENCE_TIMEOUT_MS = 30_000;
