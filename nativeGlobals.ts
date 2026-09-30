// Captured at module evaluation time, before testSetup.ts calls
// `GlobalRegistrator.register()` (testSetup.ts imports this module first, for
// that ordering alone). Side-effect-free itself: importing it changes nothing
// in `globalThis`, it only reads the bindings a test needs in order to
// build a signal the real `fetch` accepts (or to get the native Response, Request and Headers). A test that needs them
// (studio/engine/openrouter/loopback.test.ts) imports the values from here
// rather than from testSetup.ts, which also registers cleanup hooks and the
// happy-dom globals as a side effect of being imported.
export const nativeAbortController = globalThis.AbortController;
export const nativeAbortSignal = globalThis.AbortSignal;
export const nativeResponse = globalThis.Response;
export const nativeRequest = globalThis.Request;
export const nativeHeaders = globalThis.Headers;
