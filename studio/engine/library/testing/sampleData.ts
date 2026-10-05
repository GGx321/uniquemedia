import type { NewAvatar, NewPhotoMeta } from "../library";
import type { GeneratedPhotoSource, ImportedPhotoSource } from "../schemas";

// Sample data with no test-runner import, so a `*.node-test.ts` (bundled and run under Electron's Node) can use it
// too. helpers.ts re-exports all of it for the `bun test` files.

/** A clock that advances one second per call, so records get distinct,
 *  ordered timestamps. */
export function steppingClock(startIso = "2026-09-24T10:00:00.000Z"): () => Date {
  let t = Date.parse(startIso);
  return () => {
    const d = new Date(t);
    t += 1000;
    return d;
  };
}

/** Deterministic ids that match the library id pattern: test-id-0001, ... */
export function sequentialIds(prefix = "test-id"): () => string {
  let n = 0;
  return () => `${prefix}-${String(++n).padStart(4, "0")}`;
}

/** A real 1×1 PNG. */
export const PNG_1X1 = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64"
  )
);

/** JPEG start-of-image marker followed by filler — enough to sniff as JPEG. */
export const JPEG_HEADER_ONLY = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]);

export const SAMPLE_AVATAR: NewAvatar = {
  name: "Mia",
  age: 25,
  traits: { hair: "chestnut", eyes: "hazel" },
  descriptor: "a 25-year-old woman with hazel eyes and chestnut hair",
};

export const SAMPLE_SOURCE: GeneratedPhotoSource = {
  kind: "generated",
  model: "x-ai/grok-imagine-image-2.0",
  provider: "xai",
  jobId: "job-0001",
  attemptId: "attempt-0001",
  promptSha: "a".repeat(64),
  prompt: "Head-and-shoulders portrait photo",
  costMicros: 50_000,
};

export function samplePhotoMeta(extra: Partial<NewPhotoMeta> = {}): NewPhotoMeta {
  return { mediaType: "image/png", width: 1, height: 1, source: SAMPLE_SOURCE, qa: {}, ...extra };
}

/** T6c: the owner's own imported photo, not a generated frame. */
export const SAMPLE_IMPORTED_SOURCE: ImportedPhotoSource = {
  kind: "imported",
  importedAt: "2026-09-27T10:00:00.000Z",
};

/** RIFF/WEBP container header — enough to sniff as WebP. */
export const WEBP_HEADER_ONLY = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, 0x1a, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
]);
