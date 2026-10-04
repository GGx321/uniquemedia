import { join } from "node:path";
import type { MediaLookup } from "../media/service";
import { MAX_STORED_VIDEO_BYTES } from "../../shared/engine";
import { freeBytesOf } from "../freeBytes";
import { copyVerifiedOwnMedia, OWN_COPY_FREE_MARGIN_BYTES, OwnMediaUnavailableError, ownMediaNoSpace, type StreamCopyIo } from "./ownMedia";

// The render's private copy of each own video (Stage 3, 3f.3b). `MediaService.lookup` answers where a stored mezzanine is and what it must hash to; the render does
// NOT point ffmpeg at that file. Like an own photo (`ownPhotos.ts`), a sticker and a track, the mezzanine is copied into the job's own folder, verified against the
// record's size and sha256, and ffmpeg reads the copy. UNLIKE them it is STREAMED (`ownMedia.ts`'s `copyVerifiedOwnMedia`): a mezzanine can be hundreds of MiB and is
// never held in memory. That closes the window between the admission and the read: a file that is swapped, truncated, grown or turned into a link in between is
// refused, and one that changes after the copy changes nothing the render reads.

/** One own video as the admission found it: the stored mezzanine, what the record says it is, and what the render needs to know of it. */
export interface OwnVideoSource {
  readonly mediaId: string;
  /** The stored file in the library's `media/` folder. Never handed to ffmpeg. */
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  /** The STORED size (the importer's mezzanine, already upright, within 1080 x 1920): what the cover-crop is computed from. */
  readonly width: number;
  readonly height: number;
  /** The mezzanine's length in ms (`round(frames * 1000 / 30)`): what a clip's `trimStartMs` plus its length is measured against. */
  readonly durationMs: number;
}

/**
 * What a draft is judged by (`montages.get`): the stored size and length of a library media that IS a video the render could read (kind video, with a size and a length,
 * stored as the importer's MP4). Null for anything else, so a draft and a render agree on what an own video is.
 */
export function ownVideoFactsOf(found: MediaLookup, maxBytes: number = MAX_STORED_VIDEO_BYTES): { readonly width: number; readonly height: number; readonly durationMs: number } | null {
  const { summary } = found;
  if (summary.kind !== "video" || found.format !== "mp4") return null;
  // The size the render's copy takes (`copyVerifiedOwnMedia`): a draft and a render hold a video to the same bound.
  if (!(found.bytes >= 1 && found.bytes <= maxBytes)) return null;
  const { width, height, durationMs } = summary;
  if (width === null || height === null || durationMs === null) return null;
  return { width, height, durationMs };
}

/** What the render keeps of a `MediaService.lookup` answer for an own video: where the file is, what it must be, and its stored size and length; null when it is not one the render can read. */
export function ownVideoSourceOf(found: MediaLookup): OwnVideoSource | null {
  const facts = ownVideoFactsOf(found);
  if (facts === null) return null;
  return { mediaId: found.summary.mediaId, path: found.path, sha256: found.sha256, bytes: found.bytes, ...facts };
}

/** An own video's mezzanine is gone, or is not the file its record describes. It names the media (an id) and no path. */
export class OwnVideoUnavailableError extends Error {
  readonly mediaId: string;
  constructor(mediaId: string) {
    super("an own video of this montage is no longer available: it was removed or changed");
    this.name = "OwnVideoUnavailableError";
    this.mediaId = mediaId;
  }
}

/** The copy's name inside the job folder. The media id is a safe id (letters, digits, `-` and `_`), so the name is a plain file name. */
export const ownVideoCopyName = (mediaId: string): string => `own-${mediaId}.mp4`;

/**
 * Copies each mezzanine into `dir` (the job folder, which exists) as `own-<mediaId>.mp4`, streamed and checked against its record. Throws a `RenderFailure`
 * (no path in it) when a file is not a plain file, is gone, is not the size and hash its record gave, or the volume has no room; the signal's reason when `signal` fires.
 * Nothing is left of a video that fails, and no later video is copied.
 */
export async function copyOwnVideos(dir: string, sources: readonly OwnVideoSource[], signal: AbortSignal, io?: StreamCopyIo, onProgress?: (copied: number, total: number) => void): Promise<void> {
  const total = sources.reduce((sum, source) => sum + source.bytes, 0);
  if (sources.length > 0) {
    // ONE question for all of them: the folder must hold every copy at once (plus the margin for the render's own files), so a refusal comes before the first byte is
    // written, never on the twentieth video after nineteen were copied.
    const free = await (io?.freeBytes ?? freeBytesOf)(dir);
    signal.throwIfAborted();
    if (free !== null && free < total + OWN_COPY_FREE_MARGIN_BYTES) throw ownMediaNoSpace("video");
  }
  let done = 0;
  for (const source of sources) {
    signal.throwIfAborted();
    try {
      await copyVerifiedOwnMedia(source, "video", join(dir, ownVideoCopyName(source.mediaId)), signal, { ...io, onBytes: (copied) => onProgress?.(done + copied, total) });
      done += source.bytes;
    } catch (error) {
      // A mezzanine that is gone or is not what its record says is the owner's `media-unavailable`, and says WHICH media (an id, never a path); a full disk, a failed write
      // and a cancel come out as they are.
      if (error instanceof OwnMediaUnavailableError) throw new OwnVideoUnavailableError(source.mediaId);
      throw error;
    }
  }
}
