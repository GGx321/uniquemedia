import { createHash } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RenderFailure } from "../renderQueue/queue";

// The render's private copy of each own photo (Stage 3, 3f.2). `MediaService.lookup` answers where a stored photo is and what it must
// hash to; the render does NOT point ffmpeg at that file. Like a built-in sticker (sha-checked, copied with `wx` into the job folder) and
// a track (`track.m4a`), the photo is read ONCE, checked against the record's size and sha256, and written into the job's own folder,
// and ffmpeg reads the copy. That closes the window between the admission and the read: a file that is swapped, truncated, grown or
// turned into a link in between is refused, and one that changes after the copy changes nothing the render reads.

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

/** The copy's name inside the job folder. The media id is a safe id (letters, digits, `-` and `_`), so the name is a plain file name. */
export const ownPhotoCopyName = (mediaId: string): string => `own-${mediaId}.jpg`;

/** What a failed copy says: no path, and no more than the owner can act on. */
const UNAVAILABLE = (): RenderFailure => new RenderFailure({ code: "RENDER_FAILED", detail: "an own photo of this montage is no longer available: it was removed or changed" });

/**
 * Copies each photo into `dir` (the job folder, which exists) as `own-<mediaId>.jpg`, after checking its bytes. Throws a `RenderFailure`
 * when a file is not a plain file, is gone, or is not the size and hash its record gave; the signal's reason when `signal` fires.
 * Nothing is written for a photo that fails.
 */
export async function copyOwnPhotos(dir: string, sources: readonly OwnPhotoSource[], signal: AbortSignal): Promise<void> {
  for (const source of sources) {
    signal.throwIfAborted();
    let bytes: Uint8Array;
    try {
      const facts = await lstat(source.path);
      if (facts.isSymbolicLink() || !facts.isFile() || facts.size !== source.bytes) throw UNAVAILABLE();
      bytes = new Uint8Array(await readFile(source.path, { signal }));
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof RenderFailure) throw error;
      throw UNAVAILABLE();
    }
    if (bytes.length !== source.bytes || createHash("sha256").update(bytes).digest("hex") !== source.sha256) throw UNAVAILABLE();
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
