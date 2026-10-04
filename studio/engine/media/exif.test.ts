import { describe, expect, test } from "bun:test";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { readOrientation, type ExifContainer, type Orientation } from "./exif";
useNativeGlobals();

// Studio's own EXIF orientation reader (3f.2): JPEG APP1, PNG `eXIf`, WebP `EXIF`. It reads one number (IFD0 tag 0x0112) out of
// bytes the owner picked, so it is pure, bounded by the buffer, never throws, and answers 1 (upright) for everything it cannot read.

const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));
const u16be = (n: number): number[] => [(n >>> 8) & 0xff, n & 0xff];
const u32be = (n: number): number[] => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const u16le = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff];
const u32le = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];

interface TiffOptions {
  littleEndian?: boolean;
  /** Extra IFD0 entries written BEFORE the orientation one (each a 12-byte entry). */
  before?: number[][];
  type?: number;
  count?: number;
  tag?: number;
  ifdOffset?: number;
  entryCount?: number;
}

/** A TIFF block with one IFD0 holding the orientation (and whatever `before` adds). */
function tiff(orientation: number, options: TiffOptions = {}): number[] {
  const le = options.littleEndian ?? false;
  const u16 = le ? u16le : u16be;
  const u32 = le ? u32le : u32be;
  const entry = (tag: number, type: number, count: number, value: number): number[] => [...u16(tag), ...u16(type), ...u32(count), ...(type === 3 ? [...u16(value), 0, 0] : u32(value))];
  const entries = [...(options.before ?? []), entry(options.tag ?? 0x0112, options.type ?? 3, options.count ?? 1, orientation)];
  return [...(le ? ascii("II") : ascii("MM")), ...u16(0x2a), ...u32(options.ifdOffset ?? 8), ...u16(options.entryCount ?? entries.length), ...entries.flat(), ...u32(0)];
}

const SOI = [0xff, 0xd8];
const app1 = (tiffBlock: number[]): number[] => [0xff, 0xe1, ...u16be(2 + 6 + tiffBlock.length), ...ascii("Exif"), 0, 0, ...tiffBlock];
const jpeg = (...segments: number[][]): Uint8Array => Uint8Array.from([...SOI, ...segments.flat(), 0xff, 0xda, 0, 2, 0xff, 0xd9]);

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const pngChunk = (type: string, body: number[]): number[] => [...u32be(body.length), ...ascii(type), ...body, 0, 0, 0, 0];
const IHDR = pngChunk("IHDR", [...u32be(8), ...u32be(8), 8, 2, 0, 0, 0]);
const png = (...chunks: number[][]): Uint8Array => Uint8Array.from([...PNG_SIG, ...IHDR, ...chunks.flat(), ...pngChunk("IDAT", [1]), ...pngChunk("IEND", [])]);

const riffChunk = (type: string, body: number[]): number[] => [...ascii(type), ...u32le(body.length), ...body, ...(body.length % 2 === 1 ? [0] : [])];
const webp = (...chunks: number[][]): Uint8Array => {
  const inner = [...ascii("WEBP"), ...chunks.flat()];
  return Uint8Array.from([...ascii("RIFF"), ...u32le(inner.length), ...inner]);
};

const wrap: Record<ExifContainer, (tiffBlock: number[]) => Uint8Array> = {
  jpeg: (t) => jpeg(app1(t)),
  png: (t) => png(pngChunk("eXIf", t)),
  webp: (t) => webp(riffChunk("VP8X", [0x08, 0, 0, 0, 0, 0, 0, 0, 0, 0]), riffChunk("EXIF", t)),
};
const CONTAINERS: readonly ExifContainer[] = ["jpeg", "png", "webp"];
const ORIENTATIONS: readonly Orientation[] = [1, 2, 3, 4, 5, 6, 7, 8];

describe("readOrientation: every orientation in every container", () => {
  for (const container of CONTAINERS) {
    for (const orientation of ORIENTATIONS) {
      test(`reads orientation ${orientation} from a ${container}, big-endian`, () => {
        expect(readOrientation(wrap[container](tiff(orientation)), container)).toBe(orientation);
      });
    }
    test(`reads a little-endian TIFF block in a ${container}`, () => {
      expect(readOrientation(wrap[container](tiff(6, { littleEndian: true })), container)).toBe(6);
    });
  }
});

