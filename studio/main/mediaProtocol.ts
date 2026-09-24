import { readFile } from "node:fs/promises";
import { resolveMediaPath } from "../engine/library/mediaPath";

/** Registered privileged (standard, secure, fetch) without `bypassCSP`; the renderer CSP allows it in `img-src`. */
export const MEDIA_SCHEME = "studio-media";

const ID = /^[a-z0-9-]{8,64}$/;

export interface MediaIds {
  avatarId: string;
  photoId: string;
}

/**
 * Accepts exactly `studio-media://photo/<avatarId>/<photoId>` with both ids
 * matching `^[a-z0-9-]{8,64}$` (invariant 12): no other host, no extra or
 * empty segments, no credentials, port, query or fragment.
 */
export function parseMediaUrl(url: string): MediaIds | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${MEDIA_SCHEME}:` || parsed.hostname !== "photo") return null;
  if (parsed.username !== "" || parsed.password !== "" || parsed.port !== "" || parsed.search !== "" || parsed.hash !== "") return null;
  const segments = parsed.pathname.split("/");
  if (segments.length !== 3 || segments[0] !== "") return null;
  const [, avatarId = "", photoId = ""] = segments;
  if (!ID.test(avatarId) || !ID.test(photoId)) return null;
  return { avatarId, photoId };
}

export interface MediaDeps {
  /** The library root from the current settings. */
  libraryRoot(): string;
  resolve?: typeof resolveMediaPath;
  read?: (path: string) => Promise<Uint8Array<ArrayBuffer>>;
}

function notFound(): Response {
  return new Response(null, { status: 404, headers: { "X-Content-Type-Options": "nosniff" } });
}

/**
 * The `protocol.handle` handler. A photo is found only by id through T4's
 * `resolveMediaPath` (library naming convention, image extension allowlist,
 * realpath inside the root, magic bytes matching the extension) and served
 * with its image MIME type and `nosniff`. Everything else is a 404.
 */
export async function handleMediaRequest(request: { url: string; method: string }, deps: MediaDeps): Promise<Response> {
  if (request.method !== "GET") return notFound();
  const ids = parseMediaUrl(request.url);
  if (ids === null) return notFound();
  const resolve = deps.resolve ?? resolveMediaPath;
  const read = deps.read ?? readFile;
  try {
    const resolved = await resolve(deps.libraryRoot(), ids.avatarId, ids.photoId);
    if (!resolved.ok) return notFound();
    const body = await read(resolved.path);
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": resolved.mediaType, "X-Content-Type-Options": "nosniff" },
    });
  } catch {
    return notFound();
  }
}
