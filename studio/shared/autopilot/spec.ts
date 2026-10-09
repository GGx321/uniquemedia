import type { VideoShape } from "../engine/autopilot";
import type { Cell, Clip, MontageSpec } from "../engine/montage";
import { splitEvenly } from "../montage/split";
import { STICKER_MANIFEST } from "../stickers/manifest";
import { hashText, intIn, isUint32, stream } from "./hash";
import type { ChosenMusic } from "./track";

// The autopilot's montage spec generator (Stage 4 plan §6.1, §6.3, invariants A8 and A9). Pure: the spec is a function of its input, so a
// re-submit after a crash renders the same video. The photos, the track (with its start) and the sticker choice are decided by the caller
// at assignment; everything the SEED decides (durations, motion, the sticker's look) is decided here.
//
// | shape      | clips                    | duration by seed                                         | motion                         |
// | single     | 1 photo clip             | 6.0 to 10.0 s, 0.5 s steps                               | Ken Burns mostly, pan sometimes |
// | collage 2-4| 1 collage clip, stagger  | 7.0 to 10.0 s, 0.5 s steps                               | Ken Burns                      |
// | slides 5-7 | N photo clips            | 1.2 to 1.4 s a photo, the total clamped to 4 to 10 s     | per clip, by seed              |
//
// Every focus is null: the engine resolves it at render (plan §8.2). There is NO text layer; `captionSource` is the place a future text
// source plugs in (a non-null source would add one text layer through the caption validator, nothing else changes).

/** A8: no autopilot video is longer than this. The same number as the contract's `LAUNCH_MAX_VIDEO_MS` (a test pins it). */
export const AUTOPILOT_MAX_TOTAL_MS = 10_000;
/** The contract's shortest montage, mirrored (the montage module does the same: no value import of zod here). */
const MIN_TOTAL_MS = 4_000;

const STEP_MS = 100;
const HALF_SECOND_MS = 500;
const SINGLE_FROM_MS = 6_000;
const COLLAGE_FROM_MS = 7_000;
const SLIDE_MIN_MS = 1_200;
const SLIDE_MAX_MS = 1_400;
/** Out of 100: how often a photo clip pans instead of a Ken Burns. */
const PAN_PERCENT = 25;

/** The sizes of each shape: a mirror of the contract's `shapeSizeFits`, kept here so the module stays free of zod. */
const SIZES: Record<VideoShape, { readonly min: number; readonly max: number }> = {
  single: { min: 1, max: 1 },
  collage: { min: 2, max: 4 },
  slides: { min: 5, max: 7 },
};

export interface AutopilotSpecOptions {
  /** The launch's sticker toggle: on gives one built-in sticker for the whole video, off gives none. */
  readonly stickers: boolean;
  /** The sticker of the avatar's previous autopilot video, which this one avoids; null when there is none. */
  readonly previousStickerId: string | null;
  /** The text source. None is defined yet (decision 8), so it is always null and the spec never has a text layer. */
  readonly captionSource: null;
}

export interface AutopilotSpecInput {
  readonly avatarId: string;
  readonly shape: VideoShape;
  /** The avatar's scene photos, in the order they show: 1 for a single, 2 to 4 for a collage, 5 to 7 for slides. */
  readonly photoIds: readonly string[];
  /** The video's seed (`videoSeed`): a uint32. It is also the spec's own `seed`. */
  readonly seed: number;
  /** The track and the point it starts at, chosen by `chooseTrack` for this video's total. */
  readonly music: ChosenMusic;
  readonly options: AutopilotSpecOptions;
}

/** The seed of one video: a uint32 from the plan's seed, the avatar and the video's key in the launch. */
export function videoSeed(planSeed: number, avatarId: string, videoKey: string): number {
  if (!isUint32(planSeed)) throw new RangeError(`planSeed must be a uint32, got ${planSeed}`);
  // A NUL cannot be in an id or a key, so (a, b) and (a', b') with the same concatenation still differ.
  return hashText(planSeed, `${avatarId}\u0000${videoKey}`);
}

function assertSeedAndSize(shape: VideoShape, size: number, seed: number): void {
  if (!isUint32(seed)) throw new RangeError(`seed must be a uint32, got ${seed}`);
  const range = SIZES[shape];
  if (!Number.isInteger(size) || size < range.min || size > range.max) throw new RangeError(`a ${shape} video has ${range.min} to ${range.max} photos, got ${size}`);
}

/**
 * The length of the video the seed gives for this shape and number of photos, in ms: what `chooseTrack` needs BEFORE the spec exists (the
 * track must be at least `startMs` plus this). Always on the 100 ms grid and at most 10 000 ms.
 */
