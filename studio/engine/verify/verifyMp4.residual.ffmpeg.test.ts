import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { removeDir } from "../render/render.testkit";
import type { VerifyExpected, VerifyReasonCode, VerifyResult } from "./types";
import { verifyRenderedMp4 } from "./verifyMp4";
import { appendChild, concat, FIXTURE_FRAMES, locate, makeBox, renderFixture, spliceInside, writeCopy, type Fixture } from "./verify.testkit";
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
