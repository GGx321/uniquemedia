import type { MediaImporter } from "./imports";

// A TEST-ONLY photo importer for the packaged E2E (Stage 3 plan, 3f.1b). Until 3f.2 the app has no importer, so nothing is ever accepted and
// the smoke could not drive an import end to end (copy, importer, record, delete) through the real engine, on both operating systems. The
// engine entry hands this importer over in an E2E build, and ONLY there: `engine/main.ts` builds it behind `STUDIO_E2E`, a build-time
// constant, so a production bundle does not contain this module (bundleChecks.ts's `productionEngineProblems` looks for the marker).
//
// It is the smallest importer that is honest: it keeps the staged copy as it is and reads the picture's size from a PNG's own header (the
// staged head, never a file), and refuses everything else. It decodes nothing and makes no file; the real photo importer (3f.2) replaces it.

/** The one string a production bundle must not carry; also the importer's own name. */
export const E2E_PHOTO_IMPORTER_MARKER = "studio-e2e-photo-importer";

/** Larger than any photo the library keeps (4096 px after 3f.2's re-encode, with room); a header that claims more is not a photo of ours. */
const MAX_SIDE = 65_535;

export function createE2ePhotoImporter(): MediaImporter {
  const importer: MediaImporter = async ({ staged }) => {
    const head = staged.head;
    // A PNG's first chunk is its 13-byte IHDR: length, `IHDR`, then width and height as big-endian 32-bit numbers (offsets 16 and 20).
    const isIhdr = head.length >= 24 && head[12] === 0x49 && head[13] === 0x48 && head[14] === 0x44 && head[15] === 0x52;
    if (staged.format !== "png" || !isIhdr) return { ok: false, reason: "format" };
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
    const width = view.getUint32(16);
    const height = view.getUint32(20);
    if (width < 1 || height < 1 || width > MAX_SIDE || height > MAX_SIDE) return { ok: false, reason: "format" };
    return { ok: true, facts: { width, height, durationMs: null, sourceFps: null, hdrToSdr: false, loopFrames: null, delayFrames: null } };
  };
  Object.defineProperty(importer, "name", { value: E2E_PHOTO_IMPORTER_MARKER });
  return importer;
}
