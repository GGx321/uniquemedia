// The verifier's `forbiddenStrings` (Stage 3 plan, invariant 14; task 3a.8b):
// text that must not appear anywhere in a finished video because it came from
// the SOURCE PHOTOS (an EXIF Artist or Copyright, a PNG Author). The library's
// sidecar keeps none of it (it records the model, prompt and QA verdicts, not
// the photo's embedded text), so it is read from the photo's own bytes.
//
// The list has to be safe to hand to the verifier: it must never hold text the
// ENGINE writes into every video (or every render would be refused, the same
// way each time, with no way out), and never a value so short or so plain that
// it could occur in coded video by chance.

/**
 * A value shorter than this (in characters) could match the video data by chance; the verifier itself refuses under 6 bytes.
 * The same minimum holds for a music track's tags (3c.5): the search is a plain byte search over the whole file, which is mostly
 * coded video and audio, and a short title like «Aurora» would occur in it by chance and refuse a clean render with no way out.
 * The cost is that a tag under 8 characters is not searched for; the render still drops every tag (`-map_metadata -1`, and the
 * stream's own) and the verifier's allowlist of boxes and values is what catches a short one.
 */
export const FORBIDDEN_STRING_MIN_LENGTH = 8;
const MAX_STRING_CHARS = 256;
const MAX_STRINGS = 32;
/** Fewer distinct characters than this is padding or a flat pattern, not a name. */
const MIN_DISTINCT_CHARS = 4;

/**
 * Text the engine's own output carries (invariant 14's allowlist and x264's SEI):
 * the two handler names, the muxer and encoder tags, and the SEI's lines. A source
 * value that contains one, or that is a piece of one, would match a clean video.
 */
export const ENGINE_SIGNATURE_STRINGS: readonly string[] = [
  "VideoHandler",
  "SoundHandler",
  "Lavf",
  "Lavc",
  "libx264",
  "x264",
  "x264 - core",
  "options: cabac",
  "videolan",
  "Copyleft",
  "H.264/MPEG-4 AVC codec",
  "http://www.videolan.org/x264.html",
];

const SIGNATURES_LOWER = ENGINE_SIGNATURE_STRINGS.map((s) => s.toLowerCase());
// eslint-disable-next-line no-control-regex -- deliberate: C0 and C1 control characters
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;

function isEngineText(lower: string): boolean {
  return SIGNATURES_LOWER.some((signature) => lower.includes(signature) || signature.includes(lower));
}

/**
 * The one rule for a candidate: trimmed, at least 8 characters, at least 4 distinct characters, no control
 * character, none of the engine's own text (in any letter case, whole or in part), cut to 256 characters.
 * Null when it is not a usable forbidden string. Applied where the text is READ, so a hostile photo cannot make
 * the reader build millions of strings only for the builder to throw them away.
 */
export function forbiddenCandidate(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length < FORBIDDEN_STRING_MIN_LENGTH || CONTROL_CHARACTER.test(trimmed)) return null;
  const chars = Array.from(trimmed);
  if (chars.length < FORBIDDEN_STRING_MIN_LENGTH || new Set(chars).size < MIN_DISTINCT_CHARS) return null;
  if (isEngineText(trimmed.toLowerCase())) return null;
  return chars.length > MAX_STRING_CHARS ? chars.slice(0, MAX_STRING_CHARS).join("") : trimmed;
}

/**
 * Turns candidate texts into the list for `verifyRenderedMp4`: each through `forbiddenCandidate`,
 * deduplicated in first-seen order, and at most `max` (32 by default: the photos' quota; a music track has one of its own).
 */
export function buildForbiddenStrings(candidates: Iterable<string>, max: number = MAX_STRINGS): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const text = forbiddenCandidate(candidate);
    if (text === null || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length === max) break;
  }
  return out;
}

/**
 * The photos' strings and a music track's, each list built under its OWN quota, joined without a string twice: a render with 32
 * photo strings still carries every one of the track's (3c.5). Both lists already passed `forbiddenCandidate`.
 */
