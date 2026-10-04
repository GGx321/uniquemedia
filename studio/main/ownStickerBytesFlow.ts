import { createHash } from "node:crypto";
import { errorResponseFor, MEDIA_BYTE_CAPS, PROTOCOL_VERSION, type CommandMessage, type ResponseMessage } from "../shared/engine";
import { servedMediaRecord } from "../engine/library/mediaRecords";
import { inspectApng } from "../shared/stickers/apng";
import { NODE_MEDIA_FS, openDiskSource, type MediaFsOps } from "./media/diskSource";
import { KINDS } from "./media/kinds";

// `media.stickerBytes {mediaId}` (3f.5): an OWN sticker's bytes for the editor preview's ImageDecoder.
//
// THE SHAPE. A command of its own, not a kind-tagged payload on `stickers.bytes`. The built-in command's id is a key into the shipped catalogue,
// and the route behind it (`stickerBytesFlow.ts`, `media/stickers.ts`) must never be able to reach a user file; the 3d.4 review confirmed it is
// closed to them. Keeping the two doors apart means neither can be widened to the other's files by a payload field.
//
// THE BOUNDARY. The media scheme stays closed to script reads (it is never corsEnabled, the CSP is unchanged), so the window asks MAIN, behind the
// same trusted-sender check as every request (requests.ts), and names a media id and nothing else. Main resolves it through the media RECORD, as
// the `studio-media://media/<id>` route does (3f.2): `<library>/media/<id>.json` is read (bounded, no link followed) and judged by the engine's own
// record schema; it must be this media's own and a STICKER's. Then, before anything of the file is read:
//   - the container the record names must be an APNG (the importer stores nothing else), and the size it names is capped at the sticker cap;
//   - the file is opened as every served file is (`openDiskSource`: no link, a plain file inside the library, within that cap, starting like a PNG)
//     and must be exactly the size the record was written for.
// Then the file is read once, whole, and what is SENT is what is judged: its sha256 must be the record's, and it must be an APNG the strict reader takes
// whose canvas and loop are the record's (the preview loops at the STORED period, 3d.4). A file swapped, truncated, grown or replaced by a link
// since the import is refused, and none of it is sent.
//
// THE ANSWERS. Fixed texts only: NOT_FOUND "no such own sticker" for an id that has no usable record or is not a sticker (the same for all of those,
// so the window learns nothing about other kinds), INTERNAL "the own sticker failed its check" for every other failure. No path, file name or
// extension, and no system message, is ever in an answer.

export type OwnStickerBytesCommand = Extract<CommandMessage, { type: "media.stickerBytes" }>;

export function isOwnStickerBytesCommand(command: CommandMessage): command is OwnStickerBytesCommand {
  return command.type === "media.stickerBytes";
}

export interface OwnStickerBytesDeps {
  /** The library root from the current settings. */
  libraryRoot(): string;
  fs?: MediaFsOps;
}

/** A record is a few KiB of JSON. */
const MAX_RECORD_BYTES = 1024 * 1024;

const NOT_FOUND = "no such own sticker";
const CHECK_FAILED = "the own sticker failed its check";

export async function handleOwnStickerBytesCommand(command: OwnStickerBytesCommand, deps: OwnStickerBytesDeps): Promise<ResponseMessage> {
  const { mediaId } = command.payload;
  const fs = deps.fs ?? NODE_MEDIA_FS;
  const notFound = (): ResponseMessage => errorResponseFor(command, { code: "NOT_FOUND", detail: NOT_FOUND });
  const failed = (): ResponseMessage => errorResponseFor(command, { code: "INTERNAL", detail: CHECK_FAILED });
  try {
    // 1. The record, through the same door as every served file.
    const root = deps.libraryRoot();
    const recordSource = await openDiskSource({ root, segments: ["media", `${mediaId}.json`], maxBytes: MAX_RECORD_BYTES, sniff: (header) => header[0] === 0x7b }, fs);
    if (recordSource === null) return notFound();
    let json: unknown;
    try {
      json = JSON.parse(Buffer.from(await recordSource.read(0, recordSource.size)).toString("utf8"));
    } catch {
      return notFound();
    }
    const record = servedMediaRecord(json);
    if (record === null || record.id !== mediaId || record.kind !== "sticker") return notFound();

    // 2. What the record says, before a byte of the file is read.
    if (record.format !== "apng" || record.bytes > MEDIA_BYTE_CAPS.sticker || record.loopFrames === null || record.width === null || record.height === null) return failed();
    const source = await openDiskSource({ root, segments: ["media", record.file], maxBytes: Math.min(MEDIA_BYTE_CAPS.sticker, record.bytes), sniff: KINDS.apng.sniff }, fs);
    if (source === null || source.size !== record.bytes) return failed();

    // 3. The exact bytes that would be sent are the ones judged.
    const bytes = await source.read(0, source.size);
    if (bytes.length !== record.bytes || createHash("sha256").update(bytes).digest("hex") !== record.sha256) return failed();
    const inspected = inspectApng(bytes);
    if (!inspected.ok) return failed();
    const { info } = inspected;
    if (info.loopFrames !== record.loopFrames || info.width !== record.width || info.height !== record.height) return failed();

    return { v: PROTOCOL_VERSION, id: command.id, kind: "response", type: command.type, ok: true, result: { mediaId, apngBase64: Buffer.from(bytes).toString("base64") } };
  } catch {
    // A disk that failed: only that something did, never its message (it names a path).
    return failed();
  }
}
