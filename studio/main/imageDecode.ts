import type { EngineCall, MainReply } from "../engine/control";

// T7b's own decode decision: the face gate needs Electron's nativeImage,
// which only the real main process has (confirmed empirically — the
// engine's utilityProcess exposes only `net` and `systemPreferences` from
// the "electron" module — and the engine's own runtime rule forbids
// importing "electron" there regardless). This is main's side of the
// engine->main channel (control.ts's EngineCall/MainReply): `main.ts` wires
// `handleImageDecodeCall` with the real `nativeImageDecoder`; every other
// module here stays Electron-free and test-only-fake-driven, the same DI
// shape `mediaProtocol.ts` and `keyFlow.ts` already use.

/** What one decode produces: `nativeImage.toBitmap()`'s own byte order (BGRA), untagged — `handleImageDecodeCall` tags it. */
export interface DecodedImage {
  width: number;
  height: number;
  data: Uint8Array<ArrayBuffer>;
}

/** Injectable so tests never need a real Electron app; `nativeImageDecoder` below wraps the real thing. */
export type ImageDecoder = (bytes: Uint8Array) => DecodedImage;

export interface ImageDecodeDeps {
  decode: ImageDecoder;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Answers one engine `image.decode` call: never throws — a decoder that
 * throws, or answers a zero-size image (`nativeImage.createFromBuffer`'s own
 * way of saying it could not decode the bytes at all, mirroring
 * `electronDecode.mjs`'s own `width === 0 || height === 0` check), both
 * become a `VALIDATION` `MainReply`. `runs/faceGate.ts` reads that error the
 * same way it reads any other decode failure: a retry, not a broken gate.
 */
export function handleImageDecodeCall(call: Extract<EngineCall, { type: "image.decode" }>, deps: ImageDecodeDeps): MainReply {
  try {
    const { width, height, data } = deps.decode(call.bytes);
    if (width === 0 || height === 0) {
      return { kind: "control", type: "mainReply", callId: call.callId, error: { code: "VALIDATION", detail: "the image could not be decoded (zero size)" } };
    }
    return { kind: "control", type: "mainReply", callId: call.callId, image: { format: "bgra", width, height, data } };
  } catch (error) {
    return { kind: "control", type: "mainReply", callId: call.callId, error: { code: "VALIDATION", detail: `the image could not be decoded: ${messageOf(error)}` } };
  }
}

/** The slice of Electron's `nativeImage` module this file needs — injected so it never imports "electron" itself. */
export interface NativeImageLike {
  createFromBuffer(buffer: Buffer): {
    getSize(): { width: number; height: number };
    toBitmap(): Buffer;
  };
}

/**
 * The real decoder: Electron's `nativeImage.toBitmap()` — BGRA, the same
 * Chromium/libjpeg-turbo decode the spike's parity numbers were measured
 * against (pixels.ts's own header comment). `main.ts` is the only caller
 * that ever passes the real `nativeImage` module in.
 */
export function nativeImageDecoder(nativeImage: NativeImageLike): ImageDecoder {
  return (bytes) => {
    const image = nativeImage.createFromBuffer(Buffer.from(bytes));
    const { width, height } = image.getSize();
    const bitmap = image.toBitmap();
    // A fresh, plain ArrayBuffer-backed copy: Buffer's own backing store is
    // typed ArrayBufferLike (it could in principle be a SharedArrayBuffer),
    // which `DecodedImage.data`'s (and control.ts's `MainReply.image.data`)
    // own `Uint8Array` does not accept without this copy.
    const data = new Uint8Array(bitmap.length);
    data.set(bitmap);
    return { width, height, data };
  };
}
