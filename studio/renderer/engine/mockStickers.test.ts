import { describe, expect, test } from "bun:test";
import { inspectApng } from "../../shared/stickers/apng";
import { STICKER_MANIFEST } from "../../shared/stickers/manifest";
import { dataUrlBytes } from "../lib/dataUrl";
import { mockStickerUrl } from "./mockStickers";

// 3d.4: the dev mock's stand-in for a built-in sticker is an ANIMATED PNG of the manifest's own loop (one frame per 1/30 s, as the
// real set), so the dev build's preview decodes and loops it the way the real app does (ImageDecoder, the stored period). Not the
// sticker: a sparkle in the colour of its category. The real pictures are the generated set (3b.5), served by main.

describe("the mock's sticker stand-ins", () => {
  test("each built-in sticker's stand-in is an APNG the shared validator accepts, on the manifest's loop at 30 fps", () => {
    for (const sticker of STICKER_MANIFEST) {
      const url = mockStickerUrl(sticker.id);
      expect(url?.startsWith("data:image/png;base64,")).toBe(true);
      const decoded = dataUrlBytes(url ?? "");
      if (decoded === null) throw new Error(`${sticker.id}: not a data URL`);
      const inspected = inspectApng(decoded.bytes);
      if (!inspected.ok) throw new Error(`${sticker.id}: ${inspected.code} ${inspected.detail}`);
      expect([inspected.info.frameCount, inspected.info.loopFrames, inspected.info.loopCount]).toEqual([sticker.loopFrames, sticker.loopFrames, 0]);
      expect(inspected.info.frames.every((f) => f.delayFrames === 1)).toBe(true);
      expect(inspected.info.width).toBe(inspected.info.height);
    }
  });

  test("a sticker the set does not have has none", () => {
    expect(mockStickerUrl("sticker-nowhere")).toBe(null);
  });

  test("the same stand-in every time (made once per sticker)", () => {
    expect(mockStickerUrl("heart-pulse")).toBe(mockStickerUrl("heart-pulse"));
  });
});
