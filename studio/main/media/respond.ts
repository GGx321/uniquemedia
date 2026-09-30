import type { ByteSource } from "./diskSource";
import { decideRange } from "./range";

/** One read from disk is at most this many bytes, and the body pulls only when the renderer asks: memory per request is one chunk. */
export const CHUNK_BYTES = 256 * 1024;
/** One answer never carries more than this many bytes. A longer range is answered short, which RFC 9110 allows; `Content-Range` says how short, and the player asks again for the rest. */
export const MAX_RANGE_BYTES = 32 * 1024 * 1024;

export interface RespondOptions {
  readonly contentType: string;
  /** The request's `Range` header, or null. */
  readonly range: string | null;
  /** The request's abort signal. */
  readonly signal?: AbortSignal | null;
}

const BASE_HEADERS = { "X-Content-Type-Options": "nosniff", "Accept-Ranges": "bytes" } as const;

/**
 * The answer for a file that passed every check: 200 for the whole file, 206 for one range, 416 for a Range that
 * is not exactly one satisfiable range of bytes (decideRange). The body is a stream that reads one chunk per
 * pull, from the offset it stands at, so the file is never read whole and never read ahead of the renderer.
 * Cancelling the body, or aborting the request, stops it: no read starts after that, and the result of one that
 * was in flight is dropped.
 */
export function respond(source: ByteSource, options: RespondOptions): Response {
  const decision = decideRange(options.range, source.size);
  if (decision.kind === "unsatisfiable") {
    return new Response(null, { status: 416, headers: { ...BASE_HEADERS, "Content-Range": `bytes */${source.size}` } });
  }
  const partial = decision.kind === "partial";
  const start = partial ? decision.start : 0;
  const end = partial ? Math.min(decision.end, start + MAX_RANGE_BYTES - 1) : source.size - 1;
  const length = end - start + 1;
  const headers: Record<string, string> = { ...BASE_HEADERS, "Content-Type": options.contentType, "Content-Length": String(length) };
  if (partial) headers["Content-Range"] = `bytes ${start}-${end}/${source.size}`;
  return new Response(length === 0 ? null : streamOf(source, start, end, options.signal ?? null), { status: partial ? 206 : 200, headers });
}

function streamOf(source: ByteSource, start: number, end: number, signal: AbortSignal | null): ReadableStream<Uint8Array> {
  let next = start;
  let stopped = false;
  let stream: ReadableStreamDefaultController<Uint8Array> | null = null;
  const onAbort = (): void => stop(signal?.reason ?? new DOMException("the request was aborted", "AbortError"));
  function stop(reason?: unknown): void {
    if (stopped) return;
    stopped = true;
    signal?.removeEventListener("abort", onAbort);
    if (reason !== undefined) {
      try {
        stream?.error(reason);
      } catch {
        // Already closed or cancelled: nothing is waiting for the error.
      }
    }
  }
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        stream = controller;
        if (signal === null) return;
        if (signal.aborted) stop(signal.reason ?? new DOMException("the request was aborted", "AbortError"));
        else signal.addEventListener("abort", onAbort, { once: true });
      },
      async pull(controller) {
        if (stopped) return;
        let chunk: Uint8Array;
        try {
          chunk = await source.read(next, Math.min(CHUNK_BYTES, end - next + 1));
        } catch (error) {
          stop(error instanceof Error ? error : new Error("the file could not be read"));
          return;
        }
        // Cancelled or aborted while the read was in flight: its bytes are nobody's.
        if (stopped) return;
        controller.enqueue(chunk);
        next += chunk.length;
        if (next > end) {
          controller.close();
          stop();
        }
      },
      cancel() {
        stop();
      },
    },
    { highWaterMark: 0 },
  );
}
