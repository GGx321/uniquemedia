import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { removeDir } from "../render/render.testkit";
import type { VerifyExpected, VerifyReasonCode, VerifyResult } from "./types";
import { verifyRenderedMp4 } from "./verifyMp4";
import { appendChild, concat, FIXTURE_FRAMES, locate, makeBox, patched, renderFixture, spliceInside, writeCopy, type Fixture } from "./verify.testkit";
useNativeGlobals();

// REAL ffmpeg: the last review round. A second copy of a container or a table
// must not slip past the pinned checks of the first, the sample-table types
// the engine never writes are refused, and every message is safe to log.

let fx: Fixture;
beforeAll(async () => {
  fx = await renderFixture("verify-resid");
}, 120_000);
afterAll(() => fx && removeDir(fx.dir));

const EXPECTED: VerifyExpected = { frames: FIXTURE_FRAMES };
const codesOf = (r: VerifyResult): VerifyReasonCode[] => (r.ok ? [] : r.reasons.map((x) => x.code));
const run = (name: string, bytes: Uint8Array, expected: VerifyExpected = EXPECTED) => verifyRenderedMp4(writeCopy(fx, name, bytes), expected);
const ascii = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, "latin1"));
const STBL = "moov/trak/mdia/minf/stbl";
/** Short fragments of personal data, none of them 16 printable bytes in a row. */
const FRAGMENTS = ascii("Jane Doe\u0001Canon EOS R5\u000152.52N 13.40E\u00012024:05:01\u0001Berlin");

describe("a second copy of a container or a table is DUPLICATE_BOX", () => {
  test("a second edts holding an elst with text fragments", async () => {
    const dup = makeBox("edts", makeBox("elst", concat(new Uint8Array(8), FRAGMENTS)));
    expect(codesOf(await run("dup-edts.mp4", appendChild(fx.bytes, "moov/trak", dup)))).toContain("DUPLICATE_BOX");
  });

  test("a second dinf holding a url entry with text fragments", async () => {
    const url = makeBox("url ", concat(new Uint8Array([0, 0, 0, 1]), FRAGMENTS));
    const dup = makeBox("dinf", makeBox("dref", concat(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 1]), url)));
    expect(codesOf(await run("dup-dinf.mp4", appendChild(fx.bytes, "moov/trak/mdia/minf", dup)))).toContain("DUPLICATE_BOX");
  });

  test.each(["stsz", "stco", "stts", "stsc", "stsd", "stss", "ctts"])("a second %s in the video stbl", async (type) => {
    const copy = locate(fx.bytes, `${STBL}/${type}`);
    const dup = fx.bytes.slice(copy.start, copy.end);
    const codes = codesOf(await run("dup-table.mp4", appendChild(fx.bytes, STBL, dup)));
    expect(codes).toContain("DUPLICATE_BOX");
  });

  test.each(["sgpd", "sbgp"])("a second %s in the audio stbl", async (type) => {
    const copy = locate(fx.bytes, `${STBL}/${type}`);
    const dup = fx.bytes.slice(copy.start, copy.end);
    const stbl = locate(fx.bytes, STBL, 1);
    expect(codesOf(await run("dup-group.mp4", spliceInside(fx.bytes, stbl, stbl.end, 0, dup)))).toContain("DUPLICATE_BOX");
  });

  test.each([
    ["moov", "mvhd"],
    ["moov/trak", "tkhd"],
    ["moov/trak", "mdia"],
    ["moov/trak/mdia", "mdhd"],
    ["moov/trak/mdia", "hdlr"],
    ["moov/trak/mdia", "minf"],
    ["moov/trak/mdia/minf", "stbl"],
  ] as const)("a second %s/%s box", async (parent, type) => {
    expect(codesOf(await run("dup-box.mp4", appendChild(fx.bytes, parent, makeBox(type, new Uint8Array(24)))))).toContain("DUPLICATE_BOX");
  });

  test("a second udta in moov", async () => {
    expect(codesOf(await run("dup-udta.mp4", appendChild(fx.bytes, "moov", makeBox("udta"))))).toContain("DUPLICATE_BOX");
  });

  test("the real render has two tracks and one of everything else, so nothing above is a false alarm", async () => {
    expect(await verifyRenderedMp4(fx.path, EXPECTED)).toEqual({ ok: true });
  });
});