export function combineForbiddenStrings(photos: readonly string[], track: readonly string[]): string[] {
  return [...new Set([...photos, ...track])];
}

// ---------- reading a photo's own text ----------

const u16 = (b: Uint8Array, at: number, le: boolean): number | undefined => (at >= 0 && at + 2 <= b.length ? new DataView(b.buffer, b.byteOffset, b.byteLength).getUint16(at, le) : undefined);
const u32 = (b: Uint8Array, at: number, le: boolean): number | undefined => (at >= 0 && at + 4 <= b.length ? new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(at, le) : undefined);
const ascii = (b: Uint8Array, at: number, length: number): string => (at >= 0 && at + length <= b.length ? Buffer.from(b.buffer, b.byteOffset + at, length).toString("latin1") : "");

/** At most this many usable candidates are taken from all the photos of one render, and this many text fields read. */
const MAX_CANDIDATES = 4096;
const MAX_FIELDS = 4096;

/** Collects usable candidates, each once, and says when it has had enough. Nothing reads on after `full`. */
class Collector {
  readonly out: string[] = [];
  readonly #seen = new Set<string>();
  readonly #fields = new Set<string>();
  #fieldReads = 0;

  get full(): boolean {
    return this.out.length >= MAX_CANDIDATES || this.#fieldReads >= MAX_FIELDS;
  }

