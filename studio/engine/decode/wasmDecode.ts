import type { FaceGateImage } from "../face";
import { imageSize, sniffImageMediaType } from "../library/media";

/**
 * Security review, T7b section A: decoding network-sourced image bytes with
 * native Chromium decoders in the privileged main process (which can decrypt
 * the API key) is not acceptable. This module decodes them in the engine
 * instead, with a WASM JPEG/PNG decoder (`@jsquash/jpeg`/`@jsquash/png`,
 * mozjpeg/squoosh WASM) — measured byte-identical to Electron's `nativeImage`
 * on the parity fixture set (studio/engine/face/parity.test.ts). The engine
 * stays Electron-free: this file uses only node:* APIs and the two codec
 * packages (both pure JS/WASM, no native addon, no `fetch` — the caller hands
 * in an already-compiled `WebAssembly.Module`, loaded from disk and
 * sha256-checked — see realBackend.ts).
 *
 * A 16-megapixel header-parsed pixel cap (MAX_DECODE_PIXELS) is enforced
 * BEFORE any byte is handed to the decoder, from the container header alone
 * (`imageSize()`) — never by decoding first and checking after, which would
 * let a crafted header-vs-payload mismatch (a decompression bomb) allocate
 * an unbounded buffer before this module ever gets a chance to refuse it.
 *
 * Every failure here is SYSTEMIC, not "this one photo's problem" (task A.4):
 * an unsupported format (WebP etc. — the allow-list is JPEG/PNG only), a
 * pixel count over the cap, a decode that throws, or a decoded size that
 * disagrees with the header. These bytes already passed the pdq gate's own
 * ffmpeg decode (gate order: pdq runs before face), so a failure here means
 * the WASM decoder itself cannot handle a format/file OpenRouter can
 * legitimately return — never "retry the same slot" (which would burn up to
 * 3 paid attempts in a loop against a decoder that will never succeed on
 * this class of input). `faceGate.ts` lets every rejection from this
 * function propagate uncaught; `runJob.ts`'s existing `checkFree` wrapper
 * already reads an uncaught gate failure as GateBroken (systemic, stops the
 * run for a resume) unless the job was already cancelled — no new code
 * needed there.
 */
export const MAX_DECODE_PIXELS = 16_777_216;

/** One decoded frame, before this module tags it — `width`/`height`/`data.byteLength` must be internally consistent (checked by the caller below). */
export interface RawDecoded {
  width: number;
  height: number;
  /** RGBA, 8 bits per channel (`ImageData`-shaped) — a plain `Uint8Array` or the `Uint8ClampedArray` `ImageData.data` uses; both are byte-for-byte equivalent for an 8-bit channel. */
  data: Uint8Array | Uint8ClampedArray;
}

/** The two WASM codecs this module drives; `realBackend.ts` wires the real `@jsquash/*` decoders in, already `init()`-ed with a verified, precompiled module. */
export interface DecodeBackend {
  decodeJpeg(bytes: Uint8Array): Promise<RawDecoded>;
  decodePng(bytes: Uint8Array): Promise<RawDecoded>;
}

function toUint8Array(data: Uint8Array | Uint8ClampedArray): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

/**
 * Builds the `QaInput.decodeImage` function (qa.ts's own header has the full
 * signature contract) from a `DecodeBackend`. Pure orchestration — the
 * allow-list, the pixel cap, and the post-decode consistency checks — with
 * no WASM of its own, so it is unit-testable against a fake backend
 * (wasmDecode.test.ts); realBackend.ts's real decode is proven byte-identical
 * to Electron separately (wasmDecode.parity.test.ts).
 */
export function createWasmImageDecoder(backend: DecodeBackend): (bytes: Uint8Array, signal: AbortSignal) => Promise<FaceGateImage> {
  return async (bytes, signal) => {
    if (signal.aborted) throw signal.reason;

    const mediaType = sniffImageMediaType(bytes);
    if (mediaType !== "image/jpeg" && mediaType !== "image/png") {
      throw new Error(`decode/wasmDecode: unsupported image format for the engine's own decoder (only JPEG and PNG) — got ${mediaType ?? "unrecognized bytes"}`);
    }

    const header = imageSize(bytes);
    if (header === null) throw new Error("decode/wasmDecode: the image header could not be read");
    if (header.width * header.height > MAX_DECODE_PIXELS) {
      throw new Error(`decode/wasmDecode: ${header.width}x${header.height} (${header.width * header.height} px) exceeds the ${MAX_DECODE_PIXELS}-pixel cap`);
    }

    const decoded = mediaType === "image/jpeg" ? await backend.decodeJpeg(bytes) : await backend.decodePng(bytes);

    if (decoded.width !== header.width || decoded.height !== header.height) {
      throw new Error(`decode/wasmDecode: decoded size ${decoded.width}x${decoded.height} does not match the header's ${header.width}x${header.height}`);
    }
    const expectedBytes = decoded.width * decoded.height * 4;
    if (decoded.data.byteLength !== expectedBytes) {
      throw new Error(`decode/wasmDecode: decoded ${decoded.data.byteLength} bytes, expected ${expectedBytes} byte for a ${decoded.width}x${decoded.height} RGBA image`);
    }

    return { format: "rgba", width: decoded.width, height: decoded.height, data: toUint8Array(decoded.data) };
  };
}