describe("readOrientation: where it looks", () => {
  test("finds the orientation behind other IFD0 entries", () => {
    const before = [[...u16be(0x010f), ...u16be(2), ...u32be(4), ...u32be(0x1000)]];
    expect(readOrientation(wrap.jpeg(tiff(8, { before })), "jpeg")).toBe(8);
  });

  test("skips another APP1 (XMP) and an APP0 in front of the EXIF one in a JPEG", () => {
    const xmp = [0xff, 0xe1, ...u16be(2 + 29), ...ascii("http://ns.adobe.com/xap/1.0/"), 0];
    const jfif = [0xff, 0xe0, ...u16be(2 + 5), ...ascii("JFIF"), 0];
    expect(readOrientation(jpeg(jfif, xmp, app1(tiff(3))), "jpeg")).toBe(3);
  });

  test("reads the EXIF a PNG keeps after the pixel data too (eXIf may follow IDAT)", () => {
    const after = Uint8Array.from([...PNG_SIG, ...IHDR, ...pngChunk("IDAT", [1]), ...pngChunk("eXIf", tiff(5)), ...pngChunk("IEND", [])]);
    expect(readOrientation(after, "png")).toBe(5);
  });

  test("reads a WebP EXIF chunk that carries the Exif header some writers add", () => {
    const withHeader = webp(riffChunk("EXIF", [...ascii("Exif"), 0, 0, ...tiff(6)]));
    expect(readOrientation(withHeader, "webp")).toBe(6);
  });

  test("a JPEG without any EXIF is upright", () => {
    expect(readOrientation(jpeg(), "jpeg")).toBe(1);
  });

  test("a PNG without an eXIf chunk is upright", () => {
    expect(readOrientation(png(), "png")).toBe(1);
  });

  test("a WebP without an EXIF chunk is upright", () => {
    expect(readOrientation(webp(riffChunk("VP8 ", [0, 0, 0, 0])), "webp")).toBe(1);
  });

  test("an IFD0 without the orientation tag is upright", () => {
    expect(readOrientation(wrap.jpeg(tiff(6, { tag: 0x0110 })), "jpeg")).toBe(1);
  });
});

describe("readOrientation: values that are not an orientation", () => {
  test("0 is upright", () => {
    expect(readOrientation(wrap.jpeg(tiff(0)), "jpeg")).toBe(1);
  });

  test("9 is upright (one past the last orientation)", () => {
    expect(readOrientation(wrap.jpeg(tiff(9)), "jpeg")).toBe(1);
  });

  test("65535 is upright", () => {
    expect(readOrientation(wrap.jpeg(tiff(0xffff)), "jpeg")).toBe(1);
  });

  test("a tag of the wrong type (LONG, not SHORT) is upright", () => {
    expect(readOrientation(wrap.jpeg(tiff(6, { type: 4 })), "jpeg")).toBe(1);
  });

  test("a tag with a count other than 1 is upright", () => {
    expect(readOrientation(wrap.jpeg(tiff(6, { count: 2 })), "jpeg")).toBe(1);
  });

  test("a TIFF block with a wrong magic number is upright", () => {
    const block = tiff(6);
    block[2] = 0;
    block[3] = 0x2b;
    expect(readOrientation(wrap.jpeg(block), "jpeg")).toBe(1);
  });

  test("a TIFF block with neither II nor MM is upright", () => {
    const block = tiff(6);
    block[0] = 0x58;
    expect(readOrientation(wrap.jpeg(block), "jpeg")).toBe(1);
  });
});

