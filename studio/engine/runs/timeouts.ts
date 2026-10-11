/**
 * How long preparing the master as a reference (an ffmpeg downscale), or the
 * gates' `prepare()` on it, may take before a run fails, or a start is
 * refused, for free. Its own tiny module so `control.ts` (which main imports
 * for the command deadlines) can size `runs.start`'s deadline from it
 * without pulling in the run job.
 */
export const REFERENCE_TIMEOUT_MS = 30_000;

/**
 * How long one face-embedding computation (the master's, or an imported avatar's source photo) may run before the worker is terminated. The face QA gate bounds its cache with it
 * (`runs/faceGate.ts`), and the reference portrait batch bounds its embedding of the source photo with it; here so `control.ts` can size `avatars.generatePortraits`'s deadline from it.
 */
export const EMBEDDING_COMPUTE_TIMEOUT_MS = 30_000;
