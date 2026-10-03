// The identity an E2E build must run under. An E2E build talks to mocks and writes its own ledger and quota; if it ran under
// Studio's identity it would share Studio's userData (and so its settings, library and ledger). The packaged E2E app gets its own
// name from the dist:studio:*:e2e scripts (package.json: productName "Studio E2E"); an unpackaged E2E run's own userData folder
// is chosen inline in main.ts, so a production bundle folds its name away.

/** The packaged E2E app's name (its productName: Electron prefers it to `name`). */
export const E2E_APP_NAME = "Studio E2E";

/** Why this E2E build may not run, or null. Only a packaged E2E build can carry the wrong identity; any other build is not asked. */
export function e2eIdentityProblem(input: { e2e: boolean; packaged: boolean; appName: string }): string | null {
  if (!input.e2e || !input.packaged || input.appName === E2E_APP_NAME) return null;
  return `an E2E build must run under the identity "${E2E_APP_NAME}", not "${input.appName}": it would share that app's userData`;
}
