import { z } from "zod";
import { MEDIA_BYTE_CAPS } from "./media";
import { Id } from "./primitives";

// Stage 3 (3d.4, review round 1): `stickers.bytes`, the preview's way to a built-in sticker's bytes. The preview decodes a sticker's
// frames with WebCodecs `ImageDecoder`, which takes bytes, and the media scheme must stay closed to script reads (it is never
// CORS-enabled: with it, any page in the session could read any route). So the window asks MAIN, which answers from the verified
// built-in catalogue. The window names an id and nothing else; the answer is the file and never a path. The file travels as base64
// because every message of the contract survives JSON (messages.test.ts); the window turns it back into bytes.

/** Base64 of the largest sticker file the set may hold (`MEDIA_BYTE_CAPS.sticker`, the APNG validator's cap). */
export const MAX_STICKER_BASE64 = 4 * Math.ceil(MEDIA_BYTE_CAPS.sticker / 3);

/** The base64 alphabet with its padding at the end only (one plain character class: linear on a 7 MB string). */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export const StickerBytesPayload = z.strictObject({ stickerId: Id });
export type StickerBytesPayload = z.infer<typeof StickerBytesPayload>;

export const StickerBytes = z.strictObject({
  stickerId: Id,
  /** The verified APNG, byte for byte, as base64 in whole padded quanta (what `Buffer.toString("base64")` writes). */
  apngBase64: z
    .string()
    .min(4)
    .max(MAX_STICKER_BASE64)
    .refine((s) => s.length % 4 === 0 && BASE64.test(s), "not base64"),
});
export type StickerBytes = z.infer<typeof StickerBytes>;

// 3f.5: the same for an OWN sticker, as a command of its own (`media.stickerBytes`) and not a kind-tagged payload on `stickers.bytes`. The built-in
// command's id is a key into the shipped catalogue and the route behind it must never reach a user file; an own sticker's id is a media id main
// resolves through the media RECORD. Two commands keep the two doors apart (each with its own schema, handler and refusals), so neither can be
// widened to the other's files by a payload field. Main-only; the window names a media id and nothing else, and is told the verified file.

export const OwnStickerBytesPayload = z.strictObject({ mediaId: Id });
export type OwnStickerBytesPayload = z.infer<typeof OwnStickerBytesPayload>;

export const OwnStickerBytes = z.strictObject({
  mediaId: Id,
  /** The stored APNG, byte for byte, as base64 in whole padded quanta. */
  apngBase64: z
    .string()
    .min(4)
    .max(MAX_STICKER_BASE64)
    .refine((s) => s.length % 4 === 0 && BASE64.test(s), "not base64"),
});
export type OwnStickerBytes = z.infer<typeof OwnStickerBytes>;
