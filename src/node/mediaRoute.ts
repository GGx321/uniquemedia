import { FfmpegExecutor } from "./ffmpegExecutor";
import { PhotoExecutor } from "./photoExecutor";
import { detectMediaKind } from "./detectKind";
import { uniquify } from "../core/pipeline";
import { sampleRecipe } from "../core/sampler";
import { samplePhotoRecipe } from "../core/photo/sampler";
import type { RenderExecutor } from "../core/executor";
import { shouldPreserveEdges } from "../core/photo/edges";
import { EDGE_MODES, EXPORT_FORMATS, FIRST_FRAME_MODES, IDENTITY_MODES } from "../core/types";
import type {
  EdgeMode,
  ExportFormat,
  FirstFrameMode,
  IdentityMode,
  MediaKind,
  Recipe,
  ResolvedCopyOptions,
  StartOptions,
  VerifyResult,
} from "../core/types";
import type {
  ResolvedCover,
  ResolvedFirstFrame,
} from "../core/types";
import type { PhotoRecipe, ResolvedEdge, ResolvedPhotoOptions } from "../core/photo/types";

/**
 * What a host needs from a backend beyond `RenderExecutor`: a preview image for
 * the queue, a kill switch for Stop, and a binary pre-warm at startup. Both
 * executors satisfy it, so the host never has to ask whether a method is there.
 */
export interface MediaBackend<R> extends RenderExecutor<R> {
  extractThumbnail(input: string): Promise<string>;
  cancel(): void;
  warmup(): Promise<void>;
  /** Required here, optional on `RenderExecutor`: a host backend owns real
   *  files, and without these the post-pass would regenerate a copy in place —
   *  the path Stop deletes. */
  replace(from: string, to: string): Promise<void>;
  discard(path: string): Promise<void>;
}

/**
 * The still backend, which has one thing the clip backend does not: it can read
 * a colour off the picture. `fitpad` pads a shrunken frame back to full size,
 * and the colour it pads with has to come from the image — black is right for a
 * story on a black background and a bright border on anything else.
 */
export interface PhotoBackend extends MediaBackend<PhotoRecipe> {
  sampleEdgeColor(input: string): Promise<string>;
}

export interface Backends {
  video: MediaBackend<Recipe>;
  photo: PhotoBackend;
}

export interface VideoRoute {
  kind: "video";
  executor: MediaBackend<Recipe>;
  /** The still backend, for the one still a video batch can carry: the cover
   *  of `firstFrame: "photo"` is probed and its edge mode decided here, the
   *  same way a photo batch's is, before the sampler ever sees it. */
  stills: PhotoBackend;
  sampleRecipe: (opts: ResolvedCopyOptions, seed: number, intensity: number) => Recipe;
  framesPerCopy: number;
  outputExtension: ".mp4";
  defaultExportFormat: ExportFormat;
}

export interface PhotoRoute {
  kind: "photo";
  executor: PhotoBackend;
  sampleRecipe: (opts: ResolvedPhotoOptions, seed: number, intensity: number) => PhotoRecipe;
  framesPerCopy: number;
  outputExtension: ".jpg";
  defaultExportFormat: ExportFormat;
}

/** Discriminated so that resolving `executor` and `sampleRecipe` to the same
 *  recipe type is the compiler's job rather than a cast at the call site. */
export type MediaRoute = VideoRoute | PhotoRoute;

/** What both hosts read back from a batch. The recipe is deliberately absent —
 *  it differs per route and neither host looks at it. */
export interface RouteCopyResult {
  index: number;
  outputPath: string;
  verify: VerifyResult;
}

export interface RouteBatchConfig {
  seedBase: number;
  outputPath: (index: number) => string;
  maxAttempts?: number;
  interThreshold?: number;
  /**
   * Required, unlike the core config's optional one: a host always has a clock,
   * and the one host that quietly omitted this field spent its whole life
   * stamping December 1969 onto every spoofed capture. Making it part of the
   * shape means a host that forgets is a compile error rather than a batch of
   * files dated before the camera existed.
   */
  nowMs: number;
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?: (index: number, attempt: number, fraction: number) => void;
  /** Fires again for a copy the inter-copy post-pass regenerated. */
  onCopyDone?: (result: RouteCopyResult) => void;
  /** The inter-copy check after the last copy, as `done` of `total` settled. */
  onPostPass?: (done: number, total: number) => void;
}

/** A still is a single frame; asking for more would compare it against itself. */
const PHOTO_FRAMES_PER_COPY = 1;
/** Four evenly-spaced frames, which is what the video path has always sampled. */
const VIDEO_FRAMES_PER_COPY = 4;

export function createBackends(): Backends {
  return { video: new FfmpegExecutor(), photo: new PhotoExecutor() };
}

