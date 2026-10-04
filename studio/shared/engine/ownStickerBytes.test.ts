import { describe, expect, test } from "bun:test";
import { CommandMessage, MAIN_ONLY_COMMANDS, PROTOCOL_VERSION, parseEngineCommand } from "./index";
import { MAX_STICKER_BASE64, OwnStickerBytes, OwnStickerBytesPayload } from "./stickerBytes";

// 3f.5: the preview's way to an OWN sticker's bytes. `stickers.bytes` serves the built-in catalogue only (a built-in id is a catalogue key, and the
// route that answers it must never reach a user file), so an own sticker has a command of its own: `media.stickerBytes {mediaId}`, main-only, keyed
// by the media id and nothing else, answered from the record main resolves the id through. The window never names a path, and is told the file.

const command = (payload: unknown) => ({ v: PROTOCOL_VERSION, id: "msg-000001", kind: "command", type: "media.stickerBytes", payload });

describe("media.stickerBytes: what the window may send", () => {
  test("an own media's id", () => {
    expect(OwnStickerBytesPayload.safeParse({ mediaId: "media-0000001" }).success).toBe(true);
    expect(CommandMessage.safeParse(command({ mediaId: "media-0000001" })).success).toBe(true);
  });

  test("never a path, a file name or anything else beside the id", () => {
    expect(OwnStickerBytesPayload.safeParse({ mediaId: "media-0000001", path: "/tmp/x.png" }).success).toBe(false);
    expect(OwnStickerBytesPayload.safeParse({ mediaId: "media-0000001", kind: "photo" }).success).toBe(false);
    expect(OwnStickerBytesPayload.safeParse({ mediaId: "../photos/x" }).success).toBe(false);
    expect(OwnStickerBytesPayload.safeParse({ mediaId: "media-0000001.png" }).success).toBe(false);
    expect(OwnStickerBytesPayload.safeParse({ stickerId: "heart-pulse" }).success).toBe(false);
    expect(OwnStickerBytesPayload.safeParse({}).success).toBe(false);
  });

  test("main answers it itself: it is main-only, and the engine's schema refuses it", () => {
    expect(MAIN_ONLY_COMMANDS).toContain("media.stickerBytes");
    const parsed = CommandMessage.safeParse(command({ mediaId: "media-0000001" }));
    if (!parsed.success) throw new Error("the command should parse");
    expect(parseEngineCommand(parsed.data).ok).toBe(false);
  });

  test("the built-in command still takes a catalogue id and no media id", () => {
    const builtin = { v: PROTOCOL_VERSION, id: "msg-000001", kind: "command", type: "stickers.bytes", payload: { mediaId: "media-0000001" } };
    expect(CommandMessage.safeParse(builtin).success).toBe(false);
  });
});

describe("media.stickerBytes: what the window is told", () => {
  test("the id and the file as base64 (every message of the contract survives JSON)", () => {
    expect(OwnStickerBytes.safeParse({ mediaId: "media-0000001", apngBase64: "iVBORw0KGgo=" }).success).toBe(true);
  });

  test("nothing else: no path, no name of a file on disk", () => {
    expect(OwnStickerBytes.safeParse({ mediaId: "media-0000001", apngBase64: "iVBORw0KGgo=", path: "/x" }).success).toBe(false);
  });

  test("only base64, and no more of it than the largest sticker may hold", () => {
    expect(OwnStickerBytes.safeParse({ mediaId: "media-0000001", apngBase64: "not base64!" }).success).toBe(false);
    expect(OwnStickerBytes.safeParse({ mediaId: "media-0000001", apngBase64: "" }).success).toBe(false);
    expect(OwnStickerBytes.safeParse({ mediaId: "media-0000001", apngBase64: "A".repeat(MAX_STICKER_BASE64 + 4) }).success).toBe(false);
    expect(OwnStickerBytes.safeParse({ mediaId: "media-0000001", apngBase64: "A".repeat(MAX_STICKER_BASE64) }).success).toBe(true);
  });
});
