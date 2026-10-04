import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NODE_OPEN_OPS, type OpenRegularOps } from "../library/openRegular";
import type { MediaLookup } from "../media/service";
import { RenderFailure } from "../renderQueue/queue";
import { readVerifiedOwnMedia } from "./ownMedia";

// The render's private copy of each own photo (Stage 3, 3f.2). `MediaService.lookup` answers where a stored photo is and what it must hash to; the render does NOT
// point ffmpeg at that file. Like a built-in sticker (sha-checked, copied with `wx` into the job folder) and
// a track (`track.m4a`), the photo is read ONCE, checked against the record's size and sha256, and written into the job's own folder,
// and ffmpeg reads the copy. That closes the window between the admission and the read: a file that is swapped, truncated, grown or
// turned into a link in between is refused, and one that changes after the copy changes nothing the render reads. The read itself is
// `ownMedia.ts`'s, which the own stickers (3f.5, `ownStickers.ts`) use too.

/** One own photo as the admission found it: the stored file and what the record says it is. */
export interface OwnPhotoSource {
  readonly mediaId: string;
  /** The stored file in the library's `media/` folder. Never handed to ffmpeg. */
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  /** The STORED size (the importer's JPEG, already upright): what the render builder crops from. */
  readonly width: number;
  readonly height: number;
}

/** What the render keeps of a `MediaService.lookup` answer: where the file is, what it must be, and its stored size. */
export function ownPhotoSourceOf(found: MediaLookup): OwnPhotoSource | null {
  const { width, height } = found.summary;
  // A photo's record always has its size (the contract's refinement); one that does not is not a photo the render can place.
  if (width === null || height === null) return null;
  return { mediaId: found.summary.mediaId, path: found.path, sha256: found.sha256, bytes: found.bytes, width, height };
}

/** The copy's name inside the job folder. The media id is a safe id (letters, digits, `-` and `_`), so the name is a plain file name. */
export const ownPhotoCopyName = (mediaId: string): string => `own-${mediaId}.jpg`;

/**
 * The bytes of a stored photo, read ONCE and checked against its record: a plain file (not a link), of the recorded size, hashing to the
 * recorded sha256. A `RenderFailure` (no path in it) when it is gone or is not that file; the signal's reason when `signal` fires. The
 * copy for a render and the face detector's input both come from here, so what is judged is what is rendered.
 */
export function readVerifiedOwnPhoto(source: OwnPhotoSource, signal: AbortSignal, ops: OpenRegularOps = NODE_OPEN_OPS): Promise<Uint8Array> {
  return readVerifiedOwnMedia(source, "photo", signal, ops);
}

/**
 * Copies each photo into `dir` (the job folder, which exists) as `own-<mediaId>.jpg`, after checking its bytes. Throws a `RenderFailure`
 * when a file is not a plain file, is gone, or is not the size and hash its record gave; the signal's reason when `signal` fires.
 * Nothing is written for a photo that fails.
 */
export async function copyOwnPhotos(dir: string, sources: readonly OwnPhotoSource[], signal: AbortSignal, ops: OpenRegularOps = NODE_OPEN_OPS): Promise<void> {
  for (const source of sources) {
    const bytes = await readVerifiedOwnPhoto(source, signal, ops);
    signal.throwIfAborted();
    try {
      // `wx`: the job folder is new, so a name already there is not ours and is never written through.
      await writeFile(join(dir, ownPhotoCopyName(source.mediaId)), bytes, { flag: "wx", signal });
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw new RenderFailure({ code: "RENDER_FAILED", detail: "the copy of an own photo could not be written to the render's folder" });
    }
  }
}
