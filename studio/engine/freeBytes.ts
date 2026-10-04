import { statfs } from "node:fs/promises";

/**
 * Free bytes on the volume of `dir` (what a normal user can still write), or null when the volume does not say. The one answer the render's folder is asked by:
 * the layer pass's files and the own videos' copies. A volume that cannot say is never a refusal on its own.
 */
export async function freeBytesOf(dir: string): Promise<number | null> {
  try {
    const info = await statfs(dir);
    const free = info.bavail * info.bsize;
    return Number.isFinite(free) ? free : null;
  } catch {
    return null;
  }
}
