import type { FaceGateImage } from "../face";
import { createWasmImageDecoder, type DecodeBackend } from "./wasmDecode";

/**
 * The engine's WASM image decoder, built at its FIRST use (the own-photo importer, 3f.2) and not at the engine's start: the codecs are
 * read from disk, hash-checked, compiled and smoke-decoded (`createRealDecodeBackend`), which a library that never imports a photo
 * should not pay. The load runs once, also for decodes asked together. A load that failed (a codec file missing) is NOT remembered: the
 * next decode tries again, so a repaired install works without a restart.
 */
export function createLazyImageDecoder(load: () => Promise<DecodeBackend>, options: { maxPixels?: number } = {}): (bytes: Uint8Array, signal: AbortSignal) => Promise<FaceGateImage> {
  let decoder: Promise<ReturnType<typeof createWasmImageDecoder>> | undefined;
  return async (bytes, signal) => {
    if (decoder === undefined) {
      const loading = load().then((backend) => createWasmImageDecoder(backend, options));
      decoder = loading;
      loading.catch(() => {
        if (decoder === loading) decoder = undefined;
      });
    }
    return (await decoder)(bytes, signal);
  };
}
