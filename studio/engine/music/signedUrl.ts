/**
 * When a signed CDN URL stops working: the `oe` query parameter is the expiry as hex seconds since the epoch (SP5: 104
 * to 108 hours after the response). Null when there is none, or it is not a plausible time. Reads nothing else of the
 * URL, and the URL itself is never logged.
 */
export function signedUrlExpiresAtMs(url: string): number | null {
  let raw: string | null;
  try {
    raw = new URL(url).searchParams.get("oe");
  } catch {
    return null;
  }
  if (raw === null || !/^[0-9a-fA-F]{1,12}$/.test(raw)) return null;
  const seconds = Number.parseInt(raw, 16);
  // Zero is not a time, and past year 2200 is a garbled value rather than an expiry.
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 7_258_118_400) return null;
  return seconds * 1000;
}
