import { buildForbiddenStrings } from "../videos/forbiddenStrings";

// The text a stored track's OWN bytes carry, read for invariant 14 (3c.5): a render drops every tag (`-map_metadata -1`, and the
// track's stream metadata too), and the verifier then searches the finished video for these strings in UTF-8 and both UTF-16
// orders. The three places a music file keeps readable text:
//   - iTunes-style tags, `moov/udta/meta/ilst/<item>/data` (UTF-8, or UTF-16 big endian by the data type);
//   - an ID3v2 tag in an `ID32` box under `moov/meta` or `moov/trak/meta` (frames encoded Latin-1, UTF-16 or UTF-8);
//   - the handler name of each track (`hdlr`), which a real library fills with its own product name.
// The file is untrusted, so every read is bounds-checked, the depth, the number of boxes and the number of strings are capped,
// and a box that lies about its size ends that level quietly: nothing here throws.

const MAX_DEPTH = 10;
const MAX_BOXES = 20_000;
const MAX_STRINGS = 4096;
/** A text field is read up to this many bytes. */
const MAX_FIELD_BYTES = 2048;

/** Boxes whose children are boxes that may hold tags (`ilst`'s items are walked by `readIlst`). */
const CONTAINERS: ReadonlySet<string> = new Set(["moov", "trak", "mdia", "udta"]);

const latin1 = (bytes: Uint8Array, at: number, length: number): string => Buffer.from(bytes.buffer, bytes.byteOffset + at, length).toString("latin1");
const u32 = (bytes: Uint8Array, at: number): number | undefined => (at >= 0 && at + 4 <= bytes.length ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(at) : undefined);

interface BoxAt {
  readonly type: string;
  /** Where the payload starts and ends, inside `bytes`. */
  readonly start: number;
  readonly end: number;
  readonly next: number;
}

/** The box at `at` inside `[at, end)`, or null when it does not fit (a lying size, a truncated header). */
function boxAt(bytes: Uint8Array, at: number, end: number): BoxAt | null {
  const size = u32(bytes, at);
  if (size === undefined || at + 8 > end) return null;
  const type = latin1(bytes, at + 4, 4);
  let header = 8;
  let total = size;
  if (size === 1) {
    const high = u32(bytes, at + 8);
    const low = u32(bytes, at + 12);
    if (high === undefined || low === undefined || high > 0) return null;
    header = 16;
    total = low;
  } else if (size === 0) {
    total = end - at;
  }
  if (total < header || at + total > end) return null;
  return { type, start: at + header, end: at + total, next: at + total };
}

class Strings {
  readonly out: string[] = [];
  readonly #seen = new Set<string>();
  boxes = 0;

  get full(): boolean {
    return this.out.length >= MAX_STRINGS || this.boxes >= MAX_BOXES;
  }

