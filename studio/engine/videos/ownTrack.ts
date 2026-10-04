import { NODE_OPEN_OPS, type OpenRegularOps } from "../library/openRegular";
import type { MediaLookup } from "../media/service";
import { TrackUnavailableError, type RenderTrack } from "../music/renderTrack";
import { trackForbiddenStrings } from "../music/trackTags";
import { OwnFileUnavailableError, readVerifiedOwnFile } from "./ownFile";

// The render's own track (Stage 3, 3f.4). `MediaService.lookup` says where a stored track is and what it must hash to; the render does NOT point ffmpeg at
// that file. As for a trending track (`TrackStore.openForRender`) and an own photo (`ownPhotos.ts`), the bytes are read ONCE from an open handle, checked
// against the record's size and sha256, and handed over as a `RenderTrack`: the runner writes them (`wx`) to `<job folder>/track.m4a` and ffmpeg's stream
// check, true-peak pass and pass 2 all read THAT copy. The chain's input flags (`-f mov -c:a aac`) are the ones the importer's output fits: a stored own track is
// always an AAC-LC M4A.

/** One own track as the admission found it: the stored file, what the record says it is, how long it decodes to and what the owner called it. */
export interface OwnTrackSource {
  readonly mediaId: string;
  /** The stored file in the library's `media/` folder. Never handed to ffmpeg. */
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  /** The DECODED length the importer proved, in ms: what a montage's `startMs` plus its length is measured against. */
  readonly durationMs: number;
  /** The picked file's display name: what the video's tile shows. */
  readonly name: string;
}

/** The own track is gone, or is not the file its record gave, or is not one audio stream. It names no path. */
export class OwnTrackUnavailableError extends Error {
  constructor() {
    super("the own track is no longer available: it was removed or changed");
    this.name = "OwnTrackUnavailableError";
  }
}

/**
 * What a draft is judged by (`montages.get`): the decoded length of a library media that IS an own track the render could read (audio, with a length, stored as
 * the importer's M4A). Null for anything else, so a draft and a render agree on what an own track is.
 */
export function ownTrackFactsOf(found: MediaLookup): { readonly durationMs: number } | null {
  const { summary } = found;
  if (summary.kind !== "audio" || summary.durationMs === null || found.format !== "m4a") return null;
  return { durationMs: summary.durationMs };
}

/** What the render keeps of a `MediaLookup` answer for an own track, or null when it is not one the render can read (see `ownTrackFactsOf`). */
export function ownTrackSourceOf(found: MediaLookup): OwnTrackSource | null {
  const facts = ownTrackFactsOf(found);
  if (facts === null) return null;
  return { mediaId: found.summary.mediaId, path: found.path, sha256: found.sha256, bytes: found.bytes, durationMs: facts.durationMs, name: found.summary.name };
}

/**
 * The track for a render, after a fresh check: the verified bytes (`readVerifiedOwnFile`), with the length the record proved, the file's name for the tile, and
 * `check` for ffmpeg to confirm that the render's private copy is exactly one audio stream (`inspect` is `inspectStreams`). Throws `OwnTrackUnavailableError`
 * (no path in it) when the file is not what its record says, and the signal's reason for a cancel.
 */
export async function openOwnTrack(
  source: OwnTrackSource,
  signal: AbortSignal,
  inspect: (path: string, signal: AbortSignal) => Promise<readonly string[]>,
  ops: OpenRegularOps = NODE_OPEN_OPS,
): Promise<RenderTrack> {
  let bytes: Uint8Array;
  try {
    bytes = await readVerifiedOwnFile(source, signal, ops);
  } catch (error) {
    if (error instanceof OwnFileUnavailableError) throw new OwnTrackUnavailableError();
    throw error;
  }
  const check = async (copy: string, checkSignal: AbortSignal): Promise<void> => {
    let kinds: readonly string[];
    try {
      kinds = await inspect(copy, checkSignal);
    } catch {
      if (checkSignal.aborted) throw checkSignal.reason;
      throw new TrackUnavailableError("not-audio");
    }
    if (kinds.length !== 1 || kinds[0] !== "Audio") throw new TrackUnavailableError("not-audio");
  };
  return {
    data: bytes,
    check,
    bytes: source.bytes,
    sha256: source.sha256,
    decodedMs: source.durationMs,
    title: source.name,
    artist: null,
    // The stored file carries no tag (the importer dropped them all); what is still in it is searched for in the finished video all the same.
    forbidden: trackForbiddenStrings(bytes, []),
  };
}
