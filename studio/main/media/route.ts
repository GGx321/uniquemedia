import { Id } from "../../shared/engine";

/** A parsed `studio-media://` URL: which route (invariant 28), and the ids it carries. */
export type MediaRoute =
  | { readonly route: "photo"; readonly avatarId: string; readonly photoId: string }
  | { readonly route: "video"; readonly avatarId: string; readonly videoId: string }
  | { readonly route: "poster"; readonly avatarId: string; readonly videoId: string }
  | { readonly route: "track"; readonly trackId: string }
  | { readonly route: "cover"; readonly trackId: string }
  | { readonly route: "sticker"; readonly stickerId: string }
  | { readonly route: "text"; readonly previewId: string }
  | { readonly route: "media"; readonly mediaId: string };

export const MEDIA_SCHEME = "studio-media";

// The whole URL, byte for byte, before anything parses it: `<scheme>://<route>/<id>[/<id>]`, where a route is
// lowercase letters and an id is 8-64 of a-z, 0-9 and `-` (the contract's `Id`, which is checked again below).
// So there is no percent sign, backslash, dot, colon, `@`, `?`, `#`, space, control character or non-ASCII
// character to reason about: `new URL()` would silently strip tabs and newlines and normalise others, and this
// never gives it the chance. A path can only be built from what this accepts.
const SHAPE = /^studio-media:\/\/([a-z]+)\/([a-z0-9-]{8,64})(?:\/([a-z0-9-]{8,64}))?$/;

/**
 * Accepts exactly the routes of invariant 28 and nothing else. The renderer supplies ids, never a path: every
 * id is matched against the contract's `Id`, and no other part of the URL survives.
 */
export function parseMediaRoute(url: string): MediaRoute | null {
  const match = SHAPE.exec(url);
  if (match === null) return null;
  const [, route, first, second] = match;
  if (first === undefined || !Id.safeParse(first).success) return null;
  if (second !== undefined && !Id.safeParse(second).success) return null;
  switch (route) {
    case "photo":
      return second === undefined ? null : { route, avatarId: first, photoId: second };
    case "video":
    case "poster":
      return second === undefined ? null : { route, avatarId: first, videoId: second };
    case "track":
      return second === undefined ? { route, trackId: first } : null;
    case "cover":
      return second === undefined ? { route, trackId: first } : null;
    case "sticker":
      return second === undefined ? { route, stickerId: first } : null;
    case "text":
      return second === undefined ? { route, previewId: first } : null;
    case "media":
      return second === undefined ? { route, mediaId: first } : null;
    default:
      return null;
  }
}
