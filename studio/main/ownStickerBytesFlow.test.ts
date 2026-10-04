import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CommandMessage, MEDIA_BYTE_CAPS, OwnStickerBytes, PROTOCOL_VERSION } from "../shared/engine";
import { NODE_OPEN_OPS } from "../engine/library/openRegular";
import { flatApng, flatGif, type Rgba } from "../engine/media/stickerFixtures.testkit";
import { useNativeGlobals } from "../testing/nativeGlobals";
import { tempDirFor } from "../testing/tempDir";
import type { MediaFsOps } from "./media/diskSource";
import { NODE_MEDIA_FS } from "./media/diskSource";
import { handleOwnStickerBytesCommand, isOwnStickerBytesCommand, type OwnStickerBytesCommand } from "./ownStickerBytesFlow";
useNativeGlobals();

// `media.stickerBytes {mediaId}` (3f.5): an OWN sticker's bytes for the preview's ImageDecoder. The media scheme stays closed to script reads (never
// corsEnabled), so main hands the bytes over IPC, behind the same trusted-sender check as every request (requests.test.ts). The window names a media
// id; main resolves it through the media RECORD (`<library>/media/<id>.json`): the record must be this media's own and a STICKER's, the file it names
// must be the record's size (and capped BEFORE a byte is read), its bytes must hash to the record's sha256 (judged on the exact bytes sent), and be an
// APNG with the record's canvas and loop. Every refusal has a fixed text: the window is never told a path, a file name or which check failed.

const tmp = tempDirFor({ beforeEach, afterEach }, "studio-own-sticker-bytes-");
const library = (): string => join(tmp(), "library");
const mediaDir = (): string => join(library(), "media");
const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const RED: Rgba = [255, 0, 0, 255];
const GREEN: Rgba = [0, 255, 0, 255];
const APNG = flatApng([RED, GREEN], { width: 12, height: 8 });
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);

beforeEach(async () => {
  await mkdir(mediaDir(), { recursive: true });
});

function recordOf(id: string, bytes: Uint8Array, patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id,
    kind: "sticker",
    name: "party.gif",
    createdAt: "2026-10-04T10:00:00.000Z",
    bytes: bytes.length,
    sha256: sha(bytes),
    format: "apng",
    file: `${id}.png`,
    width: 12,
    height: 8,
    durationMs: null,
    sourceFps: null,
    hdrToSdr: false,
    loopFrames: 2,
    delayFrames: [1, 1],
    ...patch,
  };
}

/** A stored file and its record as the engine leaves them. */
async function store(id: string, bytes: Uint8Array = APNG, patch: Record<string, unknown> = {}, ext = "png"): Promise<void> {
  await writeFile(join(mediaDir(), `${id}.${ext}`), bytes);
  await writeFile(join(mediaDir(), `${id}.json`), JSON.stringify(recordOf(id, bytes, patch)));
}

function commandFor(mediaId: string): OwnStickerBytesCommand {
  const parsed = CommandMessage.safeParse({ v: PROTOCOL_VERSION, id: "msg-000001", kind: "command", type: "media.stickerBytes", payload: { mediaId } });
  if (!parsed.success || !isOwnStickerBytesCommand(parsed.data)) throw new Error("a media.stickerBytes command");
  return parsed.data;
}

const ask = (mediaId: string, extra: { fs?: MediaFsOps; root?: string } = {}) =>
  handleOwnStickerBytesCommand(commandFor(mediaId), { libraryRoot: () => extra.root ?? library(), ...(extra.fs === undefined ? {} : { fs: extra.fs }) });

const MEDIA = "media-0000001";
const NOT_FOUND = "no such own sticker";
const CHECK_FAILED = "the own sticker failed its check";

async function refusal(work: ReturnType<typeof ask>): Promise<{ code: string; detail: string }> {
  const answer = await work;
  if (answer.ok) throw new Error("an answer was given where a refusal was expected");
  return { code: answer.error.code, detail: answer.error.detail ?? "" };
}

