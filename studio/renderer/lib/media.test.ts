import { describe, expect, test } from "bun:test";
import { STICKER_MANIFEST } from "../../shared/stickers/manifest";
import type { EngineClient } from "../engine/client";
import { mockEngineClient } from "../engine/mockEngine";
import { stickerUrl } from "./media";

// 3d.3b: a built-in sticker's picture is asked for by id, never by a path (invariant 12): main's `studio-media://sticker/<id>`
// route serves the catalogue, the dev mock a stand-in of its own.

describe("stickerUrl", () => {
  const real = (kind: EngineClient["kind"]): Pick<EngineClient, "kind" | "stickerUrl"> => ({ kind });

  test("the real client asks main's media route by the sticker's id", () => {
    expect(stickerUrl(real("window"), "heart-pulse")).toBe("studio-media://sticker/heart-pulse");
  });

  test("an id that breaks the contract is never put into an address", () => {
    expect(stickerUrl(real("window"), "../photo")).toBe(null);
    expect(stickerUrl(real("window"), "HEART")).toBe(null);
  });

  test("the mock draws a stand-in for every sticker of the built-in set, and none for one it lacks", () => {
    const client = mockEngineClient();
    for (const sticker of STICKER_MANIFEST) expect(stickerUrl(client, sticker.id)?.startsWith("data:image/svg+xml,")).toBe(true);
    expect(stickerUrl(client, "sticker-nowhere")).toBe(null);
  });
});
