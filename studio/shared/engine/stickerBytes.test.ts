import { describe, expect, test } from "bun:test";
import { STICKER_LIMITS } from "../stickers/apng";
import { CommandMessage, MAIN_ONLY_COMMANDS, PROTOCOL_VERSION, parseEngineCommand } from "./index";
import { MEDIA_BYTE_CAPS } from "./media";
import { MAX_STICKER_BASE64, StickerBytes, StickerBytesPayload } from "./stickerBytes";

// 3d.4 review (HIGH): the preview decodes a built-in sticker's frames with ImageDecoder, which takes bytes. The media scheme must stay
// closed to script reads (no corsEnabled), so the window asks MAIN for them: `stickers.bytes {stickerId}`, main-only, answered from
// the verified built-in catalogue. The window names an id and nothing else; the answer is the file itself and never a path.

const command = (payload: unknown) => ({ v: PROTOCOL_VERSION, id: "msg-000001", kind: "command", type: "stickers.bytes", payload });

describe("stickers.bytes: what the window may send", () => {
  test("a built-in sticker's id", () => {
    expect(StickerBytesPayload.safeParse({ stickerId: "heart-pulse" }).success).toBe(true);
    expect(CommandMessage.safeParse(command({ stickerId: "heart-pulse" })).success).toBe(true);
  });

  test("never a path, a file name or anything else beside the id", () => {
    expect(StickerBytesPayload.safeParse({ stickerId: "heart-pulse", path: "/tmp/x.apng" }).success).toBe(false);
    expect(StickerBytesPayload.safeParse({ stickerId: "../photos/x" }).success).toBe(false);
    expect(StickerBytesPayload.safeParse({ stickerId: "heart-pulse.apng" }).success).toBe(false);
    expect(StickerBytesPayload.safeParse({}).success).toBe(false);
  });

  test("main answers it itself: it is main-only, and the engine's schema refuses it", () => {
    expect(MAIN_ONLY_COMMANDS).toContain("stickers.bytes");
    const parsed = CommandMessage.safeParse(command({ stickerId: "heart-pulse" }));
    if (!parsed.success) throw new Error("the command should parse");
    expect(parseEngineCommand(parsed.data).ok).toBe(false);
  });
});

describe("stickers.bytes: what the window is told", () => {
  test("the id and the file as base64 (every message of the contract survives JSON)", () => {
    expect(StickerBytes.safeParse({ stickerId: "heart-pulse", apngBase64: "iVBORw0KGgo=" }).success).toBe(true);
  });

  test("nothing else: no path, no name of a file on disk", () => {
    expect(StickerBytes.safeParse({ stickerId: "heart-pulse", apngBase64: "iVBORw0KGgo=", path: "/x" }).success).toBe(false);
  });

  test("only base64, and no more of it than the largest sticker the set may hold", () => {
    expect(StickerBytes.safeParse({ stickerId: "heart-pulse", apngBase64: "not base64!" }).success).toBe(false);
    expect(StickerBytes.safeParse({ stickerId: "heart-pulse", apngBase64: "abc" }).success).toBe(false);
    expect(StickerBytes.safeParse({ stickerId: "heart-pulse", apngBase64: "" }).success).toBe(false);
    expect(MAX_STICKER_BASE64).toBe(4 * Math.ceil(MEDIA_BYTE_CAPS.sticker / 3));
    expect(MEDIA_BYTE_CAPS.sticker).toBe(STICKER_LIMITS.maxBytes);
    expect(StickerBytes.safeParse({ stickerId: "heart-pulse", apngBase64: "A".repeat(MAX_STICKER_BASE64 + 4) }).success).toBe(false);
    expect(StickerBytes.safeParse({ stickerId: "heart-pulse", apngBase64: "A".repeat(MAX_STICKER_BASE64) }).success).toBe(true);
  });
});
