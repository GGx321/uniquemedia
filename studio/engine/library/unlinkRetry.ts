import { unlink as fsUnlink } from "node:fs/promises";
import { platform as osPlatform } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

export interface UnlinkRetryOptions {
  /** Injectable for tests; defaults to the running platform. */
  platform?: string;
  unlink?: (path: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  /** Pause before each retry; one attempt more than there are delays. */
  delaysMs?: readonly number[];
}

// Shorter than the rename's: a delete waits on the same antivirus or indexer handle, but the owner is looking at it.
const DEFAULT_DELAYS_MS = [25, 50, 100, 200, 400, 800] as const;

// What Windows reports while another process holds a handle on the file (a delete of an open file is pending or refused).
const TRANSIENT_ON_WINDOWS = new Set(["EPERM", "EACCES", "EBUSY"]);

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

/**
 * `unlink`, retried with backoff on Windows when another process holds a handle. Everywhere else, and for any other
 * error (a file that is already gone included), it fails at once, like `renameWithRetry`.
 */
export async function unlinkWithRetry(path: string, options: UnlinkRetryOptions = {}): Promise<void> {
  const unlink = options.unlink ?? fsUnlink;
  const sleep = options.sleep ?? ((ms: number) => delay(ms));
  const delays = options.delaysMs ?? DEFAULT_DELAYS_MS;
  const retries = (options.platform ?? osPlatform()) === "win32";

  for (let attempt = 0; ; attempt++) {
    try {
      await unlink(path);
      return;
    } catch (error) {
      const code = errorCode(error);
      const pause = delays[attempt];
      if (!retries || pause === undefined || code === undefined || !TRANSIENT_ON_WINDOWS.has(code)) throw error;
      await sleep(pause);
    }
  }
}
