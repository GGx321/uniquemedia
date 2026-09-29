import { beforeAll, describe, expect, test } from "bun:test";
import { useNativeGlobals } from "../../../testing/nativeGlobals";
import { EmojiFontError, type EmojiFontErrorCode, openEmojiFont } from "./emojiFont";
import { craftedGsubFont } from "./craftedFont.testkit";
import { loadPinnedEmojiFont } from "./emojiFont.testkit";
useNativeGlobals();

// Each structure the reader parses has a bound; this pins that a value past it is refused, at open, with the
// right typed error and quickly, instead of a RangeError from DataView or a loop that runs to the value.

let pristine: Uint8Array;
beforeAll(async () => {
  pristine = await loadPinnedEmojiFont();
});

/** Independent of the reader: where a table starts, straight from the directory. */
function tableAt(bytes: Uint8Array, tag: string): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < view.getUint16(4); i++) {
    const record = 12 + 16 * i;
    if (String.fromCharCode(...bytes.subarray(record, record + 4)) === tag) return view.getUint32(record + 8);
  }
  throw new Error(`no ${tag}`);
}

/** Runs `change` on a copy of the font and returns the code of the error `openEmojiFont` throws, or "OPENED". */
function outcome(change: (bytes: Uint8Array, view: DataView) => Uint8Array | void): EmojiFontErrorCode | "OPENED" | "OTHER" {
  const copy = pristine.slice();
  const changed = change(copy, new DataView(copy.buffer)) ?? copy;
  const started = performance.now();
  try {
    openEmojiFont(changed);
    return "OPENED";
  } catch (error) {
    if (performance.now() - started > 200) throw new Error("refusing took too long");
    return error instanceof EmojiFontError ? error.code : "OTHER";
  }
}

/** The encoding record of the format 12 cmap subtable (platform 3, encoding 10). */
function cmapRecord(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer);
  const cmap = tableAt(bytes, "cmap");
  for (let i = 0; i < view.getUint16(cmap + 2); i++) {
    if (view.getUint16(cmap + 4 + 8 * i) === 3 && view.getUint16(cmap + 6 + 8 * i) === 10) return cmap + 4 + 8 * i;
  }
  throw new Error("no format 12 subtable");
}

function cmapSubtable(bytes: Uint8Array): number {
  return tableAt(bytes, "cmap") + new DataView(bytes.buffer).getUint32(cmapRecord(bytes) + 4);
}

/** The first index subtable of the strike. */
function firstIndexSubtable(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer);
  const cblc = tableAt(bytes, "CBLC");
  return cblc + view.getUint32(cblc + 8) + view.getUint32(cblc + 8 + view.getUint32(cblc + 8) + 4);
}

test("the untouched font opens", () => {
  expect(outcome(() => {})).toBe("OPENED");
});

describe("the file and its directory", () => {
  test("empty input is not a font", () => {
    expect(outcome(() => new Uint8Array(0))).toBe("NOT_A_FONT");
  });

  test("eleven bytes is too short to be a font", () => {
    expect(outcome((bytes) => bytes.subarray(0, 11))).toBe("NOT_A_FONT");
  });

  test("an OpenType CFF font is not a CBDT font", () => {
    expect(outcome((_, view) => view.setUint32(0, 0x4f54544f))).toBe("NOT_A_FONT");
  });

  test("more tables than any font has is refused", () => {
    expect(outcome((_, view) => view.setUint16(4, 0xffff))).toBe("TOO_LARGE");
  });

  test("a directory cut short is truncated", () => {
    expect(outcome((bytes) => bytes.subarray(0, 100))).toBe("TRUNCATED");
  });

  test("a table that runs past the end of the file is truncated", () => {
    expect(outcome((bytes) => bytes.subarray(0, bytes.byteLength - 1))).toBe("TRUNCATED");
  });

  test("a table with an offset near 4 GiB is truncated, not wrapped", () => {
    expect(outcome((bytes, view) => view.setUint32(12 + 16 * 1 + 8, 0xffffffff))).toBe("TRUNCATED");
  });

  test("a missing table is not a CBDT font", () => {
    expect(outcome((bytes) => bytes.set([0x58], tableTagAt(bytes, "GSUB")))).toBe("NOT_A_FONT");
  });
});

function tableTagAt(bytes: Uint8Array, tag: string): number {
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < view.getUint16(4); i++) {
    const record = 12 + 16 * i;
    if (String.fromCharCode(...bytes.subarray(record, record + 4)) === tag) return record;
  }
  throw new Error(`no ${tag}`);
}

