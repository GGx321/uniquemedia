/**
 * Regenerates studio/engine/face/fixtures/electronDecodeHashes.ts (that
 * file's own header has the full "why") from a real Electron `nativeImage`
 * decode of the face fixture images. Run by hand
 * (`bun studio/scripts/generateWasmDecodeParityHashes.ts`) and commit the
 * diff whenever a fixture image under studio/engine/face/fixtures/images/
 * changes — never run by the test suite itself, which only ever reads the
 * committed hashes (parity.test.ts must run with no Electron, per the T7b
 * decode decision).
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { MASTER, IMPOSTOR, TRUE_RENDERS } from "../engine/face/fixtures/expected";
import { decodeImagesWithElectron } from "../engine/face/testing/decodeWithElectron";

const FIXTURES_DIR = join(import.meta.dir, "..", "engine", "face", "fixtures", "images");
const OUT_FILE = join(import.meta.dir, "..", "engine", "face", "fixtures", "electronDecodeHashes.ts");

function bgraToRgbaSha256(bgra: Uint8Array): string {
  const rgba = new Uint8Array(bgra.length);
  for (let i = 0; i < bgra.length; i += 4) {
    rgba[i] = bgra[i + 2] ?? 0;
    rgba[i + 1] = bgra[i + 1] ?? 0;
    rgba[i + 2] = bgra[i] ?? 0;
    rgba[i + 3] = bgra[i + 3] ?? 0;
  }
  return createHash("sha256").update(rgba).digest("hex");
}

if (import.meta.main) {
  const fixtures = [MASTER, IMPOSTOR, ...TRUE_RENDERS];
  const decoded = await decodeImagesWithElectron(fixtures.map((f) => join(FIXTURES_DIR, f.file)));

  const entries = fixtures.map((f, i) => {
    const image = decoded[i];
    if (!image) throw new Error(`no decode for ${f.file}`);
    const sha256 = bgraToRgbaSha256(image.data);
    return `  "${f.file}": { width: ${image.width}, height: ${image.height}, sha256: "${sha256}" },`;
  });

  const today = new Date().toISOString().slice(0, 10);
  const body = `/**
 * Reference hashes of Electron's \`nativeImage\` decode for the 5 committed
 * face fixtures (fixtures/images/*.jpg) — the security review's own decode
 * decision (docs/studio/2026-09-24-stage-2-plan.md, T7b wiring, "The decode
 * decision, with evidence"): decoding untrusted, network-sourced image bytes
 * with native Chromium decoders in the privileged main process is not
 * acceptable, so the engine now decodes with a WASM JPEG/PNG decoder
 * instead (studio/engine/decode/). parity.test.ts asserts the WASM decode's
 * output hashes to exactly these values — proof the two decoders are
 * byte-identical on real photos, without ever running Electron at test time.
 *
 * Produced by \`bun studio/scripts/generateWasmDecodeParityHashes.ts\`, which
 * decodes each fixture with the real \`nativeImage\` (via
 * \`face/testing/decodeWithElectron.ts\`, the same harness parity.test.ts used
 * before this task), converts its BGRA bitmap to RGBA (the tag
 * \`wasmDecode.ts\`'s own output carries) and sha256-hashes the result. Run it
 * again and commit the diff whenever a fixture image under fixtures/images/
 * changes. Last generated ${today} against this checkout's Electron
 * (\`node_modules/electron\`, the version pinned in package.json).
 */
export interface ElectronDecodeHash {
  width: number;
  height: number;
  /** sha256 of the decoded RGBA bytes (BGRA converted to RGBA — see the header above). */
  sha256: string;
}

export const ELECTRON_DECODE_HASHES: Record<string, ElectronDecodeHash> = {
${entries.join("\n")}
};
`;

  await Bun.write(OUT_FILE, body);
  console.log(`wrote ${OUT_FILE}`);
}
