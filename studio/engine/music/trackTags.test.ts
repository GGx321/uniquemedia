import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { musicTracks } from "./fixtures";
import { box, concat, fullBox, u16, u32 } from "./testing/m4aBuilder";
import { makeTaggedTrack, TAG_ARTIST, TAG_HANDLER, TAG_TITLE } from "./testing/taggedTrack";
import { trackForbiddenStrings, trackTagStrings } from "./trackTags";
useNativeGlobals();

// The text a stored track's own bytes carry (iTunes-style tags, an ID3v2 tag in an ID32 box, a handler name): the render hands
// it to the verifier as `forbiddenStrings` (invariant 14), so none of it may appear in the finished video.

let dir = "";
afterEach(async () => {
  if (dir !== "") await rm(dir, { recursive: true, force: true });
  dir = "";
});

const ilstItem = (type: string, flags: number, payload: Uint8Array): Uint8Array => box(type, box("data", concat(u32(flags), u32(0), payload)));
const moovWith = (...children: Uint8Array[]): Uint8Array => concat(box("ftyp", Uint8Array.from(Buffer.from("isom\0\0\0\0isom", "latin1"))), box("moov", concat(...children)));
const metaIlst = (...items: Uint8Array[]): Uint8Array => box("udta", fullBox("meta", 0, concat(fullBox("hdlr", 0, concat(u32(0), Uint8Array.from(Buffer.from("mdir", "latin1")), new Uint8Array(13))), box("ilst", concat(...items)))));
const utf8 = (text: string): Uint8Array => Uint8Array.from(Buffer.from(text, "utf8"));
const utf16be = (text: string): Uint8Array => Uint8Array.from(Buffer.from(text, "utf16le").swap16());

describe("trackTagStrings", () => {
  test("reads a UTF-8 iTunes tag", () => {
    const bytes = moovWith(metaIlst(ilstItem("©nam", 1, utf8("A Very Long Song Title"))));
    expect(trackTagStrings(bytes)).toContain("A Very Long Song Title");
  });

  test("reads a UTF-16 big-endian iTunes tag (data type 2)", () => {
    const bytes = moovWith(metaIlst(ilstItem("©ART", 2, utf16be("Ünïcode Artîst Name"))));
    expect(trackTagStrings(bytes)).toContain("Ünïcode Artîst Name");
  });

  test("reads the title and the artist of a real file the muxer tagged, and the handler name, and the UTF-16 ID3v2 frames", async () => {
    dir = await mkdtemp(join(tmpdir(), "studio-tags-"));
    const path = await makeTaggedTrack(dir, musicTracks.hot.file);
    const strings = trackTagStrings(new Uint8Array(readFileSync(path)));
    expect(strings).toContain(TAG_TITLE);
    expect(strings).toContain(TAG_ARTIST);
    expect(strings).toContain(TAG_HANDLER);
  });

  test("reads an ID3v2 frame written as UTF-16 with a byte-order mark", () => {
    const title = "Ünïcode Sŏng Tîtle";
    const body = concat(Uint8Array.of(1, 0xff, 0xfe), Uint8Array.from(Buffer.from(title, "utf16le")), Uint8Array.of(0, 0));
    const frame = concat(utf8("TIT2"), u32(body.byteLength), Uint8Array.of(0, 0), body);
    const tag = concat(utf8("ID3"), Uint8Array.of(3, 0, 0, 0, 0, 0, frame.byteLength), frame);
    const bytes = moovWith(fullBox("meta", 0, concat(fullBox("hdlr", 0, concat(u32(0), utf8("ID32"), new Uint8Array(13))), fullBox("ID32", 0, concat(u16(0x55c4), tag)))));
    expect(trackTagStrings(bytes)).toContain(title);
  });

  test("a file with no tags gives no forbidden string: its handler and encoder names are the engine's own text, which is never forbidden", () => {
    const plain = new Uint8Array(readFileSync(musicTracks.hot.file));
    expect(trackForbiddenStrings(plain, [])).toEqual([]);
  });

  test("the forbidden strings join the list's title and artist to the file's own text, each through the one rule (8 characters or more)", () => {
    const bytes = moovWith(metaIlst(ilstItem("\u00a9nam", 1, utf8("A Very Long Song Title")), ilstItem("\u00a9cmt", 1, utf8("short"))));
    expect(trackForbiddenStrings(bytes, ["Listed Title Here", "tiny", null])).toEqual(["Listed Title Here", "A Very Long Song Title"]);
  });

  test("gives nothing for bytes that are not an MP4", () => {
    expect(trackTagStrings(Uint8Array.from(Buffer.from("RIFF....WAVEfmt ")))).toEqual([]);
    expect(trackTagStrings(new Uint8Array(0))).toEqual([]);
  });

  test("gives nothing, and does not throw, for a box that claims more than the file holds", () => {
    const bytes = concat(box("ftyp", utf8("isom0000isom")), box("moov", box("udta", new Uint8Array(0)), 0x7fffffff));
    expect(trackTagStrings(bytes)).toEqual([]);
  });

  test("is bounded: a file of thousands of tag boxes yields a bounded list", () => {
    const items = Array.from({ length: 20_000 }, (_, i) => ilstItem("©cmt", 1, utf8(`comment number ${i} of the hostile file`)));
    expect(trackTagStrings(moovWith(metaIlst(...items))).length).toBeLessThanOrEqual(4096);
  });
});
