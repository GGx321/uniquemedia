import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { ClipFailReason } from "../../shared/engine";
import { FREE_MARGIN_BYTES, freeBytesOf, isShortOfRoom, type FreeBytes } from "../freeBytes";
import { fsyncDir, fsyncFile, tempSiblingPath } from "../library/durableFs";
import { renameWithRetry } from "../library/renameRetry";
import type { OpenRouterClient, VideoDownloadResult } from "../openrouter/types";
import { validateClipFile, type ValidClip } from "./validate";

// Stage 5, 5b.1, S5.V4b (plan s5b1 §5.10, I5.54): the paid file from the provider to the library. It streams (V3a's `downloadVideo`) to a temp file in the clips folder, capped at 100 MiB
// and after a free-space check; the file is judged (validate.ts); and only then does it become `<clipId>.mp4`, the provider's bytes, unmodified, with their sha256. Nothing re-encodes it
// and nothing strips its metadata, so Grok's stray audio stays (I5.54). The clips folder is the avatar's `clips/`: the caller names it, and never lets a renderer string reach here.
//
// Every failure here comes after a `completed`, so the money is spent: each is one of four paid failures, and the caller records it (`retryDownload` can try again for the first three).

/** A clip is far under this; a body over it is not one of ours. */
export const CLIP_DOWNLOAD_CAP_BYTES = 100 * 1024 * 1024;

export interface DownloadClipOptions {
  /** Only the one call, so a test plays any answer. */
  readonly client: Pick<OpenRouterClient, "downloadVideo">;
  /** The provider's job id of the attempt that completed. */
  readonly providerJobId: string;
  readonly clipId: string;
  /** `<library>/avatars/<avatarId>/clips`: it exists. */
  readonly clipsDir: string;
  readonly requestedSeconds: number;
  readonly signal: AbortSignal;
  /** How the volume is asked for its free bytes; `freeBytesOf` by default. */
  readonly freeBytes?: FreeBytes;
}

export type ClipDownloadFailure = Extract<ClipFailReason, "disk-full" | "invalid-file" | "download-failed" | "download-expired">;

export type ClipDownload =
  | {
      readonly kind: "saved";
      /** `<clipsDir>/<clipId>.mp4`, fsynced. */
      readonly path: string;
      /** Of the bytes as they came; recorded in the journal and the record. */
      readonly sha256: string;
      readonly clip: ValidClip;
    }
  | { readonly kind: "failed"; readonly reason: ClipDownloadFailure; readonly detail: string };

function failure(reason: ClipDownloadFailure, detail: string): ClipDownload {
  return { kind: "failed", reason, detail };
}

/** What a download that did not save means for the clip. */
function failureOf(result: Exclude<VideoDownloadResult, { kind: "saved" }>): ClipDownload {
  switch (result.kind) {
    case "gone":
      return failure("download-expired", `the provider answered ${result.httpStatus}: the file is gone`);
    case "too-large":
      return failure("invalid-file", `the body is over ${result.capBytes} bytes`);
    case "redirect-refused":
      return failure("download-failed", `a redirect to ${result.host ?? "another host"} was refused`);
    case "failed":
      return result.cause === "disk" ? failure("disk-full", result.detail) : failure("download-failed", `${result.cause}: ${result.detail}`);
  }
}

function sha256Of(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

/**
 * Downloads, validates and stores one finished clip. Never throws for the file or the provider (every outcome is a result); a disk that cannot be read or renamed into is the one thing that rejects.
 * On every result but `saved` the clips folder holds nothing of this call's.
 */
export async function downloadClip(options: DownloadClipOptions): Promise<ClipDownload> {
  const { clipId, clipsDir } = options;
  if (await isShortOfRoom(options.freeBytes ?? freeBytesOf, clipsDir, CLIP_DOWNLOAD_CAP_BYTES + FREE_MARGIN_BYTES)) {
    return failure("disk-full", "the volume has less free space than a clip can need");
  }
  const finalPath = join(clipsDir, `${clipId}.mp4`);
  // `tempSiblingPath` is the library's own temp convention: a dot, the name, six random bytes, `.tmp` (a crash's leftover is recognised and swept).
  const temp = tempSiblingPath(finalPath.slice(0, -".mp4".length));
  try {
    const result = await options.client.downloadVideo(options.providerJobId, temp, CLIP_DOWNLOAD_CAP_BYTES, options.signal);
    if (result.kind !== "saved") {
      // `exists` means a file was there before this call: it is not ours to remove (the temp name is random, so this is not expected).
      if (!(result.kind === "failed" && result.cause === "exists")) await rm(temp, { force: true });
      return failureOf(result);
    }
    const judged = await validateClipFile(temp, options.requestedSeconds);
    if (!judged.ok) {
      await rm(temp, { force: true });
      return failure("invalid-file", `${judged.reason}: ${judged.detail}`);
    }
    const sha256 = await sha256Of(temp);
    await fsyncFile(temp);
    await renameWithRetry(temp, finalPath);
    await fsyncDir(clipsDir);
    return { kind: "saved", path: finalPath, sha256, clip: judged.clip };
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}
