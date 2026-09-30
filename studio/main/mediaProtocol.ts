import { respond } from "./media/respond";
import { resolveMedia, type MediaDeps } from "./media/resolve";
import { MEDIA_SCHEME, parseMediaRoute } from "./media/route";

export { MEDIA_SCHEME, parseMediaRoute, type MediaRoute } from "./media/route";
export type { MediaDeps } from "./media/resolve";

/**
 * The scheme's privileges, registered before `ready` (main.ts). `standard` + `secure` give it an origin and a secure
 * context, `supportFetchAPI` lets the scheme be used with the Fetch API, and `stream` lets `<video>` and `<audio>` play
 * from it with Range. Nothing else: no `bypassCSP` (the renderer's CSP names the scheme in `img-src` and `media-src` and
 * nowhere else), no `corsEnabled`, no `codeCache`. Consequence to know: the renderer's own `fetch("studio-media://...")`
 * is refused by its CSP (`connect-src` falls back to `default-src 'self'`) and has no CORS grant, so elements (`<img>`,
 * `<video>`, `<audio>`) load from it and script does not read the bytes; 3d.4's `ImageDecoder` needs its own decision.
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
  try {
    const served = await resolveMedia(route, deps);
    if (served === null) return notFound();
    return respond(served.source, { contentType: served.contentType, range: request.headers?.get("Range") ?? null, signal: request.signal ?? null });
  } catch {
    return notFound();
  }
}
