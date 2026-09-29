import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { TEXT_FONTS } from "./fonts";
import { cmapCoverage } from "./sfnt";
useNativeGlobals();

const FONT_DIR = join(import.meta.dir, "..", "..", "assets", "fonts");
const real = (file: string): Uint8Array => new Uint8Array(readFileSync(join(FONT_DIR, file)));

// ---- a tiny sfnt builder: just the two tables cmapCoverage reads ----

function u16(...values: number[]): number[] {
  return values.flatMap((v) => [(v >> 8) & 0xff, v & 0xff]);
}
function u32(...values: number[]): number[] {
  return values.flatMap((v) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]);
}

/** cmap format 12; groups are [startCode, endCode, startGlyph]. */
function format12(groups: [number, number, number][]): number[] {
  return [...u16(12, 0), ...u32(16 + 12 * groups.length, 0, groups.length), ...groups.flatMap(([s, e, g]) => u32(s, e, g))];
}

/** cmap format 4 with idDelta segments [start, end, delta] and the mandatory 0xFFFF terminator. */
function format4(segments: [number, number, number][]): number[] {
  const all: [number, number, number][] = [...segments, [0xffff, 0xffff, 1]];
  const n = all.length;
  return [
    ...u16(4, 16 + 8 * n, 0, 2 * n, 0, 0, 0),
    ...all.flatMap(([, e]) => u16(e)),
    ...u16(0),
    ...all.flatMap(([s]) => u16(s)),
    ...all.flatMap(([, , d]) => u16(d & 0xffff)),
    ...all.flatMap(() => u16(0)),
  ];
}

interface Sub {
  platform: number;
  encoding: number;
  body: number[];
}

function craft(subs: Sub[], numGlyphs: number): Uint8Array {
  const cmapHeader = 4 + 8 * subs.length;
  let offset = cmapHeader;
  const records: number[] = [];
  const bodies: number[] = [];
  for (const s of subs) {
    records.push(...u16(s.platform, s.encoding), ...u32(offset));
    bodies.push(...s.body);
    offset += s.body.length;
  }
  const cmap = [...u16(0, subs.length), ...records, ...bodies];
  const maxp = [...u32(0x00005000), ...u16(numGlyphs)];
  const dir = 12 + 32;
  const cmapAt = dir;
  const maxpAt = cmapAt + cmap.length;
  const bytes = [
    ...u32(0x00010000),
    ...u16(2, 0, 0, 0),
    ...[..."cmap"].map((c) => c.charCodeAt(0)),
    ...u32(0, cmapAt, cmap.length),
    ...[..."maxp"].map((c) => c.charCodeAt(0)),
    ...u32(0, maxpAt, maxp.length),
    ...cmap,
    ...maxp,
  ];
  return Uint8Array.from(bytes);
}

const A = 0x41;

