import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { removeDir } from "../render/render.testkit";
import type { VerifyReasonCode, VerifyResult } from "./types";
import { verifyRenderedMp4 } from "./verifyMp4";
import { appendChild, concat, findAscii, FIXTURE_FRAMES, locate, makeBox, patched, renderFixture, setU32, spliceInside, writeCopy, type Fixture } from "./verify.testkit";
useNativeGlobals();

// REAL ffmpeg. Three things the 3a.5 review asked of the verifier:
//  - every box is walked, the sample entries included (metadata can hide there);
//  - the times are checked in EVERY track, the audio track's headers too;
//  - C2PA / JUMBF, in a source photo and injected into a real output, never passes.

const C2PA_SENTINEL = "SENTINEL-C2PA-ZQX";
/** The UUID that marks a C2PA manifest store in an ISO BMFF `uuid` box: D8FEC3D6-1B0E-483C-9297-5828877EC481. */
const C2PA_UUID = Uint8Array.from([0xd8, 0xfe, 0xc3, 0xd6, 0x1b, 0x0e, 0x48, 0x3c, 0x92, 0x97, 0x58, 0x28, 0x87, 0x7e, 0xc4, 0x81]);
const ascii = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0));

/** A JUMBF superbox as a C2PA manifest store writes it: `jumb` around a `jumd` description and a `c2pa` label. */
const jumbf = (): Uint8Array => makeBox("jumb", concat(makeBox("jumd", ascii(`c2pa\u0000urn:c2pa:${C2PA_SENTINEL}`)), makeBox("c2pa", ascii("claim"))));

/** The source photo with a JPEG APP11 segment (where C2PA puts its JUMBF) right after the SOI marker. */
function withC2paSegment(jpeg: Uint8Array): Uint8Array {
  const payload = concat(ascii("JP\u0000\u0000"), jumbf());
  const segment = concat(new Uint8Array([0xff, 0xeb, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]), payload);
  return concat(jpeg.subarray(0, 2), segment, jpeg.subarray(2));
}

let fx: Fixture;
let c2paSource: Fixture;
beforeAll(async () => {
  fx = await renderFixture("verify-prov");
  c2paSource = await renderFixture("verify-c2pa", async (photo) => {
    writeFileSync(photo, withC2paSegment(new Uint8Array(readFileSync(photo))));
  });
}, 180_000);
afterAll(() => {
  if (fx) removeDir(fx.dir);
  if (c2paSource) removeDir(c2paSource.dir);
});

const EXPECTED = { frames: FIXTURE_FRAMES };
const codesOf = (r: VerifyResult): VerifyReasonCode[] => (r.ok ? [] : r.reasons.map((x) => x.code));
const run = (name: string, bytes: Uint8Array) => verifyRenderedMp4(writeCopy(fx, name, bytes), EXPECTED);
const u32At = (bytes: Uint8Array, at: number): number => new DataView(bytes.buffer, bytes.byteOffset).getUint32(at);

/** `child` appended as the last box inside the `nth` sample entry (0 video, 1 audio), with the entry's and every enclosing size fixed. */
function insertIntoEntry(bytes: Uint8Array, nth: number, child: Uint8Array): Uint8Array {
  const stsd = locate(bytes, "moov/trak/mdia/minf/stbl/stsd", nth);
  const entryStart = stsd.start + 16;
  return spliceInside(bytes, stsd, entryStart + u32At(bytes, entryStart), 0, child, [entryStart]);
}

describe("every box is walked, the sample entries included", () => {
  test("the real render's sample entries hold the boxes the allowlist names (avcC, colr, pasp, btrt / esds, btrt)", () => {
    for (const type of ["avcC", "colr", "pasp", "btrt", "esds"]) expect(findAscii(fx.bytes, type)).toBeGreaterThan(0);
  });

  test("a uuid box hidden inside the video sample entry is UUID_BOX", async () => {
    expect(codesOf(await run("entry-uuid.mp4", insertIntoEntry(fx.bytes, 0, makeBox("uuid", new Uint8Array(24).fill(1)))))).toContain("UUID_BOX");
  });

  test("a jumb box hidden inside the audio sample entry is PROVENANCE_BOX", async () => {
    expect(codesOf(await run("entry-jumb.mp4", insertIntoEntry(fx.bytes, 1, jumbf())))).toContain("PROVENANCE_BOX");
  });

  test("an XMP_ box hidden inside the video sample entry is XMP_BOX", async () => {
    expect(codesOf(await run("entry-xmp.mp4", insertIntoEntry(fx.bytes, 0, makeBox("XMP_", ascii("<x:xmpmeta/>")))))).toContain("XMP_BOX");
  });

  test("an unknown box inside the video sample entry is UNKNOWN_BOX", async () => {
    expect(codesOf(await run("entry-note.mp4", insertIntoEntry(fx.bytes, 0, makeBox("note", ascii("a hidden note")))))).toContain("UNKNOWN_BOX");
  });

  test("an unknown box inside the audio sample entry is UNKNOWN_BOX", async () => {
    expect(codesOf(await run("entry-audio-note.mp4", insertIntoEntry(fx.bytes, 1, makeBox("note", ascii("a hidden note")))))).toContain("UNKNOWN_BOX");
  });

  test("a second sample entry of a type the engine never writes is UNKNOWN_BOX", async () => {
    const stsd = locate(fx.bytes, "moov/trak/mdia/minf/stbl/stsd");
    expect(codesOf(await run("entry-second.mp4", spliceInside(fx.bytes, stsd, stsd.end, 0, makeBox("hvc1", new Uint8Array(78)))))).toContain("UNKNOWN_BOX");
  });

  test("a sample entry too short for its fixed fields is STRUCTURE_UNRECOGNISED", async () => {
    const stsd = locate(fx.bytes, "moov/trak/mdia/minf/stbl/stsd");
    const short = makeBox("avc1", new Uint8Array(8));
    expect(codesOf(await run("entry-short.mp4", spliceInside(fx.bytes, stsd, stsd.end, 0, short)))).toContain("STRUCTURE_UNRECOGNISED");
  });
});

