import { rename as fsRename } from "node:fs/promises";
import { platform as osPlatform } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

export interface RenameRetryOptions {
  /** Injectable for tests; defaults to the running platform. */
  platform?: string;
  rename?: (from: string, to: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  /** Pause before each retry; one attempt more than there are delays. */
  delaysMs?: readonly number[];
}

// About 3 s in total: long enough for Defender or the search indexer to let
// go of a freshly written file, short enough to surface a real lock.
const DEFAULT_DELAYS_MS = [25, 50, 100, 200, 400, 800, 1600] as const;

// What Windows reports while another process (antivirus, indexer, backup)
// briefly holds a handle on the source or the target.
const TRANSIENT_ON_WINDOWS = new Set(["EPERM", "EACCES", "EBUSY"]);

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

/** `rename`, retried with backoff on Windows when another process holds a
 *  handle. Everywhere else, and for any other error, it fails at once. */
export async function renameWithRetry(from: string, to: string, options: RenameRetryOptions = {}): Promise<void> {
  const rename = options.rename ?? fsRename;
  const sleep = options.sleep ?? ((ms: number) => delay(ms));
  const delays = options.delaysMs ?? DEFAULT_DELAYS_MS;
  const retries = (options.platform ?? osPlatform()) === "win32";

  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = errorCode(error);
      const pause = delays[attempt];
      if (!retries || pause === undefined || code === undefined || !TRANSIENT_ON_WINDOWS.has(code)) throw error;
      await sleep(pause);
    }
  }
}
