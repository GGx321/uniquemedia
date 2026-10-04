import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CommandMessage, PROTOCOL_VERSION, StickerBytes } from "../shared/engine";
import { createStickerAssets } from "../engine/videos/stickerAssets";
import { useNativeGlobals } from "../testing/nativeGlobals";
import { tempDirFor } from "../testing/tempDir";
import { handleStickerBytesCommand, isStickerBytesCommand, type StickerBytesCommand } from "./stickerBytesFlow";
useNativeGlobals();

// 3d.4 review round 1 (HIGH): the preview's ImageDecoder gets a built-in sticker's bytes from MAIN, never by reading the media
// scheme (which stays closed to script reads). Main answers from the built-in catalogue the render trusts (engine/videos/
// stickerAssets.ts): the id must be catalogued, the file's byte count and sha256 must be the catalogue's, the APNG is inspected
// again and must agree with the manifest. The window names an id; it is told the file and never a path.

const STICKERS = join(import.meta.dir, "..", "assets", "stickers");
const dir = tempDirFor({ beforeEach, afterEach }, "studio-sticker-bytes-");

function command(stickerId: string): StickerBytesCommand {
  const parsed = CommandMessage.safeParse({ v: PROTOCOL_VERSION, id: "msg-000001", kind: "command", type: "stickers.bytes", payload: { stickerId } });
  if (!parsed.success || !isStickerBytesCommand(parsed.data)) throw new Error("a stickers.bytes command");
  return parsed.data;
}

/** A copy of the shipped set in the test's folder: the catalogue and one sticker, so a test can damage it. */
async function copyOfSet(stickerId: string): Promise<string> {
  const catalog = JSON.parse(await readFile(join(STICKERS, "catalog.json"), "utf8")) as { stickers: { id: string; file: string }[] };
  const entry = catalog.stickers.find((s) => s.id === stickerId);
  if (entry === undefined) throw new Error(`${stickerId} is not in the shipped catalogue`);
  await copyFile(join(STICKERS, "catalog.json"), join(dir(), "catalog.json"));
  await copyFile(join(STICKERS, entry.file), join(dir(), entry.file));
  return join(dir(), entry.file);
}

describe("stickers.bytes in main", () => {
  test("answers the catalogued file itself, byte for byte (its sha256 is the catalogue's), as base64", async () => {
    const answer = await handleStickerBytesCommand(command("heart-pulse"), { stickers: createStickerAssets(STICKERS) });
    if (!answer.ok) throw new Error(answer.error.code);
    const result = StickerBytes.parse(answer.result);
    expect(result.stickerId).toBe("heart-pulse");
    const catalog = JSON.parse(await readFile(join(STICKERS, "catalog.json"), "utf8")) as { stickers: { id: string; sha256: string }[] };
    const sha = createHash("sha256").update(Buffer.from(result.apngBase64, "base64")).digest("hex");
    expect(sha).toBe(catalog.stickers.find((s) => s.id === "heart-pulse")?.sha256 ?? "");
    expect([answer.id, answer.type]).toEqual(["msg-000001", "stickers.bytes"]);
  });

  test("an id the catalogue does not hold is NOT_FOUND", async () => {
    const answer = await handleStickerBytesCommand(command("sticker-nowhere"), { stickers: createStickerAssets(STICKERS) });
    expect(answer.ok ? "ok" : answer.error.code).toBe("NOT_FOUND");
  });

  test("a file whose bytes are not the catalogue's (a changed byte: another sha256) is refused, and nothing of it is sent", async () => {
    const file = await copyOfSet("heart-pulse");
    const bytes = await readFile(file);
    bytes[bytes.length - 20] = (bytes[bytes.length - 20] ?? 0) ^ 0xff;
    await writeFile(file, bytes);
    const answer = await handleStickerBytesCommand(command("heart-pulse"), { stickers: createStickerAssets(dir()) });
    if (answer.ok) throw new Error("a tampered sticker was answered");
    expect(answer.error.code).toBe("INTERNAL");
    expect(answer.error.detail).toBe("the built-in sticker failed its check");
  });

  test("a catalogue that cannot be read refuses every sticker", async () => {
    await writeFile(join(dir(), "catalog.json"), "not json");
    const answer = await handleStickerBytesCommand(command("heart-pulse"), { stickers: createStickerAssets(dir()) });
    expect(answer.ok ? "ok" : answer.error.code).toBe("INTERNAL");
  });

  test("no answer names a path or a file on disk, whatever happened", async () => {
    await copyOfSet("heart-pulse");
    const answers = [
      await handleStickerBytesCommand(command("heart-pulse"), { stickers: createStickerAssets(STICKERS) }),
      await handleStickerBytesCommand(command("sticker-nowhere"), { stickers: createStickerAssets(STICKERS) }),
      await handleStickerBytesCommand(command("heart-pulse"), { stickers: createStickerAssets(join(dir(), "missing")) }),
    ];
    for (const answer of answers) {
      const text = JSON.stringify(answer.ok ? { ...answer, result: { ...answer.result, apngBase64: "" } } : answer);
      expect([text.includes(STICKERS), text.includes(dir()), text.includes(".apng"), text.includes("catalog.json")]).toEqual([false, false, false, false]);
    }
  });

  test("answers only stickers.bytes", () => {
    const other = CommandMessage.parse({ v: PROTOCOL_VERSION, id: "msg-000002", kind: "command", type: "videos.reveal", payload: { videoId: "video-00000001" } });
    expect(isStickerBytesCommand(other)).toBe(false);
  });
});