export function routeForKind(kind: MediaKind, backends: Backends): MediaRoute {
  if (kind === "photo") {
    return {
      kind,
      executor: backends.photo,
      sampleRecipe: samplePhotoRecipe,
      framesPerCopy: PHOTO_FRAMES_PER_COPY,
      outputExtension: ".jpg",
      // A still has its own framing already. Re-framing it to a video aspect
      // throws away picture, and the PDQ distance RISES when that happens, so
      // the metric would report the damage as a success.
      defaultExportFormat: "original",
    };
  }
  return {
    kind,
    executor: backends.video,
    stills: backends.photo,
    sampleRecipe,
    framesPerCopy: VIDEO_FRAMES_PER_COPY,
    outputExtension: ".mp4",
    defaultExportFormat: "reels",
  };
}

/**
 * Turns a `--format` argument into an export format: absent means the route's
 * own default, present means exactly what was asked for whatever the medium.
 * Parses rather than casts — the argument is user input, and an unrecognised
 * one used to reach `EXPORT_DIMS` as a missing key and fail by destructuring
 * `undefined` somewhere far from the flag that caused it.
 */
export function resolveExportFormat(
  requested: string | undefined,
  route: MediaRoute
): ExportFormat {
  if (requested === undefined) return route.defaultExportFormat;
  const match = EXPORT_FORMATS.find((f) => f === requested);
  if (match === undefined) {
    throw new Error(
      `Unknown --format ${requested}. Expected one of: ${EXPORT_FORMATS.join(", ")}.`
    );
  }
  return match;
}

/**
 * Turns an `--edges` argument into an edge mode. Same shape and the same reason
 * as `resolveExportFormat`: the argument is user input, and an unrecognised one
 * reaching the sampler is simply not `fit`, so the run quietly crops — the
 * exact damage the flag exists to prevent, reported as a success.
 */
export function resolveEdgeMode(requested: string | undefined, fallback: EdgeMode): EdgeMode {
  if (requested === undefined) return fallback;
  const match = EDGE_MODES.find((m) => m === requested);
  if (match === undefined) {
    throw new Error(`Unknown --edges ${requested}. Expected one of: ${EDGE_MODES.join(", ")}.`);
  }
  return match;
}

/**
 * Turns an `--identity` argument into an identity mode. Same shape and the
 * same reason as `resolveEdgeMode`: an unrecognised mode that reached the
 * graph would simply not be `iphone` and would ship as `engine`, with the
 * encoder's signature on it, reported as success.
 */
export function resolveIdentityMode(requested: string | undefined, fallback: IdentityMode): IdentityMode {
  if (requested === undefined) return fallback;
  const match = IDENTITY_MODES.find((m) => m === requested);
  if (match === undefined) {
    throw new Error(`Unknown --identity ${requested}. Expected one of: ${IDENTITY_MODES.join(", ")}.`);
  }
  return match;
}

/**
 * Turns a `--first-frame` argument into a mode. Same shape and the same reason
 * as `resolveIdentityMode`: an unrecognised mode that reached the sampler
 * would simply not be `photo` and the copy would open on the footage,
 * reported as success.
 */
export function resolveFirstFrameMode(
  requested: string | undefined,
  fallback: FirstFrameMode
): FirstFrameMode {
  if (requested === undefined) return fallback;
  const match = FIRST_FRAME_MODES.find((m) => m === requested);
  if (match === undefined) {
    throw new Error(
      `Unknown --first-frame ${requested}. Expected one of: ${FIRST_FRAME_MODES.join(", ")}.`
    );
  }
  return match;
}

/**
 * Answers `auto`, here, where the pixels are.
 *
 * The sampler is a pure function of numbers and never opens a file, so the
 * decision cannot live there; and it is a property of the source, not of a
 * copy, so it is taken once for the batch rather than once per attempt.
 *
 * The decision itself is free: it reads the same 64x64 gray frame the pipeline
 * already extracts to hash the original. The padding colour is not free — it is
 * a second decode — so it is only measured once the answer is known to be
 * `fit`, which is also why the two are returned together.
 */
export async function resolveEdge(
  executor: PhotoBackend,
  input: string,
  mode: EdgeMode
): Promise<ResolvedEdge> {
  const preserve =
    mode === "auto" ? shouldPreserveEdges((await executor.extractGrayFrames(input, 1))[0]) : mode === "fit";
  if (!preserve) return { mode: "crop" };
  return { mode: "fit", padColor: await executor.sampleEdgeColor(input) };
}

/**
 * Refuses a cover that is not a still the bundled ffmpeg can open, by name
 * and with what to do: a HEIC gets the convert-it advice `detectMediaKind`
 * gives, footage is told the first frame takes a picture. Decided from the
 * file's bytes, as the source is. Shared by the route and the desktop
 * host's cover dialog, so the two never drift apart.
 */
