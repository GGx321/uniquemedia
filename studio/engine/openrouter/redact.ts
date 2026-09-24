export const REDACTED = "[redacted]";

/** Anything shaped like an OpenRouter key, e.g. a rotated-out one still in a stale error. */
const KEY_SHAPE = /sk-or-[A-Za-z0-9_-]{8,}/g;
const BEARER = /(Bearer\s+)(?!\[redacted\])[^\s"'\\,;}]+/gi;

/** Replaces the key, key-shaped strings and bearer tokens; apply before truncating. */
export function makeRedactor(key: string): (text: string) => string {
  return (text) => text.split(key).join(REDACTED).replace(KEY_SHAPE, REDACTED).replace(BEARER, `$1${REDACTED}`);
}

/** Start and end of every secret in `text`. */
function secretSpans(text: string, key: string): [number, number][] {
  const spans: [number, number][] = [];
  for (let at = text.indexOf(key); at !== -1; at = text.indexOf(key, at + key.length)) spans.push([at, at + key.length]);
  for (const pattern of [KEY_SHAPE, BEARER]) {
    for (const match of text.matchAll(pattern)) spans.push([match.index, match.index + match[0].length]);
  }
  return spans;
}

/**
 * Redacts the part of `text` before `cut`. A secret that straddles the cut is
 * kept whole, so it is redacted rather than left as a fragment; `text` must
 * run past the cut by at least the longest secret.
 */
export function makeHeadRedactor(key: string): (text: string, cut: number) => string {
  const redact = makeRedactor(key);
  return (text, cut) => {
    const spans = secretSpans(text, key);
    let end = cut;
    for (let moved = true; moved; ) {
      moved = false;
      for (const [start, stop] of spans) {
        if (start < end && stop > end) {
          end = stop;
          moved = true;
        }
      }
    }
    return redact(text.slice(0, end));
  };
}
