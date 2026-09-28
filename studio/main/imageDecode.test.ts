import { describe, expect, test } from "bun:test";
import type { EngineCall } from "../engine/control";
import { handleImageDecodeCall, nativeImageDecoder, type ImageDecoder } from "./imageDecode";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// T7b: main's side of the engine->main decode channel (qa.ts's own comment on
// QaInput.decodeImage, control.ts's EngineCall/MainReply). `handleImageDecodeCall`
// takes an injected decoder so this file never touches Electron's real
// nativeImage — `nativeImageDecoder` below wraps it, but only ever runs
// against a fake shaped like it (the real thing needs a live Electron app,
// exactly like face/testing/decodeWithElectron.ts's own parity harness).

function call(bytes: Extract<EngineCall, { type: "image.decode" }>["bytes"] = Uint8Array.of(0xff, 0xd8, 0xff)): Extract<EngineCall, { type: "image.decode" }> {
  return { kind: "control", type: "image.decode", callId: "call-00000001", bytes };
}

describe("handleImageDecodeCall", () => {
  test("a successful decode answers with the tagged bgra image, no error", () => {
    const decoder: ImageDecoder = () => ({ width: 4, height: 4, data: new Uint8Array(4 * 4 * 4).fill(7) });

    const reply = handleImageDecodeCall(call(), { decode: decoder });

    expect(reply).toEqual({
      kind: "control",
      type: "mainReply",
      callId: "call-00000001",
      image: { format: "bgra", width: 4, height: 4, data: new Uint8Array(4 * 4 * 4).fill(7) },
    });
  });

  test("a decoder that throws answers with a VALIDATION error, never throws itself", () => {
    const decoder: ImageDecoder = () => {
      throw new Error("not a supported image");
    };

    const reply = handleImageDecodeCall(call(), { decode: decoder });

    expect(reply.error?.code).toBe("VALIDATION");
    expect(reply.error?.detail).toContain("not a supported image");
    expect(reply.image).toBeUndefined();
  });

  test("a decoder that returns a zero size (nativeImage's own way of saying it failed) answers with VALIDATION", () => {
    const decoder: ImageDecoder = () => ({ width: 0, height: 0, data: new Uint8Array(0) });

    const reply = handleImageDecodeCall(call(), { decode: decoder });

    expect(reply.error?.code).toBe("VALIDATION");
    expect(reply.image).toBeUndefined();
  });

  test("the reply always carries the call's own callId", () => {
    const decoder: ImageDecoder = () => ({ width: 1, height: 1, data: new Uint8Array(4) });

    const reply = handleImageDecodeCall(call(Uint8Array.of(1, 2, 3)), { decode: decoder });

    expect(reply.callId).toBe("call-00000001");
  });
});

describe("nativeImageDecoder", () => {
  test("wraps a nativeImage-shaped dependency: bytes in, size + toBitmap() out", () => {
    const seen: Buffer[] = [];
    const fakeNativeImage = {
      createFromBuffer: (buffer: Buffer) => {
        seen.push(buffer);
        return {
          getSize: () => ({ width: 2, height: 3 }),
          toBitmap: () => Buffer.alloc(2 * 3 * 4, 9),
        };
      },
    };
    const decode = nativeImageDecoder(fakeNativeImage);

    const result = decode(Uint8Array.of(0xff, 0xd8, 0xff));

    expect(result).toEqual({ width: 2, height: 3, data: new Uint8Array(2 * 3 * 4).fill(9) });
    expect(seen).toHaveLength(1);
    expect(Buffer.from(seen[0]!)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  });
});
