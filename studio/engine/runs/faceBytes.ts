import { NoFaceInReferenceError } from "../face/noFaceError";
import { sniffImageMediaType, type LibraryReference } from "../library/media";

// The bytes a face embedding is computed from, shared by the photo runs' QA gate (`runJob.ts`) and the reference portrait batch (`engine.ts`). The WASM decoder reads JPEG and
// PNG only (decode/wasmDecode.ts), and an imported master may be a WebP or a CMYK JPEG, so neither may use the original file unconditionally.

/**
 * Re-review, N1 (HIGH): the decoder only handles JPEG/PNG (decode/wasmDecode.ts's own allow-list, never WebP, by design). An imported master may be WebP (`importStaging.ts`'s own
 * 16 MP cap accepts it), so using `loadMasterOriginal()`'s raw bytes unconditionally made every WebP-imported avatar's runs fail MASTER_FACE_UNUSABLE forever, though the master is
 * perfectly fine and only unreadable by this ONE decoder. Use the original file when it is JPEG/PNG (M1/N1's own fix stays: never the OpenRouter-bound downscale for a JPEG/PNG
 * original); otherwise fall back to `reference`, the <= 1024 px reference already loaded for this exact avatar's OpenRouter calls, always JPEG (`downscaleToJpeg`'s own output
 * format), so the identity check still runs, just at a smaller size, on every format the app can import.
 */
export function masterOriginalFor(original: Uint8Array, reference: LibraryReference): Uint8Array {
  const mediaType = sniffImageMediaType(original);
  return mediaType === "image/jpeg" || mediaType === "image/png" ? original : reference;
}

/**
 * The face embedding of a reference photo, computed from `masterOriginalFor`'s bytes, with M1's one retry: a JPEG/PNG original can still fail to DECODE (a CMYK colour space;
 * ffmpeg and the import tolerate it, the WASM decoder does not), so any failure but a genuine «no face» gets exactly one more try on the reference, which is a format the decoder
 * is known to read. A «no face» is final (the reference is the same photo, only smaller), so is a failure of what already ran on the reference, and so is anything once `signal`
 * has aborted (a retry would start real work that outlives the job). Both tries share the one `signal`, so the retry never doubles the caller's deadline.
 */
export async function embedFaceReference(args: {
  embed: (bytes: Uint8Array, signal: AbortSignal) => Promise<Float32Array>;
  original: Uint8Array;
  reference: LibraryReference;
  signal: AbortSignal;
}): Promise<Float32Array> {
  const { embed, original, reference, signal } = args;
  const bytes = masterOriginalFor(original, reference);
  try {
    return await embed(bytes, signal);
  } catch (error) {
    if (bytes === reference || error instanceof NoFaceInReferenceError || signal.aborted) throw error;
    return embed(reference, signal);
  }
}
