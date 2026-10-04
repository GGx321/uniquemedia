// 3d.4: the bytes of a `data:` URL, read without a fetch. The preview's sticker canvas decodes a picture's frames from its bytes; in
// the dev mock that picture is a data URL, and the window's CSP lets script fetch only the built-in stickers' route
// (`connect-src 'self' studio-media://sticker`), not a data URL.

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** The type and bytes of a `data:` URL (base64 or percent-encoded); null for anything else or a malformed one. */
export function dataUrlBytes(url: string): { type: string; bytes: Uint8Array } | null {
  if (!url.startsWith("data:")) return null;
  const comma = url.indexOf(",");
  if (comma < 0) return null;
  const params = url.slice(5, comma).split(";");
  const base64 = params[params.length - 1] === "base64";
  const type = params[0] ?? "";
  const body = url.slice(comma + 1);
  try {
    if (base64) {
      if (!BASE64.test(body)) return null;
      const binary = atob(body);
      return { type, bytes: Uint8Array.from(binary, (c) => c.charCodeAt(0)) };
    }
    return { type, bytes: new TextEncoder().encode(decodeURIComponent(body)) };
  } catch {
    // A broken base64 length or a broken escape: not a picture.
    return null;
  }
}
