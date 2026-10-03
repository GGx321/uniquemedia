import { describe, expect, test } from "bun:test";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { buildForbiddenStrings, collectForbiddenStrings, combineForbiddenStrings, FORBIDDEN_STRING_MIN_LENGTH, photoMetadataStrings } from "./forbiddenStrings";
useNativeGlobals();

// Task 3a.8b.1 (from the 3a.7 review): the verifier refuses a video that holds
// any of the source photos' own text (Artist, Copyright, ...). That list must
// never contain text the ENGINE ITSELF writes into every video, or every render
// would be refused deterministically with no way out.

describe("combineForbiddenStrings: the photos and the track each have a quota of their own (3c.5)", () => {
  const many = (prefix: string, n: number): string[] => Array.from({ length: n }, (_, i) => `${prefix} string number ${String(i).padStart(2, "0")}`);

  test("keeps all 32 of the photos' strings and all of the track's, so neither crowds the other out", () => {
    const photos = many("photo", 32);
    const track = many("track", 5);
    const combined = combineForbiddenStrings(photos, track);
    expect(combined).toHaveLength(37);
    expect(combined).toEqual(expect.arrayContaining([...photos, ...track]));
  });

  test("lists a string both have once", () => {
    expect(combineForbiddenStrings(["Shared Value Here", "Photo Only Value"], ["Shared Value Here", "Track Only Value"])).toEqual(["Shared Value Here", "Photo Only Value", "Track Only Value"]);
  });

  test("is the photos' list alone when the track has none", () => {
    expect(combineForbiddenStrings(["Photo Only Value"], [])).toEqual(["Photo Only Value"]);
  });

  test("buildForbiddenStrings caps at 32 by default and at the given quota otherwise", () => {
    expect(buildForbiddenStrings(many("x", 50))).toHaveLength(32);
    expect(buildForbiddenStrings(many("x", 50), 5)).toHaveLength(5);
  });
});

describe("buildForbiddenStrings", () => {
  test("keeps a real artist or copyright text", () => {
    expect(buildForbiddenStrings(["Jane Q. Photographer", "(c) 2026 Example Studio"])).toEqual(["Jane Q. Photographer", "(c) 2026 Example Studio"]);
  });

  test("drops anything under the minimum length, which a chance match in the video data could hit", () => {
    expect(FORBIDDEN_STRING_MIN_LENGTH).toBe(8);
    expect(buildForbiddenStrings(["Jane Doe", "Jane Do", "x"])).toEqual(["Jane Doe"]);
  });

  test("counts characters, not UTF-16 units, so an emoji is one", () => {
    expect(buildForbiddenStrings(["🎉🎉🎉🎉🎉🎉🎉"])).toEqual([]);
    expect(buildForbiddenStrings(["🎉🎈🎁🎀🎊🎆🎇🧨"])).toHaveLength(1);
  });

  test("removes duplicates, also after trimming, keeping the first spelling and the order", () => {
    expect(buildForbiddenStrings(["Jane Q. Photographer", " Jane Q. Photographer\n", "Other Person Here", "Jane Q. Photographer"])).toEqual(["Jane Q. Photographer", "Other Person Here"]);
  });

  test.each([
    ["VideoHandler", "the video track's handler name"],
    ["SoundHandler", "the audio track's handler name"],
    ["Lavf60.16.100", "the container's encoder tag"],
    ["Lavc60.31.102 libx264", "the video stream's encoder tag"],
    ["x264 - core 164 r3095 baee400 - H.264/MPEG-4 AVC codec - Copyleft 2003-2023", "the x264 SEI text"],
    ["http://www.videolan.org/x264.html", "the x264 SEI's address"],
    ["H.264/MPEG-4 AVC codec", "the x264 SEI's codec line"],
    ["Copyleft 2003-2023", "the x264 SEI's licence line"],
  ])("never lists the engine's own text: %s (%s)", (text) => {
    expect(buildForbiddenStrings([text])).toEqual([]);
  });

  test("spots the engine's text in any letter case and inside a longer value", () => {
    expect(buildForbiddenStrings(["VIDEOLAN.ORG stuff here", "made with lavf58.76.100 somewhere", "the SOUNDHANDLER track"])).toEqual([]);
  });

  test("drops a value that is only a piece of the engine's text, since the output does contain that piece", () => {
    expect(buildForbiddenStrings(["MPEG-4 AVC", "AVC codec - Copyleft"])).toEqual([]);
  });

  test("drops a value with few distinct characters, which padding or a black frame could contain", () => {
    expect(buildForbiddenStrings(["aaaaaaaaaa", "abababababab", "          "])).toEqual([]);
  });

  test("drops a value holding a control character or NUL: a field's padding, not a name", () => {
    expect(buildForbiddenStrings(["Jane\u0000Q. Photographer", "tab\there and there"])).toEqual([]);
  });

  test("cuts a very long value to 256 characters instead of scanning for an essay", () => {
    const [cut] = buildForbiddenStrings(["Jane Q. Photographer ".repeat(40)]);
    expect(Array.from(cut ?? "")).toHaveLength(256);
  });

  test("lists at most 32 values", () => {
    const many = Array.from({ length: 50 }, (_, i) => `Photographer number ${i}`);
    expect(buildForbiddenStrings(many)).toHaveLength(32);
  });
});

// ---- photoMetadataStrings: what a photo's own bytes say ----

