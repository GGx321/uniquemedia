import { errorResponseFor, PROTOCOL_VERSION, type CommandMessage, type ResponseMessage } from "../shared/engine";
import { StickerAssetError, type StickerAssets } from "../engine/videos/stickerAssets";

// `stickers.bytes {stickerId}` (3d.4, review round 1): a built-in sticker's bytes for the preview's ImageDecoder. The media scheme
// stays closed to script reads (it is never CORS-enabled: with it any page in the session could read any route), so main hands
// the bytes over IPC itself, behind the same trusted-sender check as every request (requests.ts). They come from the catalogue
// the render trusts (engine/videos/stickerAssets.ts): the id must be catalogued and the file name is the catalogue's, the file is
// no link and its byte count and sha256 are the catalogue's, the APNG is inspected again and agrees with the manifest, and the
// verified copy is kept. The window named an id; it is told the file, and never a path, a file name or why a check failed.

export type StickerBytesCommand = Extract<CommandMessage, { type: "stickers.bytes" }>;

export function isStickerBytesCommand(command: CommandMessage): command is StickerBytesCommand {
  return command.type === "stickers.bytes";
}

export interface StickerBytesDeps {
  /** The verified built-in set (`createStickerAssets` over the shipped sticker folder). */
  readonly stickers: StickerAssets;
}

export async function handleStickerBytesCommand(command: StickerBytesCommand, deps: StickerBytesDeps): Promise<ResponseMessage> {
  const { stickerId } = command.payload;
  let bytes: Uint8Array;
  try {
    bytes = (await deps.stickers.read(stickerId)).bytes;
  } catch (error) {
    if (error instanceof StickerAssetError && error.code === "not-catalogued") return errorResponseFor(command, { code: "NOT_FOUND", detail: "no such built-in sticker" });
    // Unreadable, tampered, invalid or disagreeing with the manifest: refused alike, and the error's own message (it names the
    // sticker's file) stays here.
    return errorResponseFor(command, { code: "INTERNAL", detail: "the built-in sticker failed its check" });
  }
  return { v: PROTOCOL_VERSION, id: command.id, kind: "response", type: command.type, ok: true, result: { stickerId, apngBase64: Buffer.from(bytes).toString("base64") } };
}
