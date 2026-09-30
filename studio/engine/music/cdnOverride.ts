/**
 * The mock CDN's base for the track store's transport (invariant 31, S11): the requested one when this is an E2E build
 * and main asked for a mock, else none. A production build has `STUDIO_E2E` false, so the override is inert there whatever
 * main sends, and the bundle check (`bundleChecks.ts`) reads the call with the flag folded to `false`. `e2e` is a
 * parameter so both branches can be tested. Only a loopback base is ever built into a transport
 * (`createLoopbackCdnTransport`), which refuses anything else.
 */
export function resolveMusicCdnBase(requested: string | undefined, e2e: boolean): string | null {
  return e2e && requested !== undefined ? requested : null;
}