  add(text: string): void {
    const trimmed = text.replaceAll("\u0000", " ").trim();
    if (trimmed === "" || trimmed.includes("�") || this.full || this.#seen.has(trimmed)) return;
    this.#seen.add(trimmed);
    this.out.push(trimmed);
  }

  /** Text in an encoding the ID3 and iTunes forms use: 0 Latin-1, 1 UTF-16 with a BOM, 2 UTF-16 big endian, 3 UTF-8. Split at terminators. */
  addEncoded(encoding: number, field: Uint8Array): void {
    const bytes = field.subarray(0, MAX_FIELD_BYTES);
    const wide = (littleEndian: boolean, from: number): string => {
      const even = bytes.subarray(from, from + ((bytes.length - from) & ~1));
      const buffer = Buffer.from(even);
      return (littleEndian ? buffer : buffer.swap16()).toString("utf16le");
    };
    let text: string;
    if (encoding === 0) text = Buffer.from(bytes).toString("latin1");
    else if (encoding === 3) text = Buffer.from(bytes).toString("utf8");
    else if (encoding === 2) text = wide(false, 0);
    else if (bytes[0] === 0xfe && bytes[1] === 0xff) text = wide(false, 2);
    else if (bytes[0] === 0xff && bytes[1] === 0xfe) text = wide(true, 2);
    else text = wide(true, 0);
    for (const piece of text.split("\u0000")) this.add(piece);
  }
}

/** `ilst`: each item holds `data` boxes; a type 1 payload is UTF-8, a type 2 one UTF-16 big endian, anything else is not text. */
function readIlst(bytes: Uint8Array, start: number, end: number, strings: Strings): void {
  for (let at = start; at < end && !strings.full; ) {
    const item = boxAt(bytes, at, end);
    if (item === null) return;
    strings.boxes++;
    for (let inner = item.start; inner < item.end && !strings.full; ) {
      const data = boxAt(bytes, inner, item.end);
      if (data === null) break;
      strings.boxes++;
      if (data.type === "data" && data.end - data.start > 8) {
        const kind = (u32(bytes, data.start) ?? 0) & 0xffffff;
        if (kind === 1) strings.addEncoded(3, bytes.subarray(data.start + 8, data.end));
        else if (kind === 2) strings.addEncoded(2, bytes.subarray(data.start + 8, data.end));
      }
      inner = data.next;
    }
    at = item.next;
  }
}

/** An ID3v2.3 or 2.4 tag: the text frames (`T...`) and the comment frames (`COMM`, `USLT`). */
function readId3(bytes: Uint8Array, start: number, end: number, strings: Strings): void {
  if (end - start < 10 || latin1(bytes, start, 3) !== "ID3") return;
  const version = bytes[start + 3] ?? 0;
  if (version !== 3 && version !== 4) return;
  const size = ((bytes[start + 6] ?? 0) << 21) | ((bytes[start + 7] ?? 0) << 14) | ((bytes[start + 8] ?? 0) << 7) | (bytes[start + 9] ?? 0);
  const limit = Math.min(end, start + 10 + size);
  for (let at = start + 10; at + 10 <= limit && !strings.full; ) {
    const id = latin1(bytes, at, 4);
    if (!/^[A-Z0-9]{4}$/.test(id)) return;
    const raw = u32(bytes, at + 4) ?? 0;
    const length = version === 4 ? ((raw >>> 24) << 21) | (((raw >>> 16) & 0x7f) << 14) | (((raw >>> 8) & 0x7f) << 7) | (raw & 0x7f) : raw;
    const body = at + 10;
    if (length < 1 || body + length > limit) return;
    strings.boxes++;
    const encoding = bytes[body] ?? 0;
    if (id.startsWith("T")) strings.addEncoded(encoding, bytes.subarray(body + 1, body + length));
    else if ((id === "COMM" || id === "USLT") && length > 4) strings.addEncoded(encoding, bytes.subarray(body + 4, body + length));
    at = body + length;
  }
}

function walk(bytes: Uint8Array, start: number, end: number, depth: number, strings: Strings): void {
  if (depth > MAX_DEPTH) return;
  for (let at = start; at < end && !strings.full; ) {
    const found = boxAt(bytes, at, end);
    if (found === null) return;
    strings.boxes++;
    if (CONTAINERS.has(found.type)) walk(bytes, found.start, found.end, depth + 1, strings);
    else if (found.type === "meta") {
      // An ISO `meta` is a full box (4 bytes of version and flags first); a QuickTime one is not. The child's type says which.
      const known = new Set(["hdlr", "ilst", "keys", "ID32", "xml ", "iloc", "pitm"]);
      const skip = known.has(latin1(bytes, found.start + 8, Math.min(4, Math.max(0, found.end - found.start - 8)))) ? 4 : 0;
      walk(bytes, found.start + skip, found.end, depth + 1, strings);
    } else if (found.type === "ilst") readIlst(bytes, found.start, found.end, strings);
    else if (found.type === "ID32") readId3(bytes, found.start + 6, found.end, strings);
    else if (found.type === "hdlr" && found.end - found.start > 24) {
      const name = bytes.subarray(found.start + 24, Math.min(found.end, found.start + 24 + MAX_FIELD_BYTES));
      strings.addEncoded(3, name);
    }
    at = found.next;
  }
}

/** Every readable string the track's metadata carries, once each, unfiltered, at most 4096. Bytes that are no MP4 give none. */
export function trackTagStrings(bytes: Uint8Array): string[] {
  const strings = new Strings();
  for (let at = 0; at < bytes.length && !strings.full; ) {
    const top = boxAt(bytes, at, bytes.length);
    if (top === null) break;
    if (top.type === "moov") walk(bytes, top.start, top.end, 1, strings);
    at = top.next;
  }
  return strings.out;
}

/**
 * The verifier's forbidden strings for a track: its own tags and handler names plus `extra` (what the list called it: title,
 * artist), each through the one rule of `forbiddenCandidate` (at least 8 characters, not the engine's own text), at most 32.
 */
export function trackForbiddenStrings(bytes: Uint8Array, extra: readonly (string | null)[]): string[] {
  return buildForbiddenStrings([...extra.filter((text): text is string => text !== null), ...trackTagStrings(bytes)]);
}