describe("readOrientation: hostile and truncated input", () => {
  test("an IFD offset past the end of the block is upright", () => {
    expect(readOrientation(wrap.jpeg(tiff(6, { ifdOffset: 0xffff_fff0 })), "jpeg")).toBe(1);
  });

  test("an IFD offset that points into the header (a loop on itself) ends, upright", () => {
    expect(readOrientation(wrap.jpeg(tiff(6, { ifdOffset: 0 })), "jpeg")).toBe(1);
    expect(readOrientation(wrap.jpeg(tiff(6, { ifdOffset: 4 })), "jpeg")).toBe(1);
  });

  test("an entry count far larger than the block, with no orientation among the entries that exist, is upright", () => {
    expect(readOrientation(wrap.jpeg(tiff(6, { tag: 0x0110, entryCount: 0xffff })), "jpeg")).toBe(1);
  });

  test("an entry count far larger than the block still reads an orientation that sits inside it", () => {
    expect(readOrientation(wrap.jpeg(tiff(6, { entryCount: 0xffff })), "jpeg")).toBe(6);
  });

  test("an entry count of zero is upright", () => {
    expect(readOrientation(wrap.jpeg(tiff(6, { entryCount: 0 })), "jpeg")).toBe(1);
  });

  test("a JPEG segment whose length is 0 or 1 ends the walk instead of looping", () => {
    for (const length of [0, 1]) {
      const bytes = Uint8Array.from([...SOI, 0xff, 0xe1, ...u16be(length), ...app1(tiff(6))]);
      expect(readOrientation(bytes, "jpeg")).toBe(1);
    }
  });

  test("a JPEG segment longer than the file is upright", () => {
    const bytes = Uint8Array.from([...SOI, 0xff, 0xe1, ...u16be(0xffff), ...ascii("Exif"), 0, 0]);
    expect(readOrientation(bytes, "jpeg")).toBe(1);
  });

  test("a run of fill bytes before a marker is skipped; a run to the end of the file ends the walk", () => {
    expect(readOrientation(Uint8Array.from([...SOI, 0xff, 0xff, 0xff, ...app1(tiff(3))]), "jpeg")).toBe(3);
    expect(readOrientation(Uint8Array.from([...SOI, ...new Array<number>(5000).fill(0xff)]), "jpeg")).toBe(1);
  });

  test("a PNG chunk longer than the file is upright", () => {
    const bytes = Uint8Array.from([...PNG_SIG, ...u32be(0x7fff_ffff), ...ascii("eXIf"), ...tiff(6)]);
    expect(readOrientation(bytes, "png")).toBe(1);
  });

  test("a PNG chunk length with the top bit set is upright", () => {
    const bytes = Uint8Array.from([...PNG_SIG, ...u32be(0xffff_ffff), ...ascii("eXIf"), ...tiff(6)]);
    expect(readOrientation(bytes, "png")).toBe(1);
  });

  test("a WebP chunk longer than the file is upright", () => {
    const bytes = Uint8Array.from([...ascii("RIFF"), ...u32le(100), ...ascii("WEBP"), ...ascii("EXIF"), ...u32le(0xffff_ffff), ...tiff(6)]);
    expect(readOrientation(bytes, "webp")).toBe(1);
  });

  test("a WebP whose RIFF size lies about the length is still read inside the real bytes only", () => {
    const real = webp(riffChunk("EXIF", tiff(6)));
    const lie = real.slice();
    lie.set(u32le(0xffff_fff0), 4);
    expect(readOrientation(lie, "webp")).toBe(6);
  });

  test("an empty buffer is upright for every container", () => {
    for (const container of CONTAINERS) expect(readOrientation(new Uint8Array(0), container)).toBe(1);
  });

  test("a buffer of another format is upright (a JPEG read as a PNG)", () => {
    expect(readOrientation(wrap.jpeg(tiff(6)), "png")).toBe(1);
  });

  for (const container of CONTAINERS) {
    test(`every prefix of a ${container} with an orientation answers a valid orientation and never throws`, () => {
      const whole = wrap[container](tiff(6));
      for (let length = 0; length <= whole.length; length++) {
        const answer = readOrientation(whole.subarray(0, length), container);
        expect(ORIENTATIONS.includes(answer)).toBe(true);
      }
    });

    test(`a ${container} with every single byte replaced by 0x00, 0xff and 0x7f never throws and answers a valid orientation`, () => {
      const whole = wrap[container](tiff(6));
      for (let at = 0; at < whole.length; at++) {
        for (const value of [0x00, 0xff, 0x7f]) {
          const copy = whole.slice();
          copy[at] = value;
          expect(ORIENTATIONS.includes(readOrientation(copy, container))).toBe(true);
        }
      }
    });
  }

  test("seeded random garbage after a valid signature never throws and answers a valid orientation", () => {
    let seed = 0x1234_5678;
    const next = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed;
    };
    for (let round = 0; round < 300; round++) {
      const length = next() % 400;
      const noise = Uint8Array.from({ length }, () => next() & 0xff);
      for (const container of CONTAINERS) {
        const head = container === "jpeg" ? SOI : container === "png" ? PNG_SIG : [...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBP")];
        const bytes = Uint8Array.from([...head, ...noise]);
        expect(ORIENTATIONS.includes(readOrientation(bytes, container))).toBe(true);
      }
    }
  });
});