describe("cmap", () => {
  test("four billion groups are refused before any is read", () => {
    expect(outcome((bytes, view) => view.setUint32(cmapSubtable(bytes) + 12, 0xffffffff))).toBe("TOO_LARGE");
  });

  test("groups that run past the table are truncated", () => {
    expect(outcome((bytes, view) => view.setUint32(cmapSubtable(bytes) + 12, 60_000))).toBe("TRUNCATED");
  });

  test("groups that are not sorted are refused", () => {
    expect(outcome((bytes, view) => view.setUint32(cmapSubtable(bytes) + 16, 0x10ffff))).toBe("BAD_TABLE");
  });

  test("groups that overlap are refused", () => {
    expect(outcome((bytes, view) => view.setUint32(cmapSubtable(bytes) + 16 + 12, 0))).toBe("BAD_TABLE");
  });

  test("a group that ends before it starts is refused", () => {
    expect(outcome((bytes, view) => view.setUint32(cmapSubtable(bytes) + 16 + 12 + 4, 0))).toBe("BAD_TABLE");
  });

  test("a group ending past U+10FFFF is refused", () => {
    expect(outcome((bytes, view) => view.setUint32(cmapSubtable(bytes) + 20, 0xffffffff))).toBe("BAD_TABLE");
  });

  test("a group that maps past the last glyph is refused", () => {
    expect(outcome((bytes, view) => view.setUint16(tableAt(bytes, "maxp") + 4, 10))).toBe("BAD_TABLE");
  });

  test("a cmap with only a BMP subtable is unsupported", () => {
    expect(outcome((bytes, view) => view.setUint16(tableAt(bytes, "cmap") + 2, 0))).toBe("UNSUPPORTED");
  });

  test("the format 12 subtable's offset past the table is truncated", () => {
    expect(outcome((bytes, view) => view.setUint32(cmapRecord(bytes) + 4, 0xffffff))).toBe("TRUNCATED");
  });
});

describe("GSUB", () => {
  test("a version other than 1 is refused", () => {
    expect(outcome((bytes, view) => view.setUint16(tableAt(bytes, "GSUB"), 7))).toBe("BAD_TABLE");
  });

  test("65535 lookups are refused before any is read", () => {
    expect(outcome((bytes, view) => view.setUint16(tableAt(bytes, "GSUB") + view.getUint16(tableAt(bytes, "GSUB") + 8), 0xffff))).toBe("TOO_LARGE");
  });

  test("a coverage table that repeats a glyph is refused", () => {
    const outcomeOfRepeat = outcome((bytes, view) => {
      const gsub = tableAt(bytes, "GSUB");
      const lookups = gsub + view.getUint16(gsub + 8);
      const lookup = lookups + view.getUint16(lookups + 2);
      const subtable = lookup + view.getUint16(lookup + 6);
      const coverage = subtable + view.getUint16(subtable + 2);
      if (view.getUint16(coverage) === 1) view.setUint16(coverage + 6, view.getUint16(coverage + 4));
      else view.setUint16(coverage + 4 + 6, view.getUint16(coverage + 4));
    });
    expect(outcomeOfRepeat).toBe("BAD_TABLE");
  });

  test("a lookup list offset past the table is truncated", () => {
    expect(outcome((bytes, view) => view.setUint16(tableAt(bytes, "GSUB") + 8, 0xffff))).toBe("TRUNCATED");
  });

  test("a ligature glyph past the last glyph is refused", () => {
    // maxp.numGlyphs below the largest ligature glyph, above every cmap group: the cmap check would fire first, so cut
    // it exactly at the highest glyph the cmap maps.
    const highest = highestCmapGlyph(pristine);
    expect(outcome((bytes, view) => view.setUint16(tableAt(bytes, "maxp") + 4, highest + 1))).toBe("BAD_TABLE");
  });
});

/** The highest glyph id any cmap group maps to, so `numGlyphs = that + 1` passes the cmap check. */
function highestCmapGlyph(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer);
  const subtable = cmapSubtable(bytes);
  let highest = 0;
  for (let g = 0; g < view.getUint32(subtable + 12); g++) {
    const at = subtable + 16 + 12 * g;
    highest = Math.max(highest, view.getUint32(at + 8) + view.getUint32(at + 4) - view.getUint32(at));
  }
  return highest;
}

describe("GSUB work is bounded overall", () => {
  const base = { lookups: 1, subtables: 1, coverageGlyphs: 1, ligatures: 0, components: 2 };
  const crafted = (spec: Partial<typeof base>) => outcome(() => craftedGsubFont({ ...base, ...spec }));

  test("a crafted GSUB that fits every per-structure cap but is read 512 x 256 times is refused, and fast", () => {
    // 131 072 references to ONE 65 535-glyph coverage with empty ligature sets: no ligature is ever counted.
    const started = performance.now();
    expect(crafted({ lookups: 512, subtables: 256, coverageGlyphs: 65535 })).toBe("TOO_LARGE");
    expect(performance.now() - started).toBeLessThan(500);
  });

  test("a few dozen reads of a big coverage are already refused", () => {
    expect(crafted({ lookups: 2, subtables: 16, coverageGlyphs: 65535 })).toBe("TOO_LARGE");
  });

  test("the same reads of a small coverage are within budget (the font then fails later, for want of CBDT)", () => {
    expect(crafted({ lookups: 2, subtables: 16, coverageGlyphs: 100 })).toBe("NOT_A_FONT");
  });

  test("257 subtables in one lookup are refused", () => {
    expect(crafted({ subtables: 257 })).toBe("TOO_LARGE");
  });

  test("256 subtables in one lookup are within the cap", () => {
    expect(crafted({ subtables: 256 })).toBe("NOT_A_FONT");
  });

  test("513 lookups are refused", () => {
    expect(crafted({ lookups: 513 })).toBe("TOO_LARGE");
  });

  test("more than 100 000 ligatures in all are refused", () => {
    expect(crafted({ coverageGlyphs: 2, ligatures: 60_000 })).toBe("TOO_LARGE");
  });

  test("100 000 ligatures exactly are within the cap", () => {
    expect(crafted({ coverageGlyphs: 2, ligatures: 50_000 })).toBe("NOT_A_FONT");
  });

  test("a ligature of 33 components is refused", () => {
    expect(crafted({ ligatures: 1, components: 33 })).toBe("BAD_TABLE");
  });

  test("a ligature of 32 components is within the cap", () => {
    expect(crafted({ ligatures: 1, components: 32 })).toBe("NOT_A_FONT");
  });

  test("a ligature of no components is refused", () => {
    expect(crafted({ ligatures: 1, components: 0 })).toBe("BAD_TABLE");
  });
});

