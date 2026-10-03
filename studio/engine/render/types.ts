import type { Cell, Clip } from "../../shared/engine/montage";
import type { Rect } from "../../shared/montage";

// The graph builder's inputs and outputs. Everything is plain data: the
// builder reads no file and starts no process. The engine (3a.6) resolves the
// photos, picks the paths, runs the argv arrays, and writes the concat list.

/**
 * A photo the engine has resolved: where it is and how large it is STORED.
 * `width` and `height` are the stored pixel size, which is what the library
 * sidecar and the face detector's focus are in (both ignore EXIF orientation).
 * The graph reads the file with `-noautorotate`, so ffmpeg delivers exactly
 * that stored size and orientation, on 6.0 and 6.1.1 alike. An own upload
 * (3f) with an EXIF orientation is therefore drawn as stored, unless the
 * importer bakes the rotation into the pixels.
 */
export interface PhotoSource {
  /** Absolute path. It goes to ffmpeg as `-i <path>`, never into a filter string. */
  readonly path: string;
  readonly width: number;
  readonly height: number;
}

export type PhotoRef = NonNullable<Cell["photo"]>;

/** Looks a cell's photo up. `undefined` means "not resolved", which the builder refuses. */
export type PhotoResolver = (ref: PhotoRef) => PhotoSource | undefined;

export type RenderGraphErrorCode =
  | "VIDEO_CLIP_UNSUPPORTED"
  | "CELL_EMPTY"
  | "PHOTO_UNRESOLVED"
  | "PATH_NOT_ABSOLUTE"
  | "UNSAFE_GRAPH"
  | "NO_CLIPS"
  | "BAD_OVERLAY"
  | "BAD_DURATION"
  | "BAD_PHOTO_SIZE"
  | "BAD_AUDIO";

/** A refusal to build: the spec or the injected inputs cannot produce a valid graph. */
export class RenderGraphError extends Error {
  readonly code: RenderGraphErrorCode;
  constructor(code: RenderGraphErrorCode, message: string) {
    super(message);
    this.name = "RenderGraphError";
    this.code = code;
  }
}

/** What pass 1 needs: the spec's clips and seed, the photo lookup, and the job's temp folder. */
export interface Pass1Input {
  readonly seed: number;
  readonly clips: readonly Clip[];
  readonly resolvePhoto: PhotoResolver;
  /** Absolute: `userData/render-tmp/<jobId>`. */
  readonly clipDir: string;
}

/** One ffmpeg call of pass 1: one visual clip to one intermediate. */
export interface Pass1Job {
  readonly index: number;
  readonly clipId: string;
  /** The frames the intermediate must hold: `durationMs * 3 / 100`. */
  readonly frames: number;
  /** `clip-NN.mkv`, relative to `clipDir`. */
  readonly fileName: string;
  /** `clipDir/fileName`. */
  readonly output: string;
  /** Everything after the ffmpeg binary. */
  readonly argv: readonly string[];
}

/**
 * A text PNG or a sticker as a timed overlay. 3b supplies the assets; the
 * builder needs only the file, its box and its frame range.
 */
export interface OverlayInput {
  /** Absolute path of a PNG, APNG or GIF (or, for `layers`, of the layer pass's finished file). */
  readonly path: string;
  /**
   * What the file is, which names its demuxer: a still `png`, or an animation
   * (`apng`, `gif`). An animation loops from the layer's first frame; a still
   * is just held. `layers` is the layer pass's output (3b.6): one full-frame
   * transparent lossless file that already holds every text and sticker layer,
   * so pass 2 overlays exactly one stream whatever the layer count.
   */
  readonly format: "png" | "apng" | "gif" | "layers";
  /**
   * An animation's loop period in 30 fps frames, as stored with the sticker (the manifest and catalogue), never read off the
   * file's own timing: it is the loop cache's `size`, and the preview wraps on the same number (`(t - start) mod period`).
   * 1..`ANIMATED_LOOP_MAX_FRAMES`. The layer pass requires it for an animation; pass 2's direct path falls back to the maximum.
   */
  readonly loopFrames?: number;
  /** An animation's own pixel size, which prices its loop cache (frames x w x h x 2.5 bytes) when the layer pass splits its calls. */
  readonly sourceSize?: { readonly w: number; readonly h: number };
  /** Where and how large, from the geometry module (`stickerBox`, `textBox`). Even numbers. */
  readonly box: Rect;
  /** Scale the asset to `box` (stickers). A text PNG is already the size of its box. */
  readonly resize: boolean;
  /** From `layerRange`: half-open `[startFrame, endFrame)` on the montage timeline. */
  readonly startFrame: number;
  readonly endFrame: number;
}

