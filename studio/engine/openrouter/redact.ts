import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

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

/** A `b64_json` string value, whole or cut off by a body over the cap (then without its closing quote). */
const B64_JSON_VALUE = /"b64_json"\s*:\s*"((?:[^"\\\n]|\\.)*)("?)/g;
/** An image as a data URL anywhere else in a body. */
const IMAGE_DATA_URL = /data:image\/[A-Za-z0-9.+-]+;base64,([A-Za-z0-9+/=_-]*)/g;
/**
 * Any run of base64 (standard or URL-safe) of 128 characters or more, also
 * across literal or escaped line breaks: an image under a key the two rules
 * above do not know (a provider's format change is just when bodies turn
 * unusable), in a body that is not JSON, or split across lines.
 */
const BASE64_RUN = /[A-Za-z0-9+/_-]{128,}(?:(?:\\[nr]|\r?\n)[A-Za-z0-9+/_-]+)*={0,2}/g;

/** The bytes a base64 value (a data URL prefix, JSON escapes and stray characters allowed) stands for. */
function decodedLoosely(value: string): Uint8Array {
  const payload = value.replace(/^data:[^,]*,/, "").replace(/\\./g, (escape) => escape.slice(1));
  return new Uint8Array(Buffer.from(payload, "base64"));
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A string longer than this is kept only as its length and sha256; a body that is not JSON only up to it. */
const KEPT_CHARS = 256;

function b64JsonSummary(value: string, truncated: boolean): Record<string, unknown> {
  const bytes = decodedLoosely(value);
  return {
    omitted: "image data",
    chars: value.length,
    sha256: sha256Hex(bytes),
    head: Buffer.from(bytes.subarray(0, 16)).toString("hex"),
    ...(truncated ? { truncated: true } : {}),
  };
}

function textSha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The pattern rules, on any text: `b64_json` values, image data URLs, runs of base64. */
function omitByPattern(text: string): string {
  return text
    .replace(B64_JSON_VALUE, (_match, value: string, closingQuote: string) => `"b64_json":${JSON.stringify(b64JsonSummary(value, closingQuote === ""))}`)
    .replace(IMAGE_DATA_URL, (_match, payload: string) => `[image data omitted: ${payload.length} chars, sha256 ${sha256Hex(decodedLoosely(payload))}]`)
    .replace(BASE64_RUN, (run) => `[image data omitted: ${run.length} chars, sha256 ${sha256Hex(decodedLoosely(run.replace(/\\[nr]|\r?\n/g, "")))}]`);
}

/** One string of a parsed body: a `b64_json` value or any string over KEPT_CHARS becomes its summary; a shorter one goes through the pattern rules. */
function omitInString(value: string, key: string | null): unknown {
  if (key === "b64_json") return b64JsonSummary(value, false);
  if (value.length > KEPT_CHARS) return { omitted: "long string", chars: value.length, sha256: textSha256(value) };
  return omitByPattern(value);
}

function omitInValue(value: unknown, key: string | null): unknown {
  if (typeof value === "string") return omitInString(value, key);
  if (Array.isArray(value)) return value.map((item) => omitInValue(item, null));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k.length > KEPT_CHARS ? `[long key omitted: ${k.length} chars, sha256 ${textSha256(k)}]` : k, omitInValue(v, k)]),
    );
  }
  return value;
}

function parsedJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/**
 * A paid image body that could not be used, without its image data. Such a
 * body may hold a whole image (or, cut at the cap, the top of a portrait, the
 * face) that no age check has seen, in any shape a provider's format change
 * brings (another key, base64 wrapped in 76-char lines, hex), so nothing
 * image-sized is kept (invariant 8):
 * - JSON: every string over 256 chars becomes its length and sha256, every
 *   `b64_json` its length, sha256 and first 16 decoded bytes, every image data
 *   URL and run of base64 its length and sha256; the shape and the short
 *   strings stay, re-serialised (unchanged text when nothing was replaced).
 * - Not JSON (also a body cut at the cap): the pattern rules, then only the
 *   first 256 chars with the whole body's length and sha256.
 */
export function omitImageData(text: string): string {
  const parsed = parsedJson(text);
  if (parsed.ok) {
    const scrubbed = JSON.stringify(omitInValue(parsed.value, null));
    return scrubbed === JSON.stringify(parsed.value) ? text : scrubbed;
  }
  const kept = omitByPattern(text);
  if (text.length <= KEPT_CHARS && kept.length <= KEPT_CHARS) return kept;
  return `${kept.slice(0, KEPT_CHARS)}\n[not JSON: ${text.length} chars, sha256 ${textSha256(text)}; only the first ${KEPT_CHARS} are kept]`;
}