describe("media.stickerBytes in main: what it answers", () => {
  test("the stored file itself, byte for byte (its sha256 is the record's), as base64", async () => {
    await store(MEDIA);
    const answer = await ask(MEDIA);
    if (!answer.ok) throw new Error(answer.error.code);
    const result = OwnStickerBytes.parse(answer.result);
    expect(result.mediaId).toBe(MEDIA);
    expect(Buffer.from(result.apngBase64, "base64").equals(Buffer.from(APNG))).toBe(true);
    expect([answer.id, answer.type]).toEqual(["msg-000001", "media.stickerBytes"]);
  });

  test("two stickers are answered each with its own bytes", async () => {
    const other = flatApng([GREEN, RED], { width: 12, height: 8 });
    await store("media-0000001", APNG);
    await store("media-0000002", other);
    const a = await ask("media-0000001");
    const b = await ask("media-0000002");
    if (!a.ok || !b.ok) throw new Error("refused");
    expect(Buffer.from(OwnStickerBytes.parse(a.result).apngBase64, "base64").equals(Buffer.from(APNG))).toBe(true);
    expect(Buffer.from(OwnStickerBytes.parse(b.result).apngBase64, "base64").equals(Buffer.from(other))).toBe(true);
  });
});

describe("media.stickerBytes in main: a media that is not an own sticker", () => {
  test("an id the library has no record for is NOT_FOUND, even when a stray file of that name is there", async () => {
    await writeFile(join(mediaDir(), `${MEDIA}.png`), APNG);
    expect(await refusal(ask(MEDIA))).toEqual({ code: "NOT_FOUND", detail: NOT_FOUND });
  });

  test("an own PHOTO (its record and file are there and well formed) is NOT_FOUND: the kind must be sticker", async () => {
    await writeFile(join(mediaDir(), `${MEDIA}.jpg`), JPEG);
    await writeFile(join(mediaDir(), `${MEDIA}.json`), JSON.stringify(recordOf(MEDIA, JPEG, { kind: "photo", format: "jpeg", file: `${MEDIA}.jpg`, loopFrames: null, delayFrames: null })));
    expect(await refusal(ask(MEDIA))).toEqual({ code: "NOT_FOUND", detail: NOT_FOUND });
  });

  test("an own VIDEO and an own TRACK are the same", async () => {
    await writeFile(join(mediaDir(), `${MEDIA}.mp4`), APNG);
    await writeFile(join(mediaDir(), `${MEDIA}.json`), JSON.stringify(recordOf(MEDIA, APNG, { kind: "video", format: "mp4", file: `${MEDIA}.mp4`, durationMs: 1000, sourceFps: 30, loopFrames: null, delayFrames: null })));
    expect(await refusal(ask(MEDIA))).toEqual({ code: "NOT_FOUND", detail: NOT_FOUND });
    await writeFile(join(mediaDir(), "media-0000002.m4a"), APNG);
    await writeFile(join(mediaDir(), "media-0000002.json"), JSON.stringify(recordOf("media-0000002", APNG, { kind: "audio", format: "m4a", file: "media-0000002.m4a", width: null, height: null, durationMs: 1000, loopFrames: null, delayFrames: null })));
    expect(await refusal(ask("media-0000002"))).toEqual({ code: "NOT_FOUND", detail: NOT_FOUND });
  });

  test("a record filed under another media id than its own is NOT_FOUND (the file it names is there and fine)", async () => {
    await writeFile(join(mediaDir(), "media-0000009.png"), APNG);
    await writeFile(join(mediaDir(), `${MEDIA}.json`), JSON.stringify(recordOf("media-0000009", APNG)));
    expect(await refusal(ask(MEDIA))).toEqual({ code: "NOT_FOUND", detail: NOT_FOUND });
  });

  test("a record that names another file than <its id>.<the extension of its format> is NOT_FOUND (that file is there and fine)", async () => {
    await writeFile(join(mediaDir(), "elsewhere.png"), APNG);
    await writeFile(join(mediaDir(), `${MEDIA}.json`), JSON.stringify(recordOf(MEDIA, APNG, { file: "elsewhere.png" })));
    expect(await refusal(ask(MEDIA))).toEqual({ code: "NOT_FOUND", detail: NOT_FOUND });
    await writeFile(join(library(), "secret.png"), APNG);
    await writeFile(join(mediaDir(), `${MEDIA}.json`), JSON.stringify(recordOf(MEDIA, APNG, { file: "../secret.png" })));
    expect(await refusal(ask(MEDIA))).toEqual({ code: "NOT_FOUND", detail: NOT_FOUND });
  });

  test("a record that cannot be read, from a newer Studio, or of the wrong shape is NOT_FOUND", async () => {
    await writeFile(join(mediaDir(), `${MEDIA}.png`), APNG);
    for (const text of ["{ not json", JSON.stringify({ ...recordOf(MEDIA, APNG), schemaVersion: 2 }), JSON.stringify({ id: MEDIA }), "[]", ""]) {
      await writeFile(join(mediaDir(), `${MEDIA}.json`), text);
      expect(await refusal(ask(MEDIA))).toEqual({ code: "NOT_FOUND", detail: NOT_FOUND });
    }
  });

  test("a library folder that is not there is NOT_FOUND", async () => {
    expect(await refusal(ask(MEDIA, { root: join(tmp(), "nowhere") }))).toEqual({ code: "NOT_FOUND", detail: NOT_FOUND });
  });

  test("a record that is a link is NOT_FOUND, even to a record that is fine", async () => {
    await store("media-0000002");
    await symlink(join(mediaDir(), "media-0000002.json"), join(mediaDir(), `${MEDIA}.json`));
    await writeFile(join(mediaDir(), `${MEDIA}.png`), APNG);
    expect(await refusal(ask(MEDIA))).toEqual({ code: "NOT_FOUND", detail: NOT_FOUND });
  });
});

