// Invariant 31, sources: what a signed URL from the flashapi list may point at before anything is requested from it.
//
// - `https` only, port 443 only (a URL drops the default port, so an explicit `:443` reads as none);
// - the host matches ONE of two anchored, lowercase patterns as a whole name, never by suffix: `evilcdninstagram.com`,
//   `scontent-fra3-1.cdninstagram.com.evil.example` and `scontent-fra3-1.cdninstagram.com.` (a trailing dot) all fail
//   because the pattern is anchored at both ends and its labels are spelled out;
// - no credentials, and an IP literal never matches (the patterns need letters and labels), so `127.0.0.1`, `[::1]`
//   and their decimal and hex spellings are refused as hosts before any DNS is asked;
// - a refusal names the HOST only (never the path or the query, which carry the signature).
//
// The patterns are the SP5 findings: the concrete host depends on where the request comes from (a `fra3` or a `fkiv8`
// edge). They are duplicated in the 3c.1 fixtures' `cdnHostPatterns`, and a test holds the two equal.

export const CDN_HOST_PATTERNS: readonly RegExp[] = [/^scontent-[a-z0-9]+-[0-9]+\.cdninstagram\.com$/, /^instagram\.[a-z0-9]+-[0-9]+\.fna\.fbcdn\.net$/];

/** The most a URL may be; the list schema holds the same bound. */
const MAX_URL_CHARS = 4096;
const MAX_HOST_LOG_CHARS = 80;

export type CdnRefusal = "unparseable" | "scheme" | "credentials" | "port" | "host";

export type CdnUrlCheck = { ok: true; url: URL } | { ok: false; reason: CdnRefusal; host: string };

/** The host of `raw` for a log line: control characters and bidi marks out, at most 80 chars, or a fixed word when it is not a URL. */
export function hostForLog(raw: string): string {
  let hostname: string;
  try {
    hostname = new URL(raw).hostname;
  } catch {
    return "(unparseable)";
  }
  return hostname.replace(/[\p{Cc}‪-‮⁦-⁩]/gu, "").slice(0, MAX_HOST_LOG_CHARS);
}

/** Whether `raw` is a URL a download may be requested from. Pure: no DNS, no request. */
export function checkCdnUrl(raw: string): CdnUrlCheck {
  const refuse = (reason: CdnRefusal): CdnUrlCheck => ({ ok: false, reason, host: hostForLog(raw) });
  if (raw.length === 0 || raw.length > MAX_URL_CHARS) return refuse("unparseable");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return refuse("unparseable");
  }
  if (url.protocol !== "https:") return refuse("scheme");
  if (url.username !== "" || url.password !== "") return refuse("credentials");
  // A URL leaves the port empty for the scheme's default, so any port left is a different one.
  if (url.port !== "") return refuse("port");
  if (!CDN_HOST_PATTERNS.some((pattern) => pattern.test(url.hostname))) return refuse("host");
  return { ok: true, url };
}
