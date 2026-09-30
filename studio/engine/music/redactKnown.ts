import { redactSecrets } from "../../shared/engine";

export const REDACTED = "[redacted]";

/** Shortest slice of the key that is removed by itself: the same window the leak tests look for. */
const WINDOW = 6;

/** The forms a server or a runtime error could echo the whole key in, longest first. */
function wholeForms(key: string): string[] {
  const bytes = Buffer.from(key, "utf8");
  const forms = new Set([key, encodeURIComponent(key), JSON.stringify(key).slice(1, -1), bytes.toString("base64"), bytes.toString("base64url"), bytes.toString("hex"), bytes.toString("hex").toUpperCase()]);
  forms.delete("");
  return [...forms].sort((a, b) => b.length - a.length);
}

/** Lowercases ASCII only, so the text keeps its length and an index in one is an index in the other. */
function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/**
 * Replaces every run of `text` that is at least `WINDOW` chars of the key (ASCII case ignored): a prefix, a suffix, a
 * slice, a case-folded echo. A run is the union of the overlapping windows, so a long echo becomes one `[redacted]`.
 */
function redactSlices(text: string, key: string): string {
  if (key.length < WINDOW) return text;
  const lowerKey = asciiLower(key);
  const windows = new Set<string>();
  for (let i = 0; i + WINDOW <= lowerKey.length; i++) windows.add(lowerKey.slice(i, i + WINDOW));
  const lower = asciiLower(text);
  const covered = new Uint8Array(text.length);
  let any = false;
  for (let i = 0; i + WINDOW <= lower.length; i++) {
    if (!windows.has(lower.slice(i, i + WINDOW))) continue;
    covered.fill(1, i, i + WINDOW);
    any = true;
  }
  if (!any) return text;
  let out = "";
  let start = 0;
  while (start < text.length) {
    if (covered[start] === 1) {
      let end = start;
      while (end < text.length && covered[end] === 1) end++;
      out += REDACTED;
      start = end;
    } else {
      let end = start;
      while (end < text.length && covered[end] === 0) end++;
      out += text.slice(start, end);
      start = end;
    }
  }
  return out;
}

/**
 * The text with the RapidAPI key gone from it: the whole key (raw, URL-encoded, JSON-escaped, base64, hex), any slice
 * of it of six or more chars, and whatever `redactSecrets` knows (another key's shape, a bearer token, the header
 * line). Applied to EVERY text derived from a flashapi response or error (a fetch error's message, a body, a header
 * value) before it reaches a log, a quota line or a `SafeText`. The last four chars alone are left: a status shows them.
 */
export function redactKnown(text: string, key: string): string {
  let out = text;
  for (const form of wholeForms(key)) out = out.split(form).join(REDACTED);
  return redactSecrets(redactSlices(out, key));
}