describe("messages are safe to log", () => {
  const SENTINEL = "SENTINEL-ARTIST";
  const withHandlerName = (name: Uint8Array): Uint8Array => {
    const hdlr = locate(fx.bytes, "moov/trak/mdia/hdlr");
    return spliceInside(fx.bytes, hdlr, hdlr.start + 32, 13, concat(name, new Uint8Array(1)));
  };
  /** Every message and path of a result, joined. */
  const everything = (r: VerifyResult): string => (r.ok ? "" : r.reasons.map((x) => `${x.message}\n${x.path ?? ""}`).join("\n"));

  test.each([["UTF-16LE", (s: string) => Uint8Array.from(Buffer.from(s, "utf16le"))], ["UTF-16BE", (s: string) => Uint8Array.from(Buffer.from(s, "utf16le").swap16())]] as const)("a caller string stored as %s in a handler name is masked", async (_name, encode) => {
    const r = await run("mask-utf16.mp4", withHandlerName(encode(SENTINEL)), { ...EXPECTED, forbiddenStrings: [SENTINEL] });
    expect(codesOf(r)).toContain("METADATA_VALUE_NOT_ALLOWED");
    expect(everything(r)).toContain("[caller string]");
    expect(everything(r)).not.toMatch(/S(\\x00|\u0000)?E(\\x00|\u0000)?N/);
  });

  test("a box type of control characters is escaped in messages and paths, at the top level and inside moov", async () => {
    const type = "\u0007\u001b[3";
    for (const bytes of [concat(fx.bytes, makeBox(type)), appendChild(fx.bytes, "moov", makeBox(type))]) {
      const r = await run("control-type.mp4", bytes);
      expect(codesOf(r)).toContain("UNKNOWN_BOX");
      expect(everything(r).replace(/\n/g, "")).toMatch(/^[\x20-\x7e]*$/);
      expect(everything(r)).toContain("\\x1b");
    }
  });

  test("a non-ASCII box type (a copyright sign) is escaped too", async () => {
    const r = await run("latin-type.mp4", concat(fx.bytes, makeBox("©abc")));
    expect(everything(r).replace(/\n/g, "")).toMatch(/^[\x20-\x7e]*$/);
  });

  test("a reserved-field reason reads 'must be zero', not 'is not zero'", async () => {
    const hdlr = locate(fx.bytes, "moov/trak/mdia/hdlr");
    const r = await run("grammar.mp4", patched(fx.bytes, (b) => b.set(ascii("JaneDoe12345"), hdlr.start + 20)));
    expect(everything(r)).toContain("the reserved bytes must be zero");
    expect(everything(r)).not.toContain("bytes is not zero");
  });
});

describe("sample-table types the engine never writes are refused, and the two it writes are pinned", () => {
  test.each(["sdtp", "cslg", "stps", "co64"])("a %s box with text fragments in the video stbl is UNKNOWN_BOX", async (type) => {
    const box = makeBox(type, concat(new Uint8Array(4), FRAGMENTS));
    expect(codesOf(await run("stbl-unwritten.mp4", appendChild(fx.bytes, STBL, box)))).toContain("UNKNOWN_BOX");
  });

  test.each(["fiel", "clap"])("a %s box with text fragments in the video sample entry is UNKNOWN_BOX", async (type) => {
    const stsd = locate(fx.bytes, `${STBL}/stsd`);
    const entry = stsd.start + 16;
    const entryEnd = entry + new DataView(fx.bytes.buffer, fx.bytes.byteOffset).getUint32(entry);
    const out = spliceInside(fx.bytes, stsd, entryEnd, 0, makeBox(type, FRAGMENTS), [entry]);
    expect(codesOf(await run("entry-unwritten.mp4", out))).toContain("UNKNOWN_BOX");
  });

  test("the real roll sample-group boxes are the bytes pinned: sgpd 26, sbgp 28", () => {
    const sgpd = locate(fx.bytes, `${STBL}/sgpd`);
    const sbgp = locate(fx.bytes, `${STBL}/sbgp`);
    expect(Buffer.from(fx.bytes.subarray(sgpd.start, sgpd.end)).toString("hex")).toBe("0000001a7367706401000000726f6c6c0000000200000001ffff");
    expect(Buffer.from(fx.bytes.subarray(sbgp.start, sbgp.end)).toString("hex")).toMatch(/^0000001c7362677000000000726f6c6c00000001[0-9a-f]{8}00000001$/);
  });

  test.each(["sgpd", "sbgp"])("%s followed by 15 text bytes is FIELD_NOT_CANONICAL", async (type) => {
    const box = locate(fx.bytes, `${STBL}/${type}`);
    expect(codesOf(await run("group-tail-15.mp4", spliceInside(fx.bytes, box, box.end, 0, ascii("Jane Doe Berlin"))))).toContain("FIELD_NOT_CANONICAL");
  });

  test.each(["sgpd", "sbgp"])("%s followed by text fragments is FIELD_NOT_CANONICAL", async (type) => {
    const box = locate(fx.bytes, `${STBL}/${type}`);
    expect(codesOf(await run("group-tail.mp4", spliceInside(fx.bytes, box, box.end, 0, FRAGMENTS)))).toContain("FIELD_NOT_CANONICAL");
  });

  test("an sgpd with another roll distance is FIELD_NOT_CANONICAL", async () => {
    const box = locate(fx.bytes, `${STBL}/sgpd`);
    expect(codesOf(await run("sgpd-roll.mp4", patched(fx.bytes, (b) => b.set([0x4a, 0x61], box.end - 2))))).toContain("FIELD_NOT_CANONICAL");
  });

  test.each([["grouping type", 12], ["entry count", 19], ["group description index", 27]] as const)("an sbgp with another %s is FIELD_NOT_CANONICAL", async (_what, offset) => {
    const box = locate(fx.bytes, `${STBL}/sbgp`);
    expect(codesOf(await run("sbgp-field.mp4", patched(fx.bytes, (b) => (b[box.start + offset] = 0x4a))))).toContain("FIELD_NOT_CANONICAL");
  });
});
