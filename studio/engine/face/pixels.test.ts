import { expect, test } from "bun:test";
import { toBgrImage } from "./pixels";
import type { TaggedPixels } from "./pixels";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

test("rgba: converts one pixel to interleaved BGR, dropping alpha", () => {
  const pixels: TaggedPixels = { format: "rgba", width: 1, height: 1, data: new Uint8Array([10, 20, 30, 255]) };
  const bgr = toBgrImage(pixels);
  expect(bgr.width).toBe(1);
  expect(bgr.height).toBe(1);
  expect([...bgr.data]).toEqual([30, 20, 10]);
});

test("rgba: keeps row-major order for a 2x1 image", () => {
  // pixel 0: R=1 G=2 B=3, pixel 1: R=4 G=5 B=6
  const pixels: TaggedPixels = { format: "rgba", width: 2, height: 1, data: new Uint8Array([1, 2, 3, 255, 4, 5, 6, 255]) };
  expect([...toBgrImage(pixels).data]).toEqual([3, 2, 1, 6, 5, 4]);
});

test("bgra: converts one pixel to interleaved BGR by only dropping alpha (channel order already matches)", () => {
  // nativeImage.toBitmap()'s own format: byte order is already B, G, R, A.
  const pixels: TaggedPixels = { format: "bgra", width: 1, height: 1, data: new Uint8Array([10, 20, 30, 255]) };
  expect([...toBgrImage(pixels).data]).toEqual([10, 20, 30]);
});

test("bgra: keeps row-major order for a 2x1 image", () => {
  const pixels: TaggedPixels = { format: "bgra", width: 2, height: 1, data: new Uint8Array([1, 2, 3, 255, 4, 5, 6, 255]) };
  expect([...toBgrImage(pixels).data]).toEqual([1, 2, 3, 4, 5, 6]);
});

test("rgba and bgra of the same logical pixel produce different BGR output — the tag is load-bearing, not decorative", () => {
  const rgba = toBgrImage({ format: "rgba", width: 1, height: 1, data: new Uint8Array([10, 20, 30, 255]) });
  const bgra = toBgrImage({ format: "bgra", width: 1, height: 1, data: new Uint8Array([10, 20, 30, 255]) });
  expect([...rgba.data]).not.toEqual([...bgra.data]);
});

test("ignores the alpha channel's value entirely, in both formats", () => {
  for (const format of ["rgba", "bgra"] as const) {
    const opaque = toBgrImage({ format, width: 1, height: 1, data: new Uint8Array([9, 8, 7, 255]) });
    const transparent = toBgrImage({ format, width: 1, height: 1, data: new Uint8Array([9, 8, 7, 0]) });
    expect([...opaque.data]).toEqual([...transparent.data]);
  }
});

test("throws when the buffer length does not match width*height*4", () => {
  expect(() => toBgrImage({ format: "rgba", width: 2, height: 2, data: new Uint8Array(4) })).toThrow();
});

test("throws on an unrecognized pixel format instead of silently guessing a byte order", () => {
  const pixels = { format: "cmyk", width: 1, height: 1, data: new Uint8Array(4) } as unknown as TaggedPixels;
  expect(() => toBgrImage(pixels)).toThrow();
});
