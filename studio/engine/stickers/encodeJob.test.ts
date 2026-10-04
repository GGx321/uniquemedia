import { describe, expect, test } from "bun:test";
import { inspectApng } from "../../shared/stickers/apng";
import { decodeFrames } from "../../scripts/stickers/apngDecode.testkit";
import { EncodeTooLargeError, encodeStickerFrames } from "./encodeJob";

// 3f.5: the encode worker's job, with the raw frames behind a function so no file or thread is needed. The thread and its file are
// tested in encodeGate.test.ts (scripted) and encodeGate.real.test.ts (real).

const W = 10;
const H = 6;

function frame(n: number): Uint8Array {
  const out = new Uint8Array(W * H * 4);
  for (let i = 0; i < out.length; i++) out[i] = (i * 5 + n * 41 + (i >> 2)) & 255;
  return out;
}

const framesOf = (count: number): Uint8Array[] => Array.from({ length: count }, (_, n) => frame(n));

function encode(slots: number[], frames: Uint8Array[], maxBytes = 5 * 1024 * 1024) {
  const asked: number[] = [];
  const bytes = encodeStickerFrames({ width: W, height: H, slots, maxBytes }, (index, into) => {
    asked.push(index);
    into.set(frames[index] ?? new Uint8Array(W * H * 4));
  });
  return { bytes, asked };
}

describe("encodeStickerFrames", () => {
  test("writes each kept frame with the slots it was given", () => {
    const { bytes } = encode([2, 1, 3], framesOf(3));
    const result = inspectApng(bytes);
    if (!result.ok) throw new Error(result.code);
    expect(result.info.frames.map((f) => f.delayFrames)).toEqual([2, 1, 3]);
    expect(result.info.loopFrames).toBe(6);
  });

  test("the pixels of a kept frame are the raw file's", () => {
    const frames = framesOf(3);
    const decoded = decodeFrames(encode([1, 1, 1], frames).bytes, W, H);
    expect(decoded.map((d, i) => Buffer.from(d).equals(Buffer.from(frames[i] ?? new Uint8Array())))).toEqual([true, true, true]);
  });

  test("a frame with no slot is not read and not written", () => {
    const frames = framesOf(4);
    const { bytes, asked } = encode([1, 0, 2, 0], frames);
    expect(asked).toEqual([0, 2]);
    const decoded = decodeFrames(bytes, W, H);
    expect(decoded).toHaveLength(2);
    expect(Buffer.from(decoded[1] ?? new Uint8Array()).equals(Buffer.from(frames[2] ?? new Uint8Array()))).toBe(true);
    const result = inspectApng(bytes);
    if (!result.ok) throw new Error(result.code);
    expect(result.info.frames.map((f) => f.delayFrames)).toEqual([1, 2]);
  });

  test("frames are read in order, one at a time", () => {
    expect(encode([1, 1, 1, 1], framesOf(4)).asked).toEqual([0, 1, 2, 3]);
  });

  test("a file that grows past the byte limit stops with EncodeTooLargeError", () => {
    let seed = 7;
    const noise = (): Uint8Array => Uint8Array.from({ length: W * H * 4 }, () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) >> 16) & 255);
    const frames = Array.from({ length: 40 }, noise);
    expect(() => encode(Array.from({ length: 40 }, () => 1), frames, 1500)).toThrow(EncodeTooLargeError);
  });

  test("a read that fails fails the job (the error travels, it is not swallowed)", () => {
    expect(() =>
      encodeStickerFrames({ width: W, height: H, slots: [1, 1], maxBytes: 1 << 20 }, () => {
        throw new Error("short read");
      }),
    ).toThrow("short read");
  });

  test("slots that make no loop at all are refused", () => {
    expect(() => encode([0, 0], framesOf(2))).toThrow();
  });
});