/**
 * A stored track as the render reads it. `path` comes only from the engine's own track store, by track id (invariant 31),
 * never from a window; `startMs` is where in the track the montage's first sample is.
 */
export interface MusicSource {
  readonly path: string;
  readonly startMs: number;
}

/**
 * The audio of pass 2: silence, or one track with the gain the true-peak pass chose for its clip segment. The gain is a
 * whole number of tenths of a dB and never positive (invariant 21).
 */
export type AudioSource = { readonly kind: "silent" } | ({ readonly kind: "music"; readonly gainDb: number } & MusicSource);

/** What a render job is asked for: music has no gain yet, the runner measures the segment first and then builds `AudioSource`. */
export type AudioPlan = { readonly kind: "silent" } | ({ readonly kind: "music" } & MusicSource);

export interface Pass2Input {
  /** The clips as pass 1 rendered them (ids and durations decide the list and the length). */
  readonly clips: readonly { readonly clipId: string; readonly durationMs: number }[];
  /** Absolute: the job's temp folder, where pass 1 wrote the intermediates. It is ffmpeg's `cwd`. */
  readonly clipDir: string;
  /** Absolute: the temp file on the export volume. */
  readonly output: string;
  /** In z-order, later on top. */
  readonly overlays: readonly OverlayInput[];
  readonly audio: AudioSource;
}

export interface Pass2Job {
  /** Everything after the ffmpeg binary. */
  readonly argv: readonly string[];
  /** ffmpeg's working directory: `clipDir`. */
  readonly cwd: string;
  /** The concat list's file name, relative to `cwd`. The runner writes `listFileContents` there. */
  readonly listFileName: string;
  readonly listFileContents: string;
  readonly output: string;
  /** `Σ durationMs * 3 / 100`. */
  readonly totalFrames: number;
  /** `Σ durationMs * 48`: the exact length of the audio in samples. */
  readonly audioSamples: number;
}

/** What the layer pass needs: every text and sticker layer in z-order (later on top), the timeline's length, and the job's temp folder. */
export interface LayerPassInput {
  readonly layers: readonly OverlayInput[];
  /** `Σ durationMs * 3 / 100`: the exact number of frames every layer file holds. */
  readonly totalFrames: number;
  /** Absolute: the job's temp folder. The layer files are written here. */
  readonly clipDir: string;
}

/** One ffmpeg call of the layer pass: some of the layers composited onto the file the call before wrote (or onto nothing). */
export interface LayerPassJob {
  readonly index: number;
  /** `layers-NN.mkv`, relative to `clipDir`. */
  readonly fileName: string;
  /** `clipDir/fileName`. */
  readonly output: string;
  /** The frames the file must hold: the timeline's. */
  readonly frames: number;
  /** How many layers this call composites. */
  readonly layerCount: number;
  /** What the cost model says this call's peak RSS is, in bytes. */
  readonly modelledBytes: number;
  /** Everything after the ffmpeg binary. */
  readonly argv: readonly string[];
}

export interface LayerPassPlan {
  /** The calls, to run one after another. Empty when there are no layers. */
  readonly jobs: readonly LayerPassJob[];
  /** What pass 2 overlays instead of the layers themselves: the last call's file, or null when there are no layers. */
  readonly final: OverlayInput | null;
}
