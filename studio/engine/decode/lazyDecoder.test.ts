import { describe, expect, test } from "bun:test";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { createLazyImageDecoder } from "./lazyDecoder";
import { SMOKE_TEST_PNG } from "./realBackend";
import type { DecodeBackend } from "./wasmDecode";
useNativeGlobals();

// The own-photo importer decodes in the engine process, and only when the owner imports a photo: the codecs are loaded (and checked) at the
// first use, once, and a load that failed is tried again at the next one.

const FRAME = { width: 2, height: 2, data: new Uint8Array(16) };
const backend = (): DecodeBackend => ({ decodeJpeg: async () => FRAME, decodePng: async () => FRAME });
const signal = (): AbortSignal => new AbortController().signal;

describe("createLazyImageDecoder", () => {
  test("loads nothing until the first decode", () => {
    let loads = 0;
    createLazyImageDecoder(async () => {
      loads++;
      return backend();
    });
    expect(loads).toBe(0);
  });

  test("loads the codecs once for many decodes, also when they are asked together", async () => {
    let loads = 0;
    const decode = createLazyImageDecoder(async () => {
      loads++;
      return backend();
    });
    await Promise.all([decode(SMOKE_TEST_PNG, signal()), decode(SMOKE_TEST_PNG, signal())]);
    await decode(SMOKE_TEST_PNG, signal());
    expect(loads).toBe(1);
  });

  test("decodes through the loaded codecs", async () => {
    const decode = createLazyImageDecoder(async () => backend());
    const image = await decode(SMOKE_TEST_PNG, signal());
    expect([image.width, image.height]).toEqual([2, 2]);
  });

  test("a load that failed is not remembered: the next decode loads again", async () => {
    let loads = 0;
    const decode = createLazyImageDecoder(async () => {
      loads++;
      if (loads === 1) throw new Error("the codec file is missing");
      return backend();
    });
    await expect(decode(SMOKE_TEST_PNG, signal())).rejects.toThrow("missing");
    const image = await decode(SMOKE_TEST_PNG, signal());
    expect(image.width).toBe(2);
    expect(loads).toBe(2);
  });
});
