/**
 * Test-only: decodes real images the same way production will (Chromium,
 * via Electron's `nativeImage`) so parity.test.ts can compare this module's
 * output to the spike's OpenCV numbers within the ≤0.001 cosine "Done when".
 * ffmpeg decoding does not reach that parity (spike/face-js/README.md's own
 * table: ~0.01-0.03 mean |Δcos|), so a plain node/bun JPEG decoder would not
 * do. Never imported by studio/engine.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DECODE_SCRIPT = fileURLToPath(new URL("./electronDecode.mjs", import.meta.url));

/** BGRA (Electron's `toBitmap()`) -> RGBA (this module's own input contract). */
export function bgraToRgba(bgra: Uint8Array): Uint8Array {
  if (bgra.length % 4 !== 0) throw new Error(`face/testing: expected a multiple of 4 bytes, got ${bgra.length}`);
  const out = new Uint8Array(bgra.length);
  for (let i = 0; i < bgra.length; i += 4) {
    out[i] = bgra[i + 2] ?? 0;
    out[i + 1] = bgra[i + 1] ?? 0;
    out[i + 2] = bgra[i] ?? 0;
    out[i + 3] = bgra[i + 3] ?? 0;
  }
  return out;
}

export interface DecodedImage {
  width: number;
  height: number;
  /** RGBA, already converted from Electron's native BGRA. */
  data: Uint8Array;
}

/** Resolves the electron binary's path the same way any app would: `require("electron")` outside of ELECTRON_RUN_AS_NODE is that path, not the API. */
async function electronBinaryPath(): Promise<string> {
  const mod: unknown = (await import("electron")).default;
  if (typeof mod !== "string") throw new Error("face/testing: the electron package did not resolve to a binary path");
  return mod;
}

/** Decodes several images in one Electron run (the app itself takes a moment to spin up). */
export async function decodeImagesWithElectron(paths: readonly string[]): Promise<DecodedImage[]> {
  const dir = await mkdtemp(join(tmpdir(), "studio-face-decode-"));
  try {
    const outs = paths.map((_, i) => join(dir, `${i}.bin`));
    const manifest = paths.map((inPath, i) => ({ in: inPath, out: outs[i] }));
    const manifestPath = join(dir, "manifest.json");
    await writeFile(manifestPath, JSON.stringify(manifest));

    const electron = await electronBinaryPath();
    await execFileAsync(electron, [DECODE_SCRIPT, manifestPath], { timeout: 60_000 });

    const results: DecodedImage[] = [];
    for (const outPath of outs) {
      const buf = await readFile(outPath);
      const width = buf.readInt32LE(0);
      const height = buf.readInt32LE(4);
      const bgra = new Uint8Array(buf.buffer, buf.byteOffset + 8, buf.length - 8);
      results.push({ width, height, data: bgraToRgba(bgra) });
    }
    return results;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
