import { afterAll, beforeAll } from "bun:test";
import { nativeAbortController, nativeAbortSignal, nativeHeaders, nativeRequest, nativeResponse } from "../../nativeGlobals";

// The root testSetup.ts registers happy-dom globally for the whole repo (it
// is shared with the uniquifier, which may depend on that), replacing
// AbortController/AbortSignal (and more) with happy-dom's implementations.
// studio/engine, studio/main, studio/node and studio/scripts run under
// Electron's Node in production and must never be tested against anything
// else (plan: "Engine runtime", invariant 1) — Bun's native fetch either
// silently ignores a happy-dom AbortSignal (1.3.x) or throws "signal is not
// of type AbortSignal" (1.4.x+), and `AbortSignal.any`/`AbortSignal.timeout`
// used by the transport, price fetch and candidate job would run on
// happy-dom's implementation, not the one shipped in production.
//
// Captured once, the first time any test file imports this module: at that
// point testSetup.ts's `GlobalRegistrator.register()` has already run (the
// preload runs before any test file loads) and, because Bun runs test files
// one after another in a single process — never interleaved, even under
// `bun test --randomize`, which only shuffles file order (verified directly
// for this change with a throwaway two-file probe, and already documented by
// loopback.test.ts's own note on the same guarantee) — every earlier file
// that swapped these globals restores them in its own afterAll before the
// next file's imports execute. So `globalThis.AbortController`/
// `.AbortSignal` are happy-dom's real classes right here, and stay the fixed
// reference every file below restores to.
//
// This module itself is also cached across the whole run, so this top-level
// capture happens exactly once — which is why the swap below cannot be a
// plain import side effect (see useNativeGlobals's own doc comment).
const happyDomAbortController = globalThis.AbortController;
const happyDomAbortSignal = globalThis.AbortSignal;

/**
 * Call this once, at the top level of a studio/engine, studio/main,
 * studio/node or studio/scripts test file — never inside a `test()` or
 * `describe()` body. It installs the native AbortController/AbortSignal for
 * the whole file's duration (`beforeAll`) and restores happy-dom's right
 * after the file's last test (`afterAll`), matching what Electron's Node
 * gives the engine in production.
 *
 * A plain `import "./nativeGlobals"` side effect cannot do this: Bun caches
 * this module across the entire `bun test` run (one process), so a
 * beforeAll/afterAll registered at THIS module's own top level would only
 * ever fire for the first file that happens to import it — verified
 * directly (a throwaway two-file check: a shared module's own top-level
 * `beforeAll` ran once, for file 1 only; file 2 got no hook at all). A
 * function, by contrast, runs its body fresh every time it is called, so
 * each file's own call to `useNativeGlobals()` registers fresh hooks against
 * that file's own suite.
 */
export function useNativeGlobals(): void {
  beforeAll(() => {
    globalThis.AbortController = nativeAbortController;
    globalThis.AbortSignal = nativeAbortSignal;
  });

  afterAll(() => {
    globalThis.AbortController = happyDomAbortController;
    globalThis.AbortSignal = happyDomAbortSignal;
  });
}

/**
 * Like `useNativeGlobals`, for a file that builds `Response` objects the way Electron's `protocol.handle` receives them
 * (studio/main/mediaProtocol.ts): happy-dom replaces `Response`, `Request` and `Headers` too, and its `Response`
 * is not the class the product runs on (body streaming, `Content-Length`, status handling all differ). Call it once
 * at the top level of the test file, next to `useNativeGlobals()`; the happy-dom classes are restored after the last test.
 */
export function useNativeWebClasses(): void {
  const swapped = { response: globalThis.Response, request: globalThis.Request, headers: globalThis.Headers };
  beforeAll(() => {
    swapped.response = globalThis.Response;
    swapped.request = globalThis.Request;
    swapped.headers = globalThis.Headers;
    globalThis.Response = nativeResponse;
    globalThis.Request = nativeRequest;
    globalThis.Headers = nativeHeaders;
  });
  afterAll(() => {
    globalThis.Response = swapped.response;
    globalThis.Request = swapped.request;
    globalThis.Headers = swapped.headers;
  });
}
