import { describe, expect, test } from "bun:test";
import { NoFaceInReferenceError } from "../face/noFaceError";
import { asLibraryReference } from "../openrouter/testing/fakes";
import { embedFaceReference, masterOriginalFor } from "./faceBytes";

// The bytes a face embedding is computed from (shared by the photo runs' QA gate and the reference portrait batch). The WASM decoder reads JPEG and PNG only, and a CMYK JPEG fails
// it too, so the original file is used when it is a JPEG or PNG, and the <= 1024 px JPEG reference stands in for anything else, or after a decode failure.

const JPEG_ORIGINAL = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 1, 2, 3);
const PNG_ORIGINAL = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1);
const WEBP_ORIGINAL = Uint8Array.from([..."RIFF"].map((c) => c.charCodeAt(0)).concat([0, 0, 0, 0], [..."WEBP"].map((c) => c.charCodeAt(0))));
const REFERENCE = asLibraryReference(Uint8Array.of(0xff, 0xd8, 0xff, 0xdb, 9, 9));
const EMBEDDING = Float32Array.of(1, 2, 3);

describe("masterOriginalFor", () => {
  test("keeps a JPEG original", () => {
    expect(masterOriginalFor(JPEG_ORIGINAL, REFERENCE)).toBe(JPEG_ORIGINAL);
  });

  test("keeps a PNG original", () => {
    expect(masterOriginalFor(PNG_ORIGINAL, REFERENCE)).toBe(PNG_ORIGINAL);
  });

  test("takes the JPEG reference for a WebP original, which the decoder cannot read", () => {
    expect(masterOriginalFor(WEBP_ORIGINAL, REFERENCE)).toBe(REFERENCE);
  });
});

describe("embedFaceReference", () => {
  const live = new AbortController().signal;

  function embedder(script: (bytes: Uint8Array, call: number) => Float32Array | Error) {
    const seen: Uint8Array[] = [];
    const embed = async (bytes: Uint8Array): Promise<Float32Array> => {
      seen.push(bytes);
      const answer = script(bytes, seen.length);
      if (answer instanceof Error) throw answer;
      return answer;
    };
    return { embed, seen };
  }

  test("embeds a JPEG original as it is, once", async () => {
    const { embed, seen } = embedder(() => EMBEDDING);

    expect(await embedFaceReference({ embed, original: JPEG_ORIGINAL, reference: REFERENCE, signal: live })).toBe(EMBEDDING);
    expect(seen).toEqual([JPEG_ORIGINAL]);
  });

  test("embeds the reference for a WebP original, once", async () => {
    const { embed, seen } = embedder(() => EMBEDDING);

    await embedFaceReference({ embed, original: WEBP_ORIGINAL, reference: REFERENCE, signal: live });

    expect(seen).toEqual([REFERENCE]);
  });

  test("retries once on the reference when the original fails to decode (a CMYK JPEG)", async () => {
    const { embed, seen } = embedder((_bytes, call) => (call === 1 ? new Error("unsupported colour space") : EMBEDDING));

    expect(await embedFaceReference({ embed, original: JPEG_ORIGINAL, reference: REFERENCE, signal: live })).toBe(EMBEDDING);
    expect(seen).toEqual([JPEG_ORIGINAL, REFERENCE]);
  });

  test("does not retry a photo with no face: the reference is the same photo, only smaller", async () => {
    const { embed, seen } = embedder(() => new NoFaceInReferenceError());

    await expect(embedFaceReference({ embed, original: JPEG_ORIGINAL, reference: REFERENCE, signal: live })).rejects.toBeInstanceOf(NoFaceInReferenceError);
    expect(seen).toHaveLength(1);
  });

  test("does not retry what already ran on the reference", async () => {
    const { embed, seen } = embedder(() => new Error("decoder crashed"));

    await expect(embedFaceReference({ embed, original: WEBP_ORIGINAL, reference: REFERENCE, signal: live })).rejects.toThrow("decoder crashed");
    expect(seen).toHaveLength(1);
  });

  test("does not retry once the signal has aborted", async () => {
    const controller = new AbortController();
    const { embed, seen } = embedder(() => {
      controller.abort();
      return new Error("aborted");
    });

    await expect(embedFaceReference({ embed, original: JPEG_ORIGINAL, reference: REFERENCE, signal: controller.signal })).rejects.toThrow("aborted");
    expect(seen).toHaveLength(1);
  });

  test("a failure of the retry is the answer", async () => {
    const { embed } = embedder((_bytes, call) => new Error(call === 1 ? "first" : "second"));

    await expect(embedFaceReference({ embed, original: JPEG_ORIGINAL, reference: REFERENCE, signal: live })).rejects.toThrow("second");
  });
});