describe("media.stickerBytes in main: a sticker whose file is not what its record says", () => {
  test("a file whose bytes changed (another valid APNG of the same size: only the hash tells) is refused, and none of it is sent", async () => {
    const swapped = flatApng([GREEN, RED], { width: 12, height: 8 });
    expect(swapped.length).toBe(APNG.length);
    await store(MEDIA, APNG);
    await writeFile(join(mediaDir(), `${MEDIA}.png`), swapped);
    expect(await refusal(ask(MEDIA))).toEqual({ code: "INTERNAL", detail: CHECK_FAILED });
  });

  test("a file that grew or shrank by a byte is refused", async () => {
    await store(MEDIA, APNG);
    await writeFile(join(mediaDir(), `${MEDIA}.png`), Uint8Array.from([...APNG, 0]));
    expect(await refusal(ask(MEDIA))).toEqual({ code: "INTERNAL", detail: CHECK_FAILED });
    await writeFile(join(mediaDir(), `${MEDIA}.png`), APNG.subarray(0, APNG.length - 1));
    expect(await refusal(ask(MEDIA))).toEqual({ code: "INTERNAL", detail: CHECK_FAILED });
  });

  test("a file that is gone (the record is still there) is refused", async () => {
    await writeFile(join(mediaDir(), `${MEDIA}.json`), JSON.stringify(recordOf(MEDIA, APNG)));
    expect(await refusal(ask(MEDIA))).toEqual({ code: "INTERNAL", detail: CHECK_FAILED });
  });

  test("a file that is a link, even to a file with the right bytes, is refused", async () => {
    await store("media-0000002", APNG);
    await writeFile(join(mediaDir(), `${MEDIA}.json`), JSON.stringify(recordOf(MEDIA, APNG)));
    await symlink(join(mediaDir(), "media-0000002.png"), join(mediaDir(), `${MEDIA}.png`));
    expect(await refusal(ask(MEDIA))).toEqual({ code: "INTERNAL", detail: CHECK_FAILED });
  });

  test("the size is capped BEFORE a byte is read: a record that claims more than a sticker may hold opens no file", async () => {
    await store(MEDIA, APNG, { bytes: MEDIA_BYTE_CAPS.sticker + 1 });
    const opened: string[] = [];
    const fs: MediaFsOps = { ...NODE_MEDIA_FS, open: { ...NODE_OPEN_OPS, open: async (path, flags) => (opened.push(path), NODE_OPEN_OPS.open(path, flags)) } };
    expect(await refusal(ask(MEDIA, { fs }))).toEqual({ code: "INTERNAL", detail: CHECK_FAILED });
    // The record was opened (to check it, and to read it); the sticker's own file never was.
    expect(opened.length).toBeGreaterThan(0);
    expect(opened.filter((path) => path.endsWith(".png"))).toEqual([]);
  });

  test("a file larger on disk than the cap is refused whatever its record says, and is not read whole", async () => {
    const huge = new Uint8Array(MEDIA_BYTE_CAPS.sticker + 10).fill(1);
    huge.set(APNG);
    await store(MEDIA, huge, { bytes: APNG.length, sha256: sha(APNG) });
    expect(await refusal(ask(MEDIA))).toEqual({ code: "INTERNAL", detail: CHECK_FAILED });
  });

  test("only an APNG is served: a record whose container is a GIF or a still PNG is refused (the file and the record agree)", async () => {
    const gif = flatGif([0, 1], [10, 10]);
    await store(MEDIA, gif, { format: "gif", file: `${MEDIA}.gif` }, "gif");
    expect(await refusal(ask(MEDIA))).toEqual({ code: "INTERNAL", detail: CHECK_FAILED });
  });

  test("a record whose container is `png` (a still image, which the importer never stores) is refused even when its bytes are an APNG that matches it", async () => {
    await store(MEDIA, APNG, { format: "png" });
    expect(await refusal(ask(MEDIA))).toEqual({ code: "INTERNAL", detail: CHECK_FAILED });
  });

  test("bytes that hash to the record's but are not an APNG the strict reader takes are refused", async () => {
    const junk = new Uint8Array(64).fill(7);
    await store(MEDIA, junk, { loopFrames: 2 });
    expect(await refusal(ask(MEDIA))).toEqual({ code: "INTERNAL", detail: CHECK_FAILED });
  });

  test("an APNG whose loop is not the record's is refused", async () => {
    await store(MEDIA, APNG, { loopFrames: 5, delayFrames: [2, 3] });
    expect(await refusal(ask(MEDIA))).toEqual({ code: "INTERNAL", detail: CHECK_FAILED });
  });

  test("an APNG whose canvas is not the record's is refused", async () => {
    await store(MEDIA, APNG, { width: 13 });
    expect(await refusal(ask(MEDIA))).toEqual({ code: "INTERNAL", detail: CHECK_FAILED });
    await store(MEDIA, APNG, { height: 9 });
    expect(await refusal(ask(MEDIA))).toEqual({ code: "INTERNAL", detail: CHECK_FAILED });
  });

  test("a sticker whose record has no loop (impossible by the contract, still not guessed at) is refused", async () => {
    await store(MEDIA, APNG, { loopFrames: null, delayFrames: null });
    expect(await refusal(ask(MEDIA))).toEqual({ code: "INTERNAL", detail: CHECK_FAILED });
  });
});