const u16 = (n: number, le: boolean): number[] => (le ? [n & 255, n >> 8] : [n >> 8, n & 255]);
const u32 = (n: number, le: boolean): number[] => (le ? [n & 255, (n >> 8) & 255, (n >> 16) & 255, n >>> 24] : [n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255]);
const ascii = (s: string): number[] => [...Buffer.from(s, "latin1")];

/** A JPEG whose APP1 holds a TIFF with these ASCII tags in IFD0. */
function jpegWithExif(tags: Array<[number, string]>, le = true): Uint8Array {
  const entryBytes = 12;
  const ifdStart = 8;
  const dataStart = ifdStart + 2 + tags.length * entryBytes + 4;
  let dataOffset = dataStart;
  const entries: number[] = [];
  const data: number[] = [];
  for (const [tag, text] of tags) {
    const bytes = [...ascii(text), 0];
    entries.push(...u16(tag, le), ...u16(2, le), ...u32(bytes.length, le));
    if (bytes.length <= 4) entries.push(...bytes, ...new Array<number>(4 - bytes.length).fill(0));
    else {
      entries.push(...u32(dataOffset, le));
      data.push(...bytes);
      dataOffset += bytes.length;
    }
  }
  const tiff = [...ascii(le ? "II" : "MM"), ...u16(42, le), ...u32(ifdStart, le), ...u16(tags.length, le), ...entries, ...u32(0, le), ...data];
  const payload = [...ascii("Exif"), 0, 0, ...tiff];
  const length = payload.length + 2;
  return Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, length >> 8, length & 255, ...payload, 0xff, 0xda, 0, 2, 0xff, 0xd9]);
}

function pngWith(chunks: Array<[string, number[]]>): Uint8Array {
  const out: number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const all: Array<[string, number[]]> = [...chunks, ["IEND", []]];
  for (const [type, body] of all) out.push(...u32(body.length, false), ...ascii(type), ...body, 0, 0, 0, 0);
  return Uint8Array.from(out);
}

describe("photoMetadataStrings", () => {
  test("reads Artist, Copyright and ImageDescription from a JPEG's EXIF (little-endian)", () => {
    const bytes = jpegWithExif([[0x010e, "A description of the shot"], [0x013b, "Jane Q. Photographer"], [0x8298, "(c) 2026 Example Studio"]]);
    expect(photoMetadataStrings(bytes)).toEqual(["A description of the shot", "Jane Q. Photographer", "(c) 2026 Example Studio"]);
  });

  test("reads the same from a big-endian TIFF", () => {
    expect(photoMetadataStrings(jpegWithExif([[0x013b, "Jane Q. Photographer"]], false))).toEqual(["Jane Q. Photographer"]);
  });

  test("splits a Copyright that holds photographer and editor, separated by NUL", () => {
    expect(photoMetadataStrings(jpegWithExif([[0x8298, "Photographer One\u0000Editor Person Two"]]))).toEqual(["Photographer One", "Editor Person Two"]);
  });

  test("reads Author and Copyright from PNG text chunks", () => {
    const png = pngWith([
      ["tEXt", [...ascii("Author"), 0, ...ascii("Jane Q. Photographer")]],
      ["tEXt", [...ascii("Copyright"), 0, ...ascii("(c) 2026 Example Studio")]],
      ["tEXt", [...ascii("Unrelated"), 0, ...ascii("not collected at all")]],
    ]);
    expect(photoMetadataStrings(png)).toEqual(["Jane Q. Photographer", "(c) 2026 Example Studio"]);
  });

  test("returns nothing for bytes of no known kind, for a truncated EXIF, and never throws", () => {
    expect(photoMetadataStrings(Uint8Array.from([1, 2, 3]))).toEqual([]);
    expect(photoMetadataStrings(jpegWithExif([[0x013b, "Jane Q. Photographer"]]).subarray(0, 40))).toEqual([]);
    expect(photoMetadataStrings(new Uint8Array(0))).toEqual([]);
  });

  test("an EXIF entry whose offset points outside the segment is ignored, not read out of bounds", () => {
    const bytes = jpegWithExif([[0x013b, "Jane Q. Photographer"]]);
    // SOI 2 + marker 2 + length 2 + "Exif\0\0" 6 + TIFF header 8 + entry count 2 + tag/type/count 8 = the value offset field.
    const at = 2 + 2 + 2 + 6 + 8 + 2 + 8;
    new DataView(bytes.buffer, bytes.byteOffset).setUint32(at, 0x00ff_ffff, true);
    expect(photoMetadataStrings(bytes)).toEqual([]);
  });
});

describe("collectForbiddenStrings", () => {
  test("gathers the strings of every photo, filtered and deduplicated as one list", async () => {
    const a = jpegWithExif([[0x013b, "Jane Q. Photographer"], [0x0131, "Lavf58.76.100 encoder"]]);
    const b = jpegWithExif([[0x013b, "Jane Q. Photographer"], [0x8298, "(c) 2026 Example Studio"]]);
    const photos = new Map([["photo-a", a], ["photo-b", b]]);
    const strings = await collectForbiddenStrings((id) => Promise.resolve(photos.get(id) ?? new Uint8Array(0)), ["photo-a", "photo-b"]);
    expect(strings).toEqual(["Jane Q. Photographer", "(c) 2026 Example Studio"]);
  });

  test("a photo that cannot be read is an error, not silently skipped: its text would go unchecked", async () => {
    await expect(collectForbiddenStrings(() => Promise.reject(new Error("gone")), ["photo-a"])).rejects.toThrow("gone");
  });
});
