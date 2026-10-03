import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runFfmpegOk } from "../../render/ffmpeg.testkit";
import { box, concat, fullBox, u16, u32 } from "./m4aBuilder";

/**
 * Test-only (invariant 14, task 3c.5): an HE-AAC track that CARRIES the owner-unwanted text a real file may carry, in every
 * place a hostile or sloppy track hides it, so a render's output can be searched for it. The API's tracks have no tags at all
 * (3c.1's README), so the file is made here from one of them:
 *
 * - `title` and `artist` as iTunes-style tags in `moov/udta/meta/ilst` (UTF-8, which ffmpeg's muxer writes);
 * - a `handler_name` that is not the engine's own, on the audio stream (a real library's «Core Media Audio»);
 * - the same two strings again as ID3v2.3 frames (`TIT2`, `TPE1`) in an `ID32` box under `moov/meta`, encoded UTF-16 with a
 *   byte-order mark: the form in which a title survives a copy that only looks for ASCII.
 *
 * Production code never imports this file (it lives under `testing/`).
 */
export const TAG_TITLE = "Zażółć Gęślą Jaźń Song";
export const TAG_ARTIST = "Mädchen Ünïcode Artist";
export const TAG_HANDLER = "Core Media Audio Handler";

/** What a file must not contain after a render: each tag in UTF-8, UTF-16 little endian and UTF-16 big endian. */
export function tagForms(text: string): { readonly label: string; readonly bytes: Uint8Array }[] {
  const le = Buffer.from(text, "utf16le");
  return [
    { label: `${text} (utf-8)`, bytes: Uint8Array.from(Buffer.from(text, "utf8")) },
    { label: `${text} (utf-16le)`, bytes: Uint8Array.from(le) },
    { label: `${text} (utf-16be)`, bytes: Uint8Array.from(Buffer.from(le).swap16()) },
  ];
}

/** ID3v2.3 frame text: encoding byte 1 (UTF-16 with a BOM), then the BOM and the text, little endian, and a terminator. */
function id3Frame(id: string, text: string): Uint8Array {
  const body = concat(Uint8Array.of(1, 0xff, 0xfe), Uint8Array.from(Buffer.from(text, "utf16le")), Uint8Array.of(0, 0));
  return concat(Uint8Array.from(Buffer.from(id, "latin1")), u32(body.byteLength), Uint8Array.of(0, 0), body);
}

function id3Tag(frames: Uint8Array): Uint8Array {
  const size = frames.byteLength;
  const syncsafe = Uint8Array.of((size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f);
  return concat(Uint8Array.from(Buffer.from("ID3", "latin1")), Uint8Array.of(3, 0, 0), syncsafe, frames);
}

/** `moov/meta` with an `ID32` handler and box: the ISO base media way to carry an ID3v2 tag. */
function id32Meta(title: string, artist: string): Uint8Array {
  const hdlr = fullBox("hdlr", 0, concat(u32(0), Uint8Array.from(Buffer.from("ID32", "latin1")), new Uint8Array(12), Uint8Array.of(0)));
  // `ID32`: version and flags, a pad bit and a packed ISO 639-2 language («und»), then the ID3v2 data.
  const id32 = fullBox("ID32", 0, concat(u16(0x55c4), id3Tag(concat(id3Frame("TIT2", title), id3Frame("TPE1", artist)))));
  return fullBox("meta", 0, concat(hdlr, id32));
}

/**
 * Writes `<dir>/tagged.m4a`: `source` copied (no re-encode) with the tags above. Returns its path. The MP4 muxer writes `moov`
 * last when it is not asked for faststart, which the `ID32` box relies on: it is appended inside `moov` and the size grows, and
 * no sample offset moves because nothing sits after `moov`.
 */
export async function makeTaggedTrack(dir: string, source: string): Promise<string> {
  const plain = join(dir, "tagged-plain.m4a");
  await runFfmpegOk([
    "-hide_banner", "-y", "-nostdin", "-i", source, "-map", "0:a:0", "-c", "copy",
    "-metadata", `title=${TAG_TITLE}`, "-metadata", `artist=${TAG_ARTIST}`, "-metadata:s:a:0", `handler_name=${TAG_HANDLER}`,
    "-f", "mp4", plain,
  ]);
  const bytes = new Uint8Array(readFileSync(plain));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  let moovAt = -1;
  while (at + 8 <= bytes.length) {
    const size = view.getUint32(at);
    const type = Buffer.from(bytes.subarray(at + 4, at + 8)).toString("latin1");
    if (size < 8 || at + size > bytes.length) throw new Error("the tagged track has a box that does not fit");
    if (type === "moov") moovAt = at;
    at += size;
  }
  if (moovAt < 0 || moovAt + view.getUint32(moovAt) !== bytes.length) throw new Error("the moov box is not last in the tagged track");
  const extra = id32Meta(TAG_TITLE, TAG_ARTIST);
  const grown = concat(bytes, extra);
  new DataView(grown.buffer).setUint32(moovAt, view.getUint32(moovAt) + extra.byteLength);
  const out = join(dir, "tagged.m4a");
  writeFileSync(out, grown);
  return out;
}