describe("media.stickerBytes in main: nothing of the disk leaks", () => {
  test("no answer or refusal names a path, a file name on disk or an extension, whatever happened", async () => {
    await store(MEDIA);
    await store("media-0000002", APNG, { sha256: "0".repeat(64) });
    await writeFile(join(mediaDir(), "media-0000003.json"), "{ not json");
    const answers = [await ask(MEDIA), await ask("media-0000002"), await ask("media-0000003"), await ask("media-0000404"), await ask(MEDIA, { root: join(tmp(), "nowhere") })];
    for (const answer of answers) {
      const text = JSON.stringify(answer.ok ? { ...answer, result: { ...answer.result, apngBase64: "" } } : answer);
      expect([text.includes(tmp()), text.includes(library()), text.includes(".png"), text.includes(".json"), text.includes("media/")]).toEqual([false, false, false, false, false]);
    }
  });

  test("a failure of the disk itself is the same fixed text, never the system's message", async () => {
    await store(MEDIA);
    const fs: MediaFsOps = {
      ...NODE_MEDIA_FS,
      realpath: async () => {
        throw new Error(`EACCES: permission denied, realpath '${library()}'`);
      },
    };
    const answer = await ask(MEDIA, { fs });
    expect(JSON.stringify(answer)).not.toContain(library());
  });
});
