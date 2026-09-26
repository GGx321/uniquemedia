import { expect, test } from "bun:test";
import { createServer, type AddressInfo } from "node:net";
import { nativeAbortController, nativeAbortSignal } from "../../nativeGlobals";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// M6: proves useNativeGlobals() really installs the native classes for an
// engine test, not just that it runs without throwing. The renderer's
// companion test (studio/renderer/nativeGlobalsUnaffected.test.ts) proves the
// opposite for a file that never calls it.

test("AbortController and AbortSignal are the native classes, not happy-dom's", () => {
  expect(globalThis.AbortController).toBe(nativeAbortController);
  expect(globalThis.AbortSignal).toBe(nativeAbortSignal);
  expect(new AbortController().signal).toBeInstanceOf(nativeAbortSignal);
});

test("AbortSignal.any combines native signals and reports the aborting one's reason", () => {
  const first = new AbortController();
  const second = new AbortController();
  const combined = AbortSignal.any([first.signal, second.signal]);

  expect(combined).toBeInstanceOf(nativeAbortSignal);
  expect(combined.aborted).toBe(false);

  second.abort("second aborted");

  expect(combined.aborted).toBe(true);
  expect(combined.reason).toBe("second aborted");
});

test("AbortSignal.timeout aborts natively with a TimeoutError DOMException", async () => {
  const signal = AbortSignal.timeout(10);
  expect(signal.aborted).toBe(false);

  await new Promise<void>((resolve) => setTimeout(resolve, 100));

  expect(signal.aborted).toBe(true);
  // Not `toBeInstanceOf(DOMException)`: the bare `DOMException` identifier in
  // this file is still happy-dom's — useNativeGlobals() swaps only
  // AbortController/AbortSignal (M6's scope), not every global testSetup.ts
  // replaces. `signal.reason` is still a genuine native DOMException; this
  // checks its shape instead of its identity against the wrong class.
  const reason = signal.reason as { name: string; constructor: { name: string } };
  expect(reason.name).toBe("TimeoutError");
  expect(reason.constructor.name).toBe("DOMException");
});

test("a native AbortSignal.any result is accepted by the real native fetch (no 'signal is not of type AbortSignal')", async () => {
  // A real loopback server that answers immediately: proves native fetch
  // *accepts* a combined signal and completes a real request with it, not
  // just that some rejection happened to lack one particular substring. The
  // bug this file guards against (see loopback.test.ts) is fetch throwing
  // "signal is not of type AbortSignal" for a non-native signal before a
  // connection is even attempted. `Bun.fetch`, not the bare `fetch`
  // identifier: useNativeGlobals() swaps AbortController/AbortSignal only,
  // so global `fetch` is still happy-dom's here (same as loopback.test.ts,
  // which captures `Bun.fetch` for the same reason) and would apply
  // happy-dom's own same-origin policy to a plain loopback request.
  const server = createServer((socket) => {
    socket.end("HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    const controller = new AbortController();
    const combined = AbortSignal.any([controller.signal]);

    const response = await Bun.fetch(base, { signal: combined });

    expect(response.status).toBe(200);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