export async function assertStillCover(coverPath: string): Promise<void> {
  let kind: MediaKind;
  try {
    kind = await detectMediaKind(coverPath);
  } catch (err) {
    throw new Error(
      `Cannot use ${coverPath} as the cover: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (kind !== "photo") {
    throw new Error(
      `Cannot use ${coverPath} as the cover: the first frame takes a still image, ` +
        "and this file is footage."
    );
  }
}

/**
 * Resolves the cover of a `firstFrame: "photo"` batch, or says why it cannot.
 *
 * Everything the sampler will need and cannot get for itself: that there IS a
 * cover (the option is nullable because a host's form can be empty until the
 * mode asks for it); that it is a still the bundled ffmpeg can open, decided
 * from its bytes like the source is — a HEIC gets the convert-it advice, a
 * clip is refused by name; its dimensions, which the cover's chain is built
 * against; and its edge mode, `auto` answered off its own pixels. Once per
 * batch, not per copy: all of it is a property of the file.
 */
async function resolveCover(
  stills: PhotoBackend,
  coverPath: string | null | undefined,
  edgeMode: EdgeMode
): Promise<ResolvedCover> {
  if (!coverPath) {
    throw new Error(
      'First frame mode "photo" needs a cover image: pass --cover <path> on the ' +
        "command line, or pick a photo for the first frame in the app."
    );
  }
  await assertStillCover(coverPath);
  const info = await stills.probe(coverPath);
  const edge = await resolveEdge(stills, coverPath, edgeMode);
  return { path: coverPath, edge, info };
}

/**
 * The first-frame half of a video batch's options, with the cover resolved
 * when the mode calls for one. An absent mode is `off`, for the same reason
 * an absent audio flag is `false`: the photo UI never sends it.
 *
 * The mode is parsed, not trusted: the CLI runs it through the same check,
 * but the Electron payload arrives as whatever the renderer sent, and an
 * unknown string would otherwise fall through `!== "photo"` and ship as off.
 */
async function resolveFirstFrame(
  route: VideoRoute,
  opts: StartOptions
): Promise<ResolvedFirstFrame> {
  const mode = resolveFirstFrameMode(opts.firstFrame, "off");
  if (mode !== "photo") return { mode };
  return { mode, cover: await resolveCover(route.stills, opts.coverPath, opts.edgeMode) };
}

/** Decides the route from what is inside the file, never from its extension. */
export async function routeForInput(input: string, backends: Backends): Promise<MediaRoute> {
  return routeForKind(await detectMediaKind(input), backends);
}

export function outputName(stem: string, index: number, route: MediaRoute): string {
  return `${stem}_${index + 1}${route.outputExtension}`;
}

/**
 * Runs one batch down whichever route was chosen. This is the single place
 * where the route union collapses, so a host never repeats the branch — and
 * never has to name a recipe type it has no business knowing.
 */
export async function uniquifyRoute(
  route: MediaRoute,
  input: string,
  opts: StartOptions,
  count: number,
  config: RouteBatchConfig
): Promise<RouteCopyResult[]> {
  const shared = { ...config, framesPerCopy: route.framesPerCopy };
  if (route.kind === "photo") {
    // `edgeMode` is replaced by the decided form rather than carried beside it,
    // so nothing downstream can read the unanswered one by mistake. The two
    // video-only flags go the same way they do in the renderer's own photo
    // derivation: a still has no soundtrack and no second frame, and a dead
    // flag riding along reads as a setting something honours.
    const {
      edgeMode,
      keepTrendAudio: _keepTrendAudio,
      firstFrame: _firstFrame,
      coverPath: _coverPath,
      ...rest
    } = opts;
    const photoOpts: ResolvedPhotoOptions = {
      ...rest,
      edge: await resolveEdge(route.executor, input, edgeMode),
    };
    return uniquify<PhotoRecipe, ResolvedPhotoOptions>(input, photoOpts, route.executor, count, {
      ...shared,
      sampleRecipe: route.sampleRecipe,
    });
  }
  // `firstFrame` and `coverPath` are replaced by the resolved form, as a
  // still's `edgeMode` is above: the sampler gets numbers, and a request the
  // cover cannot honour is refused here, before a frame is rendered.
  const { firstFrame: _firstFrame, coverPath: _coverPath, ...rest } = opts;
  const videoOpts: ResolvedCopyOptions = {
    ...rest,
    keepTrendAudio: opts.keepTrendAudio ?? false,
    firstFrame: await resolveFirstFrame(route, opts),
  };
  return uniquify<Recipe, ResolvedCopyOptions>(input, videoOpts, route.executor, count, {
    ...shared,
    sampleRecipe: route.sampleRecipe,
  });
}
