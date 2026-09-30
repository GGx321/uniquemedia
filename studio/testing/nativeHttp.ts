import { afterAll, beforeAll } from "bun:test";

// The root testSetup.ts registers happy-dom for the whole repo, which replaces `fetch` (it sends a CORS preflight and
// answers with its own Response) and `Response` (which `Bun.serve` refuses). Studio's engine runs on Electron's Node,
// so a test that talks HTTP to a loopback mock server must use Bun's own. This is the one place that says how.

/** Bun's own `fetch`, captured before anything can swap it. */
export const nativeFetch: typeof fetch = Bun.fetch;

const happyDomResponse = globalThis.Response;
const sample = await nativeFetch("data:,");
const nativeResponse = sample.constructor;

/**
 * Call once at the top level of a test file that serves or fetches over HTTP: for the file's duration `Response` is
 * Bun's own (so `Bun.serve` handlers can return one), and happy-dom's is back after the file's last test.
 */
export function useNativeHttp(): void {
  beforeAll(() => {
    if (typeof nativeResponse === "function") globalThis.Response = nativeResponse as typeof Response;
  });
  afterAll(() => {
    globalThis.Response = happyDomResponse;
  });
}
