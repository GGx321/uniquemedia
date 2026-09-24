const ENCODED_SLASH = /%2f/i;
const ENCODED_BACKSLASH = /%5c/i;
/** `/C:` at the start of a decoded pathname: Windows' drive letter. */
const DRIVE = /^\/[a-z]:/i;

/**
 * A file URL's path, read the way Node's `fileURLToPath` reads it on
 * `platform`, whatever platform this runs on; null where it would throw.
 * Written out because Bun ignores `fileURLToPath`'s `windows` option, so a run
 * on macOS could not otherwise hold a URL to Windows' rules.
 *
 * Everywhere: the URL must be `file:` with no host (stricter than Node on
 * Windows, which reads `file://server/share` as a UNC path), no encoded `/`,
 * and escapes that decode. On Windows also no encoded `\`, and a drive letter
 * (`file:///C:/…` → `C:\…`). Query and fragment are not part of the path.
 */
export function fileUrlToPathOn(href: string, platform: NodeJS.Platform): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  // The only host check on the sender path. Running Studio from a network
  // share (file://server/...) is not supported: its renderer URL has a host,
  // so it reads as no path and the window is untrusted (fails closed).
  if (url.protocol !== "file:" || url.hostname !== "") return null;
  const windows = platform === "win32";
  if (ENCODED_SLASH.test(url.pathname) || (windows && ENCODED_BACKSLASH.test(url.pathname))) return null;
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (!windows) return path;
  if (!DRIVE.test(path)) return null;
  return path.slice(1).replaceAll("/", "\\");
}
