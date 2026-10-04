import { describe, expect, test } from "bun:test";
import { inspectGif } from "./gif";
import { buildGif, lzw, lzwCompress } from "./gif.testkit";

// The testkit's compressing LZW (3f.5): the literal-only `lzw` writes a stream as big as the picture, which a 720 x 720 GIF of 300 frames
// could never be within the 5 MB cap. `lzwCompress` is a real dictionary encoder, so a flat frame of the largest canvas is a few KB. It is held to a
// reference decoder here (every index back, exactly), and the bounded GIF reader counts it as the pixels it was made from.

/** A reference LZW decoder for GIF (LSB-first codes, a clear and an end code), written for the test and nothing else. */
function decode(data: Uint8Array, minCodeSize: number): number[] {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  let table: number[][] = [];
  const reset = (): void => {
    table = Array.from({ length: clear + 2 }, (_, i) => (i < clear ? [i] : []));
  };
  reset();
  let width = minCodeSize + 1;
  let acc = 0;
  let bits = 0;
  let previous: number[] | null = null;
  const out: number[] = [];
  for (const byte of data) {
    acc |= byte << bits;
    bits += 8;
    while (bits >= width) {
      const code = acc & ((1 << width) - 1);
      acc >>>= width;
      bits -= width;
      if (code === clear) {
        reset();
        width = minCodeSize + 1;
        previous = null;
        continue;
      }
      if (code === eoi) return out;
      let entry: number[];
      if (code < table.length) entry = table[code] ?? [];
      else if (previous !== null) entry = [...previous, previous[0] ?? 0];
      else throw new Error("a code with nothing to refer to");
      out.push(...entry);
      if (previous !== null && table.length < 4096) {
        table.push([...previous, entry[0] ?? 0]);
        if (table.length === 1 << width && width < 12) width += 1;
      }
      previous = entry;
    }
  }
  return out;
}

const noise = (length: number, seed: number, colours = 4): number[] => {
  let state = seed;
  return Array.from({ length }, () => ((state = (state * 1103515245 + 12345) & 0x7fffffff) >> 16) % colours);
};

describe("lzwCompress", () => {
  test("a flat frame is a few KB where the literal stream is as big as the picture", () => {
    const flat = Array.from({ length: 720 * 720 }, () => 2);
    expect(lzwCompress(flat).length).toBeLessThan(8_000);
    expect(lzw(flat.slice(0, 20_000)).length).toBeGreaterThan(8_000);
  });

  test.each([
    ["one pixel", [1]],
    ["a run", Array.from({ length: 500 }, () => 3)],
    ["two colours in stripes", Array.from({ length: 900 }, (_, i) => (i >> 3) % 2)],
    ["noise of four colours", noise(6_000, 7)],
    ["noise long enough to fill the table (more than 4096 codes) and clear it", noise(60_000, 11)],
    ["a picture whose rows repeat", Array.from({ length: 64 * 64 }, (_, i) => ((i % 64) * 3) % 4)],
  ])("%s decodes to exactly the indices it was made from", (_name, indices) => {
    expect(decode(lzwCompress(indices), 2)).toEqual(indices);
  });

  test("a bigger minimum code size is honoured", () => {
    const indices = noise(5_000, 3, 16);
    expect(decode(lzwCompress(indices, 4), 4)).toEqual(indices);
  });

  test("the bounded GIF reader counts a compressed frame as the pixels it holds", () => {
    const indices = noise(40 * 30, 5);
    expect(inspectGif(buildGif({ width: 40, height: 30, frames: [{ indices, compress: true }, { indices: noise(40 * 30, 6), compress: true }] })).ok).toBe(true);
  });

  test("and refuses one that is a pixel short, as it does any other", () => {
    const result = inspectGif(buildGif({ width: 40, height: 30, frames: [{ indices: noise(40 * 30 - 1, 5), compress: true }, {}] }));
    expect(result.ok ? "ok" : result.code).toBe("FRAME_DATA_MISMATCH");
  });
});
