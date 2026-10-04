import { describe, expect, test } from "bun:test";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { webpInfo } from "./webp";
useNativeGlobals();

// What a WebP's own header says (3f.2): its size and whether it animates. Read before ffmpeg is started, so an animated file and a file
// whose header claims too many pixels are turned away without a child process. Pure and bounded by the buffer; null for bytes that are
// not a WebP it can read.

const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));
const u32le = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const u24le = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff];
const chunk = (type: string, body: number[]): number[] => [...ascii(type), ...u32le(body.length), ...body, ...(body.length % 2 === 1 ? [0] : [])];
const riff = (...chunks: number[][]): Uint8Array => {
  const inner = [...ascii("WEBP"), ...chunks.flat()];
  return Uint8Array.from([...ascii("RIFF"), ...u32le(inner.length), ...inner]);
};
const vp8x = (flags: number, width: number, height: number): number[] => chunk("VP8X", [flags, 0, 0, 0, ...u24le(width - 1), ...u24le(height - 1)]);
/** A lossy keyframe's header: the frame tag, the start code, then 14-bit sizes. */
const vp8 = (width: number, height: number): number[] => chunk("VP8 ", [0x10, 0, 0, 0x9d, 0x01, 0x2a, width & 0xff, (width >>> 8) & 0x3f, height & 0xff, (height >>> 8) & 0x3f]);
/** A lossless header: the signature byte, then width-1 and height-1 as 14 bits each. */
const vp8l = (width: number, height: number): number[] => {
  const bits = (width - 1) | ((height - 1) << 14);
  return chunk("VP8L", [0x2f, bits & 0xff, (bits >>> 8) & 0xff, (bits >>> 16) & 0xff, (bits >>> 24) & 0xff]);
};

describe("webpInfo", () => {
  test("reads the size of a lossy WebP", () => {
    expect(webpInfo(riff(vp8(640, 480)))).toEqual({ width: 640, height: 480, animated: false });
  });

  test("reads the size of a lossless WebP", () => {
    expect(webpInfo(riff(vp8l(1000, 3)))).toEqual({ width: 1000, height: 3, animated: false });
  });

  test("reads the canvas of an extended WebP", () => {
    expect(webpInfo(riff(vp8x(0, 4096, 2), vp8(4096, 2)))).toEqual({ width: 4096, height: 2, animated: false });
  });

  test("reads the largest size the format has, 16383 by 16383", () => {
    expect(webpInfo(riff(vp8l(16383, 16383)))).toEqual({ width: 16383, height: 16383, animated: false });
  });

  test("an extended WebP with the animation flag animates", () => {
    expect(webpInfo(riff(vp8x(0x02, 100, 100), chunk("ANIM", [0, 0, 0, 0, 0, 0])))?.animated).toBe(true);
  });

  test("the animation flag ALONE makes it animated: no ANIM or ANMF chunk is needed", () => {
    expect(webpInfo(riff(vp8x(0x02, 100, 100), vp8(100, 100)))?.animated).toBe(true);
  });

  test("M3: a small VP8X canvas over a big bitstream is judged by the bigger size: ffmpeg decodes at the bitstream's", () => {
    expect(webpInfo(riff(vp8x(0, 100, 100), vp8(16000, 16000)))).toEqual({ width: 16000, height: 16000, animated: false });
    expect(webpInfo(riff(vp8x(0, 100, 100), vp8l(16000, 16000)))).toEqual({ width: 16000, height: 16000, animated: false });
  });

  test("M3: each side is judged by its larger value: a wide canvas over a tall bitstream is both", () => {
    expect(webpInfo(riff(vp8x(0, 5000, 10), vp8(10, 5000)))).toEqual({ width: 5000, height: 5000, animated: false });
  });

  test("M3: a big canvas over a small bitstream stays the canvas", () => {
    expect(webpInfo(riff(vp8x(0, 4096, 2), vp8(10, 2)))).toEqual({ width: 4096, height: 2, animated: false });
  });

  test("an ANMF frame chunk makes it animated even when the flag byte says no", () => {
    expect(webpInfo(riff(vp8x(0x00, 100, 100), chunk("ANMF", new Array<number>(16).fill(0))))?.animated).toBe(true);
  });

  test("an ANIM chunk makes it animated even without an extended header", () => {
    expect(webpInfo(riff(chunk("ANIM", [0, 0, 0, 0, 0, 0]), vp8(10, 10)))?.animated).toBe(true);
  });

  test("an alpha or ICC flag alone does not make it animated", () => {
    expect(webpInfo(riff(vp8x(0x10 | 0x20, 50, 60), vp8(50, 60)))?.animated).toBe(false);
  });

  test("a size of zero in a lossy header is not read", () => {
    expect(webpInfo(riff(vp8(0, 10)))).toBeNull();
  });

  test("a lossy chunk without its start code is not read", () => {
    const bad = chunk("VP8 ", [0x10, 0, 0, 0, 0, 0, 10, 0, 10, 0]);
    expect(webpInfo(riff(bad))).toBeNull();
  });

  test("bytes that are not a WebP are not read", () => {
    expect(webpInfo(new Uint8Array(0))).toBeNull();
    expect(webpInfo(Uint8Array.from(ascii("RIFFxxxxWAVEfmt ")))).toBeNull();
    expect(webpInfo(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBeNull();
  });

  test("a chunk longer than the file ends the walk without a size", () => {
    const bytes = Uint8Array.from([...ascii("RIFF"), ...u32le(0), ...ascii("WEBP"), ...ascii("VP8 "), ...u32le(0xffff_ffff), 0, 0]);
    expect(webpInfo(bytes)).toBeNull();
  });

  test("every prefix of a valid WebP answers a size or null and never throws", () => {
    const whole = riff(vp8x(0, 20, 30), vp8(20, 30));
    for (let length = 0; length <= whole.length; length++) {
      const info = webpInfo(whole.subarray(0, length));
      expect(info === null || (info.width > 0 && info.height > 0)).toBe(true);
    }
  });

  test("animation is found even when the animated chunk sits after a large image chunk", () => {
    const big = chunk("VP8L", new Array<number>(70_000).fill(0));
    expect(webpInfo(riff(vp8x(0, 10, 10), big, chunk("ANMF", new Array<number>(16).fill(0))))?.animated).toBe(true);
  });
});
