import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

/**
 * Where the repo keeps the frame-mode background pack. Under `public/` so the
 * renderer build copies it into the packaged app's `out/renderer/` without any
 * change to the packager config; a packaged app hands its own extracted copy to
 * the batch instead (see `electron/framePack.ts`).
 */
export const DEFAULT_FRAME_PACK_DIR = resolve(import.meta.dirname, "../../public/frame-backgrounds");

/**
 * The pack's images as absolute paths, in name order so a listing is the same
 * on every machine. Only `.jpg` files count: the folder also holds
 * `CREDITS.json`, and a folder named like an image is not one.
 */
export async function listFrameBackgrounds(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    throw new Error(`Frame mode needs its background pack, and ${dir} cannot be read.`);
  }
  const files = entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".jpg"))
    .map((e) => e.name)
    .sort();
  if (files.length === 0) {
    throw new Error(`Frame mode needs its background pack, and ${dir} holds no .jpg image.`);
  }
  return files.map((name) => join(dir, name));
}