describe("CBLC and CBDT", () => {
  test("no strike is unsupported", () => {
    expect(outcome((bytes, view) => view.setUint32(tableAt(bytes, "CBLC") + 4, 0))).toBe("UNSUPPORTED");
  });

  test("four billion strikes are refused before any is read", () => {
    expect(outcome((bytes, view) => view.setUint32(tableAt(bytes, "CBLC") + 4, 0xffffffff))).toBe("TOO_LARGE");
  });

  test("four billion index subtables are refused before any is read", () => {
    expect(outcome((bytes, view) => view.setUint32(tableAt(bytes, "CBLC") + 8 + 8, 0xffffffff))).toBe("TOO_LARGE");
  });

  test("index subtables beyond the real three read as garbage and are refused", () => {
    expect(outcome((bytes, view) => view.setUint32(tableAt(bytes, "CBLC") + 8 + 8, 4000))).toBe("BAD_TABLE");
  });

  test("a strike whose array offset is past the table is truncated", () => {
    expect(outcome((bytes, view) => view.setUint32(tableAt(bytes, "CBLC") + 8, 0xffffff))).toBe("TRUNCATED");
  });

  test("index format 2 is unsupported", () => {
    expect(outcome((bytes, view) => view.setUint16(firstIndexSubtable(bytes), 2))).toBe("UNSUPPORTED");
  });

  test("image format 18 is unsupported", () => {
    expect(outcome((bytes, view) => view.setUint16(firstIndexSubtable(bytes) + 2, 18))).toBe("UNSUPPORTED");
  });

  test("a glyph range past the last glyph is refused", () => {
    expect(outcome((bytes, view) => view.setUint16(tableAt(bytes, "CBLC") + 8 + view.getUint32(tableAt(bytes, "CBLC") + 8) + 2, 0xffff))).toBe("BAD_TABLE");
  });

  test("an image data offset past CBDT is refused", () => {
    expect(outcome((bytes, view) => view.setUint32(firstIndexSubtable(bytes) + 4, 0x7fffffff))).toBe("BAD_TABLE");
  });

  test("a CBLC of an unknown version is unsupported", () => {
    expect(outcome((bytes, view) => view.setUint32(tableAt(bytes, "CBLC"), 0x00020000))).toBe("UNSUPPORTED");
  });

  test("a PNG whose first chunk is not a 13-byte IHDR is refused (length)", () => {
    expect(outcome((bytes, view) => view.setUint32(tableAt(bytes, "CBDT") + 1_557_285 + 9 + 8, 12))).toBe("BAD_TABLE");
  });

  test("a PNG whose first chunk is not a 13-byte IHDR is refused (type)", () => {
    expect(outcome((bytes) => bytes.set([0x58], tableAt(bytes, "CBDT") + 1_557_285 + 9 + 12))).toBe("BAD_TABLE");
  });

  test("a CBDT of an unknown version is unsupported", () => {
    expect(outcome((bytes, view) => view.setUint16(tableAt(bytes, "CBDT"), 9))).toBe("UNSUPPORTED");
  });

  test("a bitmap that is not a PNG is refused", () => {
    // Glyph 883 (the grinning face) starts 1 557 285 bytes into CBDT; its PNG signature 9 bytes after that.
    expect(outcome((bytes) => bytes.set([0x00], tableAt(bytes, "CBDT") + 1_557_285 + 9))).toBe("BAD_TABLE");
  });

  test("a PNG whose size disagrees with its metrics is refused", () => {
    expect(outcome((bytes) => bytes.set([0x07], tableAt(bytes, "CBDT") + 1_557_285 + 9 + 19))).toBe("BAD_TABLE");
  });

  test("a glyph data length that disagrees with the index is refused", () => {
    expect(outcome((bytes, view) => view.setUint32(tableAt(bytes, "CBDT") + 1_557_285 + 5, 5))).toBe("BAD_TABLE");
  });
});