describe("cmapCoverage on crafted fonts", () => {
  test("reads a format 4 only font", () => {
    const has = cmapCoverage(craft([{ platform: 3, encoding: 1, body: format4([[A, A + 25, -A + 1]]) }], 100));
    expect(has(A)).toBe(true);
    expect(has(A + 25)).toBe(true);
    expect(has(A + 26)).toBe(false);
    expect(has(A - 1)).toBe(false);
  });

  test("reads a format 12 font above the BMP", () => {
    const has = cmapCoverage(craft([{ platform: 3, encoding: 10, body: format12([[0x1f600, 0x1f64f, 5]]) }], 100));
    expect(has(0x1f600)).toBe(true);
    expect(has(0x1f64f)).toBe(true);
    expect(has(0x1f650)).toBe(false);
  });

  test("does not claim a code point whose glyph is past maxp.numGlyphs", () => {
    const has = cmapCoverage(craft([{ platform: 3, encoding: 10, body: format12([[A, A + 9, 95]]) }], 100));
    expect(has(A)).toBe(true); // glyph 95
    expect(has(A + 4)).toBe(true); // glyph 99, the last one that exists
    expect(has(A + 5)).toBe(false); // glyph 100
    expect(has(A + 9)).toBe(false);
  });

  test("does not claim a mapping to glyph 0, the .notdef", () => {
    const has = cmapCoverage(craft([{ platform: 3, encoding: 10, body: format12([[A, A, 0]]) }], 100));
    expect(has(A)).toBe(false);
  });

  test("prefers the (3,10) subtable over the (3,1) one", () => {
    const fullRepertoire = { platform: 3, encoding: 10, body: format12([[0x42, 0x42, 3]]) };
    const bmpOnly = { platform: 3, encoding: 1, body: format4([[A, A, -A + 3]]) };
    const has = cmapCoverage(craft([bmpOnly, fullRepertoire], 100));
    expect(has(0x42)).toBe(true);
    expect(has(A)).toBe(false);
  });

  test("prefers Unicode platform (0,4) over the (3,1) subtable", () => {
    const has = cmapCoverage(craft([{ platform: 3, encoding: 1, body: format4([[A, A, -A + 3]]) }, { platform: 0, encoding: 4, body: format12([[0x42, 0x42, 3]]) }], 100));
    expect(has(0x42)).toBe(true);
    expect(has(A)).toBe(false);
  });

  test("refuses a font with only a legacy (1,0) subtable", () => {
    expect(() => cmapCoverage(craft([{ platform: 1, encoding: 0, body: format4([[A, A, 1]]) }], 100))).toThrow(/no usable Unicode cmap/);
  });

  test("refuses format 12 groups that are not sorted, at construction", () => {
    const body = format12([[0x50, 0x60, 1], [0x41, 0x42, 5]]);
    expect(() => cmapCoverage(craft([{ platform: 3, encoding: 10, body }], 100))).toThrow(/sfnt: /);
  });

  test("refuses a format 12 group count that runs past the file, at construction", () => {
    const body = format12([[A, A, 1]]);
    body[15] = 200; // nGroups low byte
    expect(() => cmapCoverage(craft([{ platform: 3, encoding: 10, body }], 100))).toThrow(/sfnt: /);
  });

  test("answers false, never throws, for out-of-range and non-integer code points", () => {
    const has = cmapCoverage(craft([{ platform: 3, encoding: 10, body: format12([[A, A, 1]]) }], 100));
    for (const cp of [-1, 0x110000, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(has(cp)).toBe(false);
  });
});

describe("cmapCoverage on damaged real fonts", () => {
  /** Construction may refuse the bytes, but only with an `Error("sfnt: ...")`; and once it accepts them, no lookup may throw. */
  function outcome(bytes: Uint8Array): "refused" | "accepted" {
    let has: (cp: number) => boolean;
    try {
      has = cmapCoverage(bytes);
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(error instanceof RangeError).toBe(false);
      expect(error instanceof Error && error.message.startsWith("sfnt: ")).toBe(true);
      return "refused";
    }
    for (let cp = 0; cp < 0x500; cp++) has(cp);
    has(0x1f600);
    has(0x10ffff);
    return "accepted";
  }

  test("every truncation of each font is refused cleanly or answers safely", () => {
    for (const spec of Object.values(TEXT_FONTS)) {
      const bytes = real(spec.file);
      const step = Math.ceil(bytes.length / 400);
      for (let cut = 0; cut < bytes.length; cut += step) outcome(bytes.subarray(0, cut));
    }
  });

  test("a seeded storm of byte mutations in the directory and the cmap never surfaces a raw error", () => {
    let seed = 20260929;
    const random = (): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    let refused = 0;
    for (const spec of Object.values(TEXT_FONTS)) {
      const original = real(spec.file);
      const view = new DataView(original.buffer, original.byteOffset, original.byteLength);
      let cmapAt = 0;
      for (let i = 0; i < view.getUint16(4); i++) {
        const record = 12 + 16 * i;
        if (String.fromCharCode(...original.subarray(record, record + 4)) === "cmap") cmapAt = view.getUint32(record + 8);
      }
      for (let round = 0; round < 500; round++) {
        const copy = original.slice();
        for (let m = 0; m < 1 + Math.floor(random() * 6); m++) {
          const inDirectory = random() < 0.2;
          const at = inDirectory ? Math.floor(random() * (12 + 16 * view.getUint16(4))) : cmapAt + Math.floor(random() * 96);
          copy[at] = Math.floor(random() * 256);
        }
        if (outcome(copy) === "refused") refused++;
      }
    }
    expect(refused).toBeGreaterThan(0);
  });

  test("a lookup stays fast on the whole Unicode range", () => {
    const has = cmapCoverage(real(TEXT_FONTS.manrope.file));
    const started = performance.now();
    for (let cp = 0; cp < 0x30000; cp++) has(cp);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