  /** A field (`source` names the segment or chunk, `at`/`length` the place in it) is read once, however many entries point at it. */
  firstRead(source: number, at: number, length: number): boolean {
    const key = `${source}:${at}:${length}`;
    if (this.#fields.has(key)) return false;
    this.#fields.add(key);
    this.#fieldReads++;
    return true;
  }

  /** A text field's bytes as the strings a video could carry them as: UTF-8 and Latin-1 (the same for ASCII), split at NUL. */
  addField(field: Uint8Array): void {
    for (const encoding of ["utf8", "latin1"] as const) {
      const text = Buffer.from(field.buffer, field.byteOffset, field.byteLength).toString(encoding);
      for (const piece of text.split("\u0000")) {
        if (this.full) return;
        if (piece.includes("\uFFFD")) continue;
        const candidate = forbiddenCandidate(piece);
        if (candidate === null || this.#seen.has(candidate)) continue;
        this.#seen.add(candidate);
        this.out.push(candidate);
      }
    }
  }
}

/** EXIF IFD0 tags whose text a photographer or an editor typed: ImageDescription, Software, Artist, Copyright. */
const EXIF_TEXT_TAGS = new Set([0x010e, 0x0131, 0x013b, 0x8298]);
const MAX_IFD_ENTRIES = 256;
const MAX_FIELD_BYTES = 4096;
const MAX_JPEG_SEGMENTS = 64;
const MAX_PNG_CHUNKS = 1000;

function readExif(tiff: Uint8Array, source: number, collector: Collector): void {
  const order = ascii(tiff, 0, 2);
  if (order !== "II" && order !== "MM") return;
  const le = order === "II";
  if (u16(tiff, 2, le) !== 42) return;
  const ifd = u32(tiff, 4, le);
  const count = ifd === undefined ? undefined : u16(tiff, ifd, le);
  if (ifd === undefined || count === undefined) return;
  for (let i = 0; i < Math.min(count, MAX_IFD_ENTRIES) && !collector.full; i++) {
    const entry = ifd + 2 + i * 12;
    const tag = u16(tiff, entry, le);
    const type = u16(tiff, entry + 2, le);
    const length = u32(tiff, entry + 4, le);
    if (tag === undefined || type !== 2 || length === undefined || !EXIF_TEXT_TAGS.has(tag) || length > MAX_FIELD_BYTES) continue;
    const at = length <= 4 ? entry + 8 : u32(tiff, entry + 8, le);
    if (at === undefined || at + length > tiff.length || !collector.firstRead(source, at, length)) continue;
    collector.addField(tiff.subarray(at, at + length));
  }
}

function readJpeg(bytes: Uint8Array, collector: Collector): void {
  let at = 2;
  for (let segments = 0; segments < MAX_JPEG_SEGMENTS && bytes[at] === 0xff && !collector.full; segments++) {
    const marker = bytes[at + 1];
    if (marker === undefined || marker === 0xda || marker === 0xd9) break;
    const length = u16(bytes, at + 2, false);
    if (length === undefined || length < 2) break;
    if (marker === 0xe1 && ascii(bytes, at + 4, 6) === "Exif\u0000\u0000") readExif(bytes.subarray(at + 10, at + 2 + length), segments, collector);
    at += 2 + length;
  }
}

const PNG_TEXT_KEYWORDS = new Set(["Author", "Copyright", "Description", "Comment"]);

function readPng(bytes: Uint8Array, collector: Collector): void {
  let at = 8;
  for (let chunks = 0; chunks < MAX_PNG_CHUNKS && !collector.full; chunks++) {
    const length = u32(bytes, at, false);
    if (length === undefined || at + 12 + length > bytes.length) break;
    const type = ascii(bytes, at + 4, 4);
    if (type === "IEND") break;
    if ((type === "tEXt" || type === "iTXt") && length <= MAX_FIELD_BYTES) {
      const body = bytes.subarray(at + 8, at + 8 + length);
      const nul = body.indexOf(0);
      const keyword = nul < 0 ? "" : ascii(body, 0, nul);
      if (PNG_TEXT_KEYWORDS.has(keyword)) {
        if (type === "tEXt") collector.addField(body.subarray(nul + 1));
        // iTXt: flag, method, language tag, translated keyword, then the text; only an uncompressed one is read.
        else if (body[nul + 1] === 0) {
          const langEnd = body.indexOf(0, nul + 3);
          const translatedEnd = langEnd < 0 ? -1 : body.indexOf(0, langEnd + 1);
          if (translatedEnd >= 0) collector.addField(body.subarray(translatedEnd + 1));
        }
      }
    }
    at += 12 + length;
  }
}

function readPhoto(bytes: Uint8Array, collector: Collector): void {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) readJpeg(bytes, collector);
  else if (ascii(bytes, 0, 8) === "\u0089PNG\r\n\u001a\n") readPng(bytes, collector);
}

/**
 * The USABLE text a photo's own bytes carry that a video must not repeat (each candidate passed `forbiddenCandidate`,
 * each once): a JPEG's EXIF (ImageDescription, Software, Artist, Copyright) or a PNG's text chunks (Author, Copyright,
 * Description, Comment). Every read is bounds-checked, so bytes of no known kind, or a damaged header, give an empty
 * list rather than an error. It is BOUNDED against a hostile photo: a field many entries point at is read once, and
 * at most 4096 fields and 4096 candidates are taken. XMP text is not read here: the verifier refuses any XMP packet.
 */
export function photoMetadataStrings(bytes: Uint8Array): string[] {
  const collector = new Collector();
  readPhoto(bytes, collector);
  return collector.out;
}

/**
 * The verifier's `forbiddenStrings` for a render: the text of every source photo,
 * filtered by `buildForbiddenStrings`. `readPhoto` is the library's verified read
 * (`Library.readPhotoVerified`); a photo that cannot be read rejects, because its
 * text would otherwise go unchecked.
 */
export async function collectForbiddenStrings(readPhoto_: (photoId: string) => Promise<Uint8Array>, photoIds: readonly string[], signal?: AbortSignal): Promise<string[]> {
  const collector = new Collector();
  for (const photoId of photoIds) {
    // A cancel or the staging bound stops the reading between two photos: the abandoned work reads no more.
    signal?.throwIfAborted();
    if (collector.full) break;
    readPhoto(await readPhoto_(photoId), collector);
  }
  return buildForbiddenStrings(collector.out);
}
