import { FfmpegError, FfmpegTimeoutError } from "../../node/runFfmpeg";
import { isNoSpaceError } from "../freeBytes";

// Stage 5, 5b.1, S5.V4a2: what a poster that could not be drawn says about the paid file. The create chain (job.ts) decides it the same way; this is the retry's copy of that rule, kept apart
// so the two can be joined by one import when job.ts is next opened.

/** What ffmpeg says about the file it WRITES, not the one it reads: such an error proves nothing about the clip. Only the C library's fixed phrases are looked for. */
const OUTPUT_SIDE_ERROR = /Input\/output error|Read-only file system|Permission denied|Operation not permitted/i;

/**
 * Whether a failed poster PROVES ffmpeg cannot decode the paid file: ffmpeg ran and exited on its own with an error code (not a timeout, not a kill we did not send: `exitCode` null), and the
 * error is not about its own output (a full disk, EIO, a read-only or forbidden folder). Only then is the file removed; any other failure keeps it.
 */
export function posterProvesUndecodable(error: unknown): boolean {
  if (!(error instanceof FfmpegError) || error instanceof FfmpegTimeoutError || error.exitCode === null) return false;
  return !isNoSpaceError(error) && !OUTPUT_SIDE_ERROR.test(error.stderrTail);
}
