/**
 * Test-only: decodes real images the same way production will (Chromium,
 * via Electron's `nativeImage`) so parity.test.ts can compare this module's
 * output to the spike's OpenCV numbers within the ≤0.001 cosine "Done when".
 * ffmpeg decoding does not reach that parity (spike/face-js/README.md's own
 * table: ~0.01-0.03 mean |Δcos|), so a plain node/bun JPEG decoder would not
 * do. Never imported by studio/engine.
 *
 * Returns tagged `bgra` pixels, `nativeImage.toBitmap()`'s real byte order —
 * unconverted, so parity.test.ts exercises `pixels.ts`'s `bgra` branch for
 * real instead of a decoder-side conversion papering over the tag.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { TaggedPixels } from "../pixels";

const execFileAsync = promisify(execFile);
const DECODE_SCRIPT = fileURLToPath(new URL("./electronDecode.mjs", import.meta.url));

/** Resolves the electron binary's path the same way any app would: `require("electron")` outside of ELECTRON_RUN_AS_NODE is that path, not the API. */
async function electronBinaryPath(): Promise<string> {
  const mod: unknown = (await import("electron")).default;
  if (typeof mod !== "string") throw new Error("face/testing: the electron package did not resolve to a binary path");
  return mod;
}

/** Decodes several images in one Electron run (the app itself takes a moment to spin up). */
export async function decodeImagesWithElectron(paths: readonly string[]): Promise<TaggedPixels[]> {
  const dir = await mkdtemp(join(tmpdir(), "studio-face-decode-"));
  try {
    const outs = paths.map((_, i) => join(dir, `${i}.bin`));
    const manifest = paths.map((inPath, i) => ({ in: inPath, out: outs[i] }));
    const manifestPath = join(dir, "manifest.json");
    await writeFile(manifestPath, JSON.stringify(manifest));

    const electron = await electronBinaryPath();
    await execFileAsync(electron, [DECODE_SCRIPT, manifestPath], { timeout: 60_000 });

    const results: TaggedPixels[] = [];
    for (const outPath of outs) {
      const buf = await readFile(outPath);
      const width = buf.readInt32LE(0);
      const height = buf.readInt32LE(4);
      const bgra = new Uint8Array(buf.buffer, buf.byteOffset + 8, buf.length - 8);
      results.push({ format: "bgra", width, height, data: bgra });
    }
    return results;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
