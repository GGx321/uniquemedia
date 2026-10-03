import type { MediaKind, MediaPickKind } from "../../shared/engine";

// What a picked file IS, from its first bytes (3f.1). The boundary never trusts an extension: a `.jpg` that holds a script is
// refused here, and a `.dat` that holds a JPEG is a photo. This is a coarse FAMILY check, enough to turn the wrong thing away
// before it is copied. It promises nothing about the file being well formed: the per-kind importers (3f.2 to 3f.5) decode and
// validate it, and they do it on the STAGED copy, never on the user's path.

/** How much of a file's start is read to name its kind. */
export const SNIFF_HEAD_BYTES = 64 * 1024;

const ascii = (head: Uint8Array, at: number, length: number): string => String.fromCharCode(...head.subarray(at, at + length));
const u32be = (head: Uint8Array, at: number): number => ((head[at] ?? 0) * 0x1000000 + ((head[at + 1] ?? 0) << 16) + ((head[at + 2] ?? 0) << 8) + (head[at + 3] ?? 0)) >>> 0;

/** The brands of a HEIC or HEIF picture: the owner is told to save it as a JPEG. */
const HEIC_BRANDS: ReadonlySet<string> = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx", "hevm", "hevs", "mif1", "msf1"]);
/** The brands of an ISO box file that are still pictures (HEIC, HEIF, AVIF), never a video or a track. */
const IMAGE_BRANDS: ReadonlySet<string> = new Set([...HEIC_BRANDS, "avif", "avis"]);
/** The brands that mark an audio-only file. */
const AUDIO_BRANDS: ReadonlySet<string> = new Set(["M4A ", "M4B ", "M4P "]);

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function isPng(head: Uint8Array): boolean {
  return head.length >= 8 && PNG_SIGNATURE.every((b, i) => head[i] === b);
}

/** True when an `acTL` chunk comes before the first `IDAT` inside the head: a PNG that animates. */
function isApng(head: Uint8Array): boolean {
  let at = 8;
  while (at + 12 <= head.length) {
    const length = u32be(head, at);
    const type = ascii(head, at + 4, 4);
    if (type === "acTL") return true;
    if (type === "IDAT" || type === "IEND") return false;
    at += 12 + length;
  }
  return false;
}

function isMp3Frame(head: Uint8Array): boolean {
  const b1 = head[1] ?? 0;
  const b2 = head[2] ?? 0;
  if (head.length < 4 || head[0] !== 0xff || (b1 & 0xe0) !== 0xe0) return false;
  const version = (b1 >> 3) & 3;
  const layer = (b1 >> 1) & 3;
  return version !== 1 && layer !== 0 && b2 >> 4 !== 15 && ((b2 >> 2) & 3) !== 3;
}

function isAdts(head: Uint8Array): boolean {
  return head.length >= 4 && head[0] === 0xff && ((head[1] ?? 0) & 0xf6) === 0xf0 && ((head[2] ?? 0) >> 2) % 16 <= 12;
}

/**
 * The kinds `head` could be, most likely first; empty when it is none of them. An ISO box file (MP4, MOV, M4A) with no audio brand
 * is a video or a track: the head cannot say which, and the per-kind importer decides from the box tree.
 */
export function mediaKindsOf(head: Uint8Array): readonly MediaKind[] {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return ["photo"];
  if (isPng(head)) return ["photo", "sticker"];
  if (head.length >= 6 && ascii(head, 0, 4) === "GIF8" && (ascii(head, 4, 2) === "9a" || ascii(head, 4, 2) === "7a")) return ["sticker"];
  if (head.length >= 12 && ascii(head, 0, 4) === "RIFF") {
    const form = ascii(head, 8, 4);
    if (form === "WEBP") return ["photo"];
    if (form === "WAVE") return ["audio"];
    return [];
  }
  if (head.length >= 12 && ascii(head, 4, 4) === "ftyp" && u32be(head, 0) >= 12) {
    const brand = ascii(head, 8, 4);
    if (IMAGE_BRANDS.has(brand)) return [];
    return AUDIO_BRANDS.has(brand) ? ["audio"] : ["video", "audio"];
  }
  if (head.length >= 4 && (ascii(head, 0, 4) === "fLaC" || ascii(head, 0, 4) === "OggS")) return ["audio"];
  if (head.length >= 4 && ascii(head, 0, 3) === "ID3") return ["audio"];
  if (isMp3Frame(head) || isAdts(head)) return ["audio"];
  return [];
}

/**
 * The kind of file this pick takes it for, or null when the bytes are not what the pick asks for. A pick of one kind needs bytes
 * that could be that kind. `any` takes the bytes' own kind: a PNG with an animation chunk is a sticker, a still one a photo, and an
 * ISO box file without an audio brand a video.
 */
export function resolveMediaKind(pick: MediaPickKind, head: Uint8Array): MediaKind | null {
  const kinds = mediaKindsOf(head);
  if (pick !== "any") return kinds.includes(pick) ? pick : null;
  if (kinds.length === 0) return null;
  if (isPng(head)) return isApng(head) ? "sticker" : "photo";
  return kinds[0] ?? null;
}

/** True for a HEIC or HEIF picture (an ISO box file with a still-image brand that is not AVIF). */
export function isHeic(head: Uint8Array): boolean {
  return head.length >= 12 && ascii(head, 4, 4) === "ftyp" && u32be(head, 0) >= 12 && HEIC_BRANDS.has(ascii(head, 8, 4));
}

/** Why bytes that `resolveMediaKind` turned away are refused: HEIC gets its own reason when a photo (or anything) was asked for. */
export function unfitReason(pick: MediaPickKind, head: Uint8Array): "heic" | "format" {
  return isHeic(head) && (pick === "photo" || pick === "any") ? "heic" : "format";
}
