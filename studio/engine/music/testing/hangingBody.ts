import type { FlashapiFetch } from "../client";

/**
 * Test-only: a fetch that answers at once with the given status and headers and a body that never arrives. The body
 * errors when the request is aborted, as a real one does, so a timeout or a `stop()` ends the read. Production code
 * never imports this file (it lives under `testing/`, which the purity guard and the bundle check keep out).
 */
export function hangingBody(status: number, headers: Record<string, string>): FlashapiFetch {
  return (_url, init) =>
    Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            init.signal.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true });
          },
          pull: () => new Promise<void>(() => undefined),
        }),
        { status, headers },
      ),
    );
}