export function autopilotTotalMs(shape: VideoShape, size: number, seed: number): number {
  assertSeedAndSize(shape, size, seed);
  const next = stream(seed, "duration");
  let total: number;
  if (shape === "single") total = SINGLE_FROM_MS + HALF_SECOND_MS * intIn(next, 0, 8);
  else if (shape === "collage") total = COLLAGE_FROM_MS + HALF_SECOND_MS * intIn(next, 0, 6);
  else total = size * (SLIDE_MIN_MS + STEP_MS * intIn(next, 0, (SLIDE_MAX_MS - SLIDE_MIN_MS) / STEP_MS));
  return Math.min(AUTOPILOT_MAX_TOTAL_MS, Math.max(MIN_TOTAL_MS, total));
}

const clipId = (index: number): string => `clip-${String(index + 1).padStart(3, "0")}`;
const cell = (photoId: string): Cell => ({ photo: { source: "scene", photoId }, focus: null });

/** Where a sticker may sit: the corners and the middle of the sides, clear of the Reels buttons (right edge, 40 to 80 % of the height) and caption (bottom 20 %). */
const STICKER_ANCHORS: readonly { readonly x: number; readonly y: number }[] = [
  { x: 0.2, y: 0.16 },
  { x: 0.78, y: 0.16 },
  { x: 0.2, y: 0.5 },
  { x: 0.72, y: 0.5 },
];

function stickerLayer(seed: number, previousStickerId: string | null, totalMs: number): MontageSpec["layers"][number] {
  const next = stream(seed, "sticker");
  const kept = STICKER_MANIFEST.filter((sticker) => sticker.id !== previousStickerId);
  const pool = kept.length > 0 ? kept : STICKER_MANIFEST;
  const sticker = pool[intIn(next, 0, pool.length - 1)];
  const anchor = STICKER_ANCHORS[intIn(next, 0, STICKER_ANCHORS.length - 1)];
  if (sticker === undefined || anchor === undefined) throw new Error("the sticker manifest and the anchors are not empty");
  return {
    layerId: "sticker-001",
    kind: "sticker",
    startMs: 0,
    endMs: totalMs,
    sticker: { source: "builtin", stickerId: sticker.id },
    x: anchor.x,
    y: anchor.y,
    size: (18 + intIn(next, 0, 6)) / 100,
  };
}

/**
 * A complete, renderable `MontageSpec` for one autopilot video. Refuses (RangeError) a seed that is not a uint32, a number of photos the
 * shape does not have, and a photo used twice. Never longer than 10 000 ms (A8), never has a text layer and never silent (A9).
 */
export function autopilotSpec(input: AutopilotSpecInput): MontageSpec {
  const { avatarId, shape, photoIds, seed, music, options } = input;
  assertSeedAndSize(shape, photoIds.length, seed);
  if (new Set(photoIds).size !== photoIds.length) throw new RangeError("a photo can appear only once in a video");
  const totalMs = autopilotTotalMs(shape, photoIds.length, seed);

  const motion = stream(seed, "motion");
  const pickMotion = (): "kenburns" | "pan" => (intIn(motion, 0, 99) < PAN_PERCENT ? "pan" : "kenburns");
  const common = { transitionIn: "cut" as const };
  const first = photoIds[0];
  if (first === undefined) throw new RangeError("a video needs at least one photo");

  let clips: Clip[];
  if (shape === "single") {
    clips = [{ ...common, clipId: clipId(0), kind: "photo", durationMs: totalMs, motion: pickMotion(), cell: cell(first) }];
  } else if (shape === "collage") {
    const layout = photoIds.length === 2 ? "collage2" : photoIds.length === 3 ? "collage3" : "collage4";
    clips = [{ ...common, clipId: clipId(0), kind: "collage", durationMs: totalMs, motion: "kenburns", layout, cells: photoIds.map(cell), stagger: true }];
  } else {
    const durations = splitEvenly(totalMs, photoIds.length);
    clips = photoIds.map((photoId, i) => ({ ...common, clipId: clipId(i), kind: "photo", durationMs: durations[i] ?? 0, motion: pickMotion(), cell: cell(photoId) }));
  }

  const layers = options.stickers ? [stickerLayer(seed, options.previousStickerId, totalMs)] : [];
  const spec: MontageSpec = { schemaVersion: 1, avatarId, clips, layers, music: { ...music }, seed };
  // Defence in depth for A8: the sum of what was built, not of what was meant to be built.
  if (clips.reduce((sum, clip) => sum + clip.durationMs, 0) > AUTOPILOT_MAX_TOTAL_MS) throw new Error("an autopilot spec must not exceed 10 s");
  return spec;
}
