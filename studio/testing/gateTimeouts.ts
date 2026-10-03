/**
 * The render deadline a test gives a text gate whose point is NOT the deadline.
 *
 * The production deadline (TEXT_RENDER_DEADLINE_MS, 3000 ms) also covers the FIRST call to a freshly spawned worker, and that call
 * includes the spawn and, for the real worker, the resvg wasm init. A loaded Windows runner took 3047 ms for it in a test that was
 * about replacing a worker after a fatal failure (main run 37138036270), so such a test must not run under the production deadline.
 * The deadline itself stays covered by the tests that set their own (a few hundred ms) and by the perf tier.
 */
export const FIRST_CALL_RENDER_TIMEOUT_MS = 15_000;
