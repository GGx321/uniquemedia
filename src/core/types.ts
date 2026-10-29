import type { PhotoRecipe, ResolvedEdge } from "./photo/types";

export type MediaKind = "video" | "photo";

export interface MediaInfo {
  kind: MediaKind;
  durationSec: number; // 0 for photos
  width: number;
  height: number;
  hasAudio: boolean; // false for photos
  /** How a video's numbers are to be read, as its stream states it. Set by
   *  the video probe; absent on a still and on an info built by hand, which
   *  the graph reads as BT.709, limited range, 8-bit — the form it ships. */
  color?: VideoColor;
}

/**
 * A video stream's colour description, in ffprobe's own names (`bt709`,
 * `smpte170m`, `arib-std-b67`, `tv`, `yuv420p10le`, ...). Each field is ""
 * when the stream does not state it, which is common: a file ffmpeg wrote
 * itself often carries no colour tags at all.
 */
export interface VideoColor {
  pixFmt: string;
  space: string;
  transfer: string;
  primaries: string;
  range: string;
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

/**
 * What the first frame of a video copy is.
 *
 * `off` leaves the footage as it is. `black` paints frame 0 pure black. `photo`
 * puts a picture there — the same picture for every copy, but run through the
 * photo recipe with the copy's own seed, so no two copies open on the same
 * bytes. Video only: a still has one frame, and replacing it would be the
 * whole picture. Same list-first shape as EXPORT_FORMATS, so a host can
 * validate a `--first-frame` argument against the real set.
 */
export const FIRST_FRAME_MODES = ["off", "black", "photo"] as const;

export type FirstFrameMode = (typeof FIRST_FRAME_MODES)[number];

/**
 * Which way the user-controlled distortion leans the picture: `h` turns it
 * around its vertical axis, `v` around its horizontal one, `both` does both.
 * Same list-first shape as EXPORT_FORMATS, so a host can validate a
 * `--distort-axis` argument against the real set.
 */
export const TILT_AXES = ["h", "v", "both"] as const;

export type TiltAxis = (typeof TILT_AXES)[number];

/** What the pipeline itself needs, regardless of media type. */
export interface UniquifyOptions {
  targetDistance: number; // Hamming distance (0..256) the copy must exceed
  identity: IdentityMode;
  /** Video `iphone` only: also stamp a CapCut/vicut export mark. Absent means off. */
  capcutMark?: boolean;
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
  firstFrame: FirstFrameMode;
  /**
   * The picture `firstFrame: "photo"` puts on frame 0. Null in the other two
   * modes; in `photo` mode it has to be a path, and that is checked where the
   * options enter — the CLI parser, the batch handler, the route — rather
   * than encoded in the type, because a host builds these from a form whose
   * cover field can legitimately be empty until the mode asks for it.
   */
  coverPath: string | null;
  /** Put each copy in a frame over a nature background. */
  frame: boolean;
  /** Video only: lean every copy in perspective («distortion»). Off leaves the
   *  recipe exactly as it is without the mode. */
  distortion: boolean;
  /** Which axis the lean is on. Read only when `distortion` is on. */
  distortionAxis: TiltAxis;
  /** The slider, 0..1: the fraction of the maximum lean. The sign (which edge
   *  recedes) and a 70-100% spread are drawn per copy from the seed. */
  distortionStrength: number;
}

/**
 * The cover with everything the sampler cannot find out for itself: the edge
 * mode decided from the pixels (`auto` is answered where the image is, exactly
 * as it is for a photo batch) and the image's own dimensions, which the cover's
 * spatial chain is built against.
 */
export interface ResolvedCover {
  path: string;
  edge: ResolvedEdge;
  info: MediaInfo;
}

export type ResolvedFirstFrame =
  | { mode: "off" }
  | { mode: "black" }
  | { mode: "photo"; cover: ResolvedCover };

/**
 * What the video sampler actually takes. `firstFrame` and `coverPath` are
 * replaced by the resolved form rather than carried beside it, for the same
 * reason `ResolvedPhotoOptions` replaces `edgeMode`: the sampler is a pure
 * function of numbers that never opens a file, and a mode that still needs a
 * file read cannot reach it by mistake.
 */
export interface ResolvedCopyOptions extends Omit<CopyOptions, "firstFrame" | "coverPath" | "frame"> {
  firstFrame: ResolvedFirstFrame;
  /** Present when the copies go "in a frame": the pack the sampler draws each
   *  copy's background from. Absent means frame mode is off. */
  frame?: ResolvedFrame;
}

/** The background images frame mode draws from, listed where the files are. */
export interface ResolvedFrame {
  backgrounds: string[];
}

/**
 * Where the finished video sits in frame mode: scaled to `w`x`h` and placed at
 * `x`,`y` on the canvas (the export format's size), over `background`. All four
 * numbers are even, and `x + w`/`y + h` never pass the canvas.
 */
export interface FrameSpec {
  background: string;
  w: number;
  h: number;
  x: number;
  y: number;
  /** True when the footage is fitted inside the box with no crop (the `original`
   *  format, whose picture has no 9:16 shape to be cropped to); false when it
   *  was already cropped to the canvas and just fills the box. */
  fit: boolean;
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
  firstFrame?: FirstFrameMode;
  coverPath?: string | null;
  /** Video only: put each copy in a frame over a nature background. */
  frame?: boolean;
  /** Video only: the distortion mode. Optional like the flags above; the video
   *  path resolves an absence to off, axis `h`, strength 0. */
  distortion?: boolean;
  distortionAxis?: TiltAxis;
  distortionStrength?: number;
};

export interface Operation {
  id: string;
  params: Record<string, number | boolean | string>;
}

export interface SpeedSegment {
  fraction: number; // portion of source duration; fractions sum to ~1
  speed: number;    // playback speed for this segment (ffmpeg-safe 0.5..2.0)
}

/**
 * What frame 0 of a rendered copy is, as the graph reads it.
 *
 * The `photo` arm carries the cover's own recipe: drawn by the photo sampler
 * from the copy's seed and intensity on an rng instance of its own, so it is
 * different for every copy and the video draws are not moved by it. It also
 * carries the cover's dimensions, so that the graph is a pure function of the
 * recipe and the source's info — the render does not go back to the file for
 * a number the route already read.
 */
export type FirstFrame =
  | { mode: "off" }
  | { mode: "black" }
  | { mode: "photo"; path: string; info: MediaInfo; recipe: PhotoRecipe };

export interface Recipe {
  seed: number;
  intensity: number; // 1.0 baseline; raised on auto-strengthen
  exportFormat: ExportFormat;
  keepTrendAudio: boolean;
  /** Copied straight from the options, never drawn — as `firstFrame`'s mode
   *  below is: two recipes from the same seed that differ in a setting
   *  differ in that field alone. */
  identity: IdentityMode;
  /** The mode is copied straight from the options, never drawn: a recipe
   *  with it off and one with it on differ in this field alone for the same
   *  seed. The cover recipe inside the `photo` arm is drawn — on its own rng
   *  stream, so the rest of the recipe stays what it was. */
  firstFrame: FirstFrame;
  /** Frame mode: set only when the mode is on. Drawn per copy on an rng of its
   *  own, so the rest of the recipe is what it is with the mode off. */
  frame?: FrameSpec;
  segments: SpeedSegment[];
  video: Operation[];
  audio: Operation[];
}

export interface VerifyResult {
  minDistance: number;
  passed: boolean;
  perFrame: number[];
}
