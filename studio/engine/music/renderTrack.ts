// What the render may ask of the track store (3c.5, invariant 31): a track's file, by track id, and only after the store has
// checked it again. The path of a track never comes from a window or from a spec; it comes from here.

/** Why the store will not hand a track to the render. A closed set; the text of an error names no path. */
export type TrackUnavailableKind =
  /** The id is not one the store holds as stored: never listed, a download that failed verification, or an id that is not a safe name. */
  | "not-stored"
  /** The file is gone, is not a plain file, or is no longer the bytes the store verified (size or sha256). */
  | "changed"
  /** ffmpeg no longer sees exactly one audio stream in it, or could not be asked. */
  | "not-audio";

const MESSAGES: Record<TrackUnavailableKind, string> = {
  "not-stored": "the track is not in the track store",
  changed: "the track's file is missing or is not the file the store verified",
  "not-audio": "ffmpeg does not see exactly one audio stream in the track's file",
};

export class TrackUnavailableError extends Error {
  readonly kind: TrackUnavailableKind;
  constructor(kind: TrackUnavailableKind) {
    super(MESSAGES[kind]);
    this.name = "TrackUnavailableError";
    this.kind = kind;
  }
}

/** A stored track that passed the render-time checks. */
export interface RenderTrack {
  /** Absolute, built by the store from the id and a fixed name. */
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  /** The length the store's decode proved, in ms: what a montage's `startMs` plus its length is measured against. */
  readonly decodedMs: number;
  /** What the tile shows: the list's title, or the store's placeholder for a track the list gave none. */
  readonly title: string;
  readonly artist: string | null;
  /** Text the finished video must not carry (invariant 14): the track's own tags and handler names, and its list title and artist. */
  readonly forbidden: readonly string[];
}

/** What `videos.render` and `montages.get` ask of the store before anything is queued: the record only, no disk. */
export interface TrackLookup {
  /** The proven length of a stored track, or null when the store does not hold it as stored. */
  stored(trackId: string): { readonly decodedMs: number } | null;
}

/** The store as the render job uses it, at the moment it runs. */
export interface RenderTrackSource extends TrackLookup {
  /**
   * The track's file after a fresh check: a stored entry, a plain file of the recorded size and sha256, and exactly one audio
   * stream by ffmpeg's own reading. Rejects with a `TrackUnavailableError` (never an ffmpeg run on a file that did not pass),
   * or with the signal's reason for a cancel.
   */
  openForRender(trackId: string, signal: AbortSignal): Promise<RenderTrack>;
}
