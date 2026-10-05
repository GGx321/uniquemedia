import type { ByteSource } from "./media/diskSource";
import { createDiskGate, DiskGateError, type DiskGate } from "./media/diskGate";
import { respond } from "./media/respond";
import { resolveMedia, type MediaDeps } from "./media/resolve";
import { MEDIA_SCHEME, parseMediaRoute } from "./media/route";

export { MEDIA_SCHEME, parseMediaRoute, type MediaRoute } from "./media/route";
export type { MediaDeps } from "./media/resolve";

/**
 * The scheme's privileges, registered before `ready` (main.ts). `standard` + `secure` give it an origin and a secure
 * context, `supportFetchAPI` lets the scheme be used with the Fetch API, and `stream` lets `<video>` and `<audio>` play
 * from it with Range. Nothing else: no `bypassCSP` (the renderer's CSP names the scheme in `img-src` and `media-src` and
 * nowhere else), no `codeCache`, and NEVER `corsEnabled`: with it (measured on Electron 43.1.1, the 3d.4 review) an
 * `<img crossorigin>` drawn on a canvas reads any route from the app page, and any other page in the session (a `data:`
 * page, a foreign origin) fetches a photo whole, because Electron runs no CORS check on a `protocol.handle` answer and the
 * handler is shown no Origin or Sec-Fetch-* to refuse by. So elements (`<img>`, `<video>`, `<audio>`) load from the scheme
 * and no script reads its bytes; the one thing that needs bytes, the preview's sticker decoder, gets them over IPC from main
 * (`stickers.bytes`, stickerBytesFlow.ts).
 */
export const MEDIA_SCHEME_PRIVILEGES = { standard: true, secure: true, supportFetchAPI: true, stream: true } as const;

/** What a `protocol.handle` request has of the `Request`: the URL, the method, the headers (for `Range`) and the abort signal. */
export interface MediaRequest {
  readonly url: string;
  readonly method: string;
  readonly headers?: { get(name: string): string | null };
  readonly signal?: AbortSignal;
}

// One answer for everything that is not a file to serve: no body, and nothing that tells "there is no such file"
// from "there is one and it was refused" from "that is not a route". No path, id or reason is put in it or logged.
function notFound(): Response {
  return new Response(null, { status: 404, headers: { "X-Content-Type-Options": "nosniff" } });
}

/** The disk did not answer in time (504), or the protocol had no slot for the request (503): no body, no path, and a hint to ask again. */
function unavailable(status: 503 | 504, extra: Record<string, string>): Response {
  return new Response(null, { status, headers: { "X-Content-Type-Options": "nosniff", ...extra } });
}

/**
 * Two of libuv's four threads at most are ever held by this protocol's file work, so main's own (settings, keys, the app's assets) always has the rest. A
 * request has ten seconds from its ask, waiting included: a sleeping disk or a NAS waking up answers well inside that, a dead share does not. 64 may wait; a
 * longer queue means the page asked for far more than it can show, and the rest are told to come back.
 */
export const MEDIA_DISK_SLOTS = 2;
export const MEDIA_DISK_DEADLINE_MS = 10_000;
const MEDIA_DISK_MAX_QUEUED = 64;
const SHARED_GATE: DiskGate = createDiskGate({ maxConcurrent: MEDIA_DISK_SLOTS, deadlineMs: MEDIA_DISK_DEADLINE_MS, maxQueued: MEDIA_DISK_MAX_QUEUED });

/**
 * The `protocol.handle` handler for `studio-media://` (invariant 28). The URL is parsed to a route and its ids
 * (media/route.ts: nothing else of it survives), the route makes a file of them (media/resolve.ts) that must lie in
 * its own root, be a plain file and start like the kind the route serves (media/diskSource.ts), and the answer is
 * 200, 206 or 416 with the bytes streamed a chunk at a time (media/respond.ts). Only GET; everything else, and any
 * failure at all, is the same 404.
 */
export async function handleMediaRequest(request: MediaRequest, deps: MediaDeps): Promise<Response> {
  if (request.method !== "GET") return notFound();
  const route = parseMediaRoute(request.url);
  if (route === null) return notFound();
  const gate = deps.gate ?? SHARED_GATE;
  const signal = request.signal;
  try {
    // The route's disk work (the record, the root marker, every step of the path) is ONE gated operation, and so is every chunk read below: a share that
    // stops answering costs `MEDIA_DISK_SLOTS` threads at most and an answer within the deadline, never main's whole thread pool.
    const served = await gate.run(() => resolveMedia(route, deps), signal);
    if (served === null) return notFound();
    const source: ByteSource = { size: served.source.size, read: (offset, length) => gate.run(() => served.source.read(offset, length), signal) };
    return respond(source, { contentType: served.contentType, range: request.headers?.get("Range") ?? null, signal: signal ?? null });
  } catch (error) {
    if (error instanceof DiskGateError) {
      if (error.reason === "busy") return unavailable(503, { "Retry-After": "1" });
      if (error.reason === "timeout") return unavailable(504, {});
    }
    return notFound();
  }
}
