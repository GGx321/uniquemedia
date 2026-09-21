export type MediaKind = "video" | "photo";

export interface MediaInfo {
  kind: MediaKind;
  durationSec: number; // 0 for photos
  width: number;
  height: number;
  hasAudio: boolean; // false for photos
}

/** The type is derived from the list rather than written beside it, so a format
 *  can never exist in one and be missing from the other — which is what lets a
 *  host validate a `--format` argument against the real set. */
export const EXPORT_FORMATS = ["original", "reels", "feed", "square"] as const;

export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const EXPORT_DIMS: Record<Exclude<ExportFormat, "original">, { w: number; h: number }> = {
  reels: { w: 1080, h: 1920 },
  feed: { w: 1080, h: 1350 },
  square: { w: 1080, h: 1080 },
};

/**
 * How a still carries its hash shift at the frame edge.
 *
 * `crop` takes an off-centre window and scales it back up: the picture keeps
 * its texture everywhere, but 3-5% of it is gone. On a photograph that is
 * invisible; on a graphic whose content runs to the edge it is a defect — a
 * measured copy of a 1080x1920 story read "NEVER GONNA MAKE I" where the
 * original said "NEVER GONNA MAKE IT.", at a passing PDQ distance of 54,
 * because a hash cannot see that a word lost its last letter.
 *
 * `fit` shrinks the picture and pads it back to full size instead. The hash
 * moves just as far (measured 46 at 0.97 and 62 at 0.96 against the crop's 38
 * at 0.98) and nothing is lost, but on a photograph whose content reaches the
 * edge the padding reads as a visible border.
 *
 * `auto` decides from the picture. Same list-first shape as EXPORT_FORMATS, so
 * a host can validate a `--edges` argument against the real set.
 */
export const EDGE_MODES = ["crop", "fit", "auto"] as const;

export type EdgeMode = (typeof EDGE_MODES)[number];

/**
 * What a shipped file says about itself, once the source's own metadata has
 * been stripped (every graph passes `-map_metadata -1`).
 *
 * `engine` leaves the encoder's honest signature where ffmpeg puts it: `Lavf`
 * on the container, `Lavc libx264` as the compressor name, the x264 option
 * string as an SEI in the stream; JFIF plus a `Lavc` comment on a JPEG.
 * `iphone` replaces all of that with a capture identity — model, iOS, place,
 * date, lens — and scrubs every trace of the encoder, because the two side by
 * side are a stronger tell than either alone. `clean` is neither: no source
 * metadata, no device, no encoder — a file that says nothing at all.
 *
 * Same list-first shape as EXPORT_FORMATS, so a host can validate an
 * `--identity` argument against the real set.
 */
export const IDENTITY_MODES = ["engine", "iphone", "clean"] as const;

export type IdentityMode = (typeof IDENTITY_MODES)[number];

/** What the pipeline itself needs, regardless of media type. */
export interface UniquifyOptions {
  targetDistance: number; // Hamming distance (0..256) the copy must exceed
  identity: IdentityMode;
}

/** Options shared by photo and video. */
export interface PhotoCopyOptions extends UniquifyOptions {
  strength: number; // visual-change multiplier, ~0.5..1.5, default 1.0
  exportFormat: ExportFormat;
  allowMirror: boolean;
  edgeMode: EdgeMode;
}

export interface CopyOptions extends PhotoCopyOptions {
  keepTrendAudio: boolean;
  /** Paint the first output frame pure black. Video only: a still has one
   *  frame, and blacking it out would be the whole picture. */
  blackFirstFrame: boolean;
}

/**
 * What a host (Electron IPC, the CLI) hands in to start a batch, before the
 * media kind has been decided from the file itself. `keepTrendAudio` is
 * optional because a still has no sound: the photo UI never produces it, and
 * should the file turn out to be footage after all, the video path resolves its
 * absence to a definite `false` rather than passing `undefined` to a sampler.
 */
export type StartOptions = PhotoCopyOptions & {
  keepTrendAudio?: boolean;
  blackFirstFrame?: boolean;
};

export interface Operation {
  id: string;
  params: Record<string, number | boolean | string>;
}

export interface SpeedSegment {
  fraction: number; // portion of source duration; fractions sum to ~1
  speed: number;    // playback speed for this segment (ffmpeg-safe 0.5..2.0)
}

export interface Recipe {
  seed: number;
  intensity: number; // 1.0 baseline; raised on auto-strengthen
  exportFormat: ExportFormat;
  keepTrendAudio: boolean;
  /** Copied straight from the options, never drawn — as `blackFirstFrame`
   *  below is: two recipes from the same seed that differ in a setting
   *  differ in that field alone. */
  identity: IdentityMode;
  /** Copied straight from the options, never drawn: a recipe with it on and
   *  one with it off differ in this field alone for the same seed. */
  blackFirstFrame: boolean;
  segments: SpeedSegment[];
  video: Operation[];
  audio: Operation[];
}

export interface VerifyResult {
  minDistance: number;
  passed: boolean;
  perFrame: number[];
}