describe("the times are zero in every track", () => {
  // [track index, box path, offset of the creation time from the box start]
  const CASES: [string, number, string][] = [
    ["video tkhd", 0, "moov/trak/tkhd"],
    ["video mdhd", 0, "moov/trak/mdia/mdhd"],
    ["audio tkhd", 1, "moov/trak/tkhd"],
    ["audio mdhd", 1, "moov/trak/mdia/mdhd"],
  ];

  test.each(CASES)("refuses a non-zero creation time in the %s", async (_name, nth, path) => {
    const box = locate(fx.bytes, path, nth);
    const r = await run("ctime-every.mp4", patched(fx.bytes, (b) => setU32(b, box.start + 12, 1)));
    expect(codesOf(r)).toContain("NONZERO_TIMESTAMP");
    expect(!r.ok && r.reasons.find((x) => x.code === "NONZERO_TIMESTAMP")?.path).toBe(path);
  });

  test.each(CASES)("refuses a non-zero modification time in the %s", async (_name, nth, path) => {
    const box = locate(fx.bytes, path, nth);
    expect(codesOf(await run("mtime-every.mp4", patched(fx.bytes, (b) => setU32(b, box.start + 16, 1))))).toContain("NONZERO_TIMESTAMP");
  });

  test("names the audio track's time and not the video's when only the audio's is set", async () => {
    const audioMdhd = locate(fx.bytes, "moov/trak/mdia/mdhd", 1);
    const r = await run("ctime-audio-only.mp4", patched(fx.bytes, (b) => setU32(b, audioMdhd.start + 12, 9)));
    expect(!r.ok && r.reasons.filter((x) => x.code === "NONZERO_TIMESTAMP")).toHaveLength(1);
  });
});

describe("C2PA and JUMBF", () => {
  test("a top-level uuid box with the C2PA identifier is PROVENANCE_BOX, not the generic UUID_BOX", async () => {
    const codes = codesOf(await run("c2pa-uuid.mp4", concat(fx.bytes, makeBox("uuid", concat(C2PA_UUID, jumbf())))));
    expect(codes).toContain("PROVENANCE_BOX");
    expect(codes).not.toContain("UUID_BOX");
  });

  test("a top-level jumb box is PROVENANCE_BOX", async () => {
    expect(codesOf(await run("c2pa-jumb-top.mp4", concat(fx.bytes, jumbf())))).toContain("PROVENANCE_BOX");
  });

  test("a jumb box inside moov/udta is PROVENANCE_BOX", async () => {
    expect(codesOf(await run("c2pa-jumb-udta.mp4", appendChild(fx.bytes, "moov/udta", jumbf())))).toContain("PROVENANCE_BOX");
  });

  test("the manifest's own text, urn:c2pa, hidden in the media data is SOURCE_METADATA_STRING", async () => {
    const mdat = locate(fx.bytes, "mdat");
    expect(codesOf(await run("c2pa-text.mp4", patched(fx.bytes, (b) => b.set(ascii(`urn:c2pa:${C2PA_SENTINEL}`), mdat.start + 7000))))).toContain("SOURCE_METADATA_STRING");
  });

  test("the source photo really carries the JUMBF segment, so the clean render below means something", () => {
    const text = new TextDecoder("latin1").decode(new Uint8Array(readFileSync(`${c2paSource.dir}/photo.jpg`)));
    // Booleans, never the text: a failing toContain would print the whole file into the log.
    expect({ needle: C2PA_SENTINEL, present: text.includes(C2PA_SENTINEL) }).toEqual({ needle: C2PA_SENTINEL, present: true });
    expect({ needle: "jumb", present: text.includes("jumb") }).toEqual({ needle: "jumb", present: true });
  });

  test("a render of a photo carrying C2PA JUMBF passes, with its manifest label forbidden", async () => {
    expect(await verifyRenderedMp4(c2paSource.path, { ...EXPECTED, forbiddenStrings: [C2PA_SENTINEL] })).toEqual({ ok: true });
  });
});
