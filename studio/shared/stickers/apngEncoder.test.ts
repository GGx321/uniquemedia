import { describe, expect, test } from "bun:test";
import { inspectApng } from "./apng";
import { ApngTooLargeError, createApngEncoder, encodeApng } from "./apngWriter";
import { decodeFrames } from "../../scripts/stickers/apngDecode.testkit";

// 3f.5: the writer is incremental now (an own sticker has up to 300 frames of up to 720 x 720, so the frames cannot all be in memory) and a
// frame can last more than one 30 fps frame (the import quantises an owner's delays onto the grid).

const W = 12;
const H = 8;

function frame(n: number): Uint8Array {
  const out = new Uint8Array(W * H * 4);
  for (let i = 0; i < out.length; i++) out[i] = (i * 7 + n * 31 + (i >> 3)) & 255;
  return out;
}

describe("createApngEncoder", () => {
  test("writes each frame's own delay, in 30 fps frames", () => {
    const encoder = createApngEncoder({ width: W, height: H, frameCount: 3 });
    encoder.add(frame(0), 2);
    encoder.add(frame(1), 1);
    encoder.add(frame(2), 5);
    const result = inspectApng(encoder.finish());
    if (!result.ok) throw new Error(result.code);
    expect(result.info.frames.map((f) => f.delayFrames)).toEqual([2, 1, 5]);
    expect(result.info.loopFrames).toBe(8);
  });

  test("a frame lasts one 30 fps frame when no delay is given", () => {
    const encoder = createApngEncoder({ width: W, height: H, frameCount: 2 });
    encoder.add(frame(0));
    encoder.add(frame(1));
    const result = inspectApng(encoder.finish());
    if (!result.ok) throw new Error(result.code);
    expect(result.info.frames.map((f) => f.delayFrames)).toEqual([1, 1]);
  });

  test("writes the same bytes as encodeApng for the same frames", () => {
    const frames = [frame(0), frame(1), frame(2)];
    const encoder = createApngEncoder({ width: W, height: H, frameCount: 3 });
    for (const f of frames) encoder.add(f);
    expect(Buffer.from(encoder.finish()).equals(Buffer.from(encodeApng({ width: W, height: H, frames })))).toBe(true);
  });

  test("the pixels survive, whatever each frame's delay", () => {
    const frames = [frame(0), frame(1), frame(2)];
    const encoder = createApngEncoder({ width: W, height: H, frameCount: 3 });
    encoder.add(frames[0] ?? new Uint8Array(), 3);
    encoder.add(frames[1] ?? new Uint8Array(), 1);
    encoder.add(frames[2] ?? new Uint8Array(), 2);
    const decoded = decodeFrames(encoder.finish(), W, H);
    expect(decoded.map((d, i) => Buffer.from(d).equals(Buffer.from(frames[i] ?? new Uint8Array())))).toEqual([true, true, true]);
  });

  test("a frame of the wrong size is refused", () => {
    const encoder = createApngEncoder({ width: W, height: H, frameCount: 1 });
    expect(() => encoder.add(new Uint8Array(W * H * 4 - 1))).toThrow();
  });

  test("a frame with a delay below 1 or not a whole number is refused", () => {
    const encoder = createApngEncoder({ width: W, height: H, frameCount: 1 });
    expect(() => encoder.add(frame(0), 0)).toThrow();
    expect(() => encoder.add(frame(0), 1.5)).toThrow();
  });

  test("more frames than were declared are refused", () => {
    const encoder = createApngEncoder({ width: W, height: H, frameCount: 1 });
    encoder.add(frame(0));
    expect(() => encoder.add(frame(1))).toThrow();
  });

  test("finishing before the declared frames are all in is refused", () => {
    const encoder = createApngEncoder({ width: W, height: H, frameCount: 2 });
    encoder.add(frame(0));
    expect(() => encoder.finish()).toThrow();
  });

  test("a canvas or a frame count that makes no animation is refused", () => {
    expect(() => createApngEncoder({ width: 0, height: H, frameCount: 1 })).toThrow();
    expect(() => createApngEncoder({ width: W, height: H, frameCount: 0 })).toThrow();
  });

  test("stops with ApngTooLargeError the moment the file would pass its byte limit, before the rest of the frames are compressed", () => {
    // A frame of noise does not compress: a few of them pass a 2 KiB limit.
    const noise = (n: number): Uint8Array => {
      let seed = 12345 + n;
      return Uint8Array.from({ length: W * H * 4 }, () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) >> 16) & 255);
    };
    const encoder = createApngEncoder({ width: W, height: H, frameCount: 50, maxBytes: 2048 });
    let added = 0;
    expect(() => {
      for (let i = 0; i < 50; i++) {
        encoder.add(noise(i));
        added += 1;
      }
    }).toThrow(ApngTooLargeError);
    expect(added).toBeLessThan(10);
  });

  test("the finished file is held to the byte limit too", () => {
    const encoder = createApngEncoder({ width: W, height: H, frameCount: 1, maxBytes: 100 });
    expect(() => {
      encoder.add(frame(0));
      encoder.finish();
    }).toThrow(ApngTooLargeError);
  });
});
