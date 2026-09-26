import { expect, test } from "bun:test";
import { nativeAbortController, nativeAbortSignal } from "../../nativeGlobals";

// M6: studio/renderer runs UI code and stays on happy-dom's AbortController/
// AbortSignal, same as before — only studio/engine, studio/main, studio/node
// and studio/scripts call useNativeGlobals() (studio/testing/nativeGlobals.ts)
// to get the native classes Electron's Node gives them in production. This
// file deliberately never calls it, and proves the swap those other
// directories' tests do stays scoped to their own files and never leaks here
// (its companion, studio/engine/nativeGlobals.test.ts, proves the opposite:
// that AbortController/AbortSignal really are native inside an engine test).

test("the renderer keeps happy-dom's AbortController and AbortSignal", () => {
  expect(globalThis.AbortController).not.toBe(nativeAbortController);
  expect(globalThis.AbortSignal).not.toBe(nativeAbortSignal);
});

test("the renderer's AbortController is not the native, [native code] one", () => {
  const isNative = (fn: unknown): boolean => typeof fn === "function" && /\[native code\]/.test(Function.prototype.toString.call(fn));
  expect(isNative(globalThis.AbortController)).toBe(false);
  expect(isNative(globalThis.AbortSignal)).toBe(false);
});
