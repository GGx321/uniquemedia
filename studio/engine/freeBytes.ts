import { statfs } from "node:fs/promises";

/** How a volume is asked for its free bytes: `freeBytesOf` by default, and a test plays any answer. */
export type FreeBytes = (dir: string) => Promise<number | null>;

/** What an importer keeps free beyond what it writes, so that a write that fits does not leave the disk at zero. */
export const FREE_MARGIN_BYTES = 64 * 1024 * 1024;

/**
 * Free bytes on the volume of `dir` (what a normal user can still write), or null when the volume does not say. The one answer every
 * writer of the library is asked by: the render's folder (the layer pass's files, the own videos' copies) and the media import (the
 * copy, and what each importer writes). A volume that cannot say is never a refusal on its own.
 */
export async function freeBytesOf(dir: string): Promise<number | null> {
  try {
    const info = await statfs(dir);
    const free = Number(info.bavail) * Number(info.bsize);
    return Number.isFinite(free) ? free : null;
  } catch {
    return null;
  }
}

/**
 * Whether the volume of `dir` SAYS it has less than `neededBytes` free. A volume that cannot say (null, or a probe that throws) is not
 * short: a refusal needs evidence.
 */
export async function isShortOfRoom(freeBytes: FreeBytes, dir: string, neededBytes: number): Promise<boolean> {
  const free = await freeBytes(dir).catch(() => null);
  return free !== null && free < neededBytes;
}

/**
 * Whether a thrown error is a full disk: the disk's own code (ENOSPC, or EDQUOT for an exhausted quota), or an ffmpeg that exited saying so. Only the fixed phrase of the C
 * library's message is looked for in ffmpeg's stderr tail; that text itself never leaves the engine.
 */
export function isNoSpaceError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if ("code" in error && (error.code === "ENOSPC" || error.code === "EDQUOT")) return true;
  return "stderrTail" in error && typeof error.stderrTail === "string" && /No space left on device|Dis[ck] quota exceeded/i.test(error.stderrTail);
}
