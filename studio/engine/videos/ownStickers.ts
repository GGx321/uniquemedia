import { inspectApng } from "../../shared/stickers/apng";
import { NODE_OPEN_OPS, type OpenRegularOps } from "../library/openRegular";
import type { MediaLookup } from "../media/service";
import { ownMediaUnavailable, readVerifiedOwnMedia } from "./ownMedia";
import type { StickerAsset } from "./stickerAssets";

// The render's private copy of each own sticker (Stage 3, 3f.5). `MediaService.lookup` answers where a stored sticker is and what it must hash to;
// the render does NOT point ffmpeg at that file. As for a built-in sticker (sha-checked against the catalogue, copied with `wx` into the job folder)
// and an own photo (`ownPhotos.ts`), the sticker is read ONCE (`ownMedia.ts`: a no-follow open, the handle's size, a bounded read, the sha256 of
// the exact bytes), inspected again with the strict APNG reader, and compared with its record: the loop the render repeats is the STORED period,
// and a file that says another one (or another canvas) than its record would make the render drift from the preview. The bytes are then written
// into the job's own folder (`layers.ts`, with `wx`) and ffmpeg reads that copy.

/** One own sticker as the admission found it: the stored file and what the record says it is. */
export interface OwnStickerSource {
  readonly mediaId: string;
  /** The stored file in the library's `media/` folder. Never handed to ffmpeg. */
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  /** The STORED canvas (the importer's APNG): what the box is sized from. */
  readonly width: number;
  readonly height: number;
  /** The loop in 30 fps frames the record keeps: the render's loop cache holds exactly this. */
  readonly loopFrames: number;
}

/** What the render keeps of a `MediaService.lookup` answer for a sticker: where the file is, what it must be, and its stored size and loop. */
export function ownStickerSourceOf(found: MediaLookup): OwnStickerSource | null {
  const { width, height, loopFrames } = found.summary;
  // A sticker's record always has its size and loop (the contract's refinement); one that does not is not a sticker the render can place.
  if (width === null || height === null || loopFrames === null) return null;
  return { mediaId: found.summary.mediaId, path: found.path, sha256: found.sha256, bytes: found.bytes, width, height, loopFrames };
}

/**
 * The verified sticker, as the render uses it: the bytes of a stored file that is the size and hash its record gave AND an APNG the strict reader
 * takes whose canvas and loop are the record's. A `RenderFailure` (no path in it, and no media id) when it is gone, is not that file, or is another
 * sticker than the record describes; the signal's reason when `signal` fires.
 */
export async function readVerifiedOwnSticker(source: OwnStickerSource, signal: AbortSignal, ops: OpenRegularOps = NODE_OPEN_OPS): Promise<StickerAsset> {
  const bytes = await readVerifiedOwnMedia(source, "sticker", signal, ops);
  const inspected = inspectApng(bytes);
  if (!inspected.ok) throw ownMediaUnavailable("sticker");
  const { info } = inspected;
  if (info.loopFrames !== source.loopFrames || info.width !== source.width || info.height !== source.height) throw ownMediaUnavailable("sticker");
  return { bytes, loopFrames: info.loopFrames, width: info.width, height: info.height };
}
