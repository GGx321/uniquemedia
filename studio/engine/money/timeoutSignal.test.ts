import { expect, test } from "bun:test";
import { timeoutSignal, untilAborted } from "./timeoutSignal";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// A ref'd replacement for AbortSignal.timeout(ms): that native timer is
// unref'd, which hung the Windows CI runs once M6 moved engine/main/node/
// scripts tests onto Bun's native AbortController/AbortSignal (see
// timeoutSignal.ts's own doc comment for the full story). These tests run
// under the native classes (useNativeGlobals()) since that is exactly the
// runtime the bug needed.

test("aborts after ms with a TimeoutError reason", async () => {
  const timeout = timeoutSignal(20);
  expect(timeout.signal.aborted).toBe(false);

  await new Promise<void>((resolve) => setTimeout(resolve, 150));

  expect(timeout.signal.aborted).toBe(true);
  // Not `toBeInstanceOf(DOMException)` (nativeGlobals.test.ts's own note):
  // checked by shape, not identity against the bare `DOMException` global.
  const reason = timeout.signal.reason as { name: string; constructor: { name: string } };
  expect(reason.name).toBe("TimeoutError");
  expect(reason.constructor.name).toBe("DOMException");
  timeout.clear();
});

test("clear() prevents the abort, and no timer is left pending", async () => {
  const timeout = timeoutSignal(20);
  timeout.clear();

  await new Promise<void>((resolve) => setTimeout(resolve, 150));

  expect(timeout.signal.aborted).toBe(false);
});

test("combined with untilAborted, a never-resolving promise rejects within the bound", async () => {
  const timeout = timeoutSignal(20);
  const never = new Promise<never>(() => {});
  const started = performance.now();

  let rejection: unknown;
  await untilAborted(never, timeout.signal).catch((error: unknown) => {
    rejection = error;
  });

  expect(performance.now() - started).toBeLessThan(2_000);
  expect((rejection as { name: string }).name).toBe("TimeoutError");
  timeout.clear();
});
